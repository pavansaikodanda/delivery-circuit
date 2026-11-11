// Reads .specify/specs/NNN-slug/ folders into Feature objects. No vscode import: unit-tested on fixtures.
// File names follow spec-kit-sf v2 (spec.md, clarification-report-*.md, plan.md + "Architect Sign-Off",
// data-model.md, task_story_NN.md, review report) and the circuit conventions (tests/story_NN.tc.json,
// jira-map.json { refs }).
import { promises as fs } from "fs";
import * as path from "path";
import type { DeepLink, Feature, StageId, Story, TestCaseRef } from "../core/contracts";
import type { FeatureFacts, ParsedFeature } from "./model";

export const SPECS_DIR = ".specify/specs";
export const FEATURE_DIR_RE = /^(\d{3})-[A-Za-z0-9._-]+$/;
const STORY_FILE_RE = /^task_story_(\d{2})\.md$/;
const TC_FILE_RE = /^story_(\d{2})\.tc\.json$/;
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
export const SOURCE_ID_RE = /\b(?:fireflies|upload):[A-Za-z0-9][A-Za-z0-9_-]{2,}/g;

export const STAGE_IDS: StageId[] = ["intake", "clarify", "plan", "signoff", "stories", "tests", "jira", "build", "qa", "release"];

/** Remove HTML comments: spec-kit templates keep guidance (with sample markers) in them. */
export function stripComments(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, "");
}

/** Count open questions in spec.md: [NEEDS CLARIFICATION ...] markers or "Pending" rows of the Clarification Status table. */
export function specOpenQuestions(specMd: string): number {
  const text = stripComments(specMd);
  const markers = (text.match(/\[NEEDS CLARIFICATION\b/gi) ?? []).length;
  let pendingRows = 0;
  const section = sectionText(text, /^##\s+Clarification Status\b/im);
  if (section) {
    for (const line of section.split(/\r?\n/)) {
      if (!/^\s*\|/.test(line) || /^\s*\|\s*-/.test(line)) continue;
      const cells = line.split("|").map((c) => c.trim());
      // | # | Question | Status | Answer |  -> cells[3] is Status
      if (cells.length >= 4 && /pending|open/i.test(cells[3] ?? "")) pendingRows++;
    }
  }
  return Math.max(markers, pendingRows);
}

/** Count OPEN items in a clarification report (the spec-gate rule: a line with the word OPEN). */
export function clarificationOpenItems(md: string): number {
  return stripComments(md).split(/\r?\n/).filter((l) => /\bOPEN\b/.test(l)).length;
}

/** plan.md Architect Sign-Off: "Overall Sign-Off: [x] APPROVED" (same test as the spec-gate workflow). */
export function planSignedOff(planMd: string): boolean {
  return /\[[xX]\][ \t]*APPROVED/.test(stripComments(planMd));
}

/** Text from a heading line to the next heading of the same or higher level. */
export function sectionText(md: string, heading: RegExp): string | undefined {
  const m = heading.exec(md);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  const level = (m[0].match(/^#+/) ?? ["##"])[0].length;
  const rest = md.slice(start);
  const next = rest.search(new RegExp(`^#{1,${level}}\\s`, "m"));
  return next === -1 ? rest : rest.slice(0, next);
}

/** "# Feature Specification: Case Escalation" -> "Case Escalation" */
export function specTitle(specMd: string | undefined, slug: string): string {
  const m = specMd?.match(/^#\s+(?:Feature Specification:\s*)?(.+)$/m);
  const t = m?.[1]?.trim();
  if (t && !t.includes("$FEATURE_NAME")) return t;
  return slug.replace(/^\d{3}-/, "").split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/** "# STORY-01 — Agent escalates a Case" -> "Agent escalates a Case" */
export function storyTitle(md: string, num: string): string {
  const h = md.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (!h) return `Story ${num}`;
  const parts = h.split(/\s+[—–-]\s+/);
  return (parts.length > 1 ? parts.slice(1).join(" - ") : h).trim();
}

/** "**Jira**: ABC-12" in a story file, when it is a real key. */
export function storyJiraKey(md: string): string | undefined {
  const k = md.match(/\*\*Jira\*\*:\s*\[?([A-Z][A-Z0-9]+-\d+)\]?/)?.[1];
  return k && JIRA_KEY_RE.test(k) ? k : undefined;
}

export function parseJiraMap(json: string | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const refs = JSON.parse(json)?.refs;
    if (!refs || typeof refs !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(refs)) if (typeof v === "string" && JIRA_KEY_RE.test(v)) out[k] = v;
    return out;
  } catch { return {}; }
}

export function parseTcIndex(json: string, refs: Record<string, string>): TestCaseRef[] {
  try {
    const cases = JSON.parse(json)?.cases;
    if (!Array.isArray(cases)) return [];
    return cases
      .filter((c: any) => c && typeof c.id === "string")
      .map((c: any) => {
        const level: TestCaseRef["level"] = c.level === "ui" || c.level === "unit" || c.level === "manual" ? c.level : "manual";
        const tc: TestCaseRef = { id: c.id, level };
        if (typeof c.ac === "string") tc.ac = c.ac;
        if (refs[c.id]) tc.jiraKey = refs[c.id];
        return tc;
      });
  } catch { return []; }
}

/** "Overall Feature Score: 488/555" from a /speckit-sf-score report. */
export function parseScore(md: string): number | undefined {
  const m = stripComments(md).match(/Overall Feature Score\**:?\**\s*(\d+)\s*\/\s*555/i);
  return m ? Number(m[1]) : undefined;
}

/** Source ids cited by a spec ("source: fireflies:<id>" / "upload:<id>"). */
export function citedSources(...texts: (string | undefined)[]): string[] {
  const set = new Set<string>();
  for (const t of texts) for (const m of stripComments(t ?? "").match(SOURCE_ID_RE) ?? []) set.add(m);
  return [...set].sort();
}

async function readText(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, "utf8"); } catch { return undefined; }
}
async function listDir(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); } catch { return []; }
}

const rel = (...p: string[]) => path.posix.join(...p);

function emptyStages(): Feature["stages"] {
  return Object.fromEntries(STAGE_IDS.map((s) => [s, "todo"])) as Feature["stages"];
}

/** Parse one feature folder (dirName like "001-case-escalation"). Stages and gates are filled by gates.ts. */
export async function parseFeature(root: string, dirName: string): Promise<ParsedFeature | undefined> {
  const m = FEATURE_DIR_RE.exec(dirName);
  if (!m) return undefined;
  const relDir = rel(SPECS_DIR, dirName);
  const abs = path.join(root, SPECS_DIR, dirName);
  const files = await listDir(abs);
  const spec = await readText(path.join(abs, "spec.md"));
  const plan = files.includes("plan.md") ? await readText(path.join(abs, "plan.md")) : undefined;
  const refs = parseJiraMap(await readText(path.join(abs, "jira-map.json")));

  const clarificationFiles = files.filter((f) => /clarif/i.test(f) && f.endsWith(".md")).sort();
  let clarOpen = 0;
  for (const f of clarificationFiles) clarOpen += clarificationOpenItems((await readText(path.join(abs, f))) ?? "");
  const openQuestions = Math.max(spec ? specOpenQuestions(spec) : 0, clarOpen);

  const storyNums = files.map((f) => STORY_FILE_RE.exec(f)?.[1]).filter((x): x is string => !!x).sort();
  const testFiles = await listDir(path.join(abs, "tests"));
  const tcStories = testFiles.map((f) => TC_FILE_RE.exec(f)?.[1]).filter((x): x is string => !!x).sort();

  const stories: Story[] = [];
  for (const num of storyNums) {
    const md = (await readText(path.join(abs, `task_story_${num}.md`))) ?? "";
    const tcJson = tcStories.includes(num) ? await readText(path.join(abs, "tests", `story_${num}.tc.json`)) : undefined;
    const s: Story = {
      num,
      title: storyTitle(md, num),
      file: rel(relDir, `task_story_${num}.md`),
      testCases: tcJson ? parseTcIndex(tcJson, refs) : [],
    };
    const key = refs[num] ?? storyJiraKey(md);
    if (key) s.jiraKey = key;
    stories.push(s);
  }

  let score: number | undefined;
  for (const f of files.filter((f) => /score/i.test(f) && f.endsWith(".md"))) {
    score = parseScore((await readText(path.join(abs, f))) ?? "") ?? score;
  }

  const clarTexts: string[] = [];
  for (const f of clarificationFiles) clarTexts.push((await readText(path.join(abs, f))) ?? "");

  const links: DeepLink[] = [];
  if (spec !== undefined) links.push({ kind: "file", label: "spec.md", target: rel(relDir, "spec.md") });
  for (const f of clarificationFiles) links.push({ kind: "file", label: f, target: rel(relDir, f) });
  if (plan !== undefined) links.push({ kind: "file", label: "plan.md", target: rel(relDir, "plan.md") });
  if (files.includes("data-model.md")) links.push({ kind: "file", label: "data-model.md", target: rel(relDir, "data-model.md") });

  const feature: Feature = {
    id: m[1],
    slug: dirName,
    title: specTitle(spec, dirName),
    dir: relDir,
    stages: emptyStages(),
    gates: {},
    openQuestions,
    signedOff: plan !== undefined && planSignedOff(plan),
    stories,
    sources: citedSources(spec, ...clarTexts),
    links,
  };
  if (score !== undefined) feature.score = score;
  const facts: FeatureFacts = {
    hasSpec: spec !== undefined,
    hasClarification: clarificationFiles.length > 0,
    hasPlan: plan !== undefined,
    hasDataModel: files.includes("data-model.md"),
    hasReview: files.some((f) => /^review.*\.md$/i.test(f) || /-review\.md$/i.test(f)),
    tcStories,
    jiraRefs: refs,
    clarificationFiles: clarificationFiles.map((f) => rel(relDir, f)),
  };
  return { feature, facts };
}

/** All feature folders under .specify/specs, sorted by id. */
export async function loadFeatures(root: string): Promise<ParsedFeature[]> {
  const dirs = (await listDir(path.join(root, SPECS_DIR))).filter((d) => FEATURE_DIR_RE.test(d)).sort();
  const out: ParsedFeature[] = [];
  for (const d of dirs) {
    const p = await parseFeature(root, d);
    if (p) out.push(p);
  }
  return out;
}

/** UI suite path of a story by convention. */
export function suitePath(featureSlug: string, storyNum: string): string {
  return `test-cases/${featureSlug}-story-${storyNum}.sf-tests.yaml`;
}
