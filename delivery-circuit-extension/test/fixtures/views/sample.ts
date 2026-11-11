// Realistic sample data for the views module: feature 001-case-escalation, PRs #41-#44 with mixed review signals.
// Used by the unit tests and to generate preview/fixtures/views.*.json (UPDATE_FIXTURES=1 npx vitest run test/unit/views).
import { canAct, type ActionRef, type ConnectionStatus, type Feature, type Identity, type PrRef, type QueueItem, type SourceRef } from "../../../src/core/contracts";

export const NOW = Date.parse("2026-11-11T15:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

export const OWNER = "acme-org";
export const REPO = "salesDemoOrg";
const GH = `https://github.com/${OWNER}/${REPO}`;
const JIRA = "https://acme.atlassian.net/browse/";
export const jiraUrl = (k: string) => JIRA + k;

const base = { owner: OWNER, repo: REPO, orgOwned: true };
export const ARCHITECT: Identity = { ...base, login: "maya-arch", personas: ["architect"], active: "architect", isAdmin: true };
export const DEVELOPER: Identity = { ...base, login: "ravi-dev", personas: ["developer"], active: "developer", isAdmin: false };
export const TESTER: Identity = { ...base, login: "tess-qa", personas: ["tester"], active: "tester", isAdmin: false };

/** What ActionsService.allowed does for these samples: the identity acts as the action's persona. */
export const allowedFor = (id: Identity | null) => (a: ActionRef) => !!id && canAct(id, a.persona);

const tc = (story: string, n: number, level: "ui" | "unit" | "manual", key?: string) =>
  ({ id: `S${story}-TC-${String(n).padStart(2, "0")}`, level, ac: `AC-${story}.${n}`, jiraKey: key });

export const FEATURES: Feature[] = [
  {
    id: "001", slug: "001-case-escalation", title: "Case escalation with reason and queue routing",
    dir: ".specify/specs/001-case-escalation",
    stages: { intake: "done", clarify: "done", plan: "done", signoff: "done", stories: "done", tests: "done", jira: "done", build: "active", qa: "todo", release: "todo" },
    gates: { G1: "done", G2: "done", G3: "waiting", G4: "waiting", G5: "waiting", G6: "waiting", G7: "waiting", G8: "not-started", G9: "not-started" },
    openQuestions: 0, signedOff: true, score: 92,
    sources: ["fireflies:01JD8Q2KX7", "upload:3f9a1c2b7d4e"],
    stories: [
      { num: "00", title: "Escalation data model and permissions (Story 00)", file: ".specify/specs/001-case-escalation/task_story_00.md", jiraKey: "CE-11",
        testCases: [tc("00", 1, "unit", "CE-31"), tc("00", 2, "unit", "CE-32")], prNumber: 41 },
      { num: "01", title: "Agent escalates a Case with a reason", file: ".specify/specs/001-case-escalation/task_story_01.md", jiraKey: "CE-12",
        testCases: [tc("01", 1, "ui", "CE-33"), tc("01", 2, "unit", "CE-34"), tc("01", 3, "manual", "CE-35")], prNumber: 42 },
      { num: "02", title: "Escalated Cases route to the Tier 2 queue", file: ".specify/specs/001-case-escalation/task_story_02.md", jiraKey: "CE-13",
        testCases: [tc("02", 1, "ui", "CE-36"), tc("02", 2, "unit", "CE-37")], prNumber: 43 },
      { num: "03", title: "Notify the account owner on escalation", file: ".specify/specs/001-case-escalation/task_story_03.md", jiraKey: "CE-14",
        testCases: [tc("03", 1, "ui", "CE-38"), tc("03", 2, "unit", "CE-39"), tc("03", 3, "unit", "CE-40"), tc("03", 4, "manual", "CE-41")], prNumber: 44 },
    ],
    links: [
      { kind: "file", label: "spec.md", target: ".specify/specs/001-case-escalation/spec.md" },
      { kind: "jira", label: "Epic CE-10", target: JIRA + "CE-10" },
      { kind: "confluence", label: "Design", target: "https://acme.atlassian.net/wiki/spaces/CE/pages/2211843/Case+escalation" },
      { kind: "lucid", label: "Diagram", target: "https://lucid.app/lucidchart/7c1e2b9a-case-escalation/edit" },
    ],
  },
  {
    id: "002", slug: "002-entitlement-sla", title: "Entitlement SLA timers on premium support Cases",
    dir: ".specify/specs/002-entitlement-sla",
    stages: { intake: "done", clarify: "active", plan: "todo", signoff: "todo", stories: "todo", tests: "todo", jira: "todo", build: "todo", qa: "todo", release: "todo" },
    gates: { G1: "waiting" },
    openQuestions: 3, signedOff: false, sources: ["fireflies:01JDC4M9ZP"], stories: [],
    links: [{ kind: "file", label: "spec.md", target: ".specify/specs/002-entitlement-sla/spec.md" }],
  },
];

export const SOURCES: SourceRef[] = [
  { id: "fireflies:01JD8Q2KX7", kind: "fireflies", title: "Acme support: escalation workshop", date: "2026-10-28T16:00:00Z", usedBy: ["001"] },
  { id: "upload:3f9a1c2b7d4e", kind: "upload", title: "Tier 2 routing notes (Teams recording)", date: "2026-10-30T10:12:00Z", usedBy: ["001"] },
  { id: "fireflies:01JDC4M9ZP", kind: "fireflies", title: "Acme support: premium SLA call", date: "2026-11-06T15:30:00Z", usedBy: ["002"] },
];

export const PRS: PrRef[] = [
  {
    number: 41, url: `${GH}/pull/41`, title: "Spec: case escalation stories and test cases", branch: "spec/001-case-escalation", draft: false,
    author: "maya-arch", labels: ["sdd"], checks: { guard: "success", "spec-gate": "success" }, featureId: "001", updatedAt: ago(30),
    reviews: [
      { source: "human", author: "ravi-dev", state: "approved", summary: "Stories are buildable; Story 00 contract complete", url: `${GH}/pull/41#pullrequestreview-2401`, at: ago(34) },
      { source: "human", author: "tess-qa", state: "approved", summary: "Test cases cover every AC", url: `${GH}/pull/41#pullrequestreview-2402`, at: ago(32) },
      { source: "coderabbit", author: "coderabbitai[bot]", state: "commented", summary: "2 nitpicks in task_story_03.md", url: `${GH}/pull/41#pullrequestreview-2398`, at: ago(40) },
    ],
  },
  {
    number: 42, url: `${GH}/pull/42`, title: "CE-12 Agent escalates a Case with a reason", branch: "feature/CE-12-escalate-case", draft: false,
    author: "claude[bot]", labels: ["ai-generated", "plan-approved", "testplan-approved", "ai-attempt-1"],
    checks: { guard: "success", static: "success", qa: "success", "spec-gate": "success", "gate/developer": "pending", "gate/tester": "pending", "gate/architect": "missing" },
    storyKey: "CE-12", featureId: "001", aiAttempt: 1, updatedAt: ago(5),
    reviews: [
      { source: "coderabbit", author: "coderabbitai[bot]", state: "changes-requested", summary: "Null check missing in EscalationService", url: `${GH}/pull/42#pullrequestreview-2410`, at: ago(20) },
      { source: "coderabbit", author: "coderabbitai[bot]", state: "commented", summary: "Resolved; 1 nitpick left", url: `${GH}/pull/42#pullrequestreview-2417`, at: ago(6) },
      { source: "ai-reviewer", author: "github-actions[bot]", state: "pass", summary: "VERDICT: PASS", url: `${GH}/pull/42#issuecomment-88120`, at: ago(6) },
      { source: "code-analyzer", author: "github-actions[bot]", state: "pass", summary: "0 violations (sev 1-2)", url: `${GH}/actions/runs/11872001`, at: ago(6) },
      { source: "sf-ai-tester", author: "github-actions[bot]", state: "pass", summary: "3/3 ui cases passed on qa", url: `${GH}/actions/runs/11872001`, at: ago(5) },
    ],
  },
  {
    number: 43, url: `${GH}/pull/43`, title: "CE-13 Escalated Cases route to the Tier 2 queue", branch: "feature/CE-13-escalation-routing", draft: true,
    author: "claude[bot]", labels: ["ai-generated", "plan-review"], checks: { guard: "success" },
    storyKey: "CE-13", featureId: "001", updatedAt: ago(26), reviews: [],
  },
  {
    number: 44, url: `${GH}/pull/44`, title: "CE-14 Notify the account owner on escalation", branch: "feature/CE-14-escalation-notify", draft: false,
    author: "claude[bot]", labels: ["ai-generated", "plan-approved", "testplan-approved", "ai-attempt-3", "needs-human"],
    checks: { guard: "success", static: "failure", qa: "failure", "spec-gate": "success", "gate/developer": "missing", "gate/tester": "missing" },
    storyKey: "CE-14", featureId: "001", aiAttempt: 3, updatedAt: ago(3),
    reviews: [
      { source: "coderabbit", author: "coderabbitai[bot]", state: "changes-requested", summary: "SOQL inside loop in NotifyOwnerHandler", url: `${GH}/pull/44#pullrequestreview-2431`, at: ago(4) },
      { source: "ai-reviewer", author: "github-actions[bot]", state: "block", summary: "VERDICT: BLOCK (bulk safety)", url: `${GH}/pull/44#issuecomment-88177`, at: ago(3) },
      { source: "code-analyzer", author: "github-actions[bot]", state: "block", summary: "2 violations: ApexCRUDViolation, AvoidSoqlInLoops", url: `${GH}/actions/runs/11873310`, at: ago(3) },
      { source: "sf-ai-tester", author: "github-actions[bot]", state: "block", summary: "S03-TC-01 failed: no email sent", url: `${GH}/actions/runs/11873310`, at: ago(3) },
    ],
  },
];

const prLink = (n: number) => ({ kind: "github" as const, label: `PR #${n}`, target: `${GH}/pull/${n}` });
const jiraLink = (k: string) => ({ kind: "jira" as const, label: k, target: JIRA + k });
const ai = (persona: ActionRef["persona"], command: string, label: string, arg: string | number, argKind = "pr"): ActionRef =>
  ({ id: `ai:${command}`, label, persona, kind: "ai", args: { command, argKind, arg } });
const gate = (persona: ActionRef["persona"], id: string, label: string, pr: number): ActionRef =>
  ({ id, label, persona, kind: "gate", args: { pr } });

export const QUEUE: QueueItem[] = [
  // architect
  { id: "a-g7-42", persona: "architect", gate: "G7", kind: "review-pr", title: "Schema review: CE-12 Agent escalates a Case", detail: "Developer and Tester gates pending",
    featureId: "001", storyKey: "CE-12", prNumber: 42, since: ago(5), links: [prLink(42), jiraLink("CE-12")],
    actions: [ai("architect", "/arch-review-pr", "AI review", 42), gate("architect", "gate:approve", "Approve (G7)", 42)] },
  { id: "a-clarify-002", persona: "architect", kind: "clarify", title: "Answer 3 open questions: 002-entitlement-sla", detail: "Clarification report has OPEN items",
    featureId: "002", since: ago(110), links: [{ kind: "file", label: "spec.md", target: ".specify/specs/002-entitlement-sla/spec.md" }],
    actions: [ai("architect", "/arch-design", "Design", "002-entitlement-sla", "feature")] },
  { id: "a-human-44", persona: "architect", kind: "needs-human", title: "AI stopped on CE-14 after 3 attempts", detail: "Developer notified in Slack",
    featureId: "001", storyKey: "CE-14", prNumber: 44, since: ago(3), links: [prLink(44), jiraLink("CE-14"), { kind: "slack", label: "Slack", target: "https://acme.slack.com/archives/C07CIRCUIT/p1731333000" }],
    actions: [] },
  // developer
  { id: "d-g3-43", persona: "developer", gate: "G3", kind: "approve-plan", title: "Approve AI plan: CE-13 Tier 2 routing", detail: "docs/plans/CE-13/PLAN.md on draft PR",
    featureId: "001", storyKey: "CE-13", prNumber: 43, since: ago(26), links: [prLink(43), jiraLink("CE-13"), { kind: "file", label: "PLAN.md", target: "docs/plans/CE-13/PLAN.md" }],
    actions: [ai("developer", "/dev-review-plan", "AI review plan", 43), gate("developer", "gate:label:plan-approved", "Add plan-approved", 43)] },
  { id: "d-g5-42", persona: "developer", gate: "G5", kind: "review-pr", title: "Code review: CE-12 Agent escalates a Case", detail: "All checks green; CodeRabbit 1 nitpick",
    featureId: "001", storyKey: "CE-12", prNumber: 42, since: ago(5), links: [prLink(42), jiraLink("CE-12"), { kind: "coderabbit", label: "CodeRabbit", target: `${GH}/pull/42#pullrequestreview-2417` }],
    actions: [ai("developer", "/dev-review-pr", "AI review", 42), gate("developer", "gate:approve", "Approve (G5)", 42)] },
  { id: "d-human-44", persona: "developer", kind: "needs-human", title: "Take over CE-14: AI stopped after 3 attempts", detail: "static and qa failing; route dev",
    featureId: "001", storyKey: "CE-14", prNumber: 44, since: ago(3), links: [prLink(44), jiraLink("CE-14")],
    actions: [{ id: "ai:/dev-review-pr", label: "Take over", persona: "developer", kind: "ai", args: { command: "/dev-review-pr", argKind: "pr", arg: 44, intent: "takeover" } }] },
  // tester
  { id: "t-g4-43", persona: "tester", gate: "G4", kind: "approve-testplan", title: "Approve AI test plan: CE-13 Tier 2 routing", detail: "docs/plans/CE-13/TESTPLAN.md",
    featureId: "001", storyKey: "CE-13", prNumber: 43, since: ago(26), links: [prLink(43), jiraLink("CE-13"), { kind: "file", label: "TESTPLAN.md", target: "docs/plans/CE-13/TESTPLAN.md" }],
    actions: [ai("tester", "/qa-review-testplan", "AI review test plan", 43), gate("tester", "gate:label:testplan-approved", "Add testplan-approved", 43)] },
  { id: "t-g6-42", persona: "tester", gate: "G6", kind: "qa-pr", title: "QA on sandbox: CE-12 Agent escalates a Case", detail: "SF AI Tester: 3/3 passed in CI",
    featureId: "001", storyKey: "CE-12", prNumber: 42, since: ago(5), links: [prLink(42), jiraLink("CE-12"), { kind: "report", label: "Report", target: "test-results/CE-12/report.html" }],
    actions: [ai("tester", "/qa-explore", "Explore on QA", 42), gate("tester", "gate:approve", "Approve (G6)", 42)] },
];

export const CONNECTIONS: ConnectionStatus[] = [
  { id: "github", label: "GitHub", scope: "personal", state: "connected", neededBy: ["architect", "developer", "tester"] },
  { id: "claude", label: "Claude", scope: "personal", state: "connected", neededBy: ["architect", "developer", "tester"] },
  { id: "sf-dev", label: "Salesforce DEV", scope: "personal", state: "connected", neededBy: ["developer", "architect"] },
  { id: "sf-qa", label: "Salesforce QA", scope: "personal", state: "expiring", neededBy: ["tester"] },
  { id: "jira", label: "Jira", scope: "personal", state: "connected", neededBy: ["architect", "tester"] },
  { id: "coderabbit", label: "CodeRabbit", scope: "project", state: "connected", neededBy: ["developer", "architect"] },
  { id: "code-analyzer", label: "Code Analyzer", scope: "personal", state: "disconnected", neededBy: ["developer"] },
  { id: "ai-reviewer", label: "AI Reviewer", scope: "project", state: "connected", neededBy: ["developer", "architect"] },
  { id: "mcp-atlassian", label: "Atlassian MCP", scope: "personal", state: "error", detail: "Needs authentication", neededBy: ["architect"] },
  { id: "mcp-fireflies", label: "Fireflies MCP", scope: "personal", state: "disconnected", neededBy: ["architect"] },
];

export const TEAMS = { architect: "architects", developer: "developers", tester: "testers" };
export const EXISTING_FILES = [
  ".specify/specs/001-case-escalation/spec.md", ".specify/specs/001-case-escalation/plan.md",
  ".specify/specs/001-case-escalation/data-model.md", ".specify/specs/001-case-escalation/jira-map.json",
];
