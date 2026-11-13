// Shared contracts of the Delivery Circuit v4 extension (docs/CIRCUIT-V4.md section 7). Modules code against these
// types only; they never import another module's internals.

import type * as vscode from "vscode";

// ---------- roles and identity ----------
/** "tester" is the QA role (GitHub team "testers", Claude agent "tester"). */
export type Role = "architect" | "developer" | "tester" | "lead";
export const ROLES: Role[] = ["architect", "developer", "tester", "lead"];
export const ROLE_LABEL: Record<Role, string> = { architect: "Architect", developer: "Developer", tester: "QA", lead: "Lead" };
/** GitHub team slug per role (deliveryCircuit.githubTeams overrides it). */
export const DEFAULT_TEAMS: Record<Role, string> = { architect: "architects", developer: "developers", tester: "testers", lead: "leads" };
/** Claude Code agent (plugin agents/<name>.md) a role's sessions run as. Leads have none: plain claude. */
export const ROLE_AGENT: Record<Role, string | undefined> = { architect: "architect", developer: "developer", tester: "tester", lead: undefined };

export const isRole = (x: unknown): x is Role => typeof x === "string" && (ROLES as string[]).includes(x);

export interface Identity {
  /** GitHub login of the person using VS Code */
  login: string;
  /** Roles from GitHub team membership. Empty when no team says (personal repo, or not in a team). */
  roles: Role[];
  /** The role the person works as now (the header chip). */
  active: Role | null;
  /** Org or repo admin. */
  isAdmin: boolean;
  /** owner/repo of the open workspace, from git remote "origin" */
  owner: string;
  repo: string;
  /** True when the repo is owned by an organisation (teams exist). */
  orgOwned: boolean;
  /** Why roles are missing (not in a team, team membership unreadable, ...). */
  notice?: string;
}

/** Roles the chip offers: the person's team roles, or all four when no team says (the chip is a view filter; GitHub
 *  rulesets, CODEOWNERS and the production environment still decide who may approve or merge). */
export function roleChoices(id: Identity | null): Role[] {
  if (!id) return [];
  return id.roles.length ? id.roles : [...ROLES];
}

export interface IdentityService {
  get(): Identity | null;
  refresh(): Promise<Identity | null>;
  setActive(r: Role): Promise<void>;
  onDidChange: vscode.Event<Identity | null>;
}

// ---------- connections (section 7: about 7 rows, logins only, no tokens or secrets) ----------
export type ConnectionId = "github" | "claude" | "sf-dev" | "sf-qa" | "atlassian" | "lucid" | "coderabbit" | "fireflies";
export type ConnectionState = "connected" | "disconnected" | "error" | "checking" | "unknown";

export interface ConnectionStatus {
  id: ConnectionId;
  label: string;
  state: ConnectionState;
  /** who it is connected as (login, email, org username) */
  account?: string;
  /** one short line: what is connected, or what to do */
  detail?: string;
  /** roles that need it; other roles do not see the row */
  neededBy: Role[];
  /** nice to have (Fireflies): never listed as missing */
  optional?: boolean;
}

export interface ConnectionsService {
  list(): Promise<ConnectionStatus[]>;
  /** last known rows without waiting for checks */
  cached(): ConnectionStatus[];
  check(id: ConnectionId): Promise<ConnectionStatus>;
  /** Interactive connect / fix flow (sign-in, browser login, /mcp). Never asks for a token. */
  connect(id: ConnectionId): Promise<ConnectionStatus>;
  onDidChange: vscode.Event<void>;
  /** sf CLI alias of the DEV or QA org (build.config.yml salesforce.dev_alias / qa_alias). */
  sfAlias(org: "dev" | "qa"): string;
  /** GitHub REST call as the signed-in person. Throws on non-2xx (error.status = HTTP status). */
  githubRequest<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T>;
  /** GitHub GraphQL call as the signed-in person. */
  githubGraphql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

// ---------- links ----------
export interface DeepLink {
  kind: "github" | "jira" | "confluence" | "lucid" | "salesforce" | "url";
  label: string;
  /** https URL */
  target: string;
}

// ---------- transcripts (New design from transcript) ----------
export type SourceOrigin = "paste" | "file" | "fireflies";

export interface SourceRef {
  /** "fireflies:<meetingId>" or "upload:<sha256-12>" */
  id: string;
  kind: "fireflies" | "upload";
  title: string;
  /** ISO date of the call or upload */
  date: string;
  origin?: SourceOrigin;
}

// ---------- work (Jira + GitHub, section 7 Work and Missing tabs) ----------
/** The one status a sprint story shows. */
export type StoryStatus = "design" | "ready" | "building" | "in-pr" | "qa" | "done";
export const STORY_STATUS_LABEL: Record<StoryStatus, string> = {
  design: "Design", ready: "Ready", building: "Building", "in-pr": "In PR", qa: "QA", done: "Done",
};

export type CheckState = "success" | "failure" | "pending" | "missing";
export type CodeRabbitState = "approved" | "changes" | "pending";

/** What one click does. Steps and missing items keep it on the extension side; the webview only sends the row id. */
export type RunSpec =
  | { kind: "skill"; role: Role; command: string; arg?: string }
  | { kind: "url"; url: string }
  | { kind: "intake" }
  | { kind: "connect"; id: ConnectionId }
  | { kind: "story"; key: string }
  | { kind: "bootstrap" };

export interface WorkRow {
  id: string;
  title: string;
  detail?: string;
  /** the one button: short label */
  button: string;
  run: RunSpec;
}

export interface MissingItem extends WorkRow {
  group: "connections" | "repo" | "stories";
}

export interface SprintRow {
  key: string;
  title: string;
  status: StoryStatus;
  url?: string;
}

export interface StoryPrState {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  scan: CheckState;
  scanUrl?: string;
  coderabbit: CodeRabbitState;
  /** human approvals (GitHub logins) */
  approvedBy: string[];
  /** ISO time the PR is waiting for a human approval since (open PRs without one) */
  waitingSince?: string;
}

export interface StoryDetail {
  key: string;
  title: string;
  status: StoryStatus;
  /** Design → Stories → Build → QA → Release */
  steps: { id: "design" | "stories" | "build" | "qa" | "release"; label: string; state: "done" | "active" | "todo" }[];
  pr?: StoryPrState;
  links: DeepLink[];
}

export interface WorkSnapshot {
  /** next steps for the role (at most 5) */
  next: WorkRow[];
  sprint: { name?: string; stories: SprintRow[] };
  missing: MissingItem[];
  /** short reasons data could not be read (Jira, GitHub) */
  errors: string[];
  updatedAt: string;
}

export interface ProjectService {
  /** Everything the Work and Missing tabs show for a role (connections come from ConnectionsService). */
  work(role: Role, login: string | undefined, connections: ConnectionStatus[]): Promise<WorkSnapshot>;
  /** One story for the story panel. */
  story(key: string): Promise<StoryDetail | undefined>;
  /** Store pasted text or a transcript file outside git (encrypted, local) and index it. */
  addText(text: string, opts: { title: string; origin: SourceOrigin }): Promise<SourceRef>;
  addFile(file: string): Promise<SourceRef>;
  /** Recent Fireflies meetings through the person's Fireflies MCP login. Empty when it is not connected. */
  firefliesRecent(limit?: number): Promise<SourceRef[]>;
  /** Text of an upload; for Fireflies a pointer to read it at the source. */
  transcript(sourceId: string): Promise<string>;
  refresh(): Promise<void>;
  onDidChange: vscode.Event<void>;
}

// ---------- Circuit MCP (transcript_get for /circuit-intake) ----------
export interface McpEndpoint { url: string; token: string }

export interface CircuitMcpService {
  /** Writes .claude/personas/<agent>.local.mcp.json (gitignored) with the tracked vendor servers plus, for the
   *  Architect, the Circuit MCP. Returns the file, or undefined when the role has no agent config. */
  writeSessionConfig(role: Role): Promise<string | undefined>;
  stop(): Promise<void>;
}

export interface SessionsService {
  /** Start Claude in a terminal as the role with a prompt (usually a skill command such as "/dev-start-story ACME-12"). */
  start(role: Role, prompt: string): Promise<void>;
}

// ---------- module wiring ----------
export interface CircuitServices {
  ctx: vscode.ExtensionContext;
  /** Absolute path of the workspace root (the Salesforce DX repo). */
  root: string;
  log: (msg: string) => void;
  identity: IdentityService;
  connections: ConnectionsService;
  project: ProjectService;
  mcp: CircuitMcpService;
  sessions: SessionsService;
}
