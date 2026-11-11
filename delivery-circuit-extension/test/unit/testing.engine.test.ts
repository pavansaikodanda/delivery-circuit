import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { loadSuite, saveSuite } from "../../src/testing/engine/suite";
import { caseHash } from "../../src/testing/engine/hash";
import { resolveTarget, isSalesforceUrl } from "../../src/testing/engine/target";
import { planChains, sharedPrefix, isSafeSpecPath } from "../../src/testing/engine/runner";
import { routeOf, verdictFor } from "../../src/testing/engine/verdict";
import { listRuns, readRun, runStartedAt, countStatuses } from "../../src/testing/engine/runs";
import { readStatus, recordResult } from "../../src/testing/engine/status";
import { catalog, mergeStatus, newSuitePath, statusFromRuns, storyRefOf, suiteRecord } from "../../src/testing/engine/catalog";
import { esc, writeReport } from "../../src/testing/engine/report";
import { shellArg } from "../../src/testing/engine/exec";
import { sanitize } from "../../src/testing/engine/generate";
import { agentEnv } from "../../src/testing/engine/agent";
import { formatMeta } from "../../src/testing/engine/orgmeta";
import type { CaseResult, TestCase, TestSuite } from "../../src/testing/engine/types";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-testing-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (rel: string, text: string) => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};
const tc = (id: string, steps: string[], extra: Partial<TestCase> = {}): TestCase => ({ id, title: `Case ${id}`, steps, expected: ["ok"], ...extra });
const result = (id: string, status: CaseResult["status"], extra: Partial<CaseResult> = {}): CaseResult => ({
  id, title: `Case ${id}`, mode: "manual", status, summary: `${id} ${status}`, steps: [], defects: [], evidence: [], durationMs: 1000, costUsd: 0.1, turns: 3, ...extra,
});
const writeRun = (id: string, suite: string, results: CaseResult[], org = "qa") =>
  write(`.sf-ai-tester/runs/${id}/results.json`, JSON.stringify({ suite, org, results }));

const SUITE = `name: Smoke - Account
context: SDO org
cases:
  - id: SMOKE-ACC-001
    title: Create an Account
    steps: [Open the Accounts tab, Click "New", Click "Save"]
    expected: [The Account is saved]
  - id: SMOKE-ACC-002
    title: List view
    steps: [Open the Accounts tab, Select the "GFS Customers" list view]
    expected: [Header shows GFS Customers]
`;

describe("suite loading and validation", () => {
  it("loads a suite object", () => {
    const s = loadSuite(write("test-cases/a.sf-tests.yaml", SUITE));
    expect(s.name).toBe("Smoke - Account");
    expect(s.cases.map((c) => c.id)).toEqual(["SMOKE-ACC-001", "SMOKE-ACC-002"]);
  });
  it("accepts a bare list of cases and names the suite after the file", () => {
    const s = loadSuite(write("list.yaml", "- id: A-1\n  title: t\n  steps: [s]\n  expected: [e]\n"));
    expect(s.name).toBe("list.yaml");
    expect(s.cases).toHaveLength(1);
  });
  it.each([
    ["missing id", "cases:\n  - title: t\n    steps: [s]\n    expected: [e]\n", /missing "id"/],
    ["bad id", "cases:\n  - id: A 1\n    title: t\n    steps: [s]\n    expected: [e]\n", /may only contain/],
    ["missing title", "cases:\n  - id: A-1\n    steps: [s]\n    expected: [e]\n", /missing "title"/],
    ["empty steps", "cases:\n  - id: A-1\n    title: t\n    steps: []\n    expected: [e]\n", /"steps" must be a non-empty list/],
    ["no expected", "cases:\n  - id: A-1\n    title: t\n    steps: [s]\n", /"expected" must be a non-empty list/],
    ["duplicate id", "cases:\n  - {id: A-1, title: t, steps: [s], expected: [e]}\n  - {id: A-1, title: u, steps: [s], expected: [e]}\n", /duplicate test case id "A-1"/],
    ["no cases", "name: Empty\n", /no test cases found/],
  ])("rejects %s", (_n, yaml, err) => {
    expect(() => loadSuite(write("bad.sf-tests.yaml", yaml))).toThrow(err);
  });
  it("allows an empty suite when asked", () => {
    expect(loadSuite(write("e.yaml", "name: Empty\n"), { allowEmpty: true }).cases).toEqual([]);
  });
  it("saveSuite round-trips and drops empty fields", () => {
    const f = path.join(dir, "test-cases", "out.sf-tests.yaml");
    saveSuite(f, { name: "Out", target: "auto", cases: [tc("X-1", ["a"], { tags: [], description: "" })] });
    const text = fs.readFileSync(f, "utf8");
    expect(text).not.toMatch(/tags|description|target/);
    expect(loadSuite(f).cases[0].id).toBe("X-1");
  });
});

describe("case hashing", () => {
  it("is stable and changes only with what the case tests", () => {
    const a = tc("A-1", ["one", "two"]);
    expect(caseHash(a)).toBe(caseHash({ ...a }));
    expect(caseHash(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(caseHash({ ...a, section: "Other", tags: ["x"], id: "B-2" })).toBe(caseHash(a));
    expect(caseHash({ ...a, steps: ["one", "three"] })).not.toBe(caseHash(a));
    expect(caseHash({ ...a, expected: ["changed"] })).not.toBe(caseHash(a));
    expect(caseHash({ ...a, data: { k: 1 } })).not.toBe(caseHash(a));
  });
});

describe("target resolution", () => {
  const suite: TestSuite = { name: "s", cases: [] };
  it("honours explicit case then suite targets", () => {
    expect(resolveTarget(tc("A", ["Open http://localhost:8080"], { target: "salesforce" }), suite)).toBe("salesforce");
    expect(resolveTarget(tc("A", ["Open the Accounts tab"]), { ...suite, target: "web" })).toBe("web");
  });
  it("detects web cases from non-Salesforce URLs in steps", () => {
    expect(resolveTarget(tc("A", ["Open http://localhost:8080/login"]), suite)).toBe("web");
    expect(resolveTarget(tc("A", ["Go to localhost:3000"]), suite)).toBe("web");
    expect(resolveTarget(tc("A", ["Open https://acme.lightning.force.com/lightning/o/Account/list"]), suite)).toBe("salesforce");
    expect(resolveTarget(tc("A", ["Open https://acme.my.site.com and https://example.org"]), suite)).toBe("web");
  });
  it("falls back to the suite base URL, else Salesforce", () => {
    expect(resolveTarget(tc("A", ["Click New"]), { ...suite, baseUrl: "https://shop.example.com" })).toBe("web");
    expect(resolveTarget(tc("A", ["Click New"]), { ...suite, baseUrl: "https://acme.my.salesforce.com" })).toBe("salesforce");
    expect(resolveTarget(tc("A", ["Click New"]), suite)).toBe("salesforce");
    expect(isSalesforceUrl("https://x.sandbox.my.salesforce.com/")).toBe(true);
  });
});

describe("continuity chaining", () => {
  it("counts identical opening steps, case and whitespace insensitive, leaving one step to run", () => {
    expect(sharedPrefix(["Open the Accounts tab", "Click New"], ["open the  accounts tab.", "Select view"])).toBe(1);
    expect(sharedPrefix(["a", "b"], ["a", "b"])).toBe(1);
    expect(sharedPrefix(["a", "b", "c"], ["a", "b", "c", "d"])).toBe(3);
    expect(sharedPrefix(["x"], ["y", "z"])).toBe(0);
  });
  it("one worker runs everything as one chain", () => {
    const cases = [tc("A", ["a", "b"]), tc("B", ["x", "y"])];
    expect(planChains(cases, 1, "continue")).toEqual([cases]);
    expect(planChains([], 1, "continue")).toEqual([]);
  });
  it("groups consecutive cases with shared openings, capped, longest first", () => {
    const cases = [tc("A", ["open", "1"]), tc("B", ["open", "2"]), tc("C", ["other", "3"]), tc("D", ["open", "4"])];
    const chains = planChains(cases, 2, "continue");
    expect(chains.map((c) => c.map((x) => x.id))).toEqual([["A", "B"], ["C"], ["D"]]);
    expect(planChains(cases, 2, "fresh").every((c) => c.length === 1)).toBe(true);
    const many = Array.from({ length: 12 }, (_, i) => tc(`M${i}`, ["open", String(i)]));
    expect(Math.max(...planChains(many, 2, "continue").map((c) => c.length))).toBe(5); // MAX_CARRY_CHAIN
  });
});

describe("verdict routing (same as ai-tester-verdict.mjs)", () => {
  it("routes by precedence: failed > error > blocked > pass; nothing ran = infra", () => {
    expect(routeOf([])).toBe("infra");
    expect(routeOf([{ status: "passed" }])).toBe("pass");
    expect(routeOf([{ status: "passed" }, { status: "blocked" }])).toBe("qa");
    expect(routeOf([{ status: "blocked" }, { status: "error" }])).toBe("infra");
    expect(routeOf([{ status: "error" }, { status: "failed" }])).toBe("dev");
    expect(routeOf([{ status: "PASSED" }])).toBe("pass");
    expect(routeOf([{ status: "passed" }], 1)).toBe("infra");
  });
  it("matches the circuit's CI script on the same runs folder", () => {
    writeRun("2026-11-10T10-00-00-000Z", "S1", [result("A", "passed"), result("B", "blocked", { defects: [{ title: "No access", severity: "major", details: "" }] })]);
    writeRun("2026-11-10T11-00-00-000Z", "S2", [result("C", "failed")]);
    const mine = verdictFor(path.join(dir, ".sf-ai-tester", "runs"), 3);
    expect(mine.route).toBe("infra"); // one expected suite produced no results
    expect(verdictFor(path.join(dir, ".sf-ai-tester", "runs")).route).toBe("dev");
    const script = path.resolve(__dirname, "../../../sf-delivery-circuit/templates/repo/scripts/ci/ai-tester-verdict.mjs");
    if (!fs.existsSync(script)) return;
    for (const args of [[], ["--expect", "3"]]) {
      const out = JSON.parse(execFileSync(process.execPath, [script, path.join(dir, ".sf-ai-tester", "runs"), ...args], { encoding: "utf8" }));
      expect(verdictFor(path.join(dir, ".sf-ai-tester", "runs"), args.length ? 3 : undefined)).toEqual(out);
    }
  });
});

describe("results and status reading", () => {
  it("reads runs newest first with counts, route and start time", () => {
    writeRun("2026-11-10T10-00-00-000Z", "S", [result("A", "passed")]);
    writeRun("2026-11-10T12-30-05-123Z", "S", [result("A", "failed"), result("B", "passed")]);
    write(".sf-ai-tester/runs/2026-11-10T13-00-00-000Z/results.json", "{not json");
    const runs = listRuns(dir);
    expect(runs.map((r) => r.id)).toEqual(["2026-11-10T12-30-05-123Z", "2026-11-10T10-00-00-000Z"]);
    expect(runs[0]).toMatchObject({ suite: "S", org: "qa", total: 2, route: "dev", startedAt: "2026-11-10T12:30:05.123Z" });
    expect(runs[0].counts).toEqual({ passed: 1, failed: 1, blocked: 0, error: 0 });
    expect(readRun(path.join(dir, "nope"))).toBeUndefined();
    expect(runStartedAt("garbage")).toBeUndefined();
    expect(countStatuses([{ status: "weird" }, { status: "error" }])).toEqual({ passed: 0, failed: 0, blocked: 0, error: 1 });
  });
  it("records and reads status.json per suite key", () => {
    recordResult(dir, "test-cases/a.sf-tests.yaml", result("A", "blocked", { caseHash: "h1" }), "/runs/1");
    recordResult(dir, "test-cases/a.sf-tests.yaml", result("A", "passed", { mode: "automation", specFile: "tests/sf-ai/A.spec.ts" }), "/runs/2");
    const st = readStatus(dir, "test-cases/a.sf-tests.yaml");
    expect(st.A.manual).toMatchObject({ status: "blocked", runDir: "/runs/1", caseHash: "h1", defects: 0 });
    expect(st.A.automation).toMatchObject({ status: "passed", specFile: "tests/sf-ai/A.spec.ts" });
    expect(readStatus(dir, "other")).toEqual({});
  });
  it("fills status from run folders written by the CLI/CI and keeps the newer verdict", () => {
    writeRun("2026-11-10T10-00-00-000Z", "Smoke - Account", [result("SMOKE-ACC-001", "failed")]);
    writeRun("2026-11-10T11-00-00-000Z", "Smoke - Account", [result("SMOKE-ACC-001", "passed")]);
    const fromRuns = statusFromRuns(dir)["Smoke - Account"];
    expect(fromRuns["SMOKE-ACC-001"].manual?.status).toBe("passed");
    const merged = mergeStatus({ "SMOKE-ACC-001": { manual: { ...fromRuns["SMOKE-ACC-001"].manual!, status: "blocked", at: Date.parse("2026-11-11T00:00:00Z") } } }, fromRuns);
    expect(merged["SMOKE-ACC-001"].manual?.status).toBe("blocked");
  });
  it("builds the catalogue with last counts, stale marks and Jira keys from jira-map.json", () => {
    write("test-cases/001-account-smoke-story-01.sf-tests.yaml", SUITE);
    write("test-cases/broken.sf-tests.yaml", "cases:\n  - id: X\n");
    write("test-cases/notes.yaml", SUITE); // not a suite file name
    write(".specify/specs/001-account-smoke/jira-map.json", JSON.stringify({ refs: { epic: "SDO-1", "01": "SDO-12", "SMOKE-ACC-002": "SDO-32" } }));
    writeRun("2026-11-10T10-00-00-000Z", "Smoke - Account", [result("SMOKE-ACC-001", "passed", { caseHash: "outdated" })]);
    const all = catalog(dir);
    expect(all.map((s) => s.key)).toEqual(["test-cases/001-account-smoke-story-01.sf-tests.yaml", "test-cases/broken.sf-tests.yaml"]);
    const [smoke, broken] = all;
    expect(smoke).toMatchObject({ name: "Smoke - Account", storyKey: "SDO-12", feature: "001-account-smoke", last: { passed: 1 }, notRun: 1 });
    expect(smoke.cases[0].manual?.stale).toBe(true);
    expect(smoke.cases[1].jiraKey).toBe("SDO-32");
    expect(broken.error).toMatch(/test-cases\/broken\.sf-tests\.yaml case #1: missing "title"/);
    expect(broken.error).not.toContain(dir);
    expect(storyRefOf("test-cases/012-lead-convert-story-03.sf-tests.yaml")).toEqual({ feature: "012-lead-convert", featureId: "012", story: "03" });
    expect(storyRefOf("smoke-account.sf-tests.yaml")).toBeUndefined();
    expect(suiteRecord(dir, path.join(dir, "test-cases/001-account-smoke-story-01.sf-tests.yaml")).cases).toHaveLength(2);
  });
  it("picks a new suite file name that does not exist yet", () => {
    write("test-cases/lead-conversion.sf-tests.yaml", SUITE);
    expect(path.basename(newSuitePath(dir, "Lead Conversion!"))).toBe("lead-conversion-2.sf-tests.yaml");
    expect(path.basename(newSuitePath(dir, "***"))).toBe("suite.sf-tests.yaml");
  });
});

describe("report HTML", () => {
  it("escapes everything the agent or suite author wrote", () => {
    expect(esc(`<img src=x onerror="a('b')">&`)).toBe("&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
    const bad = `<script>alert(1)</script>`;
    write("run/evidence/A-manual/shot.png", "png");
    const file = writeReport(path.join(dir, "run"), `Suite ${bad}`, `org ${bad}`, [
      result("A", "failed", {
        title: `Title ${bad}`, summary: `Summary ${bad}`,
        steps: [{ step: `Step ${bad}`, status: "failed", actual: `Actual ${bad}` }],
        defects: [{ title: `Defect ${bad}`, severity: "major", details: `Details ${bad}` }],
        evidence: ["shot.png", "missing.png"],
      }),
    ]);
    const html = fs.readFileSync(file, "utf8");
    expect(html).not.toContain("<script>");
    expect(html.match(/&lt;script&gt;/g)?.length).toBeGreaterThanOrEqual(7);
    expect(html).toContain('src="evidence/A-manual/shot.png"');
    expect(html).not.toContain("missing.png");
  });
});

describe("process and agent safety", () => {
  it("quotes Windows shell arguments and refuses shell metacharacters", () => {
    expect(shellArg("SELECT Id FROM Account", "win32")).toBe('"SELECT Id FROM Account"');
    expect(shellArg("qa", "win32")).toBe("qa");
    expect(shellArg("a b", "linux")).toBe("a b");
    expect(() => shellArg("x & del", "win32")).toThrow(/Unsafe/);
    expect(() => shellArg('a"b', "win32")).toThrow(/Unsafe/);
  });
  it("only runs specs under tests/sf-ai", () => {
    expect(isSafeSpecPath("tests/sf-ai/SMOKE-1.spec.ts")).toBe(true);
    expect(isSafeSpecPath("tests\\sf-ai\\SMOKE-1.spec.ts")).toBe(true);
    expect(isSafeSpecPath("tests/sf-ai/../../evil.spec.ts")).toBe(false);
    expect(isSafeSpecPath("tests/sf-ai/a.spec.ts & calc")).toBe(false);
    expect(isSafeSpecPath("other/a.spec.ts")).toBe(false);
  });
  it("strips API-key auth so the Claude subscription login is used", () => {
    const keep = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok";
    try {
      const env = agentEnv(true, { SF_INSTANCE_URL: "https://x" });
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.SF_INSTANCE_URL).toBe("https://x");
      expect(env.PATH ?? env.Path).toBeDefined(); // the SDK replaces the env, so the rest must be carried over
    } finally {
      process.env = keep;
    }
  });
  it("sanitizes generated case ids against existing ones", () => {
    const out = sanitize([tc("opp 1", ["s"]), tc("OPP-1", ["s"]), { ...tc("", ["s"]), id: "" }, { ...tc("BAD", []) }], ["OPP-1"]);
    expect(out.map((c) => c.id)).toEqual(["OPP-001", "OPP-002", "TC-3"]); // the case without steps is dropped
  });
  it("formats org metadata compactly", () => {
    const text = formatMeta([{ name: "Account", label: "Account", fieldCount: 50, required: [{ name: "Name", label: "Account Name" }],
      picklists: [{ name: "Type", label: "Type", values: ["Prospect", "Customer"] }], validationRules: [{ name: "VR1", message: "Need\n  a phone", field: "Phone" }] }]);
    expect(text).toContain("required on create: Account Name (Name)");
    expect(text).toContain("picklist Type (Type): Prospect | Customer");
    expect(text).toContain('validation rule VR1 on Phone: "Need a phone"');
  });
});
