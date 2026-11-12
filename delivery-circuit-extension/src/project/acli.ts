// Jira through the Atlassian CLI (`acli`), logged in with `acli jira auth login --web` (no API token anywhere).
// No vscode import. The process runner is injected so tests feed recorded JSON instead of starting acli.
//
// acli does not document the shape of its --json output, so every reader here accepts the Jira REST shape
// ({key, fields:{summary, status:{name}, ...}}) as well as a flattened one ({key, summary, status: "To Do", ...}),
// wrapped in an array, {issues: [...]}, {values: [...]} or {data: {issues: [...]}}.
import type { ExecResult } from "../core/util";
import type { JiraIssue, JiraLink } from "./model";

export type AcliExec = (args: string[]) => Promise<ExecResult>;

export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]+$/;

export class AcliError extends Error {
  constructor(public kind: "missing" | "auth" | "failed", message: string) { super(message); }
}

// ---------- command lines (arrays: never a shell string) ----------
export function searchArgs(jql: string, fields = "*all"): string[] {
  return ["jira", "workitem", "search", "--jql", jql, "--fields", fields, "--paginate", "--json"];
}
export function viewArgs(key: string): string[] {
  if (!JIRA_KEY_RE.test(key)) throw new Error(`Not a Jira key: ${key}`);
  return ["jira", "workitem", "view", key, "--fields", "*all", "--json"];
}
export const AUTH_STATUS_ARGS = ["jira", "auth", "status"];

/** "KEY-1, KEY-2" for JQL `in (...)`; only well-formed keys get in. */
export function keyList(keys: Iterable<string>): string {
  return [...new Set([...keys].filter((k) => JIRA_KEY_RE.test(k)))].sort(compareKeys).join(", ");
}

/** ABC-2 before ABC-10. */
export function compareKeys(a: string, b: string): number {
  const [pa, na] = splitKey(a), [pb, nb] = splitKey(b);
  return pa === pb ? na - nb : pa.localeCompare(pb);
}
const splitKey = (k: string): [string, number] => { const i = k.lastIndexOf("-"); return [k.slice(0, i), Number(k.slice(i + 1)) || 0]; };

// ---------- running ----------
function classify(r: ExecResult, what: string): AcliError {
  const err = `${r.stderr}\n${r.stdout}`.trim();
  if (/ENOENT|not recognized as|command not found|cannot find the file|no such file/i.test(err) || (!err && r.code !== 0)) {
    return new AcliError("missing", "The Atlassian CLI (acli) is not installed or not on PATH. Install it from developer.atlassian.com/cloud/acli and run: acli jira auth login --web");
  }
  if (/not (logged|signed) in|unauthori[sz]ed|\b401\b|auth(entication)? (required|failed)|acli jira auth login|token (has )?expired/i.test(err)) {
    return new AcliError("auth", "Atlassian CLI is not logged in. Run: acli jira auth login --web");
  }
  return new AcliError("failed", `acli ${what} failed: ${firstLine(err) || `exit code ${r.code}`}`);
}
const firstLine = (s: string) => (s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "").slice(0, 200);

/** Parse the first JSON value in the output (acli may print a notice line before it). */
export function parseCliJson(stdout: string): unknown {
  const t = stdout.trim();
  if (!t) return undefined;
  try { return JSON.parse(t); } catch { /* look for the JSON part */ }
  const start = t.search(/[[{]/);
  if (start < 0) return undefined;
  const open = t[start], close = open === "[" ? "]" : "}";
  const end = t.lastIndexOf(close);
  if (end <= start) return undefined;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return undefined; }
}

export async function acliJson(exec: AcliExec, args: string[]): Promise<unknown> {
  const r = await exec(args);
  const parsed = parseCliJson(r.stdout);
  if (r.code !== 0 || parsed === undefined) {
    // An empty result is valid JSON ("[]"); anything else without JSON is an error.
    if (r.code === 0 && /^\s*(no (work items|issues|results) found)?\s*$/i.test(r.stdout)) return [];
    throw classify(r, args.slice(0, 3).join(" "));
  }
  return parsed;
}

export async function searchIssues(exec: AcliExec, jql: string): Promise<JiraIssue[]> {
  return normalizeIssues(await acliJson(exec, searchArgs(jql)));
}

export async function viewIssue(exec: AcliExec, key: string): Promise<JiraIssue | undefined> {
  return normalizeIssues(await acliJson(exec, viewArgs(key)))[0];
}

/** Site of the logged-in account from `acli jira auth status` (output format undocumented: any *.atlassian.net). */
export async function authSite(exec: AcliExec): Promise<{ loggedIn: boolean; site?: string; detail: string }> {
  let r: ExecResult;
  try { r = await exec(AUTH_STATUS_ARGS); } catch (e: any) { return { loggedIn: false, detail: String(e?.message ?? e) }; }
  const text = `${r.stdout}\n${r.stderr}`;
  const site = /([a-z0-9][a-z0-9-]*\.atlassian\.net)/i.exec(text)?.[1]?.toLowerCase();
  if (r.code !== 0 || /not (logged|signed) in|no (active )?account|unauthori[sz]ed/i.test(text)) {
    return { loggedIn: false, detail: classify(r, "jira auth status").message };
  }
  return { loggedIn: true, ...(site ? { site: `https://${site}` } : {}), detail: firstLine(r.stdout) };
}

// ---------- normalising ----------
export function normalizeIssues(json: unknown): JiraIssue[] {
  const j: any = json;
  const list: unknown[] = Array.isArray(j) ? j
    : Array.isArray(j?.issues) ? j.issues
    : Array.isArray(j?.workItems) ? j.workItems
    : Array.isArray(j?.values) ? j.values
    : Array.isArray(j?.data?.issues) ? j.data.issues
    : j && typeof j === "object" && (j.key || j.fields) ? [j] : [];
  const out: JiraIssue[] = [];
  for (const raw of list) {
    const i = normalizeIssue(raw);
    if (i) out.push(i);
  }
  return out;
}

const nameOf = (v: any): string | undefined =>
  v == null ? undefined : typeof v === "string" ? v : typeof v === "object" ? (v.name ?? v.value ?? v.displayName ?? undefined) : String(v);

export function normalizeIssue(raw: any): JiraIssue | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const key = String(raw.key ?? "");
  if (!JIRA_KEY_RE.test(key)) return undefined;
  const f: Record<string, any> = raw.fields && typeof raw.fields === "object" ? { ...raw, ...raw.fields } : { ...raw };
  delete f.fields;
  const status = f.status;
  const issue: JiraIssue = {
    key,
    summary: String(f.summary ?? ""),
    issueType: String(nameOf(f.issuetype ?? f.issueType ?? f.type) ?? ""),
    status: String(nameOf(status) ?? ""),
    labels: Array.isArray(f.labels) ? f.labels.map(String) : typeof f.labels === "string" ? f.labels.split(/[,\s]+/).filter(Boolean) : [],
    links: normalizeLinks(f.issuelinks ?? f.issueLinks ?? f.links),
    fields: f,
  };
  const cat = status?.statusCategory?.key ?? f.statusCategory?.key ?? (typeof f.statusCategory === "string" ? f.statusCategory : undefined);
  if (cat) issue.statusCategory = String(cat).toLowerCase();
  const parent = f.parent?.key ?? (typeof f.parent === "string" ? f.parent : undefined) ?? f.parentKey ?? f.epicKey;
  if (parent && JIRA_KEY_RE.test(String(parent))) issue.parentKey = String(parent);
  const desc = docText(f.description);
  if (desc) issue.description = desc;
  if (f.updated) issue.updated = String(f.updated);
  if (f.created) issue.created = String(f.created);
  return issue;
}

function normalizeLinks(v: any): JiraLink[] {
  if (!Array.isArray(v)) return [];
  const out: JiraLink[] = [];
  for (const l of v) {
    const other = l?.outwardIssue ?? l?.inwardIssue;
    if (!other?.key || !JIRA_KEY_RE.test(String(other.key))) continue;
    const outward = !!l.outwardIssue;
    const of = other.fields ?? other;
    const link: JiraLink = {
      type: String(l?.type?.name ?? l?.type ?? ""),
      direction: outward ? "outward" : "inward",
      phrase: String((outward ? l?.type?.outward : l?.type?.inward) ?? ""),
      key: String(other.key),
    };
    if (of.summary) link.summary = String(of.summary);
    const st = nameOf(of.status);
    if (st) link.status = st;
    const cat = of.status?.statusCategory?.key;
    if (cat) link.statusCategory = String(cat).toLowerCase();
    const t = nameOf(of.issuetype ?? of.issueType);
    if (t) link.issueType = t;
    out.push(link);
  }
  return out;
}

/** Plain text of a Jira field: a string, or Atlassian Document Format (paragraphs and list items become lines). */
export function docText(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v !== "object") return undefined;
  const out: string[] = [];
  const BLOCK = new Set(["paragraph", "heading", "listItem", "codeBlock", "blockquote", "tableRow", "rule"]);
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === "text" && typeof n.text === "string") out.push(n.text);
    else if (n.type === "hardBreak") out.push("\n");
    else if (n.type === "heading") out.push("#".repeat(Math.min(6, Number(n.attrs?.level) || 2)) + " ");
    else if (n.type === "inlineCard" || n.type === "blockCard") { if (n.attrs?.url) out.push(String(n.attrs.url)); }
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (BLOCK.has(n.type)) out.push("\n");
  };
  walk(v);
  const text = out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text || undefined;
}
