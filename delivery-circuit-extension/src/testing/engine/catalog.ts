// Suite catalogue for the Testing page: test-cases/*.sf-tests.yaml with their last status (from status.json) and the
// Jira keys the circuit's jira-sync wrote (.specify/specs/NNN-slug/jira-map.json). No VS Code here.
import * as fs from "fs";
import * as path from "path";
import { loadSuite } from "./suite";
import { readAll, type ModeStatus, type SuiteStatus } from "./status";
import { caseHash } from "./hash";
import { resolveTarget } from "./target";
import { listRuns } from "./runs";
import type { Status, TestCase, TestSuite } from "./types";

export const SUITE_DIR = "test-cases";
export const SUITE_RE = /\.sf-tests\.ya?ml$/i;

/** Workspace-relative suite key with forward slashes (the key status.json uses). */
export const suiteKey = (workspaceDir: string, file: string) => path.relative(workspaceDir, path.resolve(workspaceDir, file)).replace(/\\/g, "/");

/** Absolute paths of test-cases/*.sf-tests.yaml, sorted by name. */
export function listSuiteFiles(workspaceDir: string): string[] {
  const dir = path.join(workspaceDir, SUITE_DIR);
  try {
    return fs.readdirSync(dir).filter((f) => SUITE_RE.test(f)).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** test-cases/001-case-escalation-story-02.sf-tests.yaml -> { feature: "001-case-escalation", featureId: "001", story: "02" } */
export function storyRefOf(file: string): { feature: string; featureId: string; story: string } | undefined {
  const m = /^((\d{3})-[a-z0-9-]+?)-story-(\d{2})\.sf-tests\.ya?ml$/i.exec(path.basename(file));
  return m ? { feature: m[1], featureId: m[2], story: m[3] } : undefined;
}

/** refs of .specify/specs/<feature>/jira-map.json, or {} when the feature has not been synced to Jira. */
export function jiraRefs(workspaceDir: string, feature: string): Record<string, string> {
  if (!/^[\w-]+$/.test(feature)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workspaceDir, ".specify", "specs", feature, "jira-map.json"), "utf8"));
    const refs = raw?.refs && typeof raw.refs === "object" ? raw.refs : {};
    return Object.fromEntries(Object.entries(refs).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

export interface CaseRow {
  id: string;
  title: string;
  section: string;
  mode?: TestCase["mode"];
  target: "salesforce" | "web";
  steps: number;
  manual?: ModeStatus & { stale: boolean };
  automation?: ModeStatus & { stale: boolean };
  jiraKey?: string;
}

export interface SuiteRecord {
  /** absolute path */
  file: string;
  /** workspace-relative, forward slashes */
  key: string;
  name: string;
  context?: string;
  cases: CaseRow[];
  /** latest verdict per case (newest of manual/automation) */
  last: Partial<Record<Status, number>>;
  /** cases with no verdict yet */
  notRun: number;
  storyKey?: string;
  feature?: string;
  /** load/validation error (suite listed but not runnable) */
  error?: string;
  /** the suite as loaded (absent when it failed to load) */
  suite?: TestSuite;
}

export const sectionOf = (c: TestCase) => c.section?.trim() || (c.id.includes("-") ? c.id.split("-")[0] : "GENERAL");

/** Latest verdict of a case across modes (by time). */
export function latestOf(entry: { manual?: ModeStatus; automation?: ModeStatus } | undefined): ModeStatus | undefined {
  const all = [entry?.manual, entry?.automation].filter(Boolean) as ModeStatus[];
  return all.sort((a, b) => b.at - a.at)[0];
}

export function lastCounts(cases: TestCase[], st: SuiteStatus): { last: Partial<Record<Status, number>>; notRun: number } {
  const last: Partial<Record<Status, number>> = {};
  let notRun = 0;
  for (const tc of cases) {
    const s = latestOf(st[tc.id]);
    if (!s) notRun++;
    else last[s.status] = (last[s.status] ?? 0) + 1;
  }
  return { last, notRun };
}

/**
 * Latest verdicts per suite NAME from the run folders themselves. Runs started outside the page (the SF AI Tester
 * CLI, CI) write results.json but not status.json; these fill the gaps so their verdicts still show.
 */
export function statusFromRuns(workspaceDir: string, limit = 100): Record<string, SuiteStatus> {
  const out: Record<string, SuiteStatus> = {};
  // listRuns is newest first: keep the first verdict seen per case and mode.
  for (const run of listRuns(workspaceDir, limit)) {
    const suite = (out[run.suite] ??= {});
    const at = run.startedAt ? Date.parse(run.startedAt) : 0;
    for (const r of run.results) {
      const entry = (suite[r.id] ??= {});
      if (r.mode !== "manual" && r.mode !== "automation") continue;
      if (entry[r.mode]) continue;
      entry[r.mode] = {
        status: r.status, summary: r.summary, model: r.model, at, durationMs: r.durationMs, runDir: run.runDir,
        specFile: r.specFile, defects: r.defects.length, caseHash: r.caseHash,
      };
    }
  }
  return out;
}

/** status.json entries, falling back per case and mode to the newest run of a suite with the same name. */
export function mergeStatus(fromFile: SuiteStatus, fromRuns: SuiteStatus | undefined): SuiteStatus {
  if (!fromRuns) return fromFile;
  const out: SuiteStatus = {};
  for (const id of new Set([...Object.keys(fromRuns), ...Object.keys(fromFile)])) {
    const a = fromFile[id] ?? {}, b = fromRuns[id] ?? {};
    const pick = (x?: ModeStatus, y?: ModeStatus) => (x && y ? (y.at > x.at ? y : x) : x ?? y);
    out[id] = { manual: pick(a.manual, b.manual), automation: pick(a.automation, b.automation) };
  }
  return out;
}

/** One suite file with status and Jira links; never throws (a broken file is returned with `error`). */
export function suiteRecord(
  workspaceDir: string,
  file: string,
  statusAll: Record<string, SuiteStatus> = readAll(workspaceDir),
  runStatus: Record<string, SuiteStatus> = statusFromRuns(workspaceDir),
): SuiteRecord {
  const key = suiteKey(workspaceDir, file);
  const ref = storyRefOf(file);
  const refs = ref ? jiraRefs(workspaceDir, ref.feature) : {};
  const base = { file, key, storyKey: ref ? refs[ref.story] : undefined, feature: ref?.feature };
  let suite: TestSuite;
  try {
    suite = loadSuite(file, { allowEmpty: true });
  } catch (e) {
    return { ...base, name: path.basename(file).replace(SUITE_RE, ""), cases: [], last: {}, notRun: 0, error: (e as Error).message.replace(file, key) };
  }
  const st = mergeStatus(statusAll[key] ?? {}, runStatus[suite.name]);
  const cases: CaseRow[] = suite.cases.map((tc) => {
    const h = caseHash(tc);
    const mark = (s?: ModeStatus) => (s ? { ...s, stale: !!s.caseHash && s.caseHash !== h } : undefined);
    return {
      id: tc.id,
      title: tc.title,
      section: sectionOf(tc),
      mode: tc.mode,
      target: resolveTarget(tc, suite),
      steps: tc.steps.length,
      manual: mark(st[tc.id]?.manual),
      automation: mark(st[tc.id]?.automation),
      jiraKey: refs[tc.id],
    };
  });
  return { ...base, name: suite.name, context: suite.context, cases, ...lastCounts(suite.cases, st), suite };
}

export function catalog(workspaceDir: string): SuiteRecord[] {
  const all = readAll(workspaceDir);
  const runs = statusFromRuns(workspaceDir);
  return listSuiteFiles(workspaceDir).map((f) => suiteRecord(workspaceDir, f, all, runs));
}

/** A file name for a new suite: test-cases/<slug>.sf-tests.yaml that does not exist yet. */
export function newSuitePath(workspaceDir: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "suite";
  let file = path.join(workspaceDir, SUITE_DIR, `${slug}.sf-tests.yaml`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(workspaceDir, SUITE_DIR, `${slug}-${n}.sf-tests.yaml`);
  return file;
}
