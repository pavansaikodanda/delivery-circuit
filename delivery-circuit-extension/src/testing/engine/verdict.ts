// Same routing as the circuit's CI script scripts/ci/ai-tester-verdict.mjs, so the extension and CI always agree:
//   pass | dev (a case failed = defect) | qa (blocked = suite/data/permission) | infra (nothing ran, a suite
//   produced no results, or agent error)
import * as fs from "fs";
import * as path from "path";

export type Route = "pass" | "dev" | "qa" | "infra";

export interface VerdictCase {
  suite: string;
  id: string;
  mode: string;
  status: string;
  summary: string;
  defects: string[];
  run?: string;
}

export interface Verdict {
  route: Route;
  total: number;
  passed: number;
  failed: Omit<VerdictCase, "status" | "run">[];
  blocked: Omit<VerdictCase, "status" | "run">[];
  error: Omit<VerdictCase, "status" | "run">[];
  missing_runs: number;
  runs: string[];
}

/** Cases of one results.json, normalised exactly like the CI script. Throws on an unexpected shape. */
export function readRunCases(file: string): VerdictCase[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!raw || !Array.isArray(raw.results)) throw new Error(`Unexpected results.json shape in ${file} (no results array)`);
  return raw.results.map((c: any) => ({
    suite: raw.suite,
    id: c.id,
    mode: c.mode,
    status: String(c.status || "").toLowerCase(),
    summary: String(c.summary || "").slice(0, 300),
    defects: (c.defects || []).map((d: any) => `[${d.severity}] ${d.title}`).slice(0, 5),
  }));
}

/** The route for a set of case statuses (missingRuns: suites expected but without results). */
export function routeOf(cases: { status: string }[], missingRuns = 0): Route {
  const has = (s: string) => cases.some((c) => String(c.status).toLowerCase() === s);
  if (cases.length === 0 || missingRuns) return "infra";
  if (has("failed")) return "dev";
  if (has("error")) return "infra";
  if (has("blocked")) return "qa";
  return "pass";
}

/** Full verdict over a runs folder (every <run>/results.json), as `ai-tester-verdict.mjs [root] --expect N` prints it. */
export function verdictFor(runsRoot: string, expect?: number): Verdict {
  const runs = fs.existsSync(runsRoot)
    ? fs.readdirSync(runsRoot).filter((d) => fs.existsSync(path.join(runsRoot, d, "results.json"))).sort()
    : [];
  const cases = runs.flatMap((d) => readRunCases(path.join(runsRoot, d, "results.json")).map((c) => ({ ...c, run: d })));
  const pick = (s: string) => cases.filter((c) => c.status === s);
  const brief = (c: VerdictCase) => ({ suite: c.suite, id: c.id, mode: c.mode, summary: c.summary, defects: c.defects });
  const missingRuns = expect != null && runs.length < expect ? expect - runs.length : 0;
  return {
    route: routeOf(cases, missingRuns),
    total: cases.length,
    passed: pick("passed").length,
    failed: pick("failed").map(brief),
    blocked: pick("blocked").map(brief),
    error: pick("error").map(brief),
    missing_runs: missingRuns,
    runs,
  };
}
