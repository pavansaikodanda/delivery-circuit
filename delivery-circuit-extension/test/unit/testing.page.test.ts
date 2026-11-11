import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyEvent, buildPageState, initialLive, type LiveRun, type PageContext } from "../../src/testing/page";
import { catalog } from "../../src/testing/engine/catalog";
import { listRuns } from "../../src/testing/engine/runs";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-testing-page-"));
  fs.mkdirSync(path.join(dir, "test-cases"));
  fs.writeFileSync(path.join(dir, "test-cases", "smoke.sf-tests.yaml"),
    "name: Smoke\ncases:\n  - {id: S-1, title: One, steps: [a], expected: [b]}\n  - {id: S-2, title: Two, steps: [a], expected: [b]}\n");
  const run = path.join(dir, ".sf-ai-tester", "runs", "2026-11-10T10-00-00-000Z");
  fs.mkdirSync(path.join(run, "evidence", "S-1-manual"), { recursive: true });
  fs.writeFileSync(path.join(run, "evidence", "S-1-manual", "S-1-final.png"), "png");
  fs.writeFileSync(path.join(run, "evidence", "S-1-manual", "console.log"), "log");
  fs.writeFileSync(path.join(run, "results.json"), JSON.stringify({
    suite: "Smoke", org: "qa-alias",
    results: [
      { id: "S-1", title: "One", mode: "manual", status: "failed", summary: "broken", steps: [], defects: [{ title: "Save fails", severity: "major", details: "500" }],
        evidence: ["S-1-final.png", "console.log", "gone.png"], durationMs: 61_000, costUsd: 0.123, turns: 9 },
      { id: "S-2", title: "Two", mode: "manual", status: "passed", summary: "ok", steps: [], defects: [], evidence: [], durationMs: 1000, costUsd: 0, turns: 1 },
    ],
  }));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const engine = () => ({ suites: () => catalog(dir), runs: (n?: number) => listRuns(dir, n) });
const ctx = (over: Partial<PageContext> = {}): PageContext => ({
  root: dir, login: "maria", active: "tester", canSee: true, canRun: true,
  settings: { headless: true, models: ["claude-haiku-4-5"], workers: 2, maxTurns: 80 },
  aliases: { qa: "qa-alias", dev: "dev-alias" }, salesforce: { qa: "https://acme.lightning.force.com" },
  jiraUrl: (k) => `https://acme.atlassian.net/browse/${k}`, imageUri: (abs) => `vscode-resource:${path.basename(abs)}`, ...over,
});

describe("Testing page state", () => {
  it("denies the page to personas that cannot view it, without leaking data", () => {
    const s = buildPageState(engine(), ctx({ canSee: false, canRun: false, reason: "The Testing page is for Testers and Architects." }), {}, initialLive()) as any;
    expect(s.denied).toMatch(/Testers and Architects/);
    expect(s.suites).toBeUndefined();
  });
  it("shows suites, the latest run with route, defects, evidence URIs and deep links", () => {
    const s = buildPageState(engine(), ctx(), {}, initialLive()) as any;
    expect(s.selected).toBe("test-cases/smoke.sf-tests.yaml");
    expect(s.suites[0]).toMatchObject({ name: "Smoke", cases: 2, last: { failed: 1, passed: 1 }, notRun: 0 });
    expect(s.suites[0].links[0]).toEqual({ kind: "file", label: "Suite file", target: "test-cases/smoke.sf-tests.yaml" });
    expect(s.result.route).toBe("dev");
    expect(s.result.routeText).toMatch(/Developer/);
    const one = s.result.cases[0];
    expect(one.defects[0].title).toBe("Save fails");
    expect(one.durationSec).toBe(61);
    expect(one.evidence.map((e: any) => [e.name, e.uri])).toEqual([["S-1-final.png", "vscode-resource:S-1-final.png"], ["console.log", undefined]]);
    expect(s.result.links.map((l: any) => l.kind)).toEqual(["report", "file", "salesforce"]);
    expect(s.result.links[0].target).toBe(".sf-ai-tester/runs/2026-11-10T10-00-00-000Z/report.html");
    expect(s.orgs.find((o: any) => o.role === "qa").links[0].target).toBe("https://acme.lightning.force.com/lightning/page/home");
  });
  it("keeps everything visible but read-only for the Architect", () => {
    const s = buildPageState(engine(), ctx({ active: "architect", canRun: false, reason: "View only — you act as Architect" }), {}, initialLive()) as any;
    expect(s.persona).toMatchObject({ canSee: true, canRun: false, reason: "View only — you act as Architect" });
    expect(s.detail.cases).toHaveLength(2);
  });
  it("folds live run events", () => {
    let l: LiveRun = { ...initialLive(), running: true, total: 2 };
    l = applyEvent(l, { type: "log", message: "hello" });
    l = applyEvent(l, { type: "needsUser", message: "Complete the passkey" });
    l = applyEvent(l, { type: "caseStart", caseId: "S-1", mode: "manual", model: "m1" });
    expect(l.current).toEqual({ caseId: "S-1", mode: "manual", model: "m1" });
    expect(l.needsUser).toBeUndefined();
    l = applyEvent(l, { type: "escalate", caseId: "S-1", mode: "manual", model: "m2" });
    expect(l.current?.model).toBe("m2");
    l = applyEvent(l, { type: "caseEnd", caseId: "S-1", mode: "manual", status: "failed", message: "x", runDir: "/r" });
    expect(l).toMatchObject({ done: 1, current: undefined, lastRunDir: "/r" });
    expect(l.results).toEqual([{ caseId: "S-1", mode: "manual", status: "failed", summary: "x" }]);
    expect(l.log).toEqual(["hello", "Complete the passkey"]);
    for (let i = 0; i < 500; i++) l = applyEvent(l, { type: "log", message: String(i) });
    expect(l.log).toHaveLength(400);
  });
});
