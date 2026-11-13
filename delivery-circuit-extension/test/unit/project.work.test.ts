// The work model (docs/CIRCUIT-V4.md section 7): story status mapping, next steps per role, missing items, story panel.
import { describe, expect, it } from "vitest";
import { STORY_STATUS_LABEL, type ConnectionStatus } from "../../src/core/contracts";
import { baseStatus } from "../../src/connections/catalog";
import type { JiraIssue, PrInfo } from "../../src/project/model";
import { deployedAfter, MAX_NEXT, missingItems, nextSteps, sprintRows, storyDetail, storyPr, storyStatus } from "../../src/project/work";
import { ENVIRONMENTS, NOW, workData } from "./workFixture";

const issue = (p: Partial<JiraIssue>): JiraIssue => ({ key: "ABC-1", summary: "Story 01: x", issueType: "Story", status: "To Do", statusCategory: "new", labels: [], links: [], fields: {}, ...p });
const pr = (p: Partial<PrInfo>): PrInfo => ({
  number: 1, url: "https://github.com/acme-org/acme-salesforce/pull/1", title: "ABC-1 x", author: "dev1", head: "feature/ABC-1-x", base: "sprint/2026-11",
  draft: false, state: "open", createdAt: "2026-11-13T00:00:00Z", updatedAt: "", storyKey: "ABC-1", scan: "success", coderabbit: "pending",
  approvedBy: [], changesBy: [], autoMerge: true, ...p,
});
const rows = (role: Parameters<typeof nextSteps>[0], login = "dev1") => nextSteps(role, workData(), login).map((r) => [r.id, r.title, r.button]);

describe("story status: Design · Ready · Building · In PR · QA · Done", () => {
  const R = "Ready for Dev";
  it("maps Jira and GitHub to one status", () => {
    expect(storyStatus(issue({}), undefined, R)).toBe("design");
    expect(storyStatus(issue({ status: "Ready for Dev" }), undefined, R)).toBe("ready");
    expect(storyStatus(issue({ status: "ready for dev", statusCategory: "indeterminate" }), undefined, R)).toBe("ready");
    expect(storyStatus(issue({ status: "In Progress", statusCategory: "indeterminate" }), undefined, R)).toBe("building");
    expect(storyStatus(issue({ status: "In Progress", statusCategory: "indeterminate" }), pr({}), R)).toBe("in-pr");
    expect(storyStatus(issue({ status: "In Progress", statusCategory: "indeterminate" }), pr({ state: "merged" }), R)).toBe("qa");
    expect(storyStatus(issue({ status: "In QA", statusCategory: "indeterminate" }), undefined, R)).toBe("qa");
    expect(storyStatus(issue({ status: "Done", statusCategory: "done" }), pr({}), R)).toBe("done");
    expect(Object.values(STORY_STATUS_LABEL)).toEqual(["Design", "Ready", "Building", "In PR", "QA", "Done"]);
  });
  it("a story's PR is the open one, else the newest merged one; closed PRs never count", () => {
    const prs = [pr({ number: 1, state: "closed" }), pr({ number: 2, state: "merged", mergedAt: "2026-11-01T00:00:00Z" }), pr({ number: 3, state: "merged", mergedAt: "2026-11-02T00:00:00Z" })];
    expect(storyPr(prs, "ABC-1")?.number).toBe(3);
    expect(storyPr([...prs, pr({ number: 4 })], "ABC-1")?.number).toBe(4);
    expect(storyPr([pr({ state: "closed" })], "ABC-1")).toBeUndefined();
  });
  it("deployed = a successful deploy.yml run on the branch after the merge", () => {
    const runs = [{ id: 1, branch: "sprint/2026-11", status: "completed", conclusion: "success", url: "", createdAt: "2026-11-10T10:05:00Z" }];
    expect(deployedAfter(runs, "sprint/2026-11", "2026-11-10T10:00:00Z")).toBe(true);
    expect(deployedAfter(runs, "sprint/2026-11", "2026-11-10T11:00:00Z")).toBe(false);
    expect(deployedAfter(runs, "dev", "2026-11-10T10:00:00Z")).toBe(false);
  });
  it("the sprint list on the fixture", () => {
    expect(sprintRows(workData()).map((r) => [r.key, r.status])).toEqual([["ABC-11", "qa"], ["ABC-12", "in-pr"], ["ABC-13", "in-pr"], ["ABC-14", "ready"], ["ABC-15", "design"]]);
  });
});

describe("next steps per role (one button each, at most five)", () => {
  it("Architect: new design, finish designs with open questions, create stories for approved pages without an epic", () => {
    expect(rows("architect")).toEqual([
      ["intake", "New design from transcript", "Start"],
      ["design:222222", "Finish design Partner onboarding", "Finish"],
      ["stories:333333", "Create stories for Returns portal", "Create"],
    ]);
    const n = nextSteps("architect", workData());
    expect(n[1].run).toEqual({ kind: "skill", role: "architect", command: "/arch-design", arg: "order-sync" });
    expect(n[2].run).toEqual({ kind: "skill", role: "architect", command: "/arch-jira-push", arg: "returns-portal" });
  });
  it("Developer: fix own failing PRs, review teammates' PRs, build Ready stories", () => {
    expect(rows("developer")).toEqual([
      ["fix:41", "Fix ABC-12", "Fix"], ["review:43", "Review PR #43", "Open"], ["review:44", "Review PR #44", "Open"], ["build:ABC-14", "Build ABC-14", "Build"],
    ]);
    const n = nextSteps("developer", workData(), "dev1");
    expect(n[0]).toMatchObject({ detail: "Scan failed", run: { kind: "skill", role: "developer", command: "/dev-fix", arg: "ABC-12" } });
    expect(n[1].run).toEqual({ kind: "url", url: "https://github.com/acme-org/acme-salesforce/pull/43" });
    expect(n[3].run).toEqual({ kind: "skill", role: "developer", command: "/dev-start-story", arg: "ABC-14" });
    // dev2 owns #43 and #44; #41 is not theirs to fix and fails its scan, so it is not offered for review yet
    expect(nextSteps("developer", workData(), "dev2").map((r) => r.id)).toEqual(["build:ABC-14"]);
  });
  it("QA: test merged and deployed stories in QA; write tests for stories without test cases", () => {
    expect(rows("tester")).toEqual([["qa:ABC-11", "Test ABC-11 in QA", "Test"]]);
    const d = workData();
    d.tests = d.tests.filter((t) => t.key !== "ABC-35");
    d.deploys = [];
    expect(nextSteps("tester", d).map((r) => [r.id, r.run])).toEqual([["tests:ABC-14", { kind: "skill", role: "tester", command: "/qa-design-tests", arg: "ABC-14" }]]);
  });
  it("Lead: production approval, sprint promotion (create or open), open promotion PRs", () => {
    expect(rows("lead")).toEqual([
      ["prod:901", "Approve production deploy", "Open"],
      ["promote:sprint/2026-11", "Sprint review: promote sprint/2026-11 → dev", "Create"],
      ["promote:dev", "Promote dev → sit", "Open"],
    ]);
    expect(nextSteps("lead", workData())[1].run).toEqual({ kind: "url", url: "https://github.com/acme-org/acme-salesforce/compare/dev...sprint/2026-11?expand=1" });
    const d = workData();
    d.prs.push(pr({ number: 50, head: "sprint/2026-11", base: "dev", storyKey: undefined, url: "https://github.com/acme-org/acme-salesforce/pull/50" }));
    expect(nextSteps("lead", d)[1]).toMatchObject({ button: "Open", detail: "PR #50 · waits for a lead", run: { kind: "url", url: "https://github.com/acme-org/acme-salesforce/pull/50" } });
    d.sprintAhead = 0; d.prs.pop();
    expect(nextSteps("lead", d).map((r) => r.id)).toEqual(["prod:901", "promote:dev"]);
  });
  it("never more than five rows", () => {
    const d = workData();
    for (let i = 0; i < 8; i++) d.stories.push(issue({ key: `ABC-${100 + i}`, status: "Ready for Dev", parentKey: "ABC-10" }));
    expect(nextSteps("developer", d, "dev1")).toHaveLength(MAX_NEXT);
  });
  it("no gate numbers or jargon in titles", () => {
    for (const r of ["architect", "developer", "tester", "lead"] as const) {
      for (const s of nextSteps(r, workData(), "dev1")) expect(`${s.title} ${s.detail ?? ""}`).not.toMatch(/\bG\d\b|gate|persona|C5/i);
    }
  });
});

describe("Missing tab", () => {
  const conn = (id: ConnectionStatus["id"], state: ConnectionStatus["state"]): ConnectionStatus => ({ ...baseStatus(id), state });
  const conns = [conn("github", "connected"), conn("claude", "disconnected"), conn("sf-dev", "error"), conn("lucid", "disconnected"),
    conn("fireflies", "disconnected"), conn("coderabbit", "disconnected"), conn("atlassian", "checking")];
  it("connections the role needs, repo setup (names only) and story gaps", () => {
    const m = missingItems("developer", workData(), conns, ENVIRONMENTS, NOW);
    expect(m.map((x) => [x.group, x.id, x.title, x.button])).toEqual([
      ["connections", "conn:claude", "Connect Claude", "Connect"],
      ["connections", "conn:sf-dev", "Fix Salesforce DEV org", "Fix"],
      ["connections", "conn:coderabbit", "Connect CodeRabbit", "Connect"],
      ["repo", "repo:bootstrap", "Set up the repo", "Set up"],
      ["repo", "repo:branch:uat", "Branch uat is missing", "Open"],
      ["repo", "repo:secret:sit", "sit: no SFDX_AUTH_URL secret", "Open"],
      ["repo", "repo:env:uat", "Environment uat is missing", "Open"],
      ["repo", "repo:automerge", "Auto-merge is off", "Open"],
      ["stories", "ac:ABC-13", "ABC-13: no acceptance criteria", "Open"],
      ["stories", "ac:ABC-14", "ABC-14: no acceptance criteria", "Open"],
      ["stories", "ac:ABC-15", "ABC-15: no acceptance criteria", "Open"],
      ["stories", "scan:41", "ABC-12: scan failing", "Open"],
      ["stories", "rabbit:41", "ABC-12: CodeRabbit asked for changes", "Open"],
      ["stories", "wait:41", "PR #41 waits for a review", "Open"],
      ["stories", "nokey:43", "PR #43 has no Jira key", "Open"],
    ]);
    expect(m.find((x) => x.id === "repo:secret:sit")!.run).toEqual({ kind: "url", url: "https://github.com/acme-org/acme-salesforce/settings/environments" });
    expect(m.find((x) => x.id === "conn:claude")!.run).toEqual({ kind: "connect", id: "claude" });
    expect(m.find((x) => x.id === "wait:41")!.detail).toBe("3 d without an approval");
  });
  it("hides connections other roles need and lists CodeRabbit under repo setup for them", () => {
    const m = missingItems("tester", workData(), conns, ENVIRONMENTS, NOW);
    expect(m.filter((x) => x.group === "connections").map((x) => x.id)).toEqual(["conn:claude"]);
    expect(m.some((x) => x.id === "repo:coderabbit")).toBe(true);
    const a = missingItems("architect", workData(), conns, ENVIRONMENTS, NOW);
    expect(a.filter((x) => x.group === "connections").map((x) => x.id)).toEqual(["conn:claude", "conn:sf-dev", "conn:lucid"]); // Fireflies is optional
  });
  it("story gaps: unapproved design, missing test cases; nothing when all is in place", () => {
    const d = workData();
    d.features[0].page = { ...d.features[0].page!, status: "In progress" };
    d.tests = d.tests.filter((t) => t.key !== "ABC-35");
    const ids = missingItems("developer", d, [], ENVIRONMENTS, NOW).map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(["design:ABC-11", "design:ABC-14", "tests:ABC-14"]));
    expect(ids).not.toContain("tests:ABC-15"); // still in design
    d.designsRead = false;
    expect(missingItems("developer", d, [], ENVIRONMENTS, NOW).map((x) => x.id)).not.toContain("design:ABC-11");
    const clean = workData();
    clean.stories = []; clean.prs = []; clean.setup = { branches: { dev: true }, sprintBranch: "sprint/x", environments: {}, autoMerge: true };
    expect(missingItems("lead", clean, [conn("github", "connected")], ENVIRONMENTS, NOW)).toEqual([]);
  });
});

describe("story panel", () => {
  it("five steps, PR state and links", () => {
    const d = workData();
    const s = storyDetail(d.stories.find((x) => x.key === "ABC-11")!, d, { inMain: false });
    expect(s.steps.map((x) => [x.label, x.state])).toEqual([["Design", "done"], ["Stories", "done"], ["Build", "done"], ["QA", "active"], ["Release", "todo"]]);
    expect(s.pr).toEqual({ number: 42, url: "https://github.com/acme-org/acme-salesforce/pull/42", state: "merged", scan: "success", coderabbit: "approved", approvedBy: ["dev2"], scanUrl: "https://github.com/acme-org/acme-salesforce/actions/runs/4200" });
    expect(s.links.map((l) => l.label)).toEqual(["Jira", "Design page", "Diagram", "PR #42"]);
    const open = storyDetail(d.stories.find((x) => x.key === "ABC-12")!, d);
    expect(open.pr).toMatchObject({ scan: "failure", coderabbit: "changes", waitingSince: "2026-11-10T09:00:00Z" });
    expect(open.steps.find((x) => x.id === "build")!.state).toBe("active");
    const done = storyDetail(issue({ status: "Done", statusCategory: "done" }), d, { inMain: true });
    expect(done.steps.map((x) => x.state)).toEqual(["done", "done", "done", "done", "done"]);
  });
});
