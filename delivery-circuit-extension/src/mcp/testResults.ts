// SF AI Tester run results from .sf-ai-tester/runs/<timestamp>/results.json (+ status.json when present).
// No vscode import. The per-step trail is left out: it is long and can contain org URLs and screenshots paths.
import { promises as fs } from "fs";
import * as path from "path";

export const RUNS_DIR = ".sf-ai-tester/runs";

export interface TestCaseResult {
  id: string; title: string; mode: string; status: string; summary: string;
  defects: { severity: string; title: string }[];
  durationMs?: number; costUsd?: number;
}
export interface TestRunResult {
  runDir: string;
  suite: string;
  org?: string;
  startedAt?: string;
  total: number;
  counts: Record<"passed" | "failed" | "blocked" | "error", number>;
  route: "pass" | "dev" | "qa" | "infra";
  report?: string;
  status?: unknown;
  cases: TestCaseResult[];
}

/** "2026-11-10T14-32-41-535Z" -> "2026-11-10T14:32:41.535Z" */
export function runDirDate(name: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : undefined;
}

/** Same routing as scripts/ci/ai-tester-verdict.mjs */
export function routeOf(counts: TestRunResult["counts"], total: number): TestRunResult["route"] {
  if (total === 0) return "infra";
  if (counts.failed) return "dev";
  if (counts.error) return "infra";
  if (counts.blocked) return "qa";
  return "pass";
}

export function mapResults(runDir: string, raw: any, status?: unknown): TestRunResult | undefined {
  if (!raw || !Array.isArray(raw.results)) return undefined;
  const counts = { passed: 0, failed: 0, blocked: 0, error: 0 };
  const cases: TestCaseResult[] = raw.results.map((c: any) => {
    const st = String(c?.status ?? "").toLowerCase();
    if (st in counts) counts[st as keyof typeof counts]++;
    const tc: TestCaseResult = {
      id: String(c?.id ?? ""), title: String(c?.title ?? ""), mode: String(c?.mode ?? ""), status: st,
      summary: String(c?.summary ?? "").slice(0, 500),
      defects: (Array.isArray(c?.defects) ? c.defects : []).slice(0, 10).map((d: any) => ({ severity: String(d?.severity ?? ""), title: String(d?.title ?? "").slice(0, 200) })),
    };
    if (typeof c?.durationMs === "number") tc.durationMs = c.durationMs;
    if (typeof c?.costUsd === "number") tc.costUsd = Math.round(c.costUsd * 10000) / 10000;
    return tc;
  });
  const r: TestRunResult = {
    runDir, suite: String(raw.suite ?? ""), total: cases.length, counts, route: routeOf(counts, cases.length), cases,
  };
  if (raw.org) r.org = String(raw.org);
  const started = runDirDate(path.posix.basename(runDir));
  if (started) r.startedAt = started;
  if (status !== undefined) r.status = status;
  return r;
}

async function suiteName(root: string, suite: string): Promise<string | undefined> {
  if (!/\.ya?ml$/i.test(suite)) return undefined;
  const abs = path.resolve(root, suite);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return undefined;
  try { return /^name:\s*["']?(.+?)["']?\s*$/m.exec(await fs.readFile(abs, "utf8"))?.[1]; } catch { return undefined; }
}

/** Newest first. `suite` matches the suite name, or a suite file path whose `name:` matches. */
export async function readTestResults(root: string, suite?: string, limit = 10): Promise<TestRunResult[]> {
  const dir = path.join(root, RUNS_DIR);
  let names: string[] = [];
  try { names = (await fs.readdir(dir)).sort().reverse(); } catch { return []; }
  const wanted = suite ? [suite, await suiteName(root, suite)].filter((x): x is string => !!x) : [];
  const out: TestRunResult[] = [];
  for (const n of names) {
    if (out.length >= limit) break;
    let raw: any;
    try { raw = JSON.parse(await fs.readFile(path.join(dir, n, "results.json"), "utf8")); } catch { continue; }
    let status: unknown;
    try { status = JSON.parse(await fs.readFile(path.join(dir, n, "status.json"), "utf8")); } catch { status = undefined; }
    const r = mapResults(`${RUNS_DIR}/${n}`, raw, status);
    if (!r) continue;
    if (wanted.length && !wanted.includes(r.suite)) continue;
    try { await fs.access(path.join(dir, n, "report.html")); r.report = `${RUNS_DIR}/${n}/report.html`; } catch { /* no report */ }
    out.push(r);
  }
  return out;
}
