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
export type ConnectionId =
  | "github" | "claude" | "sf-dev" | "sf-qa" | "jira" | "confluence" | "slack"
  | "fireflies" | "lucid" | "testing-browsers"
  // review tools
  | "coderabbit" | "code-analyzer" | "ai-reviewer"
  // vendor MCP servers that Claude uses (sign-in happens in Claude Code's /mcp)
  | "mcp-atlassian" | "mcp-github" | "mcp-salesforce" | "mcp-slack" | "mcp-lucid" | "mcp-fireflies";

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

export interface JiraCredentials { site: string; email: string; token: string }

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
  /** Interactive connect flow (sign-in, token prompt, sf org login web, ...). */
  connect(id: ConnectionId): Promise<ConnectionStatus>;
  disconnect(id: ConnectionId): Promise<void>;
  onDidChange: vscode.Event<void>;
  /** GitHub session token (VS Code auth provider). Throws if not signed in. */
  githubToken(): Promise<string>;
  jira(): Promise<JiraCredentials | undefined>;
  firefliesKey(): Promise<string | undefined>;
  /** sf CLI alias for an org role, e.g. "dev" / "qa". */
  sfAlias(role: "dev" | "qa"): string;
  /** Resolves the role's alias with the sf CLI and decides whether AI may work in that org (browser agent, org
   *  exploration). Allowed when the alias resolves to a connected org of any type (SDO and demo orgs are production orgs). */
  sfOrgGuard(role: "dev" | "qa"): Promise<SfOrgGuard>;
  /** GitHub REST call as the signed-in person (path like "/repos/o/r/pulls"). Throws on non-2xx with the API message. */
  githubRequest<T = any>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
  /** GitHub GraphQL call as the signed-in person. */
  githubGraphql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T>;
  /** Names of the repo's Actions secrets (values are never readable). */
  repoSecretNames(): Promise<string[]>;
  /** Encrypt (libsodium sealed box, repo public key) and store an Actions secret; env = environment name for env secrets. */
  setRepoSecret(name: string, value: string, env?: string): Promise<void>;
  /** Secrets the circuit's workflows need (CI secrets, Slack webhooks, environment secrets) and whether each exists.
   *  present is undefined when the person can't list secrets (needs repo admin). */
  projectSecrets(): Promise<ProjectSecret[]>;
}

export interface ProjectSecret {
  name: string;
  /** "ci" | "webhook" | ... (what the secret is for) */
  kind: string;
  present?: boolean;
  /** GitHub environment, for environment secrets */
  env?: string;
  /** True when a build-state.md reminder says it expires within 30 days */
  expiring?: boolean;
}

// ---------- project context (Spec Kit, GitHub, Jira, sources) ----------
export type GateId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8" | "G9";
export type GateState = "done" | "waiting" | "blocked" | "not-started";

export const GATES: Record<GateId, { owner: Persona; label: string }> = {
  G1: { owner: "architect", label: "Plan signed off" },
  G2: { owner: "tester", label: "Testability confirmed (ai-ready)" },
  G3: { owner: "developer", label: "AI plan approved" },
  G4: { owner: "tester", label: "AI test plan approved" },
  G5: { owner: "developer", label: "Code review" },
  G6: { owner: "tester", label: "QA on sandbox" },
  G7: { owner: "architect", label: "Schema and design review" },
  G8: { owner: "architect", label: "Merge" },
  G9: { owner: "architect", label: "Production approval" },
};

/** Spec Kit lifecycle stages, read from .specify/specs/NNN-slug/ */
export type StageId = "intake" | "clarify" | "plan" | "signoff" | "stories" | "tests" | "jira" | "build" | "qa" | "release";
export type StageState = "done" | "active" | "todo" | "blocked";

export interface DeepLink {
  kind: "github" | "jira" | "salesforce" | "slack" | "confluence" | "lucid" | "fireflies" | "coderabbit" | "file" | "report" | "url";
  label: string;
  /** https URL, or a workspace-relative file path for kind "file"/"report" */
  target: string;
}

export interface SourceRef {
  /** "fireflies:<meetingId>" or "upload:<sha256-12>" */
  id: string;
  kind: "fireflies" | "upload";
  title: string;
  /** ISO date of the call or upload */
  date: string;
  /** Feature ids whose spec cites this source */
  usedBy?: string[];
}

export interface TestCaseRef { id: string; level: "ui" | "unit" | "manual"; ac?: string; jiraKey?: string }

export interface Story {
  num: string;               // "00", "01", ...
  title: string;
  file: string;              // workspace-relative path of task_story_NN.md
  jiraKey?: string;
  testCases: TestCaseRef[];
  prNumber?: number;
}

export interface Feature {
  id: string;                // "001"
  slug: string;              // "001-case-escalation"
  title: string;
  dir: string;               // workspace-relative
  stages: Record<StageId, StageState>;
  gates: Partial<Record<GateId, GateState>>;
  openQuestions: number;
  signedOff: boolean;
  stories: Story[];
  sources: string[];         // SourceRef ids cited by the spec
  score?: number;            // speckit-sf-score, if present
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
  /** commit statuses and check runs by name: guard, static, qa, spec-gate, gate/developer, ... */
  checks: Record<string, CheckState>;
  reviews: ReviewSignal[];
  storyKey?: string;         // Jira key from branch feature/ABC-12-...
  featureId?: string;
  aiAttempt?: number;
  updatedAt: string;
  state?: "open" | "merged" | "closed";
  mergedAt?: string;
}

export interface QueueItem {
  id: string;
  persona: Persona;
  gate?: GateId;
  kind: "sign-off" | "clarify" | "review-stories" | "design-tests" | "testability" | "approve-plan" | "approve-testplan"
    | "review-pr" | "qa-pr" | "needs-human" | "needs-qa" | "merge" | "deploy-approval" | "connect";
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
  /** jira-map.json (refs -> keys) of a feature */
  jiraMap(featureId: string): Promise<Record<string, string>>;
  jiraBrowseUrl(key: string): string | undefined;
  sources(): Promise<SourceRef[]>;
  /** Recent Fireflies meetings (not necessarily indexed yet). Empty when Fireflies isn't connected. */
  firefliesRecent(limit?: number): Promise<SourceRef[]>;
  /** Add a Fireflies meeting to .circuit/sources.json (metadata only). */
  indexFireflies(meetingId: string): Promise<SourceRef>;
  /** Store an uploaded transcript outside git (encrypted, local) and index it. */
  addUpload(fileUri: vscode.Uri, title?: string): Promise<SourceRef>;
  /** Full transcript text. Callers must enforce persona (Architect only). */
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
   *  "gate:label:<label>", "gate:review", "gate:merge", "gate:signoff", "gate:deploy", "nav:feature", "nav:testing",
   *  "nav:connections". */
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
