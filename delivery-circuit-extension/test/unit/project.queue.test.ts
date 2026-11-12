// v3 features, gates and queues (docs/CIRCUIT-V3.md sections 3 and 4), built from recorded acli and reader outputs
// plus the GitHub PR fixture.
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import type { Persona, QueueItem } from "../../src/core/contracts";
import { normalizeIssues } from "../../src/project/acli";
import { normalizePage, withPageOnlyFeatures } from "../../src/project/design";
import { decisionsDetail, designDetail, orgSnapshotDetail, storyDetail } from "../../src/project/details";
import { aggregate, buildFeatures, linkPrs, nextGate, pageFeatureId, slugify, storyPr } from "../../src/project/gates";
import { mapPrsResponse } from "../../src/project/github";
import { groupFeatures, parseConfig } from "../../src/project/jira";
import { normalizeListing, readerJson } from "../../src/project/mcpReader";
import type { DeployInfo, DesignPage, FeatureInfo, FeatureSource, JiraIssue, PrInfo } from "../../src/project/model";
import { buildQueue, failingChecks, startBlocker, V3_ACTIONS, type QueueEnv } from "../../src/project/queue";

const FIX = path.join(__dirname, "..", "fixtures", "project");
const raw = (p: string) => fs.readFileSync(path.join(FIX, p), "utf8");
const reader = (p: string) => readerJson({ code: 0, stdout: raw(p), stderr: "" });
const cfg = parseConfig(raw("repo/build.config.yml"));
const repo = { owner: "acme", repo: "sales" };
const jiraBrowseUrl = (k: string) => `https://acme.atlassian.net/browse/${k}`;
const resp = JSON.parse(raw("github-prs.json"));

const issues = () => ({
  epics: normalizeIssues(JSON.parse(raw("acli/epics.json"))),
  children: normalizeIssues(JSON.parse(raw("acli/children.json"))),
  tests: normalizeIssues(JSON.parse(raw("acli/tests.json"))),
});
const pages: Record<string, DesignPage> = Object.fromEntries(["123456", "222222", "333333"].map((id) => [id, normalizePage(reader(`confluence/page-${id}.json`), id, "2026-11-12T00:00:00.000Z")]));

function sources(edit?: (i: ReturnType<typeof issues>) => void, pageEdit?: (p: Record<string, DesignPage>) => void): FeatureSource[] {
  const i = issues();
  edit?.(i);
  const p = { ...pages };
  pageEdit?.(p);
  const listing = normalizeListing(reader("confluence/listing.json"));
  return withPageOnlyFeatures(groupFeatures(i.epics, i.children, i.tests, cfg.fields), listing)
    .map((s) => (s.pageId && p[s.pageId] ? { ...s, page: p[s.pageId] } : s));
}
const freshPrs = (): PrInfo[] => mapPrsResponse(resp).prs;
function build(opts: { prs?: PrInfo[]; deploy?: DeployInfo; edit?: (i: ReturnType<typeof issues>) => void; pageEdit?: (p: Record<string, DesignPage>) => void } = {}) {
  const prs = opts.prs ?? freshPrs();
  const features = buildFeatures(sources(opts.edit, opts.pageEdit), prs, opts.deploy, cfg, { repo, jiraBrowseUrl });
  return { features, prs };
}
const env = (over: Partial<QueueEnv> = {}): QueueEnv => ({ repo, jiraBrowseUrl, maxAttempts: 3, ...over });
function queue(persona: Persona, opts: Parameters<typeof build>[0] & { env?: Partial<QueueEnv> } = {}): QueueItem[] {
  const { features, prs } = build(opts);
  return buildQueue(persona, { features, prs, deploy: opts.deploy, env: env(opts.env) });
}
const kinds = (q: QueueItem[]) => q.map((i) => `${i.kind}:${i.prNumber ?? i.storyKey ?? i.featureId ?? ""}`);
const issue = (i: ReturnType<typeof issues>, key: string): JiraIssue => [...i.epics, ...i.children, ...i.tests].find((x) => x.key === key)!;
const prNode = (n: number) => resp.data.repository.open.nodes.find((x: any) => x.number === n);
const withPr = (edit: (prs: PrInfo[]) => void) => { const prs = freshPrs(); edit(prs); return prs; };
const pr = (prs: PrInfo[], n: number) => prs.find((p) => p.number === n)!;

describe("gate helpers", () => {
  it("aggregates per-story marks", () => {
    expect(aggregate([])).toBe("not-started");
    expect(aggregate(["ok", "ok"])).toBe("done");
    expect(aggregate(["ok", "none"])).toBe("waiting");
    expect(aggregate(["none", "none"])).toBe("not-started");
    expect(aggregate(["ok", "waiting", "blocked"])).toBe("blocked");
  });
  it("links story PRs to their epic by the Jira key in the branch", () => {
    const { features, prs } = build();
    const by = (n: number) => linkPrs(features, prs).find((p) => p.number === n)!;
    expect([by(42).featureId, by(42).storyKey]).toEqual(["ABC-10", "ABC-12"]);
    expect(by(44).featureId).toBe("ABC-10");
    expect(by(46).featureId).toBeUndefined(); // ABC-99 is not a story of a feature epic
    expect(by(40).storyKey).toBeUndefined(); // not a feature/<KEY>- branch
  });
  it("prefers the open PR of a story, else the latest merged, never a closed one", () => {
    const base = freshPrs().find((p) => p.number === 42)!;
    const mk = (n: number, state: PrInfo["state"], mergedAt?: string): PrInfo => ({ ...base, number: n, state, mergedAt });
    expect(storyPr([mk(1, "merged", "2026-01-01"), mk(2, "merged", "2026-02-01"), mk(3, "closed")], "ABC-12")!.number).toBe(2);
    expect(storyPr([mk(1, "merged", "2026-01-01"), mk(4, "open")], "ABC-12")!.number).toBe(4);
    expect(storyPr([mk(3, "closed")], "ABC-12")).toBeUndefined();
    expect(slugify("Agent escalates a Case!")).toBe("agent-escalates-a-case");
  });
});

describe("features from Jira epics and Confluence design pages", () => {
  const { features } = build();
  const f = features[0];
  it("one feature per epic plus page-only designs", () => {
    expect(features.map((x) => [x.id, x.title, x.epicKey ?? null, x.design?.pageId ?? null])).toEqual([
      ["ABC-10", "Case escalation", "ABC-10", "123456"],
      ["ABC-20", "Partner onboarding", "ABC-20", "222222"],
      [pageFeatureId("333333"), "Returns portal", null, "333333"],
    ]);
    expect(f.slug).toBe("ABC-10-case-escalation");
    expect(f.links).toEqual([
      { kind: "jira", label: "Epic ABC-10", target: "https://acme.atlassian.net/browse/ABC-10" },
      { kind: "confluence", label: "Design: Case escalation design", target: "https://acme.atlassian.net/wiki/spaces/SD/pages/123456/Case+escalation" },
      { kind: "confluence", label: "Org snapshot", target: "https://acme.atlassian.net/wiki/spaces/SD/pages/123457/Org+snapshot" },
    ]);
    expect(f.sources).toEqual(["fireflies:01JD7K2M9Q", "upload:3f9a0c1b2d4e"]);
  });
  it("stories carry Jira facts, C5, test cases and PR numbers", () => {
    expect(f.stories.map((s) => [s.jiraKey, s.num, s.designSync, s.testCases.length, s.prNumber ?? null])).toEqual([
      ["ABC-11", "00", "ok", 1, 44], ["ABC-12", "01", "ok", 2, 42], ["ABC-13", "02", "changed", 1, 43], ["ABC-14", "03", "ok", 1, null], ["ABC-15", "04", "missing", 0, null],
    ]);
    const s01 = f.stories[1];
    expect(s01).toMatchObject({ title: "Agent escalates a Case", status: "In Progress", approvedDesignVersion: 3, testabilityConfirmed: true, blockedBy: ["ABC-11"], url: "https://acme.atlassian.net/browse/ABC-12" });
    expect(s01.acceptanceCriteria).toContain("AC1: Agent escalates with a reason");
  });
  it("computes gates G1-G9 and stages", () => {
    expect(f.design!.approval).toMatchObject({ state: "approved", approvedVersion: 3, approverIsArchitect: true });
    expect(f.gates).toEqual({ G1: "done", G2: "waiting", G3: "waiting", G4: "waiting", G5: "waiting", G6: "waiting", G7: "waiting", G8: "waiting", G9: "not-started" });
    expect(f.signedOff).toBe(true);
    expect(nextGate(f)).toBe("G2");
    expect(f.stages).toMatchObject({ intake: "done", clarify: "done", plan: "done", signoff: "done", stories: "done", tests: "active", build: "active", release: "todo" });
    expect(features[1].gates.G1).toBe("waiting"); // In progress
    expect(features[1].openQuestions).toBe(2);
    expect(features[1].stages).toMatchObject({ clarify: "active", signoff: "active" });
    expect(features[2].gates).toMatchObject({ G1: "waiting", G2: "not-started" });
  });
  it("G1 is blocked when someone outside architects set Approved, and unknown before the page is read", () => {
    const { features: bad } = build({ pageEdit: (p) => { p["123456"] = { ...p["123456"], versions: [{ number: 3, by: "dev.person@example.com", message: "Approved v3" }] }; } });
    expect(bad[0].gates.G1).toBe("blocked");
    expect(bad[0].stages.signoff).toBe("blocked");
    const { features: unread } = build({ pageEdit: (p) => { delete p["123456"]; } });
    expect(unread[0].design!.approval.state).toBe("unknown");
    expect(unread[0].gates.G1).toBe("waiting");
    expect(unread[0].stories.every((s) => s.designSync === "unknown")).toBe(true);
  });
  it("G9 from production deploy runs after the last merge", () => {
    const merged = withPr((prs) => { for (const p of prs) if (p.storyKey && p.storyKey !== "ABC-99") { p.state = "merged"; p.mergedAt = "2026-11-10T00:00:00Z"; } });
    const run = (status: string, conclusion: string | null) => ({ runs: [{ id: 7, status, conclusion, url: "https://github.com/acme/sales/actions/runs/7", createdAt: "2026-11-11T00:00:00Z", headSha: "abc" }] });
    const g = (deploy?: DeployInfo) => build({ prs: merged.map((p) => ({ ...p })), deploy }).features[0].gates;
    // ABC-14 and ABC-15 have no PR yet, so the feature is not fully merged.
    expect(g(run("waiting", null)).G9).toBe("not-started");
    const all = (deploy?: DeployInfo) => build({ prs: merged.map((p) => ({ ...p })), deploy, edit: (i) => { i.children = i.children.filter((c) => !["ABC-14", "ABC-15"].includes(c.key)); } }).features[0].gates;
    expect(all(undefined)).toMatchObject({ G8: "done", G9: "waiting" });
    expect(all(run("waiting", null)).G9).toBe("waiting");
    expect(all(run("completed", "failure")).G9).toBe("blocked");
    expect(all(run("completed", "success")).G9).toBe("done");
    expect(all({ runs: [], prodDeployedAt: "2026-11-11T00:00:00Z" }).G9).toBe("done");
  });
});

describe("architect queue", () => {
  it("approve design, clarify, design changed, schema review and merge", () => {
    const q = queue("architect");
    expect(kinds(q)).toEqual(["design-changed:ABC-10", "clarify:ABC-20", "sign-off:ABC-20", "sign-off:page-333333", "review-pr:43", "merge:44"]);
    const approve = q.find((i) => i.id === "architect:sign-off:ABC-20")!;
    expect(approve).toMatchObject({ gate: "G1", title: "Partner onboarding: approve design" });
    expect(approve.actions[0]).toEqual({ id: "arch:approve-design", label: "Approve design", persona: "architect", kind: "nav",
      args: { featureId: "ABC-20", pageId: "222222", url: "https://acme.atlassian.net/wiki/spaces/SD/pages/222222/Partner+onboarding" } });
    expect(approve.actions.map((a) => a.id)).toEqual(["arch:approve-design", "ai:/arch-design", "decision:record"]);
    expect(approve.actions[2].args).toEqual({ featureId: "ABC-20", pageId: "222222", command: "/record-decision", arg: "ABC-20" });
    const changed = q.find((i) => i.kind === ("design-changed" as any))!;
    expect(changed.detail).toContain("ABC-13: Design changed since this story was planned: re-plan or re-approve (story v2, page v3)");
    expect(changed.detail).toContain("ABC-15: Story has no Approved design version");
    const merge = q.find((i) => i.kind === "merge")!;
    expect(merge.actions[0]).toMatchObject({ id: "gate:merge", kind: "gate", args: { pr: 44 } });
    const review = q.find((i) => i.kind === "review-pr")!;
    expect(review.actions.map((a) => a.id)).toEqual(["ai:/arch-review-pr", "gate:review", "gate:review"]);
  });
  it("no design page yet: design with AI; approved without stories: create stories", () => {
    const q = queue("architect", { edit: (i) => { delete issue(i, "ABC-20").fields.customfield_10050; i.children = i.children.filter((c) => c.parentKey !== "ABC-10"); } });
    expect(kinds(q)).toEqual(expect.arrayContaining(["clarify:ABC-20", "create-stories:ABC-10"]));
    const noPage = q.find((i) => i.id === "architect:clarify:ABC-20:design")!;
    expect(noPage.actions[0]).toMatchObject({ id: "ai:/arch-design", args: { command: "/arch-design", arg: "ABC-20" } });
    expect(q.find((i) => i.kind === ("create-stories" as any))!.actions[0]).toMatchObject({ id: "ai:/arch-jira-push", args: { arg: "ABC-10" } });
  });
  it("release: production deployment waiting for approval (no AI)", () => {
    const deploy: DeployInfo = { runs: [{ id: 5, status: "waiting", conclusion: null, url: "https://github.com/acme/sales/actions/runs/5", createdAt: "2026-11-10T00:00:00Z", headSha: "abcdef1234" }] };
    const item = queue("architect", { deploy }).find((i) => i.kind === "deploy-approval")!;
    expect(item).toMatchObject({ gate: "G9", detail: "deploy-prod run 5 (abcdef12), no AI" });
    expect(item.actions).toEqual([{ id: "gate:deploy", label: "Review deployment", persona: "architect", kind: "gate", args: { runId: 5 } }]);
  });
});

describe("developer queue", () => {
  it("plans, re-plan on design change, needs-human and code review", () => {
    const q = queue("developer", { env: { login: "dev1" } });
    expect(kinds(q)).toEqual(["approve-plan:42", "design-changed:43", "needs-human:46"]);
    const replan = q.find((i) => i.kind === ("design-changed" as any))!;
    expect(replan.actions[0]).toMatchObject({ id: "dev:start-story", kind: "ai", args: { command: "/dev-start-story", arg: "ABC-13", storyKey: "ABC-13", pr: 43, replan: "yes" } });
    expect(q[0].actions.map((a) => a.id)).toEqual(["ai:/dev-review-plan", "gate:label"]);
    expect(q[0].actions[1].args).toEqual({ pr: 42, label: "plan-approved" });
  });
  it("story review before any story starts", () => {
    const q = queue("developer", { prs: [] });
    const item = q.find((i) => i.kind === "review-stories")!;
    expect(item.title).toBe("Case escalation: story review (2 stories)");
    expect(item.actions[0]).toMatchObject({ id: "ai:/dev-review-stories", args: { arg: "ABC-10" } });
  });
  it("Start story: Story 00 first, blockers respected, ai-ready only", () => {
    const q = queue("developer", { prs: [] });
    expect(q.filter((i) => i.kind === ("start-story" as any)).map((i) => i.storyKey)).toEqual(["ABC-11"]);
    const start = q.find((i) => i.storyKey === "ABC-11")!;
    expect(start.title).toBe("ABC-11 Foundation");
    expect(start.actions).toEqual([{ id: "dev:start-story", label: "Start story", persona: "developer", kind: "ai",
      args: { storyKey: "ABC-11", featureId: "ABC-10", command: "/dev-start-story", arg: "ABC-11" } }]);
    // once Story 00 is merged, the stories it blocked can start (ABC-13 is on an old design, ABC-15 is not ai-ready)
    const merged = withPr((prs) => { const p = pr(prs, 44); p.state = "merged"; p.mergedAt = "2026-11-10T00:00:00Z"; });
    const after = queue("developer", { prs: merged.filter((p) => [44].includes(p.number)) });
    expect(after.filter((i) => i.kind === ("start-story" as any)).map((i) => i.storyKey)).toEqual(["ABC-12", "ABC-14"]);
    const { features, prs } = build({ prs: [] });
    expect(startBlocker(features[0], features[0].stories[1], prs)).toBe("Story 00 (ABC-11) goes first");
  });
  it("Fix with AI on own failing PRs, capped at the attempt limit", () => {
    const mine = withPr((prs) => { for (const p of prs) p.author = "dev1"; });
    const q = queue("developer", { prs: mine, env: { login: "dev1" } });
    const fix = q.find((i) => i.kind === ("fix" as any) && i.prNumber === 43)!;
    expect(failingChecks(pr(mine, 43))).toEqual(["qa", "reviewer"]);
    expect(fix.detail).toBe("Failing: qa, reviewer (AI attempt 3 of 3)");
    expect(fix.actions[0]).toEqual({ id: "dev:fix", label: "Fix with AI", persona: "developer", kind: "ai", args: { pr: 43, checks: "qa,reviewer", attempt: 3, command: "/dev-fix", arg: "43" } });
    const capped = withPr((prs) => { for (const p of prs) p.author = "dev1"; pr(prs, 43).aiAttempt = 3; });
    expect(queue("developer", { prs: capped, env: { login: "dev1" } }).some((i) => i.kind === ("fix" as any) && i.prNumber === 43)).toBe(false);
    // someone else's PR: no Fix item
    expect(queue("developer", { env: { login: "dev2" } }).some((i) => i.kind === ("fix" as any))).toBe(false);
  });
  it("Open review room when green, then Record verdict", () => {
    const green = withPr((prs) => { const p = pr(prs, 42); p.author = "dev1"; p.draft = false; p.labels.push("plan-approved"); p.checks = { guard: "success" }; });
    const open = queue("developer", { prs: green, env: { login: "dev1" } }).find((i) => i.prNumber === 42 && i.kind === ("review-room" as any))!;
    expect(open.actions[0]).toEqual({ id: "review:open-room", label: "Open review room", persona: "developer", kind: "ai", args: { pr: 42, command: "/review-room", arg: "open 42" } });
    pr(green, 42).labels.push("review-room");
    const verdict = queue("developer", { prs: green, env: { login: "dev1" } }).find((i) => i.prNumber === 42 && i.kind === ("record-verdict" as any))!;
    expect(verdict.actions[0]).toMatchObject({ id: "review:record-verdict", args: { pr: 42, command: "/review-room", arg: "verdict 42" } });
    pr(green, 42).labels.push("review-verdict");
    expect(queue("developer", { prs: green, env: { login: "dev1" } }).some((i) => i.prNumber === 42 && ["review-room", "record-verdict"].includes(i.kind))).toBe(false);
  });
  it("code review (G5) on teammates' ready PRs", () => {
    const prs = withPr((list) => { pr(list, 43).checks["gate/developer"] = "missing"; pr(list, 43).labels = pr(list, 43).labels.filter((l) => l !== "ai-attempt-2"); });
    const q = queue("developer", { prs, env: { login: "dev1" } });
    const review = q.find((i) => i.kind === "review-pr" && i.prNumber === 43)!;
    expect(review.gate).toBe("G5");
    expect(review.actions.map((a) => a.id)).toEqual(["ai:/dev-review-pr", "gate:review", "gate:review"]);
  });
});

describe("tester queue", () => {
  it("design tests, add tests to the PR, test plan and QA review", () => {
    const q = queue("tester", { env: { login: "qa1" } });
    expect(kinds(q)).toEqual(["design-tests:ABC-10", "add-tests:42", "qa-pr:43", "approve-testplan:46"]);
    const add = q.find((i) => i.kind === ("add-tests" as any))!;
    expect(add.title).toBe("Add tests to ABC-12");
    expect(add.actions[0]).toEqual({ id: "qa:add-tests", label: "Add tests to ABC-12", persona: "tester", kind: "ai",
      args: { pr: 42, storyKey: "ABC-12", suite: "test-cases/ABC-12.sf-tests.yaml", tcIndex: "tests/ABC-12.tc.json", command: "/qa-add-tests", arg: "ABC-12" } });
    expect(q.find((i) => i.kind === "design-tests")!.detail).toBe("No Jira test cases yet: ABC-15");
    const qa = q.find((i) => i.kind === "qa-pr")!;
    expect(qa.actions.map((a) => a.id)).toEqual(["ai:/qa-explore", "gate:review", "gate:review", "nav:testing"]);
  });
  it("testability (G2) for stories with test cases but no ai-ready", () => {
    const q = queue("tester", { prs: [], edit: (i) => { const s = issue(i, "ABC-14"); s.labels = []; } });
    const item = q.find((i) => i.kind === "testability")!;
    expect(item).toMatchObject({ gate: "G2", featureId: "ABC-10" });
    expect(item.detail).toContain("ABC-14");
  });
  it("needs-qa goes to the Tester", () => {
    const prs = withPr((list) => { pr(list, 43).labels.push("needs-qa"); });
    expect(queue("tester", { prs }).find((i) => i.prNumber === 43)!.kind).toBe("needs-qa");
  });
  it("does not ask for tests when the file list may be truncated", () => {
    const prs = withPr((list) => { pr(list, 42).files = Array.from({ length: 100 }, (_, i) => `force-app/f${i}.cls`); });
    expect(queue("tester", { prs }).some((i) => i.kind === ("add-tests" as any))).toBe(false);
  });
});

describe("connect notices", () => {
  it("GitHub and Jira errors become connect items", () => {
    const q = queue("tester", { env: { githubError: "Not signed in to GitHub", jiraError: "Atlassian CLI is not logged in. Run: acli jira auth login --web" } });
    expect(q.slice(0, 2).map((i) => [i.kind, i.id])).toEqual([["connect", "tester:connect:github"], ["connect", "tester:connect:jira"]]);
    expect(q[1].actions[0]).toEqual({ id: "nav:connections", label: "Open Connections", persona: "tester", kind: "nav" });
  });
  it("every new action id is one of the v3 ids", () => {
    expect(Object.keys(V3_ACTIONS).sort()).toEqual(["arch:approve-design", "decision:record", "dev:fix", "dev:start-story", "qa:add-tests", "review:open-room", "review:record-verdict"]);
    const ids = new Set<string>();
    for (const p of ["architect", "developer", "tester"] as const) {
      for (const it of [...queue(p), ...queue(p, { prs: [] })]) for (const a of it.actions) ids.add(a.id.split(":").slice(0, 2).join(":"));
    }
    for (const id of ids) expect(id).toMatch(/^(ai:\/[a-z-]+|gate:(label|review|merge|deploy)|nav:(feature|testing|connections)|arch:approve-design|decision:record|dev:(start-story|fix)|qa:add-tests|review:(open-room|record-verdict))$/);
  });
});

describe("Circuit MCP detail reads", () => {
  const { features, prs } = build();
  const f = features[0] as FeatureInfo;
  it("design_get: approved version and how to read it", () => {
    const d: any = designDetail(f, pages["123456"]);
    expect(d).toMatchObject({ featureId: "ABC-10", pageId: "123456", status: "Approved", currentVersion: 3, approvedVersion: 3, approvedBy: "demo.user@example.com", state: "approved" });
    expect(d.howToRead).toContain("getConfluenceContentVersion for page 123456 version 3");
    expect((designDetail(features[1], pages["222222"]) as any).howToRead).toMatch(/not approved yet/);
  });
  it("decisions_get and org_snapshot_get", () => {
    expect((decisionsDetail(f, pages["123456"]) as any).decisions).toHaveLength(2);
    expect((orgSnapshotDetail(f, pages["123456"]) as any).snapshot.fields).toEqual(["Case.Escalation_Reason__c", "Case.Escalated__c"]);
    expect((orgSnapshotDetail(features[1], pages["222222"]) as any).snapshot).toBeNull();
  });
  it("story_get: ACs, C5, testability, names and PR", () => {
    const s: any = storyDetail(f, f.stories[2], prs);
    expect(s).toMatchObject({ key: "ABC-13", design: { storyApprovedVersion: 2, pageApprovedVersion: 3, c5: "changed" }, testability: { aiReady: true, g2: true },
      branch: "feature/ABC-13-escalation-queue", suite: "test-cases/ABC-13.sf-tests.yaml", tcIndex: "tests/ABC-13.tc.json", plan: "docs/plans/ABC-13/PLAN.md" });
    expect(s.pr).toMatchObject({ number: 43, state: "open" });
    const fresh: any = storyDetail(f, f.stories[4], prs);
    expect(fresh).toMatchObject({ branch: "feature/ABC-15-escalation-email", prTitle: "ABC-15 Escalation email", pr: null });
  });
  it("uses the PR fixture shape", () => { expect(prNode(43).headRefName).toBe("feature/ABC-13-escalation-queue"); });
});
