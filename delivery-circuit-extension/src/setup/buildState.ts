// build-state.md: the bootstrap's resumable state (same table the circuit-bootstrap skill writes). No vscode import.
//   | Phase | Status | Verified | Evidence | Notes |
//   |---|---|---|---|---|
//   | B0 Preflight | DONE | 2026-11-10 | versions below | |
// Everything outside the table is kept verbatim. Rows that ended up outside the table (for example several rows
// glued onto one line) are folded back into the table on the next write.

export interface PhaseRow {
  /** "B0" */
  id: string;
  /** "B0 Preflight" (the first cell as written) */
  phase: string;
  status: string;
  verified: string;
  evidence: string;
  notes: string;
}

export interface BuildState {
  /** lines before the header row */
  before: string[];
  rows: PhaseRow[];
  /** lines after the table */
  after: string[];
  /** true when stray rows were found outside the table and merged */
  repaired: boolean;
  /** the file had no table: a new one is written on update */
  hadTable: boolean;
}

export type StatusKind = "done" | "partial" | "blocked" | "todo";

export function statusKind(status: string): StatusKind {
  const s = status.trim().toUpperCase();
  if (/^(DONE|COMPLETE|PASS)/.test(s)) return "done";
  if (/^(BLOCKED|FAIL)/.test(s)) return "blocked";
  if (/^(PARTIAL|IN PROGRESS|STARTED|WIP)/.test(s)) return "partial";
  return "todo";
}

const HEADER = /^\|\s*Phase\s*\|\s*Status\s*\|\s*Verified\s*\|\s*Evidence\s*\|\s*Notes\s*\|\s*$/i;
const SEPARATOR = /^\|(\s*:?-{3,}:?\s*\|)+\s*$/;

/** Split a markdown table row into cells, honouring "\|" escapes. */
export function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\" && t[i + 1] === "|") { cur += "|"; i++; continue; }
    if (t[i] === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

const escCell = (s: string) => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();

function rowFromCells(c: string[]): PhaseRow | undefined {
  const m = (c[0] ?? "").match(/^(B\d{1,2})\b/);
  if (!m) return undefined;
  return { id: m[1], phase: c[0], status: c[1] ?? "", verified: c[2] ?? "", evidence: c[3] ?? "", notes: c[4] ?? "" };
}

/** Rows written outside the table, possibly several glued together ("| B4 ... | notes || B3 ... |"). */
function strayRows(line: string): { rows: PhaseRow[]; rest: string } {
  const re = /\|\s*(B\d{1,2}\b[^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/g;
  const rows: PhaseRow[] = [];
  let rest = line;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const r = rowFromCells([m[1], m[2], m[3], m[4], m[5]].map((x) => x.trim()));
    if (r) { rows.push(r); rest = rest.replace(m[0], ""); }
  }
  return { rows, rest: rest.trim() };
}

export function parseBuildState(text: string): BuildState {
  const lines = text.split(/\r?\n/);
  const h = lines.findIndex((l) => HEADER.test(l.trim()));
  if (h < 0) return { before: lines, rows: [], after: [], repaired: false, hadTable: false };
  let i = h + 1;
  if (i < lines.length && SEPARATOR.test(lines[i].trim())) i++;
  const rows: PhaseRow[] = [];
  for (; i < lines.length && lines[i].trim().startsWith("|"); i++) {
    const r = rowFromCells(splitRow(lines[i]));
    if (r) rows.push(r);
  }
  const before: string[] = [];
  let repaired = false;
  const strays: PhaseRow[] = [];
  for (const l of lines.slice(0, h)) {
    const s = /\|\s*B\d{1,2}\b/.test(l) ? strayRows(l) : { rows: [], rest: l };
    if (s.rows.length) {
      repaired = true; strays.push(...s.rows);
      // "...|# Build state": keep whatever was glued after the rows on its own line.
      if (s.rest) before.push(s.rest);
    } else before.push(l);
  }
  for (const s of strays) {
    const t = rows.find((r) => r.id === s.id);
    if (!t) rows.push(s);
    else if (statusKind(t.status) === "todo" && statusKind(s.status) !== "todo") Object.assign(t, { status: s.status, verified: s.verified, evidence: s.evidence, notes: s.notes });
  }
  rows.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return { before, rows, after: lines.slice(i), repaired, hadTable: true };
}

export function serializeBuildState(s: BuildState, eol = "\n"): string {
  const table = [
    "| Phase | Status | Verified | Evidence | Notes |",
    "|---|---|---|---|---|",
    ...s.rows.map((r) => "|" + [r.phase, r.status, r.verified, r.evidence, r.notes].map((c) => { const e = escCell(c); return e ? ` ${e} ` : " "; }).join("|") + "|"),
  ];
  const before = s.hadTable ? s.before : [...s.before, ...(s.before.length && s.before[s.before.length - 1].trim() ? [""] : [])];
  return [...before, ...table, ...s.after].join(eol);
}

/** Set fields of one phase (adds the row if missing, keeping B-order). */
export function updatePhase(s: BuildState, id: string, patch: Partial<Omit<PhaseRow, "id">>, name?: string): BuildState {
  const rows = s.rows.map((r) => ({ ...r }));
  let r = rows.find((x) => x.id === id);
  if (!r) {
    r = { id, phase: name ? `${id} ${name}` : id, status: "TODO", verified: "", evidence: "", notes: "" };
    rows.push(r);
    rows.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  }
  Object.assign(r, patch);
  return { ...s, rows, hadTable: true };
}

/** Replace (or add) the dated line under "## Tool versions (B0)". */
export function setToolVersions(s: BuildState, dateIso: string, versions: string): BuildState {
  const line = `${dateIso.slice(0, 10)}: ${versions}`;
  const after = s.after.slice();
  const h = after.findIndex((l) => /^##\s+Tool versions/i.test(l));
  if (h < 0) return { ...s, after: [...after, "", "## Tool versions (B0)", line] };
  let j = h + 1;
  while (j < after.length && !after[j].trim()) j++;
  if (j < after.length && /^\d{4}-\d{2}-\d{2}:/.test(after[j])) after[j] = line; else after.splice(h + 1, 0, line);
  return { ...s, after };
}

export function eolOf(text: string): string { return text.includes("\r\n") ? "\r\n" : "\n"; }
