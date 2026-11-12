// v3 sample data for the views module (placeholders only: acme-org, ACME-*, acme.atlassian.net). Features are Jira
// epics with a Confluence design page; stories carry the approved design version; story PRs are opened as drafts by
// the Developer's "Start story". Used by the unit tests and to generate preview/fixtures/views.*.json
// (UPDATE_FIXTURES=1 npx vitest run test/unit/views).
import { canAct, type ActionRef, type ConnectionStatus, type Identity, type PrRef, type QueueItem, type SourceRef } from "../../../src/core/contracts";
import type { FeatureV3, StoryV3 } from "../../../src/views/model";

export const NOW = Date.parse("2026-11-11T15:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

export const OWNER = "acme-org";
export const REPO = "salesDemoOrg";
const GH = `https://github.com/${OWNER}/${REPO}`;
const JIRA = "https://acme.atlassian.net/browse/";
const WIKI = "https://acme.atlassian.net/wiki/spaces/ACME/pages";
export const jiraUrl = (k: string) => JIRA + k;

const base = { owner: OWNER, repo: REPO, orgOwned: true };
export const ARCHITECT: Identity = { ...base, login: "maya-arch", personas: ["architect"], active: "architect", isAdmin: true };
export const DEVELOPER: Identity = { ...base, login: "ravi-dev", personas: ["developer"], active: "developer", isAdmin: false };
export const TESTER: Identity = { ...base, login: "tess-qa", personas: ["tester"], active: "tester", isAdmin: false };

/** What ActionsService.allowed does for these samples: the identity acts as the action's persona. */
export const allowedFor = (id: Identity | null) => (a: ActionRef) => !!id && canAct(id, a.persona);

const tc = (key: string, n: number, level: "ui" | "unit" | "manual", jira?: string) =>
  ({ id: `${key}-TC-${String(n).padStart(2, "0")}`, level, ac: `AC-${n}`, jiraKey: jira });

/** A story in the project module's shape (StoryInfo): labels, Approved design version, Testability confirmed, C5. */
const story = (num: string, key: string, title: string, over: Partial<StoryV3> = {}): StoryV3 =>
  ({ num, title, jiraKey: key, testCases: [], labels: ["ai-ready"], testabilityConfirmed: true, approvedDesignVersion: 8,
    designSync: "ok", blockedBy: num === "00" ? [] : ["ACME-11"], url: JIRA + key, ...over });

export const FEATURES: FeatureV3[] = [
  {
    id: "ACME-10", slug: "ACME-10", epicKey: "ACME-10", title: "Case escalation with reason and queue routing",
    stages: { intake: "done", clarify: "done", plan: "done", signoff: "done", stories: "done", tests: "done", jira: "done", build: "active", qa: "todo", release: "todo" },
    gates: { G1: "done", G2: "done", G3: "waiting", G4: "waiting", G5: "waiting", G6: "waiting", G7: "waiting", G8: "not-started", G9: "not-started" },
    openQuestions: 0, signedOff: true, decisions: 6,
    design: { pageId: "2211843", url: `${WIKI}/2211843/Case+escalation`, title: "Case escalation: design", status: "Approved", version: 8,
      approval: { state: "approved", approvedVersion: 8, approvedBy: "maya.arch@example.com", approverIsArchitect: true, changedSinceApproval: false,
        detail: "Approved v8 by maya.arch@example.com" },
      orgSnapshotUrl: `${WIKI}/2211901/Org+snapshot` },
    sources: ["fireflies:01JD8Q2KX7", "upload:3f9a1c2b7d4e"],
    stories: [
      story("00", "ACME-11", "Escalation data model and permissions (Story 00)", { status: "Done", statusCategory: "done", prNumber: 41, testsOnPr: true,
        testCases: [tc("ACME-11", 1, "unit", "ACME-31"), tc("ACME-11", 2, "unit", "ACME-32")] }),
      story("01", "ACME-12", "Agent escalates a Case with a reason", { status: "In Review", prNumber: 42, testsOnPr: true,
        testCases: [tc("ACME-12", 1, "ui", "ACME-33"), tc("ACME-12", 2, "unit", "ACME-34"), tc("ACME-12", 3, "manual", "ACME-35")] }),
      story("02", "ACME-13", "Escalated Cases route to the Tier 2 queue", { status: "Plan Review", prNumber: 43,
        testCases: [tc("ACME-13", 1, "ui", "ACME-36"), tc("ACME-13", 2, "unit", "ACME-37")] }),
      story("03", "ACME-14", "Notify the account owner on escalation", { status: "In Build", prNumber: 44, testsOnPr: true,
        testCases: [tc("ACME-14", 1, "ui", "ACME-38"), tc("ACME-14", 2, "unit", "ACME-39"), tc("ACME-14", 3, "unit", "ACME-40"), tc("ACME-14", 4, "manual", "ACME-41")] }),
      story("04", "ACME-15", "Escalation history on the Case page", { status: "Ready for Dev",
        testCases: [tc("ACME-15", 1, "ui", "ACME-42")] }),
      story("05", "ACME-16", "Escalation report for team leads", { status: "Test Design", labels: [], testabilityConfirmed: false }),
      story("06", "ACME-17", "Auto-close stale escalations", { status: "In Build", prNumber: 45, testsOnPr: true,
        testCases: [tc("ACME-17", 1, "unit", "ACME-43")] }),
    ],
    links: [
      { kind: "jira", label: "Epic ACME-10", target: JIRA + "ACME-10" },
      { kind: "confluence", label: "Design: Case escalation", target: `${WIKI}/2211843/Case+escalation` },
      { kind: "confluence", label: "Org snapshot", target: `${WIKI}/2211901/Org+snapshot` },
      { kind: "lucid", label: "Diagram", target: "https://lucid.app/lucidchart/7c1e2b9a-case-escalation/edit" },
    ],
  },
  {
    id: "ACME-20", slug: "ACME-20", epicKey: "ACME-20", title: "Entitlement SLA timers on premium support Cases",
    stages: { intake: "done", clarify: "active", plan: "active", signoff: "todo", stories: "todo", tests: "todo", jira: "todo", build: "todo", qa: "todo", release: "todo" },
    gates: { G1: "waiting" },
    openQuestions: 3, signedOff: false,
    design: { pageId: "2240011", url: `${WIKI}/2240011/Entitlement+SLA`, status: "In progress", version: 3,
      approval: { state: "draft", changedSinceApproval: false, detail: "Design page status: In progress (v3)" } },
    sources: ["fireflies:01JDC4M9ZP"], stories: [],
    links: [
      { kind: "jira", label: "Epic ACME-20", target: JIRA + "ACME-20" },
      { kind: "confluence", label: "Design", target: `${WIKI}/2240011/Entitlement+SLA` },
    ],
  },
  {
    id: "ACME-30", slug: "ACME-30", epicKey: "ACME-30", title: "Partner onboarding checklist",
    stages: { intake: "done", clarify: "done", plan: "done", signoff: "blocked", stories: "done", tests: "done", jira: "done", build: "todo", qa: "todo", release: "todo" },
    gates: { G1: "blocked", G2: "done" },
    openQuestions: 0, signedOff: false,
    // Approved at v4, edited twice since: stories planned on v4 must be re-planned or the page re-approved (C5).
    design: { pageId: "2250777", url: `${WIKI}/2250777/Partner+onboarding`, status: "Approved", version: 6,
      approval: { state: "changed", approvedVersion: 4, approvedBy: "maya.arch@example.com", approverIsArchitect: true, changedSinceApproval: true,
        detail: "Design changed after approval: v6 is newer than approved v4. Re-approve." } },
    sources: ["paste:9c0d11aa77e2"],
    stories: [story("00", "ACME-31", "Onboarding checklist object (Story 00)", { approvedDesignVersion: 4, designSync: "changed", status: "Ready for Dev" })],
    links: [{ kind: "jira", label: "Epic ACME-30", target: JIRA + "ACME-30" }],
  },
];

export const SOURCES: SourceRef[] = [
  { id: "fireflies:01JD8Q2KX7", kind: "fireflies", title: "Acme Shipping support: escalation workshop", date: "2026-10-28T16:00:00Z", usedBy: ["ACME-10"] },
  { id: "upload:3f9a1c2b7d4e", kind: "upload", title: "Tier 2 routing notes (call recording transcript)", date: "2026-10-30T10:12:00Z", usedBy: ["ACME-10"] },
  { id: "fireflies:01JDC4M9ZP", kind: "fireflies", title: "Acme Shipping support: premium SLA call", date: "2026-11-06T15:30:00Z", usedBy: ["ACME-20"] },
];

const ok = "success" as const;
export const PRS: PrRef[] = [
  {
    number: 41, url: `${GH}/pull/41`, title: "ACME-11 Escalation data model and permissions", branch: "feature/ACME-11-escalation-model", draft: false,
    author: "ravi-dev", labels: ["plan-approved", "testplan-approved"], state: "merged", mergedAt: ago(30),
    checks: { guard: ok, static: ok, "design-gate": ok, qa: ok, "gate/developer": ok, "gate/tester": ok, "gate/architect": ok },
    storyKey: "ACME-11", featureId: "ACME-10", updatedAt: ago(30),
    reviews: [
      { source: "human", author: "sam-dev", state: "approved", summary: "Data model matches the approved design v8", url: `${GH}/pull/41#pullrequestreview-2401`, at: ago(34) },
      { source: "coderabbit", author: "coderabbitai[bot]", state: "commented", summary: "2 nitpicks", url: `${GH}/pull/41#pullrequestreview-2398`, at: ago(40) },
    ],
  },
  {
    number: 42, url: `${GH}/pull/42`, title: "ACME-12 Agent escalates a Case with a reason", branch: "feature/ACME-12-escalate-case", draft: false,
    author: "sam-dev", labels: ["plan-approved", "testplan-approved"],
    checks: { guard: ok, static: ok, "design-gate": ok, qa: ok, "gate/developer": "pending", "gate/tester": "pending", "gate/architect": "missing" },
    storyKey: "ACME-12", featureId: "ACME-10", updatedAt: ago(5),
    reviews: [
      { source: "coderabbit", author: "coderabbitai[bot]", state: "changes-requested", summary: "Null check missing in EscalationService", url: `${GH}/pull/42#pullrequestreview-2410`, at: ago(20) },
      { source: "coderabbit", author: "coderabbitai[bot]", state: "commented", summary: "Resolved; 1 nitpick left", url: `${GH}/pull/42#pullrequestreview-2417`, at: ago(6) },
      { source: "ai-reviewer", author: "github-actions[bot]", state: "pass", summary: "VERDICT: PASS", url: `${GH}/pull/42#issuecomment-88120`, at: ago(6) },
      { source: "code-analyzer", author: "github-actions[bot]", state: "pass", summary: "0 violations (sev 1-2)", url: `${GH}/actions/runs/11872001`, at: ago(6) },
      { source: "sf-ai-tester", author: "github-actions[bot]", state: "pass", summary: "3/3 ui cases passed on qa", url: `${GH}/actions/runs/11872001`, at: ago(5) },
    ],
  },
  {
    number: 43, url: `${GH}/pull/43`, title: "ACME-13 Escalated Cases route to the Tier 2 queue", branch: "feature/ACME-13-escalation-routing", draft: true,
    author: "ravi-dev", labels: ["plan-review"], checks: { guard: ok, "design-gate": ok },
    storyKey: "ACME-13", featureId: "ACME-10", updatedAt: ago(26), reviews: [],
  },
  {
    number: 44, url: `${GH}/pull/44`, title: "ACME-14 Notify the account owner on escalation", branch: "feature/ACME-14-escalation-notify", draft: false,
    author: "ravi-dev", labels: ["plan-approved", "testplan-approved", "ai-attempt-3", "needs-human"],
    checks: { guard: ok, static: "failure", "design-gate": ok, qa: "failure", "gate/developer": "missing", "gate/tester": "missing" },
    storyKey: "ACME-14", featureId: "ACME-10", aiAttempt: 3, updatedAt: ago(3),
    reviews: [
      { source: "coderabbit", author: "coderabbitai[bot]", state: "changes-requested", summary: "SOQL inside loop in NotifyOwnerHandler", url: `${GH}/pull/44#pullrequestreview-2431`, at: ago(4) },
      { source: "ai-reviewer", author: "github-actions[bot]", state: "block", summary: "VERDICT: BLOCK (bulk safety)", url: `${GH}/pull/44#issuecomment-88177`, at: ago(3) },
      { source: "code-analyzer", author: "github-actions[bot]", state: "block", summary: "2 violations: ApexCRUDViolation, AvoidSoqlInLoops", url: `${GH}/actions/runs/11873310`, at: ago(3) },
      { source: "sf-ai-tester", author: "github-actions[bot]", state: "block", summary: "ACME-14-TC-01 failed: no email sent", url: `${GH}/actions/runs/11873310`, at: ago(3) },
    ],
  },
  {
    number: 45, url: `${GH}/pull/45`, title: "ACME-17 Auto-close stale escalations", branch: "feature/ACME-17-auto-close", draft: false,
    author: "ravi-dev", labels: ["plan-approved", "testplan-approved", "ai-attempt-1"],
    checks: { guard: ok, static: "failure", "design-gate": ok, qa: "pending", "gate/developer": "missing", "gate/tester": "missing" },
    storyKey: "ACME-17", featureId: "ACME-10", aiAttempt: 1, updatedAt: ago(2),
    reviews: [{ source: "code-analyzer", author: "github-actions[bot]", state: "block", summary: "1 violation: ApexUnitTestClassShouldHaveAsserts", url: `${GH}/actions/runs/11874020`, at: ago(2) }],
  },
];

const prLink = (n: number) => ({ kind: "github" as const, label: `PR #${n}`, target: `${GH}/pull/${n}` });
const jiraLink = (k: string) => ({ kind: "jira" as const, label: k, target: JIRA + k });
const ai = (persona: ActionRef["persona"], command: string, label: string, arg: string | number, argKind = "pr"): ActionRef =>
  ({ id: `ai:${command}`, label, persona, kind: "ai", args: { command, argKind, arg } });
const named = (id: string, persona: ActionRef["persona"], label: string, args: Record<string, string | number>, kind: ActionRef["kind"] = "ai"): ActionRef =>
  ({ id, label, persona, kind, args });
const gate = (persona: ActionRef["persona"], id: string, label: string, pr: number): ActionRef =>
  ({ id, label, persona, kind: "gate", args: { pr } });
/** v3 queue kinds the project module adds (contract request); cast until the contract lists them. */
const k = (kind: string) => kind as QueueItem["kind"];

export const QUEUE: QueueItem[] = [
  // architect
  { id: "a-g1-ACME-20", persona: "architect", gate: "G1", kind: "sign-off", title: "Entitlement SLA timers: approve design", detail: "Open questions remain. Design page status: In progress (v3)",
    featureId: "ACME-20", since: ago(50), links: [jiraLink("ACME-20"), { kind: "confluence", label: "Design page", target: `${WIKI}/2240011/Entitlement+SLA` }],
    actions: [named("arch:approve-design", "architect", "Approve design", { featureId: "ACME-20", pageId: "2240011", url: `${WIKI}/2240011/Entitlement+SLA` }, "nav"),
      named("decision:record", "architect", "Record a decision", { command: "/record-decision", arg: "ACME-20", featureId: "ACME-20", pageId: "2240011" })] },
  { id: "a-g7-42", persona: "architect", gate: "G7", kind: "review-pr", title: "Schema review: ACME-12 Agent escalates a Case", detail: "Developer and Tester gates pending",
    featureId: "ACME-10", storyKey: "ACME-12", prNumber: 42, since: ago(5), links: [prLink(42), jiraLink("ACME-12")],
    actions: [ai("architect", "/arch-review-pr", "AI review", 42), gate("architect", "gate:review", "Approve (G7)", 42)] },
  { id: "a-human-44", persona: "architect", kind: "needs-human", title: "AI stopped on ACME-14 after 3 attempts", detail: "The Developer takes over",
    featureId: "ACME-10", storyKey: "ACME-14", prNumber: 44, since: ago(3), links: [prLink(44), jiraLink("ACME-14")],
    actions: [] },
  // developer
  { id: "d-start-ACME-15", persona: "developer", kind: k("start-story"), title: "Start story: ACME-15 Escalation history on the Case page", detail: "ai-ready · design v8",
    featureId: "ACME-10", storyKey: "ACME-15", since: ago(30), links: [jiraLink("ACME-15")],
    actions: [named("dev:start-story", "developer", "Start story", { command: "/dev-start-story", arg: "ACME-15", storyKey: "ACME-15", featureId: "ACME-10" })] },
  { id: "d-g3-43", persona: "developer", gate: "G3", kind: "approve-plan", title: "Approve plan: ACME-13 Tier 2 routing", detail: "docs/plans/ACME-13/PLAN.md on the draft PR",
    featureId: "ACME-10", storyKey: "ACME-13", prNumber: 43, since: ago(26), links: [prLink(43), jiraLink("ACME-13")],
    actions: [ai("developer", "/dev-review-plan", "AI review plan", 43), gate("developer", "gate:label:plan-approved", "Add plan-approved", 43)] },
  { id: "d-fix-45", persona: "developer", kind: k("fix"), title: "Fix with AI: ACME-17 static failed", detail: "Attempt 2 of 3 · Code Analyzer: ApexUnitTestClassShouldHaveAsserts",
    featureId: "ACME-10", storyKey: "ACME-17", prNumber: 45, since: ago(2), links: [prLink(45), jiraLink("ACME-17")],
    actions: [named("dev:fix", "developer", "Fix with AI", { command: "/dev-fix", arg: "45", pr: 45, checks: "static", attempt: 2 })] },
  { id: "d-g5-42", persona: "developer", gate: "G5", kind: "review-pr", title: "Code review: ACME-12 Agent escalates a Case", detail: "All checks green; CodeRabbit 1 nitpick",
    featureId: "ACME-10", storyKey: "ACME-12", prNumber: 42, since: ago(5), links: [prLink(42), jiraLink("ACME-12"), { kind: "coderabbit", label: "CodeRabbit", target: `${GH}/pull/42#pullrequestreview-2417` }],
    actions: [ai("developer", "/dev-review-pr", "AI review", 42), gate("developer", "gate:review", "Approve (G5)", 42)] },
  { id: "d-human-44", persona: "developer", kind: "needs-human", title: "Take over ACME-14: AI stopped after 3 attempts", detail: "static and qa failing",
    featureId: "ACME-10", storyKey: "ACME-14", prNumber: 44, since: ago(3), links: [prLink(44), jiraLink("ACME-14")],
    actions: [{ id: "ai:/dev-review-pr", label: "Take over", persona: "developer", kind: "ai", args: { command: "/dev-review-pr", argKind: "pr", arg: 44, intent: "takeover" } }] },
  // tester
  { id: "t-tests-43", persona: "tester", kind: k("add-tests"), title: "Add tests to ACME-13", detail: "2 test cases in Jira; the draft PR has no tests/ACME-13.tc.json yet",
    featureId: "ACME-10", storyKey: "ACME-13", prNumber: 43, since: ago(25), links: [prLink(43), jiraLink("ACME-13")],
    actions: [named("qa:add-tests", "tester", "Add tests to ACME-13", { command: "/qa-add-tests", arg: "ACME-13", pr: 43, storyKey: "ACME-13",
      suite: "test-cases/ACME-13.sf-tests.yaml", tcIndex: "tests/ACME-13.tc.json" })] },
  { id: "t-g4-43", persona: "tester", gate: "G4", kind: "approve-testplan", title: "Approve test plan: ACME-13 Tier 2 routing", detail: "docs/plans/ACME-13/TESTPLAN.md",
    featureId: "ACME-10", storyKey: "ACME-13", prNumber: 43, since: ago(26), links: [prLink(43), jiraLink("ACME-13")],
    actions: [ai("tester", "/qa-review-testplan", "AI review test plan", 43), gate("tester", "gate:label:testplan-approved", "Add testplan-approved", 43)] },
  { id: "t-g6-42", persona: "tester", gate: "G6", kind: "qa-pr", title: "QA on sandbox: ACME-12 Agent escalates a Case", detail: "SF AI Tester: 3/3 passed in CI",
    featureId: "ACME-10", storyKey: "ACME-12", prNumber: 42, since: ago(5), links: [prLink(42), jiraLink("ACME-12")],
    actions: [ai("tester", "/qa-explore", "Explore on QA", 42), gate("tester", "gate:review", "Approve (G6)", 42)] },
  { id: "t-g2-ACME-16", persona: "tester", gate: "G2", kind: "testability", title: "Confirm testability: ACME-16 Escalation report", detail: "Set Testability confirmed and label ai-ready in Jira",
    featureId: "ACME-10", storyKey: "ACME-16", since: ago(20), links: [jiraLink("ACME-16")],
    actions: [ai("tester", "/qa-design-tests", "Design tests", "ACME-10", "feature")] },
];

export const CONNECTIONS: ConnectionStatus[] = [
  { id: "github", label: "GitHub", scope: "personal", state: "connected", neededBy: ["architect", "developer", "tester"] },
  { id: "claude", label: "Claude", scope: "personal", state: "connected", neededBy: ["architect", "developer", "tester"] },
  { id: "sf-dev", label: "Salesforce DEV", scope: "personal", state: "connected", neededBy: ["developer", "architect"] },
  { id: "sf-qa", label: "Salesforce QA", scope: "personal", state: "expiring", neededBy: ["tester"] },
  { id: "acli", label: "Atlassian CLI (acli)", scope: "personal", state: "connected", neededBy: ["architect", "tester"] },
  { id: "coderabbit", label: "CodeRabbit", scope: "project", state: "connected", neededBy: ["developer", "architect"] },
  { id: "code-analyzer", label: "Code Analyzer", scope: "personal", state: "disconnected", neededBy: ["developer"] },
  { id: "ai-reviewer", label: "AI Reviewer", scope: "project", state: "connected", neededBy: ["developer", "architect"] },
  { id: "mcp-atlassian", label: "Atlassian MCP", scope: "personal", state: "error", detail: "Needs authentication", neededBy: ["architect"] },
  { id: "mcp-fireflies", label: "Fireflies MCP", scope: "personal", state: "disconnected", neededBy: ["architect"] },
];

export const TEAMS = { architect: "architects", developer: "developers", tester: "testers" };
