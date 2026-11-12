// Sources page logic without VS Code: validation, the Fireflies-through-Claude listing (prompt, schema, tool filter,
// result parsing), locating and reading Wispr Flow's local history, and the page state. Transcript text never goes
// into the page state except an on-demand excerpt; the repo keeps only .circuit/sources.json (through the project
// module). No vscode import.
import * as path from "path";
import type { ConnectionState, DeepLink, Identity, SourceOrigin, SourceRef } from "../core/contracts";
import { canAct } from "../core/contracts";
import { parseColumns, type SqliteReader, type SqlValue } from "./sqlite";

export type { SourceOrigin };
export const ORIGINS: SourceOrigin[] = ["paste", "file", "fireflies", "fireflies-export", "wispr-flow", "watch-folder"];
export const ORIGIN_LABEL: Record<SourceOrigin, string> = {
  paste: "Pasted or dictated", file: "File", fireflies: "Fireflies", "fireflies-export": "Fireflies export", "wispr-flow": "Wispr Flow", "watch-folder": "Watch folder",
};
export const isOrigin = (x: unknown): x is SourceOrigin => typeof x === "string" && (ORIGINS as string[]).includes(x);

export const ATTACH_EXTENSIONS = ["txt", "md", "docx", "vtt", "srt", "pdf"];
/** Types the project module extracts itself (addUpload); others are extracted here first. */
export const PROJECT_EXTRACTS = ["txt", "md", "docx", "vtt", "srt"];
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_CHARS = 2_000_000;
export const MEETING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,}$/;
export const SOURCE_ID_RE = /^(fireflies|upload):[A-Za-z0-9][A-Za-z0-9_-]{2,}$/;

export function extOf(name: string): string { return path.extname(name).slice(1).toLowerCase(); }

export function validateAttach(name: string, size: number): string | undefined {
  const ext = extOf(name);
  if (!ATTACH_EXTENSIONS.includes(ext)) return `${name}: use ${ATTACH_EXTENSIONS.map((e) => "." + e).join(", ")}.`;
  if (size <= 0) return `${name} is empty.`;
  if (size > MAX_FILE_BYTES) return `${name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`;
  return undefined;
}

export function validateText(text: string): string | undefined {
  const t = text.trim();
  if (!t) return "There is no text to add.";
  if (t.length > MAX_TEXT_CHARS) return `The text is longer than ${MAX_TEXT_CHARS.toLocaleString("en-US")} characters.`;
  return undefined;
}

/** One line, no control characters, at most 120 characters; the fallback when nothing is left. */
export function cleanTitle(raw: unknown, fallback: string): string {
  const t = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return t || fallback;
}

export function defaultTitle(origin: SourceOrigin, at: Date = new Date()): string {
  const d = at.toISOString().slice(0, 16).replace("T", " ");
  return origin === "wispr-flow" ? `Wispr Flow notes ${d}` : origin === "paste" ? `Notes ${d}` : `Source ${d}`;
}

export function titleFromFile(name: string): string { return cleanTitle(path.basename(name, path.extname(name)).replace(/[_]+/g, " "), "Transcript"); }

/** A watch folder must be outside the repo: transcripts never enter git. */
export function insideRepo(folder: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === "win32" ? path.win32 : path.posix;
  const norm = (x: string) => { const r = p.resolve(x); return platform === "win32" ? r.toLowerCase() : r; };
  const f = norm(folder), r = norm(root);
  return f === r || f.startsWith(r.endsWith(p.sep) ? r : r + p.sep);
}

/** The environment for an Agent SDK call: the person's logged-in Claude only, never an API key from the environment. */
export function subscriptionEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: "delivery-circuit-sources/0.1.0" };
  delete e.ANTHROPIC_API_KEY; delete e.ANTHROPIC_AUTH_TOKEN; delete e.CLAUDE_CODE_OAUTH_TOKEN;
  delete e.CLAUDE_CODE_USE_BEDROCK; delete e.CLAUDE_CODE_USE_VERTEX;
  return e;
}

// ---------- Fireflies through the person's Fireflies MCP ----------
export interface FirefliesMeeting { id: string; title: string; date: string; durationMin?: number; organizer?: string; participants?: number }

export const FIREFLIES_SCHEMA = {
  type: "object",
  properties: {
    meetings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" }, title: { type: "string" }, date: { type: "string", description: "ISO 8601 date-time of the meeting" },
          durationMinutes: { type: "number" }, organizer: { type: "string" }, participants: { type: "number" },
        },
        required: ["id", "title", "date"],
      },
    },
    error: { type: "string", description: "Set only when the Fireflies tools are not available or failed" },
  },
  required: ["meetings"],
} as const;

export function firefliesPrompt(limit: number): string {
  const n = Math.max(1, Math.min(50, Math.floor(limit)));
  return `List my ${n} most recent Fireflies meetings using the Fireflies MCP tool fireflies_get_transcripts (metadata only: do not fetch transcripts or summaries). `
    + "Return each meeting's Fireflies transcript id, title, date (ISO 8601), duration in minutes, organizer email and number of participants. "
    + "Do not invent meetings. If no Fireflies tool is available or it fails, return an empty list and put the reason in error.";
}

/** Only Fireflies read tools that list meetings (any server name, e.g. a claude.ai connector), plus the structured result. */
export function isAllowedFirefliesTool(name: string): boolean {
  return name === "StructuredOutput" || /^mcp__[^_].*__fireflies_(get_transcripts|search|get_user)$/i.test(name);
}

export function parseFirefliesMeetings(raw: unknown): { meetings: FirefliesMeeting[]; error?: string } {
  const o = raw as any;
  const list = Array.isArray(o?.meetings) ? o.meetings : [];
  const seen = new Set<string>();
  const meetings: FirefliesMeeting[] = [];
  for (const m of list) {
    const id = typeof m?.id === "string" ? m.id.trim() : "";
    if (!MEETING_ID_RE.test(id) || seen.has(id)) continue;
    const date = toIso(m.date);
    if (!date) continue;
    seen.add(id);
    const dur = Number(m.durationMinutes);
    const ppl = Number(m.participants);
    meetings.push({
      id, title: cleanTitle(m.title, "Untitled meeting"), date,
      ...(Number.isFinite(dur) && dur > 0 ? { durationMin: Math.round(dur) } : {}),
      ...(typeof m.organizer === "string" && m.organizer.trim() ? { organizer: m.organizer.trim().slice(0, 120) } : {}),
      ...(Number.isFinite(ppl) && ppl > 0 ? { participants: Math.round(ppl) } : {}),
    });
  }
  meetings.sort((a, b) => b.date.localeCompare(a.date));
  const error = typeof o?.error === "string" && o.error.trim() ? o.error.trim().slice(0, 300) : undefined;
  return { meetings, ...(error ? { error } : {}) };
}

/** ISO string from an ISO date, epoch seconds or epoch milliseconds; undefined when not a date. */
export function toIso(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && v.trim()) {
    if (/^\d+(\.\d+)?$/.test(v.trim())) return toIso(Number(v));
    const t = Date.parse(v);
    return isNaN(t) ? undefined : new Date(t).toISOString();
  }
  return undefined;
}

export function firefliesUrl(id: string): string { return `https://app.fireflies.ai/view/${encodeURIComponent(id)}`; }

// ---------- Wispr Flow local history (read-only) ----------
export interface WisprPaths { home: string; appData?: string; localAppData?: string }

/** Where Wispr Flow keeps its history database (flow.sqlite). Wispr Flow has no Linux app. Locations come from the
 *  app's data folder conventions and community tools; Wispr Flow does not document them. */
export function wisprDbCandidates(platform: NodeJS.Platform, p: WisprPaths): string[] {
  if (platform === "darwin") return [path.posix.join(p.home, "Library", "Application Support", "Wispr Flow", "flow.sqlite")];
  if (platform === "win32") {
    const roaming = p.appData ?? path.win32.join(p.home, "AppData", "Roaming");
    const local = p.localAppData ?? path.win32.join(p.home, "AppData", "Local");
    return [path.win32.join(roaming, "Wispr Flow", "flow.sqlite"), path.win32.join(local, "Wispr Flow", "flow.sqlite"),
      path.win32.join(roaming, "wispr-flow", "flow.sqlite")];
  }
  return [];
}

export interface WisprColumns { table: string; text: string; time?: string; app?: string }
export interface WisprEntry { key: string; text: string; at?: string; app?: string }

const TEXT_COLS = ["editedText", "formattedText", "text", "transcript", "asrText"];
const TIME_COLS = ["timestamp", "createdAt", "created_at", "date", "time"];
const APP_COLS = ["app", "appName", "application"];

/** Pick the history table and its text / time / app columns from whatever schema the installed version has. */
export function pickWisprColumns(tables: { name: string; columns: string[] }[]): WisprColumns | undefined {
  const lc = (xs: string[]) => new Map(xs.map((x) => [x.toLowerCase(), x]));
  const ranked = [...tables].sort((a, b) => Number(/history/i.test(b.name)) - Number(/history/i.test(a.name)));
  for (const t of ranked) {
    const m = lc(t.columns);
    const text = TEXT_COLS.map((c) => m.get(c.toLowerCase())).find(Boolean);
    if (!text) continue;
    return { table: t.name, text, time: TIME_COLS.map((c) => m.get(c.toLowerCase())).find(Boolean), app: APP_COLS.map((c) => m.get(c.toLowerCase())).find(Boolean) };
  }
  return undefined;
}

/** Newest first; prefers the edited / formatted text over the raw recognition; skips empty rows. */
export function wisprEntries(rows: Record<string, SqlValue>[], cols: WisprColumns, limit = 200): WisprEntry[] {
  const pickText = (r: Record<string, SqlValue>) => {
    for (const c of [cols.text, ...TEXT_COLS]) { const v = r[c]; if (typeof v === "string" && v.trim()) return v.trim(); }
    return "";
  };
  const out: WisprEntry[] = [];
  rows.forEach((r, i) => {
    const text = pickText(r);
    if (!text) return;
    const at = cols.time ? toIso(r[cols.time]) : undefined;
    const app = cols.app && typeof r[cols.app] === "string" ? String(r[cols.app]).slice(0, 60) : undefined;
    out.push({ key: `${i}`, text: text.slice(0, MAX_TEXT_CHARS), ...(at ? { at } : {}), ...(app ? { app } : {}) });
  });
  return out.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || Number(b.key) - Number(a.key)).slice(0, limit);
}

/** Reads the history through the read-only reader. */
export function readWisprHistory(reader: SqliteReader, limit = 200): { entries: WisprEntry[]; columns?: WisprColumns } {
  const tables = reader.tables();
  const withCols = tables.map((t) => ({ name: t.name, columns: columnsOf(t.sql) }));
  const cols = pickWisprColumns(withCols);
  if (!cols) return { entries: [] };
  const table = tables.find((t) => t.name === cols.table)!;
  return { entries: wisprEntries(reader.rows(table, { limit: Math.max(limit * 3, 600), last: true }), cols, limit), columns: cols };
}
function columnsOf(sql: string): string[] { return parseColumns(sql).map((c) => c.name); }

/** Several dictations as one source: oldest first, each with its time and app. */
export function combineWispr(entries: WisprEntry[]): string {
  return [...entries].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "")).map((e) => {
    const head = [e.at ? e.at.slice(0, 16).replace("T", " ") : "", e.app ?? ""].filter(Boolean).join(" · ");
    return head ? `[${head}]\n${e.text}` : e.text;
  }).join("\n\n");
}

export function wisprPreview(e: WisprEntry): { label: string; description: string } {
  const one = e.text.replace(/\s+/g, " ");
  return { label: one.length > 80 ? one.slice(0, 79) + "…" : one, description: [e.at ? e.at.slice(0, 16).replace("T", " ") : "", e.app ?? ""].filter(Boolean).join(" · ") };
}

// ---------- page state ----------
export interface SourceRow {
  id: string; kind: SourceRef["kind"]; origin?: SourceOrigin; originLabel: string; title: string; date: string; usedBy: string[];
  links: DeepLink[];
}
export interface MeetingRow extends FirefliesMeeting { indexed: boolean; link: DeepLink }

export interface SourcesState {
  identity: Identity | null;
  canAct: boolean;
  /** Why the page is read-only (not acting as Architect). */
  reason?: string;
  sources: SourceRow[];
  fireflies: {
    mcp: { state: ConnectionState; detail?: string };
    status: "idle" | "loading" | "ready" | "error";
    meetings: MeetingRow[];
    error?: string;
    loadedAt?: string;
  };
  wispr: { supported: boolean; found?: string; candidates: string[] };
  watch: { folder?: string; active: boolean; last?: { title: string; at: string }; error?: string };
  /** Operations in flight: "paste", "attach", "fireflies", "ff:<id>", "wispr", "watch". */
  busy: string[];
  extensions: string[];
  sourcesError?: string;
}

export function buildSourcesState(a: {
  identity: Identity | null; sources: SourceRef[]; origins: Record<string, SourceOrigin>; sourcesError?: string;
  fireflies: { mcpState: ConnectionState; mcpDetail?: string; status: SourcesState["fireflies"]["status"]; meetings: FirefliesMeeting[]; error?: string; loadedAt?: string };
  wispr: { platform: NodeJS.Platform; candidates: string[]; found?: string };
  watch: SourcesState["watch"]; busy: Iterable<string>;
}): SourcesState {
  const id = a.identity;
  const act = !!id && canAct(id, "architect");
  const reason = !id ? "Sign in to GitHub to load your persona." : !id.personas.includes("architect")
    ? "Sources are the Architect's: transcripts are shown and added only by the architects team."
    : !act ? "Switch to acting as Architect to add sources." : undefined;
  const indexed = new Set(a.sources.map((s) => s.id));
  const rows: SourceRow[] = [...a.sources].sort((x, y) => (y.date ?? "").localeCompare(x.date ?? "")).map((s) => {
    const origin = a.origins[s.id] ?? (s.kind === "fireflies" ? "fireflies" : undefined);
    const ffId = s.id.startsWith("fireflies:") ? s.id.slice("fireflies:".length) : undefined;
    return {
      id: s.id, kind: s.kind, origin, originLabel: origin ? ORIGIN_LABEL[origin] : s.kind === "upload" ? "Upload" : "Fireflies",
      title: s.title, date: s.date, usedBy: s.usedBy ?? [],
      links: ffId ? [{ kind: "fireflies", label: "Open in Fireflies", target: firefliesUrl(ffId) }] : [],
    };
  });
  return {
    identity: id, canAct: act, reason,
    sources: act || id?.personas.includes("architect") ? rows : [],
    fireflies: {
      mcp: { state: a.fireflies.mcpState, detail: a.fireflies.mcpDetail }, status: a.fireflies.status, error: a.fireflies.error, loadedAt: a.fireflies.loadedAt,
      meetings: a.fireflies.meetings.map((m) => ({ ...m, indexed: indexed.has(`fireflies:${m.id}`), link: { kind: "fireflies", label: "Open in Fireflies", target: firefliesUrl(m.id) } })),
    },
    wispr: { supported: a.wispr.candidates.length > 0, candidates: a.wispr.candidates, ...(a.wispr.found ? { found: a.wispr.found } : {}) },
    watch: a.watch, busy: [...a.busy], extensions: ATTACH_EXTENSIONS, ...(a.sourcesError ? { sourcesError: a.sourcesError } : {}),
  };
}
