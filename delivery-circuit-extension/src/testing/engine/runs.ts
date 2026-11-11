// Reading run output back: .sf-ai-tester/runs/<timestamp>/{results.json, report.html, analysis.json, evidence/}.
import * as fs from "fs";
import * as path from "path";
import type { RunAnalysis } from "./analyst";
import type { CaseResult, Status } from "./types";
import { routeOf, type Route } from "./verdict";

export const TOOL_DIR = ".sf-ai-tester";

/**
 * Creates <workspace>/.sf-ai-tester with a `*` .gitignore before anything is written there: it holds Salesforce
 * session cookies (auth/), org metadata and run evidence, none of which may be committed. Returns the folder.
 */
export function ensureToolDir(workspaceDir: string): string {
  const dir = path.join(workspaceDir, TOOL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore) || fs.readFileSync(ignore, "utf8").trim() !== "*") fs.writeFileSync(ignore, "*\n");
  return dir;
}

export const STATUSES: Status[] = ["passed", "failed", "blocked", "error"];

export interface RunInfo {
  /** absolute run folder */
  runDir: string;
  /** folder name, an ISO timestamp with : and . replaced */
  id: string;
  suite: string;
  org?: string;
  total: number;
  counts: Record<Status, number>;
  route: Route;
  /** absolute report.html (may not exist for a run that crashed before writing it) */
  reportPath: string;
  /** ISO time the run started, from the folder name */
  startedAt?: string;
  results: CaseResult[];
  analysis?: RunAnalysis;
}

export const runsRoot = (workspaceDir: string) => path.join(workspaceDir, TOOL_DIR, "runs");

/** "2026-11-10T14-32-41-535Z" -> "2026-11-10T14:32:41.535Z" */
export function runStartedAt(id: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(id);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : undefined;
}

export function countStatuses(results: { status: string }[]): Record<Status, number> {
  const counts = { passed: 0, failed: 0, blocked: 0, error: 0 } as Record<Status, number>;
  for (const r of results) if ((STATUSES as string[]).includes(r.status)) counts[r.status as Status]++;
  return counts;
}

/** One run, or undefined when its results.json is missing or malformed. */
export function readRun(runDir: string): RunInfo | undefined {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (!raw || !Array.isArray(raw.results)) return undefined;
  const results: CaseResult[] = raw.results.map((r: any) => ({
    ...r,
    status: String(r.status || "").toLowerCase(),
    steps: Array.isArray(r.steps) ? r.steps : [],
    defects: Array.isArray(r.defects) ? r.defects : [],
    evidence: Array.isArray(r.evidence) ? r.evidence : [],
  }));
  let analysis: RunAnalysis | undefined;
  try {
    analysis = JSON.parse(fs.readFileSync(path.join(runDir, "analysis.json"), "utf8"));
  } catch {
    analysis = undefined;
  }
  const id = path.basename(runDir);
  return {
    runDir,
    id,
    suite: String(raw.suite ?? ""),
    org: raw.org ? String(raw.org) : undefined,
    total: results.length,
    counts: countStatuses(results),
    route: routeOf(results),
    reportPath: path.join(runDir, "report.html"),
    startedAt: runStartedAt(id),
    results,
    analysis,
  };
}

/** Runs, newest first. */
export function listRuns(workspaceDir: string, limit = 20): RunInfo[] {
  const root = runsRoot(workspaceDir);
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: RunInfo[] = [];
  for (const d of dirs.sort().reverse()) {
    const run = readRun(path.join(root, d));
    if (run) out.push(run);
    if (out.length >= limit) break;
  }
  return out;
}

/** Evidence files of one case execution that still exist on disk (absolute paths, images first). */
export function evidenceFiles(run: RunInfo, r: CaseResult): string[] {
  const dir = path.join(run.runDir, "evidence", `${r.id}-${r.mode}`);
  const files = (r.evidence ?? [])
    .map((e) => path.join(dir, path.basename(e)))
    .filter((f) => fs.existsSync(f));
  return files.sort((a, b) => Number(isImage(b)) - Number(isImage(a)));
}

export const isImage = (f: string) => /\.(png|jpe?g|gif|webp)$/i.test(f);
