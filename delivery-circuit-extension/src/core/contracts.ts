// Shared contracts for every Delivery Circuit module. Modules code against these types and interfaces only;
// they never import another module's internals. Changing this file is the integrator's job.

import type * as vscode from "vscode";

// ---------- personas and identity ----------
export type Persona = "architect" | "developer" | "tester";
export const PERSONAS: Persona[] = ["architect", "developer", "tester"];

export interface Identity {
  /** GitHub login of the person using VS Code */
  login: string;
  /** Personas from GitHub team membership (or the personal-repo override). Empty = no persona. */
  personas: Persona[];
  /** The persona the person is acting as now (one of personas). */
  active: Persona | null;
  /** Org admin (or repo admin): may open Project Setup. */
  isAdmin: boolean;
  /** owner/repo of the open workspace, from git remote "origin" */
  owner: string;
  repo: string;
  /** True when the repo is owned by an organisation (teams exist), false for a personal account. */
  orgOwned: boolean;
  /** Why personas are missing or incomplete (not in a persona team, personal repo without personaOverride, ...). */
  notice?: string;
}

/** Architect sees every persona view; Developer and Tester see only their own. */
export function canView(id: Identity, view: Persona): boolean {
  return id.personas.includes("architect") || id.personas.includes(view);
}
/** Actions (AI or gate) in a view need that persona AND acting as it. The Architect acts only as Architect. */
export function canAct(id: Identity, view: Persona): boolean {
  return id.active === view && id.personas.includes(view);
}

export interface IdentityService {
  get(): Identity | null;
  refresh(): Promise<Identity | null>;
  setActive(p: Persona): Promise<void>;
  onDidChange: vscode.Event<Identity | null>;
}

// ---------- connections ----------
/** v3: every connection is a login (docs/CIRCUIT-V3.md section 1); none of them holds a stored token. */
export type ConnectionId =
  | "github" | "claude" | "sf-dev" | "sf-qa" | "acli" | "slack" | "lucid" | "testing-browsers"
  // review tools
  | "coderabbit" | "code-analyzer" | "ai-reviewer"
  // vendor MCP servers that Claude uses (sign-in happens in Claude Code's /mcp)
  | "mcp-atlassian" | "mcp-github" | "mcp-salesforce" | "mcp-slack" | "mcp-lucid" | "mcp-fireflies"
  // project rows: the self-hosted runner and the GitHub for Jira app
  | "runner" | "github-jira";

export type ConnectionState = "connected" | "disconnected" | "expiring" | "error" | "checking" | "unknown";
export type ConnectionScope = "personal" | "project";

export interface ConnectionStatus {
  id: ConnectionId;
  label: string;
  scope: ConnectionScope;
  state: ConnectionState;
  /** One short line: account, org alias, error, or what to do */
  detail?: string;
  account?: string;
  /** ISO date when a token/cert expires, if known */
  expiresAt?: string;
  /** Personas that need this connection */
  neededBy: Persona[];
  /** Where to manage it (vendor page) */
  manageUrl?: string;
}

export interface SfOrgGuard {
  alias: string;
  instanceUrl?: string;
  allowed: boolean;
  /** Why it was refused (or a note when allowed, e.g. a declared trial org). */
  reason?: string;
}

export interface ConnectionsService {
  list(): Promise<ConnectionStatus[]>;
  check(id: ConnectionId): Promise<ConnectionStatus>;
  /** Interactive connect flow (sign-in, acli web login, sf org login web, /mcp, ...). Never prompts for a token. */
  connect(id: ConnectionId): Promise<ConnectionStatus>;
  disconnect(id: ConnectionId): Promise<void>;
  onDidChange: vscode.Event<void>;
  /** GitHub session token (VS Code auth provider). Throws if not signed in. */
  githubToken(): Promise<string>;
  /** sf CLI alias for an org role, e.g. "dev" / "qa". */
  sfAlias(role: "dev" | "qa"): string;
  /** Resolves the role's alias with the sf CLI and decides whether AI may work in that org (browser agent, org
   *  exploration). Allowed when the alias resolves to a connected org of any type (SDO and demo orgs are production orgs). */
  sfOrgGuard(role: "dev" | "qa"): Promise<SfOrgGuard>;
  /** GitHub REST call as the signed-in person (path like "/repos/o/r/pulls"). Throws on non-2xx with the API message. */
  githubRequest<T = any>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
  /** GitHub GraphQL call as the signed-in person. */
  githubGraphql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T>;
  /** Names of the repo's Actions secrets (values are never readable). v3 stores none; setup uses this only to find
   *  leftover v2 credentials so an admin can delete them. */
  repoSecretNames(): Promise<string[]>;
}

// ---------- project context (Jira, Confluence, GitHub, sources) ----------
export type GateId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8" | "G9";
export type GateState = "done" | "waiting" | "blocked" | "not-started";

export const GATES: Record<GateId, { owner: Persona; label: string }> = {
  G1: { owner: "architect", label: "Design approved" },
  G2: { owner: "tester", label: "Testability confirmed (ai-ready)" },
  G3: { owner: "developer", label: "AI plan approved" },
  G4: { owner: "tester", label: "AI test plan approved" },
  G5: { owner: "developer", label: "Code review" },
  G6: { owner: "tester", label: "QA on sandbox" },
  G7: { owner: "architect", label: "Schema and design review" },
  G8: { owner: "architect", label: "Merge" },
  G9: { owner: "architect", label: "Production approval" },
};

/** Feature lifecycle stages, derived from the Confluence design page (intake..signoff), Jira (stories, tests; "jira" =
 *  testability) and GitHub (build, qa, release). Nothing is read from .specify/specs (gitignored local drafts). */
export type StageId = "intake" | "clarify" | "plan" | "signoff" | "stories" | "tests" | "jira" | "build" | "qa" | "release";
export type StageState = "done" | "active" | "todo" | "blocked";

export interface DeepLink {
  kind: "github" | "jira" | "salesforce" | "slack" | "confluence" | "lucid" | "fireflies" | "coderabbit" | "file" | "report" | "url";
  label: string;
  /** https URL, or a workspace-relative file path for kind "file"/"report" */
  target: string;
}

export type SourceOrigin = "paste" | "file" | "fireflies" | "fireflies-export" | "wispr-flow" | "watch-folder";

export interface SourceRef {
  /** "fireflies:<meetingId>" or "upload:<sha256-12>" */
  id: string;
  kind: "fireflies" | "upload";
  title: string;
  /** ISO date of the call or upload */
  date: string;
  /** How the Architect added it (Sources page). */
  origin?: SourceOrigin;
  /** Feature ids whose design page cites this source */
  usedBy?: string[];
}

export interface TestCaseRef { id: string; level: "ui" | "unit" | "manual"; ac?: string; jiraKey?: string }

/** C5: the story's Approved design version compared with the design page's current approved version. */
export type DesignSync = "ok" | "changed" | "missing" | "ahead" | "unknown";
export type DesignApprovalState = "approved" | "changed" | "draft" | "unverified-approver" | "missing" | "unknown";

/** A Jira story of a feature epic. */
export interface Story {
  num: string;               // "00", "01", ...
  title: string;
  jiraKey?: string;
  testCases: TestCaseRef[];
  prNumber?: number;
  status?: string;
  /** Jira status category key: "new" | "indeterminate" | "done" */
  statusCategory?: string;
  labels: string[];
  acceptanceCriteria?: string;
  /** Jira field *Approved design version* */
  approvedDesignVersion?: number;
  /** Jira field *Testability confirmed* (G2 together with label ai-ready) */
  testabilityConfirmed?: boolean;
  designSync: DesignSync;
  /** keys of issues that block this story (Jira "is blocked by") */
  blockedBy: string[];
  url?: string;
}

/** G1: a feature's Confluence design page and its approval. */
export interface FeatureDesign {
  pageId: string;
  url?: string;
  title?: string;
  status?: string;
  version?: number;
  approval: {
    state: DesignApprovalState;
    approvedVersion?: number;
    approvedBy?: string;
    /** true = a configured architect; false = not one; undefined = cannot tell */
    approverIsArchitect?: boolean;
    changedSinceApproval: boolean;
    detail: string;
  };
  orgSnapshotUrl?: string;
  readAt?: string;
  error?: string;
}

/** A Jira epic with its Confluence design page, or a design page (label circuit-design) that has no epic yet. */
export interface Feature {
  /** the epic key ("ACME-10"), or "page-<confluencePageId>" for a design page without an epic */
  id: string;
  slug: string;
  title: string;
  epicKey?: string;
  design?: FeatureDesign;
  stages: Record<StageId, StageState>;
  gates: Partial<Record<GateId, GateState>>;
  openQuestions: number;
  signedOff: boolean;
  stories: Story[];
  sources: string[];         // SourceRef ids cited by the design page
  score?: number;
  links: DeepLink[];
}

export type CheckState = "success" | "failure" | "pending" | "missing";

/** One review signal on a PR, from any review tool or person. */
export interface ReviewSignal {
  source: "human" | "coderabbit" | "ai-reviewer" | "code-analyzer" | "sf-ai-tester";
  author: string;
  state: "approved" | "changes-requested" | "commented" | "pass" | "block";
  summary: string;
  url?: string;
  at: string;
}

export interface PrRef {
  number: number;
  url: string;
  title: string;
  branch: string;
  draft: boolean;
  author: string;
  labels: string[];
  /** commit statuses and check runs by name: guard, static, qa, design-gate, gate/developer, ... */
  checks: Record<string, CheckState>;
  reviews: ReviewSignal[];
  storyKey?: string;         // Jira key from branch feature/ABC-12-...
  featureId?: string;
  aiAttempt?: number;
  updatedAt: string;
  state?: "open" | "merged" | "closed";
  mergedAt?: string;
  /** paths changed by the PR (first 100), e.g. to tell whether tests/<KEY>.tc.json is on it */
  files?: string[];
}

export interface QueueItem {
  id: string;
  persona: Persona;
  gate?: GateId;
  kind: "sign-off" | "clarify" | "review-stories" | "design-tests" | "testability" | "approve-plan" | "approve-testplan"
    | "review-pr" | "qa-pr" | "needs-human" | "needs-qa" | "merge" | "deploy-approval" | "connect"
    // v3
    | "create-stories" | "design-changed" | "start-story" | "add-tests" | "fix" | "review-room" | "record-verdict";
  title: string;
  detail?: string;
  featureId?: string;
  storyKey?: string;
  prNumber?: number;
  since?: string;
  links: DeepLink[];
  actions: ActionRef[];
}

export interface ProjectContextService {
  features(): Promise<Feature[]>;
  feature(id: string): Promise<Feature | undefined>;
  prs(): Promise<PrRef[]>;
  /** Everything waiting on this persona now. */
  queue(id: Identity, persona: Persona): Promise<QueueItem[]>;
  jiraBrowseUrl(key: string): string | undefined;
  /** Design page of a feature: status, versions, G1 approval (Circuit MCP design_get). */
  design(featureId: string): Promise<unknown>;
  /** Decisions section of the design page (C1, Circuit MCP decisions_get). */
  decisions(featureId: string): Promise<unknown>;
  /** "Org snapshot" child page of the design page (C4, Circuit MCP org_snapshot_get). */
  orgSnapshot(featureId: string): Promise<unknown>;
  /** One Jira story with ACs, versions, test cases and PR (Circuit MCP story_get). */
  story(key: string): Promise<unknown>;
  sources(): Promise<SourceRef[]>;
  /** Recent Fireflies meetings, read through the person's Fireflies MCP login. Empty when it isn't signed in. */
  firefliesRecent(limit?: number): Promise<SourceRef[]>;
  /** Add a Fireflies meeting to .circuit/sources.json (metadata only). meta avoids a second Fireflies read. */
  indexFireflies(meetingId: string, meta?: { title: string; date: string }): Promise<SourceRef>;
  /** Store an uploaded transcript outside git (encrypted, local) and index it. */
  addUpload(fileUri: vscode.Uri, title?: string): Promise<SourceRef>;
  /** Store pasted or dictated text (or text from a PDF / Wispr Flow) encrypted with no temp file, and index it. */
  addText(text: string, opts: { title: string; origin: SourceOrigin; date?: string }): Promise<SourceRef>;
  /** Text of an upload; for Fireflies a pointer to read it at the source. Callers enforce Architect only. */
  transcript(sourceId: string): Promise<string>;
  refresh(): Promise<void>;
  onDidChange: vscode.Event<void>;
}

// ---------- Circuit MCP ----------
export interface McpEndpoint { url: string; token: string; persona: Persona }

export interface CircuitMcpService {
  /** Starts the local HTTP MCP server if needed and returns the persona-bound endpoint. */
  endpoint(persona: Persona): Promise<McpEndpoint>;
  /** Writes .claude/personas/<persona>.local.mcp.json (gitignored) with Circuit + vendor servers for that persona. */
  writePersonaConfig(persona: Persona): Promise<string>;
  /** In-process MCP server config for Agent SDK sessions (mcpServers entry). */
  sdkServer(persona: Persona): unknown;
  stop(): Promise<void>;
}

// ---------- testing (ported SF AI Tester engine) ----------
export type TestMode = "manual" | "automation" | "both";
export type TestStatus = "passed" | "failed" | "blocked" | "error";

export interface SuiteSummary {
  file: string;              // workspace-relative
  name: string;
  cases: number;
  last?: Partial<Record<TestStatus, number>>;
  storyKey?: string;
  /** Set when the suite file fails to load or validate. */
  error?: string;
}

export interface RunRequest { suite: string; caseIds?: string[]; mode: TestMode; orgRole: "dev" | "qa" }

export interface RunSummary {
  runDir: string;            // workspace-relative
  suite: string;
  total: number;
  counts: Record<TestStatus, number>;
  route: "pass" | "dev" | "qa" | "infra";
  reportPath: string;        // workspace-relative report.html
  startedAt?: string;        // ISO
  org?: string;              // sf alias the run used
}

export interface TestingService {
  suites(): Promise<SuiteSummary[]>;
  run(req: RunRequest, onEvent?: (e: { type: string; message?: string; caseId?: string; status?: TestStatus }) => void): Promise<RunSummary>;
  cancel(): void;
  runs(limit?: number): Promise<RunSummary[]>;
  onDidChange: vscode.Event<void>;
}

// ---------- actions and sessions ----------
export interface ActionRef {
  /** Grammar (src/actions/grammar.ts): "ai:<skill command>" (e.g. "ai:/dev-review-plan"), "gate:label" or
   *  "gate:label:<label>", "gate:review", "gate:merge", "gate:deploy", "nav:feature", "nav:testing",
   *  "nav:connections", and the v3 named actions:
   *  dev:start-story {storyKey, featureId?, pr?, phase?: "build"}, qa:add-tests {storyKey, pr?},
   *  dev:fix {pr, checks?, attempt?, failure?}, review:open-room {pr}, review:record-verdict {pr},
   *  decision:record {featureId, text?}, arch:approve-design {featureId | pageId | url} (opens the Confluence page;
   *  G1 is a human status change, never AI). AI-run named actions may also carry {command, arg}. */
  id: string;
  label: string;
  persona: Persona;
  kind: "ai" | "gate" | "nav";
  /** AI actions: {command, argKind?: "feature"|"pr"|"source", arg?, intent?}. nav:feature: {featureId}. nav:testing: {suite?}.
   *  gate:review / gate:merge: {pr, sha?} where sha is the head commit the person was shown. */
  args?: Record<string, string | number>;
}

/** Argument shapes of the cross-module commands. */
export interface OpenPersonaOptions { featureId?: string }
export interface OpenTestingOptions { suite?: string }

export interface ActionsService {
  /** Runs an action as the current identity. Gate actions confirm first and use the person's own GitHub token. */
  run(action: ActionRef): Promise<void>;
  /** Whether the current identity may run it (canAct + gate rules). */
  allowed(action: ActionRef): boolean;
}

export interface SessionsService {
  /** Start Claude as a persona with a prompt (usually a skill command such as "/dev-review-plan 42"). */
  start(persona: Persona, prompt: string, opts?: { mode?: "terminal" | "panel"; title?: string }): Promise<void>;
}

// ---------- module wiring ----------
export interface CircuitServices {
  ctx: vscode.ExtensionContext;
  /** Absolute path of the workspace root (the client Salesforce DX repo). */
  root: string;
  /** Absolute path of the bundled sf-delivery-circuit plugin (templates, installer, skills). */
  pluginRoot: string;
  log: (msg: string) => void;
  identity: IdentityService;
  connections: ConnectionsService;
  project: ProjectContextService;
  mcp: CircuitMcpService;
  testing: TestingService;
  actions: ActionsService;
  sessions: SessionsService;
}
