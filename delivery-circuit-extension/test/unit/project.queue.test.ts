import * as fs from "fs";
import * as path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Feature, QueueItem } from "../../src/core/contracts";
import { aggregate, computeGates, enrichFeatures, linkPrs, nextGate, storyPr } from "../../src/project/gates";
import { mapPrsResponse } from "../../src/project/github";
import type { DeployInfo, ParsedFeature, PrInfo } from "../../src/project/model";
import { loadFeatures } from "../../src/project/parse";
import { buildQueue, type QueueEnv } from "../../src/project/queue";

const FIX = path.join(__dirname, "..", "fixtures", "project");
const resp = JSON.parse(fs.readFileSync(path.join(FIX, "github-prs.json"), "utf8"));
const repo = { owner: "acme", repo: "sales" };
const jiraBrowseUrl = (k: string) => `https://acme.atlassian.net/browse/${k}`;

let parsed: ParsedFeature[];
const freshPrs = (): PrInfo[] => mapPrsResponse(resp).prs;
const enrich = (prs = freshPrs(), jira?: Record<string, string[]>, deploy?: DeployInfo) =>
  enrichFeatures(parsed, prs, jira, deploy, { repo, jiraBrowseUrl });
const env = (over: Partial<QueueEnv> = {}): QueueEnv => ({ repo, jiraConnected: false, jiraBrowseUrl, ...over });
const queue = (persona: "architect" | "developer" | "tester", prs = freshPrs(), deploy?: DeployInfo, e: Partial<QueueEnv> = {}, jira?: Record<string, string[]>) => {
  const features = enrichFeatures(parsed, prs, jira, deploy, { repo, jiraBrowseUrl });
  return buildQueue(persona, { features, prs, deploy, env: env({ ...(jira ? { jiraLabels: jira } : {}), ...e }) });
};
const kinds = (q: QueueItem[]) => q.map((i) => `${i.kind}:${i.prNumber ?? i.featureId ?? ""}`).sort();

beforeAll(async () => { parsed = await loadFeatures(path.join(FIX, "repo")); });

describe("gate aggregation", () => {
  it("aggregates per-story marks", () => {
    expect(aggregate([])).toBe("not-started");
    expect(aggregate(["ok", "ok"])).toBe("done");
    expect(aggregate(["ok", "none"])).toBe("waiting");
    expect(aggregate(["none", "none"])).toBe("not-started");
    expect(aggregate(["ok", "waiting", "blocked"])).toBe("blocked");
  });
  it("links story PRs to features through jira-map refs", () => {
    const prs = linkPrs(parsed, freshPrs());
    const by = (n: number) => prs.find((p) => p.number === n)!;
    expect([by(42).featureId, by(42).storyNum]).toEqual(["001", "01"]);
    expect([by(44).featureId, by(44).storyNum]).toEqual(["001", "00"]);
    expect(by(46).featureId).toBeUndefined();
  });
  it("prefers the open PR of a story, else the latest merged, never a closed one", () => {
    const base = freshPrs().find((p) => p.number === 42)!;
    const mk = (n: number, state: PrInfo["state"], mergedAt?: string): PrInfo => ({ ...base, number: n, state, mergedAt });
    expect(storyPr([mk(1, "merged", "2026-01-01"), mk(2, "merged", "2026-02-01"), mk(3, "closed")], "ABC-12")!.number).toBe(2);
    expect(storyPr([mk(1, "merged", "2026-01-01"), mk(4, "open")], "ABC-12")!.number).toBe(4);
    expect(storyPr([mk(3, "closed")], "ABC-12")).toBeUndefined();
  });
});

describe("feature 001 with open story PRs", () => {
  it("computes gates G1-G9", () => {
    const [f] = enrich();
    expect(f.gates).toEqual({ G1: "done", G3: "waiting", G4: "done", G5: "waiting", G6: "waiting", G7: "waiting", G8: "waiting", G9: "not-started" });
    expect(f.gates.G2).toBeUndefined();
    expect(nextGate(f)).toBe("G3");
  });
  it("computes G2 from Jira ai-ready labels when Jira is connected", () => {
    expect(enrich(freshPrs(), { "ABC-11": ["ai-ready"], "ABC-12": ["ai-ready"], "ABC-13": [] })[0].gates.G2).toBe("waiting");
    expect(enrich(freshPrs(), { "ABC-11": ["ai-ready"], "ABC-12": ["ai-ready", "x"], "ABC-13": ["ai-ready"] })[0].gates.G2).toBe("done");
    expect(enrich(freshPrs(), {})[1].gates.G2).toBe("not-started");
  });
  it("computes stages", () => {
    const [f] = enrich();
    expect(f.stages).toEqual({ intake: "done", clarify: "done", plan: "done", signoff: "done", stories: "done", tests: "done", jira: "active", build: "active", qa: "active", release: "todo" });
  });
  it("sets story PR numbers and outside links", () => {
    const [f] = enrich();
    expect(f.stories.map((s) => s.prNumber)).toEqual([44, 42, 43]);
    expect(f.links).toContainEqual({ kind: "github", label: "Spec folder on GitHub", target: "https://github.com/acme/sales/tree/main/.specify/specs/001-case-escalation" });
    expect(f.links).toContainEqual({ kind: "github", label: "Spec PR #40", target: "https://github.com/acme/sales/pull/40" });
    expect(f.links).toContainEqual({ kind: "jira", label: "Epic ABC-10", target: "https://acme.atlassian.net/browse/ABC-10" });
  });
  it("marks blocked gates and stages for needs-human / needs-qa", () => {
    const prs = freshPrs();
    const p43 = prs.find((p) => p.number === 43)!;
    p43.labels.push("needs-qa");
    p43.checks["gate/developer"] = "missing";
    p43.labels.push("needs-human");
    const [f] = enrich(prs);
    expect(f.gates.G5).toBe("blocked");
    expect(f.gates.G6).toBe("blocked");
    expect(f.stages.build).toBe("blocked");
    expect(f.stages.qa).toBe("blocked");
  });
  it("does not mutate the parsed features", () => {
    enrich();
    expect(parsed[0].feature.stories[0].prNumber).toBeUndefined();
    expect(parsed[0].feature.gates).toEqual({});
  });
});

describe("feature 001 after merge: G8 and G9", () => {
  const merged = () => {
    const prs = freshPrs();
    for (const n of [42, 43, 44]) { const p = prs.find((x) => x.number === n)!; p.state = "merged"; p.mergedAt = `2026-11-1${n - 42}T00:00:00Z`; }
    return prs;
  };
  const run = (status: string, conclusion: string | null, createdAt = "2026-11-13T00:00:00Z") =>
    ({ id: 99, status, conclusion, url: "https://github.com/acme/sales/actions/runs/99", createdAt, headSha: "abcdef123456" });

  it("G8 done when every story PR is merged; G9 waits for production", () => {
    const [f] = enrich(merged(), undefined, { runs: [], prodDeployedAt: "2026-10-01T00:00:00Z", prodDeployedSha: "x" });
    expect(f.gates.G8).toBe("done");
    expect(f.gates.G9).toBe("waiting");
    expect(f.stages.build).toBe("done");
    expect(f.stages.release).toBe("active");
  });
  it("G9 done when the prod-deployed tag is newer than the last merge", () => {
    const [f] = enrich(merged(), undefined, { runs: [], prodDeployedAt: "2026-11-15T00:00:00Z", prodDeployedSha: "x" });
    expect(f.gates.G9).toBe("done");
    expect(f.stages.release).toBe("done");
  });
  it("G9 waiting on an approval, blocked on a failed deploy", () => {
    expect(enrich(merged(), undefined, { runs: [run("waiting", null)] })[0].gates.G9).toBe("waiting");
    const [f] = enrich(merged(), undefined, { runs: [run("completed", "failure")], prodDeployedSha: "x", prodDeployedAt: "2026-10-01T00:00:00Z" });
    expect(f.gates.G9).toBe("blocked");
    expect(f.stages.release).toBe("blocked");
  });
  it("G9 done after a successful dry-run style deploy without the tag", () => {
    expect(enrich(merged(), undefined, { runs: [run("completed", "success")] })[0].gates.G9).toBe("done");
  });
});

describe("feature 002 (open questions, unsigned plan)", () => {
  it("G1 waiting and early stages", () => {
    const f = enrich()[1];
    expect(f.gates.G1).toBe("waiting");
    expect(f.gates.G3).toBe("not-started");
    expect(f.stages).toMatchObject({ intake: "done", clarify: "active", plan: "done", signoff: "active", stories: "todo", tests: "todo", jira: "todo", build: "todo", release: "todo" });
  });
  it("G1 not started without plan.md", () => {
    const f: Feature = { ...parsed[1].feature };
    expect(computeGates(f, { ...parsed[1].facts, hasPlan: false }, [], undefined).G1).toBe("not-started");
  });
});

describe("Architect queue", () => {
  it("has clarify, sign-off, G7 review and G8 merges", () => {
    expect(kinds(queue("architect"))).toEqual(["clarify:002", "merge:40", "merge:44", "review-pr:43", "sign-off:002"]);
  });
  it("builds the sign-off item with plan links and a gate action", () => {
    const item = queue("architect").find((i) => i.kind === "sign-off")!;
    expect(item).toMatchObject({ id: "architect:sign-off:002", gate: "G1", featureId: "002", persona: "architect" });
    expect(item.links.map((l) => l.label)).toEqual(["plan.md", "Spec folder on GitHub"]);
    expect(item.actions[0]).toEqual({ id: "gate:signoff", label: "Sign off plan", persona: "architect", kind: "gate", args: { featureId: "002" } });
    expect(item.actions[1]).toMatchObject({ id: "ai:/arch-design", kind: "ai", args: { command: "/arch-design", arg: "002-partner-onboarding" } });
    expect(item.actions[2]).toEqual({ id: "nav:feature", label: "Open feature", persona: "architect", kind: "nav", args: { featureId: "002" } });
  });
  it("clarify links the spec and the clarification report", () => {
    const item = queue("architect").find((i) => i.kind === "clarify")!;
    expect(item.title).toBe("002-partner-onboarding: 2 open questions");
    expect(item.links.map((l) => l.label)).toEqual(["spec.md", "clarification-report-partner-onboarding.md", "Spec folder on GitHub"]);
  });
  it("G7 review item has GitHub, Jira, CodeRabbit and story links, AI and approve actions", () => {
    const item = queue("architect").find((i) => i.kind === "review-pr")!;
    expect(item).toMatchObject({ gate: "G7", prNumber: 43, storyKey: "ABC-13", featureId: "001" });
    expect(item.links).toEqual([
      { kind: "github", label: "PR #43", target: "https://github.com/acme/sales/pull/43" },
      { kind: "jira", label: "ABC-13", target: "https://acme.atlassian.net/browse/ABC-13" },
      { kind: "coderabbit", label: "CodeRabbit review", target: "https://github.com/acme/sales/pull/43#pullrequestreview-9" },
      { kind: "file", label: "task_story_02.md", target: ".specify/specs/001-case-escalation/task_story_02.md" },
    ]);
    expect(item.actions.map((a) => [a.id, a.args])).toEqual([
      ["ai:/arch-review-pr", { command: "/arch-review-pr", arg: "43" }],
      ["gate:review", { pr: 43, event: "APPROVE" }],
      ["gate:review", { pr: 43, event: "REQUEST_CHANGES" }],
    ]);
  });
  it("does not offer a merge while a check is failing or pending", () => {
    const prs = freshPrs();
    prs.find((p) => p.number === 44)!.checks.qa = "pending";
    prs.find((p) => p.number === 40)!.checks.guard = "failure";
    expect(kinds(queue("architect", prs)).filter((k) => k.startsWith("merge"))).toEqual([]);
  });
  it("does not offer a spec PR merge before sign-off", () => {
    const prs = freshPrs();
    prs.find((p) => p.number === 40)!.featureId = "002";
    expect(kinds(queue("architect", prs))).not.toContain("merge:40");
  });
  it("lists production deployments waiting for approval (G9)", () => {
    const deploy: DeployInfo = { runs: [
      { id: 7, status: "waiting", conclusion: null, url: "https://github.com/acme/sales/actions/runs/7", createdAt: "2026-11-10T00:00:00Z", headSha: "abcdef1234567" },
      { id: 6, status: "completed", conclusion: "success", url: "https://github.com/acme/sales/actions/runs/6", createdAt: "2026-11-01T00:00:00Z", headSha: "x" },
    ] };
    const items = queue("architect", freshPrs(), deploy).filter((i) => i.kind === "deploy-approval");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ gate: "G9", detail: "deploy-prod run 7 (abcdef12)", links: [{ kind: "github", label: "Run 7", target: "https://github.com/acme/sales/actions/runs/7" }] });
    expect(items[0].actions).toEqual([{ id: "gate:deploy", label: "Review deployment", persona: "architect", kind: "gate", args: { runId: 7 } }]);
  });
});

describe("Developer queue", () => {
  it("has the G3 plan approval and the needs-human PR", () => {
    expect(kinds(queue("developer"))).toEqual(["approve-plan:42", "needs-human:46"]);
  });
  it("G3 item links PLAN.md on the PR branch and offers the label gate", () => {
    const item = queue("developer").find((i) => i.kind === "approve-plan")!;
    expect(item.gate).toBe("G3");
    expect(item.links).toContainEqual({ kind: "github", label: "PLAN.md", target: "https://github.com/acme/sales/blob/feature/ABC-12-agent-escalates/docs/plans/ABC-12/PLAN.md" });
    expect(item.actions).toEqual([
      { id: "ai:/dev-review-plan", label: "Review with AI (dev-review-plan)", persona: "developer", kind: "ai", args: { command: "/dev-review-plan", arg: "42" } },
      { id: "gate:label", label: "Add plan-approved", persona: "developer", kind: "gate", args: { pr: 42, label: "plan-approved" } },
    ]);
  });
  it("needs-human mentions the AI attempt", () => {
    expect(queue("developer").find((i) => i.kind === "needs-human")!.detail).toBe("AI stopped after attempt 3: a developer takes over");
  });
  it("offers G5 code review until gate/developer is set, but not on the person's own PR", () => {
    const prs = freshPrs();
    prs.find((p) => p.number === 43)!.checks["gate/developer"] = "missing";
    const item = queue("developer", prs).find((i) => i.kind === "review-pr")!;
    expect(item).toMatchObject({ gate: "G5", prNumber: 43, detail: "Code review (G5). Failing: qa, reviewer" });
    expect(queue("developer", prs, undefined, { login: "circuit-app[bot]" }).some((i) => i.kind === "review-pr")).toBe(false);
  });
  it("asks for a story review when stories exist and are not in Jira yet", () => {
    const saved = parsed[0].facts.jiraRefs;
    const savedStories = parsed[0].feature.stories;
    parsed[0].facts.jiraRefs = {};
    parsed[0].feature.stories = savedStories.map((s) => ({ ...s, jiraKey: undefined }));
    try {
      const item = queue("developer", []).find((i) => i.kind === "review-stories")!;
      expect(item).toMatchObject({ featureId: "001", title: "001-case-escalation: review 3 stories before Jira" });
      expect(item.actions[0]).toMatchObject({ id: "ai:/dev-review-stories", args: { command: "/dev-review-stories", arg: "001-case-escalation" } });
      expect(item.links.filter((l) => l.kind === "file").map((l) => l.label)).toEqual(["task_story_00.md", "task_story_01.md", "task_story_02.md", "plan.md"]);
    } finally {
      parsed[0].facts.jiraRefs = saved;
      parsed[0].feature.stories = savedStories;
    }
  });
});

describe("Tester queue", () => {
  it("has the G6 QA item for the PR with failing qa", () => {
    expect(kinds(queue("tester"))).toEqual(["qa-pr:43"]);
    const item = queue("tester")[0];
    expect(item.detail).toBe("QA on sandbox (G6); qa check failure");
    expect(item.actions.map((a) => a.id)).toEqual(["ai:/qa-explore", "gate:review", "gate:review", "nav:testing"]);
    expect(item.actions[3].args).toEqual({ suite: "test-cases/001-case-escalation-story-02.sf-tests.yaml" });
    expect(item.links).toContainEqual({ kind: "github", label: "TESTPLAN.md", target: "https://github.com/acme/sales/blob/feature/ABC-13-escalation-queue/docs/plans/ABC-13/TESTPLAN.md" });
  });
  it("asks for G4 on a draft AI PR without testplan-approved", () => {
    const prs = freshPrs();
    prs.find((p) => p.number === 42)!.labels = ["ai-generated", "plan-review"];
    const item = queue("tester", prs).find((i) => i.kind === "approve-testplan")!;
    expect(item.gate).toBe("G4");
    expect(item.actions[1]).toEqual({ id: "gate:label", label: "Add testplan-approved", persona: "tester", kind: "gate", args: { pr: 42, label: "testplan-approved" } });
  });
  it("needs-qa replaces the G6 item", () => {
    const prs = freshPrs();
    prs.find((p) => p.number === 43)!.labels.push("needs-qa");
    expect(kinds(queue("tester", prs))).toEqual(["needs-qa:43"]);
  });
  it("asks to design tests for stories without a tc index", () => {
    const saved = parsed[0].feature.stories;
    parsed[0].feature.stories = saved.map((s, i) => (i === 2 ? { ...s, testCases: [] } : s));
    try {
      const item = queue("tester", freshPrs()).find((i) => i.kind === "design-tests")!;
      expect(item).toMatchObject({ featureId: "001", detail: "Stories without a test-case index: 02" });
      expect(item.actions[0].args).toEqual({ command: "/qa-design-tests", arg: "001-case-escalation" });
    } finally { parsed[0].feature.stories = saved; }
  });
  it("asks for testability (G2) before the AI picks stories up", () => {
    const item = queue("tester", []).find((i) => i.kind === "testability")!;
    expect(item).toMatchObject({ gate: "G2", featureId: "001", detail: "Jira not connected: status unknown, check in Jira" });
    expect(item.links.filter((l) => l.kind === "jira").map((l) => l.label)).toEqual(["ABC-11", "ABC-12", "ABC-13", "Epic ABC-10"]);
    const connected = queue("tester", [], undefined, { jiraConnected: true }, { "ABC-11": ["ai-ready"], "ABC-12": [], "ABC-13": [] });
    // Counts and links only the stories G2 is waiting on (ABC-11 is already ai-ready).
    const t = connected.find((i) => i.kind === "testability")!;
    expect(t.detail).toBe("2 stories without ai-ready: ABC-12, ABC-13");
    expect(t.links.filter((l) => l.kind === "jira").map((l) => l.label)).toEqual(["ABC-12", "ABC-13", "Epic ABC-10"]);
    // A story already in progress still counts when it lacks ai-ready, because G2 counts it.
    const started = queue("tester", freshPrs(), undefined, { jiraConnected: true }, { "ABC-11": ["ai-ready"], "ABC-12": ["ai-ready"], "ABC-13": [] });
    expect(started.find((i) => i.kind === "testability")!.detail).toBe("1 story without ai-ready: ABC-13");
    const done = queue("tester", [], undefined, { jiraConnected: true }, { "ABC-11": ["ai-ready"], "ABC-12": ["ai-ready"], "ABC-13": ["ai-ready"] });
    expect(done.some((i) => i.kind === "testability")).toBe(false);
  });
});

describe("GitHub not readable", () => {
  it("adds a connect item to every queue", () => {
    for (const p of ["architect", "developer", "tester"] as const) {
      const q = queue(p, [], undefined, { githubError: "Not signed in" });
      expect(q[0]).toMatchObject({ kind: "connect", id: `${p}:connect:github`, detail: "Not signed in" });
      // It links to the repo on GitHub and offers a way to fix it.
      expect(q[0].links).toEqual([{ kind: "github", label: "acme/sales", target: "https://github.com/acme/sales/pulls" }]);
      expect(q[0].actions).toEqual([{ id: "nav:connections", label: "Open Connections", persona: p, kind: "nav" }]);
    }
  });
  it("pins review and merge buttons to the PR head commit", () => {
    const sha = "c".repeat(40);
    const prs = freshPrs().map((p) => ({ ...p, headSha: sha }));
    const dev = queue("architect", prs).flatMap((i) => i.actions).filter((a) => a.id === "gate:review");
    expect(dev.length).toBeGreaterThan(0);
    expect(dev.every((a) => a.args!.sha === sha)).toBe(true);
    const green = prs.map((p) => (p.number === 44 ? { ...p, checks: Object.fromEntries(Object.keys(p.checks).map((k) => [k, "success" as const])) } : p));
    const merges = queue("architect", green).flatMap((i) => i.actions).filter((a) => a.id === "gate:merge");
    expect(merges.map((m) => m.args)).toContainEqual({ pr: 44, sha });
    expect(merges.every((m) => m.args!.sha === sha)).toBe(true);
  });
  it("item ids are unique per persona", () => {
    for (const p of ["architect", "developer", "tester"] as const) {
      const ids = queue(p).map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
