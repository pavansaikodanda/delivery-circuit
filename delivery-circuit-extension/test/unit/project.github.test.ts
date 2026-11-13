import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  checkRunState, environmentNames, hasAuthSecret, mapDeployRuns, mapWorkResponse, refMatches, rulesetCoverage, sampleBranch, statusContextState,
  storyKeyFromBranch, storyKeyFromTitle, workQuery,
} from "../../src/project/github";

const FIX = path.join(__dirname, "..", "fixtures", "project");
const json = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const BRANCHES = ["dev", "sit", "uat", "main"];

describe("story keys and checks", () => {
  it("reads the story key from feature branches and PR titles", () => {
    expect(storyKeyFromBranch("feature/ABC-12-escalate")).toBe("ABC-12");
    expect(storyKeyFromBranch("sprint/2026-11")).toBeUndefined();
    expect(storyKeyFromTitle("ABC-12 Agent escalates")).toBe("ABC-12");
    expect(storyKeyFromTitle("Cleanup ABC-12")).toBeUndefined();
  });
  it("maps check runs and commit statuses", () => {
    expect(checkRunState("COMPLETED", "SUCCESS")).toBe("success");
    expect(checkRunState("COMPLETED", "SKIPPED")).toBe("success");
    expect(checkRunState("COMPLETED", "TIMED_OUT")).toBe("failure");
    expect(checkRunState("IN_PROGRESS", null)).toBe("pending");
    expect(statusContextState("ERROR")).toBe("failure");
    expect(statusContextState(undefined)).toBe("missing");
  });
  it("one query: auto-merge, environment branches by name, sprint branches, PRs with reviews and checks", () => {
    const q = workQuery(BRANCHES);
    for (const s of ["autoMergeAllowed", 'b0: ref(qualifiedName: "refs/heads/dev")', 'b3: ref(qualifiedName: "refs/heads/main")', 'refPrefix: "refs/heads/sprint/"',
      "baseRefName", "reviews(last: 50)", "autoMergeRequest", "statusCheckRollup"]) expect(q).toContain(s);
    expect(workQuery(["sprint/*", 'x") { evil }'])).not.toContain("evil");
  });
});

describe("mapWorkResponse on the fixture", () => {
  const w = mapWorkResponse(json("github-work.json"), BRANCHES);
  const pr = (n: number) => w.prs.find((p) => p.number === n)!;
  it("branches, sprints and auto-merge", () => {
    expect(w.branches).toEqual({ dev: true, sit: true, uat: false, main: true });
    expect(w.sprints).toEqual(["sprint/2026-11", "sprint/2026-10"]);
    expect(w.autoMerge).toBe(false);
  });
  it("scan, CodeRabbit state from the coderabbitai bot, human approvals (bots never count)", () => {
    expect(pr(41)).toMatchObject({ storyKey: "ABC-12", base: "sprint/2026-11", scan: "failure", coderabbit: "changes", approvedBy: [], autoMerge: true, state: "open" });
    expect(pr(41).scanUrl).toMatch(/actions\/runs\/4100$/);
    expect(pr(42)).toMatchObject({ storyKey: "ABC-11", state: "merged", coderabbit: "approved", approvedBy: ["dev2"], mergeSha: "b0b0b0b0" });
    expect(pr(43)).toMatchObject({ coderabbit: "pending", scan: "success" });
    expect(pr(43).storyKey).toBeUndefined();
    expect(pr(45)).toMatchObject({ head: "dev", base: "sit" });
    expect(pr(45).storyKey).toBeUndefined();
  });
  it("tolerates empty responses", () => {
    expect(mapWorkResponse({}, BRANCHES)).toEqual({ prs: [], sprints: [], branches: {} });
  });
});

describe("deploy runs and repo setup (names only)", () => {
  it("maps deploy.yml runs", () => {
    expect(mapDeployRuns(json("deploy-runs.json")).map((r) => [r.id, r.branch, r.status])).toEqual([[901, "main", "waiting"], [900, "sprint/2026-11", "completed"]]);
  });
  it("environments and the SFDX_AUTH_URL secret, by name only", () => {
    expect(environmentNames({ environments: [{ name: "qa" }, { name: "production" }, {}] })).toEqual(["qa", "production"]);
    expect(hasAuthSecret({ total_count: 1, secrets: [{ name: "SFDX_AUTH_URL", created_at: "x" }] })).toBe(true);
    expect(hasAuthSecret({ secrets: [{ name: "OTHER" }] })).toBe(false);
  });
  it("ruleset coverage per branch", () => {
    expect(refMatches("refs/heads/sprint/*", "sprint/2026-11")).toBe(true);
    expect(refMatches("refs/heads/sprint/*", "sprint/a/b")).toBe(false);
    expect(refMatches("refs/heads/**", "sprint/a/b")).toBe(true);
    expect(refMatches("~DEFAULT_BRANCH", "main", "main")).toBe(true);
    const rulesets = [
      { enforcement: "active", target: "branch", conditions: { ref_name: { include: ["refs/heads/sprint/*"], exclude: [] } } },
      { enforcement: "active", conditions: { ref_name: { include: ["refs/heads/dev", "refs/heads/sit", "~DEFAULT_BRANCH"], exclude: [] } } },
      { enforcement: "disabled", conditions: { ref_name: { include: ["refs/heads/uat"], exclude: [] } } },
    ];
    const branches = ["sprint/*", "dev", "sit", "uat", "main"].map((b) => sampleBranch(b, "sprint/2026-11"));
    expect(rulesetCoverage(rulesets, branches, "main")).toEqual({ "sprint/2026-11": true, dev: true, sit: true, uat: false, main: true });
    expect(sampleBranch("sprint/*")).toBe("sprint/sample");
  });
});
