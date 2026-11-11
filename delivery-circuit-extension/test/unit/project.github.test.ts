import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  aiAttemptFromLabels, checkRunState, featureIdFromBranch, mapDeployRuns, mapPr, mapPrsResponse, mapStoryPrsResponse, missingStoryKeys, PRS_QUERY, STORY_SEARCH_BATCH, storyPrsQuery, reviewerVerdict,
  statusContextState, storyKeyFromBranch,
} from "../../src/project/github";

const resp = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "project", "github-prs.json"), "utf8"));

describe("branch, label and check helpers", () => {
  it("reads the story key from feature branches only", () => {
    expect(storyKeyFromBranch("feature/ABC-12-agent-escalates")).toBe("ABC-12");
    expect(storyKeyFromBranch("feature/ABC-12")).toBe("ABC-12");
    expect(storyKeyFromBranch("feature/abc-12-x")).toBeUndefined();
    expect(storyKeyFromBranch("spec/001-x")).toBeUndefined();
    expect(storyKeyFromBranch("feature/ABC-123x")).toBeUndefined();
  });
  it("reads the feature id of spec PRs", () => {
    expect(featureIdFromBranch("spec/001-case-escalation")).toBe("001");
    expect(featureIdFromBranch("intake/foo", "Spec 002-partner")).toBe("002");
    expect(featureIdFromBranch("main")).toBeUndefined();
  });
  it("takes the highest ai-attempt label", () => {
    expect(aiAttemptFromLabels(["ai-attempt-1", "ai-attempt-3", "x"])).toBe(3);
    expect(aiAttemptFromLabels(["ai-generated"])).toBeUndefined();
  });
  it("maps check runs and commit statuses", () => {
    expect(checkRunState("COMPLETED", "SUCCESS")).toBe("success");
    expect(checkRunState("COMPLETED", "SKIPPED")).toBe("success");
    expect(checkRunState("COMPLETED", "TIMED_OUT")).toBe("failure");
    expect(checkRunState("IN_PROGRESS", null)).toBe("pending");
    expect(statusContextState("ERROR")).toBe("failure");
    expect(statusContextState("EXPECTED")).toBe("pending");
    expect(statusContextState(undefined)).toBe("missing");
  });
  it("finds the AI Reviewer verdict only in the last lines", () => {
    expect(reviewerVerdict("Findings...\n\nVERDICT: PASS")).toBe("pass");
    expect(reviewerVerdict("x\n**VERDICT: BLOCK**\n")).toBe("block");
    expect(reviewerVerdict("VERDICT: PASS\n1\n2\n3\n4\n5\n6")).toBeUndefined();
    expect(reviewerVerdict("no verdict")).toBeUndefined();
  });
  it("is a single query that asks for labels, rollup contexts, reviews, comments and the prod tag", () => {
    for (const s of ["statusCheckRollup", "StatusContext", "CheckRun", "reviews(", "comments(", "prod-deployed", "states: MERGED"]) expect(PRS_QUERY).toContain(s);
  });
});

describe("mapPrsResponse on the fixture", () => {
  const { prs, prodDeployedAt, prodDeployedSha } = mapPrsResponse(resp);
  const pr = (n: number) => prs.find((p) => p.number === n)!;

  it("maps open and merged PRs and the prod-deployed tag", () => {
    expect(prs.map((p) => p.number)).toEqual([40, 42, 43, 44, 46, 30]);
    expect(pr(30).state).toBe("merged");
    expect(pr(30).mergedAt).toBe("2026-10-01T09:59:00Z");
    expect(prodDeployedAt).toBe("2026-10-01T10:00:00Z");
    expect(prodDeployedSha).toBe("aaa111");
  });

  it("maps a spec PR", () => {
    expect(pr(40)).toMatchObject({ featureId: "001", draft: false, labels: ["sdd", "plan-review"], state: "open", headSha: "s40" });
    expect(pr(40).storyKey).toBeUndefined();
    expect(pr(40).checks).toEqual({ "spec-gate": "success", guard: "success", reviewer: "success" });
  });

  it("maps a draft AI plan PR without checks; gate statuses default to missing", () => {
    expect(pr(42)).toMatchObject({ storyKey: "ABC-12", draft: true, author: "circuit-app[bot]" });
    expect(pr(42).checks).toEqual({ "gate/developer": "missing", "gate/tester": "missing", "gate/architect": "missing" });
    expect(pr(42).reviews).toEqual([]);
  });

  it("builds review signals from people, CodeRabbit, the AI Reviewer, Code Analyzer and SF AI Tester", () => {
    const p = pr(43);
    expect(p.aiAttempt).toBe(2);
    expect(p.checks).toMatchObject({ guard: "success", static: "success", qa: "failure", reviewer: "failure", "gate/developer": "success", "gate/tester": "missing" });
    const by = (src: string) => p.reviews.filter((r) => r.source === src);
    expect(by("coderabbit")).toEqual([expect.objectContaining({ author: "coderabbitai", state: "changes-requested", summary: "Actionable comments posted: 2" })]);
    // the later plain comment does not hide dev1's approval; bots other than CodeRabbit are ignored
    expect(by("human")).toEqual([expect.objectContaining({ author: "dev1", state: "approved", summary: "Approved" })]);
    expect(by("ai-reviewer")).toEqual([expect.objectContaining({ state: "block", summary: "Review", url: "https://github.com/acme/sales/pull/43#issuecomment-2" })]);
    expect(by("code-analyzer")).toEqual([expect.objectContaining({ author: "static", state: "pass" })]);
    expect(by("sf-ai-tester")).toEqual([expect.objectContaining({ state: "block" })]);
    expect(p.reviews.map((r) => r.at)).toEqual([...p.reviews.map((r) => r.at)].sort());
  });

  it("prefers a dedicated Code Analyzer check run", () => {
    const ca = pr(44).reviews.find((r) => r.source === "code-analyzer")!;
    expect(ca).toMatchObject({ author: "Code Analyzer", state: "pass", summary: "0 violations" });
    expect(pr(44).reviews.find((r) => r.source === "sf-ai-tester")!.state).toBe("pass");
  });

  it("reports running QA as pending and needs-qa as blocked", () => {
    expect(pr(46).checks.qa).toBe("pending");
    expect(pr(46).reviews.find((r) => r.source === "sf-ai-tester")!.state).toBe("commented");
    const node = JSON.parse(JSON.stringify(resp.data.repository.open.nodes[4]));
    node.labels.nodes.push({ name: "needs-qa" });
    const m = mapPrsResponse({ repository: { open: { nodes: [node] } } });
    expect(m.prs[0].reviews.find((r) => r.source === "sf-ai-tester")!.state).toBe("block");
  });

  it("tolerates empty responses", () => {
    expect(mapPrsResponse(undefined).prs).toEqual([]);
    expect(mapPrsResponse({ data: { repository: null } }).prs).toEqual([]);
  });
});

describe("deploy runs", () => {
  it("maps the REST workflow runs response", () => {
    const runs = mapDeployRuns({ workflow_runs: [{ id: 7, status: "waiting", conclusion: null, html_url: "https://github.com/acme/sales/actions/runs/7", created_at: "2026-11-10T00:00:00Z", head_sha: "abc" }] });
    expect(runs).toEqual([{ id: 7, status: "waiting", conclusion: null, url: "https://github.com/acme/sales/actions/runs/7", createdAt: "2026-11-10T00:00:00Z", headSha: "abc" }]);
    expect(mapDeployRuns({})).toEqual([]);
  });
});

describe("older story PR lookup", () => {
  const pr = (n: number, branch: string, state: "open" | "merged" | "closed") => ({ ...mapPr({ number: n, headRefName: branch, state: state.toUpperCase() }) });
  it("lists only referenced, well-formed keys with no open or merged PR", () => {
    const prs = [pr(1, "feature/CE-1-a", "merged"), pr(2, "feature/CE-2-b", "open"), pr(3, "feature/CE-3-c", "closed")];
    expect(missingStoryKeys(["CE-1", "CE-2", "CE-3", "CE-4", "CE-4", "bad key"], prs)).toEqual(["CE-3", "CE-4"]);
  });
  it("builds one aliased search per key with variables, never interpolating them into the query", () => {
    const keys = Array.from({ length: 25 }, (_v, i) => `CE-${i + 1}`);
    const q = storyPrsQuery("acme", "sales", ["bad\" key", ...keys]);
    expect(Object.keys(q.variables)).toHaveLength(STORY_SEARCH_BATCH);
    expect(q.variables.q0).toBe("repo:acme/sales is:pr is:merged head:feature/CE-1");
    expect(q.query).toContain("s0: search(query: $q0, type: ISSUE");
    expect(q.query).not.toContain("CE-1");
    expect(() => storyPrsQuery("acme", "sa les", ["CE-1"])).toThrow();
  });
  it("keeps only merged PRs whose branch is exactly that story", () => {
    const node = (n: number, b: string, st = "MERGED") => ({ number: n, headRefName: b, state: st, mergedAt: "2026-01-01T00:00:00Z" });
    const out = mapStoryPrsResponse({ data: { s0: { nodes: [node(5, "feature/CE-1-x"), node(6, "feature/CE-10-y"), node(7, "feature/CE-1-z", "OPEN"), null] }, s1: { nodes: [node(8, "feature/CE-2")] } } }, ["CE-1", "CE-2"]);
    expect(out.map((p) => [p.number, p.storyKey])).toEqual([[5, "CE-1"], [8, "CE-2"]]);
  });
});
