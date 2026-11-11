// Architect Sign-Off section of a Spec Kit plan.md (spec-kit-sf plan template). No vscode import.
//   ## Architect Sign-Off            (any heading level 2 containing "Architect Sign-Off", emoji allowed)
//   ### Data Model Review
//   - [ ] Object relationships are correct ...
//   - **Reviewed by**: [Architect Name]
//   **Overall Sign-Off**: [ ] APPROVED / [ ] CHANGES REQUIRED
//   **Date**: [Date]

export interface SignOffItem {
  /** 0-based line index in plan.md */
  line: number;
  /** subsection, e.g. "Data Model Review" */
  section: string;
  text: string;
  checked: boolean;
  /** the Overall Sign-Off APPROVED box (the G1 evidence spec-gate looks for) */
  overall: boolean;
}

function sectionBounds(lines: string[]): { start: number; end: number } | undefined {
  const start = lines.findIndex((l) => /^##\s+.*Architect Sign-Off/i.test(l));
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
  return { start, end };
}

export function signOffItems(plan: string): SignOffItem[] {
  const lines = plan.split(/\r?\n/);
  const b = sectionBounds(lines);
  if (!b) return [];
  const out: SignOffItem[] = [];
  let section = "";
  for (let i = b.start + 1; i < b.end; i++) {
    const l = lines[i];
    const h = l.match(/^###\s+(.*)$/);
    if (h) { section = h[1].trim(); continue; }
    const overall = l.match(/Overall Sign-Off\**:?\**\s*\[( |x|X)\]\s*APPROVED/i);
    if (overall) { out.push({ line: i, section: "Overall", text: "Overall Sign-Off: APPROVED", checked: overall[1].toLowerCase() === "x", overall: true }); continue; }
    const m = l.match(/^\s*[-*]\s*\[( |x|X)\]\s*(.+)$/);
    if (m) out.push({ line: i, section, text: m[2].trim(), checked: m[1].toLowerCase() === "x", overall: false });
  }
  return out;
}

export function isSignedOff(plan: string): boolean {
  return /\[x\]\s*APPROVED/i.test(plan);
}

/**
 * Tick the chosen lines, fill "Reviewed by" placeholders with the person's name and the Date placeholder with today.
 * The Overall APPROVED box must be among the chosen lines; CHANGES REQUIRED is never ticked.
 */
export function applySignOff(plan: string, chosenLines: number[], name: string, dateIso: string): string {
  const eol = plan.includes("\r\n") ? "\r\n" : "\n";
  const lines = plan.split(/\r?\n/);
  const b = sectionBounds(lines);
  if (!b) throw new Error("plan.md has no Architect Sign-Off section");
  const items = signOffItems(plan);
  const chosen = new Set(chosenLines);
  const overall = items.find((i) => i.overall);
  if (!overall) throw new Error("plan.md has no 'Overall Sign-Off: [ ] APPROVED' line");
  if (!chosen.has(overall.line)) throw new Error("The Overall Sign-Off APPROVED box must be ticked");
  for (const it of items) {
    if (!chosen.has(it.line) || it.checked) continue;
    lines[it.line] = it.overall
      ? lines[it.line].replace(/\[ \](\s*APPROVED)/i, "[x]$1")
      : lines[it.line].replace(/\[ \]/, "[x]");
  }
  const date = dateIso.slice(0, 10);
  for (let i = b.start + 1; i < b.end; i++) {
    lines[i] = lines[i]
      .replace(/(\*\*Reviewed by\*\*:\s*)\[Architect Name\]/i, `$1${name}`)
      .replace(/(\*\*Date\*\*:\s*)\[Date\]/i, `$1${date}`);
  }
  return lines.join(eol);
}
