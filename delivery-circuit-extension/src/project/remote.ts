// Fireflies GraphQL and Jira REST reads used by the project context. No vscode import; fetch is injectable for tests.
// Keys travel only in headers and are never logged or put into error messages.
import type { JiraCredentials, SourceRef } from "../core/contracts";

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

const defaultFetch: FetchLike = (url, init) => (globalThis.fetch as any)(url, init);

export const FIREFLIES_GRAPHQL = "https://api.fireflies.ai/graphql";

async function firefliesQuery(key: string, query: string, variables: Record<string, unknown>, fetchFn: FetchLike): Promise<any> {
  const r = await fetchFn(FIREFLIES_GRAPHQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`Fireflies request failed (HTTP ${r.status})`);
  const j = await r.json();
  if (j?.errors?.length) throw new Error(`Fireflies: ${String(j.errors[0]?.message ?? "error").slice(0, 200)}`);
  return j?.data;
}

/** Fireflies `date` is epoch milliseconds (number or numeric string); dateString is ISO. */
export function firefliesDate(t: any): string {
  if (typeof t?.dateString === "string" && t.dateString) return new Date(t.dateString).toISOString();
  const n = Number(t?.date);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : "";
}

export function firefliesRef(t: any): SourceRef {
  return { id: `fireflies:${t.id}`, kind: "fireflies", title: String(t.title ?? t.id), date: firefliesDate(t) };
}

export const MEETING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,}$/;

export async function firefliesRecent(key: string, limit = 10, fetchFn: FetchLike = defaultFetch): Promise<SourceRef[]> {
  const n = Math.min(Math.max(1, Math.floor(limit)), 50);
  const d = await firefliesQuery(key, "query Recent($limit: Int) { transcripts(limit: $limit) { id title date dateString } }", { limit: n }, fetchFn);
  return (d?.transcripts ?? []).filter((t: any) => t?.id && MEETING_ID_RE.test(String(t.id))).map(firefliesRef);
}

export async function firefliesMeta(key: string, id: string, fetchFn: FetchLike = defaultFetch): Promise<SourceRef> {
  if (!MEETING_ID_RE.test(id)) throw new Error("Invalid Fireflies meeting id");
  const d = await firefliesQuery(key, "query Meta($id: String!) { transcript(id: $id) { id title date dateString } }", { id }, fetchFn);
  if (!d?.transcript) throw new Error(`Fireflies meeting ${id} not found`);
  return firefliesRef(d.transcript);
}

/** Full transcript as text: a header and one "Speaker: sentence" line per sentence (consecutive lines merged). */
export async function firefliesTranscript(key: string, id: string, fetchFn: FetchLike = defaultFetch): Promise<string> {
  if (!MEETING_ID_RE.test(id)) throw new Error("Invalid Fireflies meeting id");
  const d = await firefliesQuery(key,
    "query T($id: String!) { transcript(id: $id) { id title date dateString sentences { speaker_name text } } }", { id }, fetchFn);
  const t = d?.transcript;
  if (!t) throw new Error(`Fireflies meeting ${id} not found`);
  return formatSentences(t);
}

export function formatSentences(t: any): string {
  const lines: string[] = [];
  let speaker = "", buf: string[] = [];
  const flush = () => { if (buf.length) lines.push(`${speaker || "Unknown"}: ${buf.join(" ")}`); buf = []; };
  for (const s of t?.sentences ?? []) {
    const who = String(s?.speaker_name ?? "").trim();
    if (who !== speaker) { flush(); speaker = who; }
    const text = String(s?.text ?? "").trim();
    if (text) buf.push(text);
  }
  flush();
  return [`# ${t?.title ?? t?.id}`, `Date: ${firefliesDate(t)}`, `Source: fireflies:${t?.id}`, "", ...lines].join("\n");
}

// ---------- Jira ----------
export function jiraSiteUrl(site: string): string | undefined {
  const s = site.trim().replace(/\/+$/, "");
  if (!s || s.includes("<")) return undefined;
  const url = /^https:\/\//i.test(s) ? s : /^[a-z0-9.-]+$/i.test(s) ? `https://${s.includes(".") ? s : `${s}.atlassian.net`}` : undefined;
  if (!url) return undefined;
  try { return new URL(url).origin; } catch { return undefined; }
}

/** Labels of the given issues (keys validated; batched 50 per JQL). Uses the enhanced search, then the classic one. */
export async function jiraLabels(creds: JiraCredentials, keys: string[], fetchFn: FetchLike = defaultFetch): Promise<Record<string, string[]>> {
  const base = jiraSiteUrl(creds.site);
  if (!base) throw new Error("Jira site is not set");
  const auth = "Basic " + Buffer.from(`${creds.email}:${creds.token}`).toString("base64");
  const valid = [...new Set(keys.filter((k) => /^[A-Z][A-Z0-9]+-\d+$/.test(k)))];
  const out: Record<string, string[]> = {};
  for (let i = 0; i < valid.length; i += 50) {
    const batch = valid.slice(i, i + 50);
    const jql = encodeURIComponent(`key in (${batch.join(",")})`);
    const headers = { Authorization: auth, Accept: "application/json" };
    let r = await fetchFn(`${base}/rest/api/3/search/jql?jql=${jql}&fields=labels&maxResults=100`, { headers });
    if (r.status === 404 || r.status === 410) r = await fetchFn(`${base}/rest/api/2/search?jql=${jql}&fields=labels&maxResults=100`, { headers });
    if (!r.ok) throw new Error(`Jira search failed (HTTP ${r.status})`);
    const j = await r.json();
    for (const issue of j?.issues ?? []) out[issue.key] = Array.isArray(issue?.fields?.labels) ? issue.fields.labels.map(String) : [];
  }
  return out;
}
