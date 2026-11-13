// Internal types of the project module (no vscode import). Public shapes live in core/contracts.ts.

// ---------- Jira (normalised from `acli jira workitem ... --json` or the Atlassian MCP reader) ----------

/** One Jira link of an issue, seen from that issue. */
export interface JiraLink {
  /** link type name, e.g. "Blocks", "Relates", "Tests" */
  type: string;
  /** "inward" = the other issue points at this one (e.g. "is blocked by"), "outward" = this one points at the other */
  direction: "inward" | "outward";
  phrase: string;
  key: string;
  summary?: string;
  status?: string;
  statusCategory?: string;
  issueType?: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  issueType: string;
  status: string;
  /** "new" | "indeterminate" | "done" (Jira status category key) when known */
  statusCategory?: string;
  labels: string[];
  parentKey?: string;
  description?: string;
  updated?: string;
  created?: string;
  links: JiraLink[];
  /** Every field the reader returned (custom fields included), raw, for the configured field ids. */
  fields: Record<string, unknown>;
}

/** Jira custom fields of the circuit. Ids come from build.config.yml `jira.fields`; names are matched otherwise. */
export interface JiraFieldMap {
  designPage?: string;
  acceptanceCriteria?: string;
}

/** The project's circuit settings read from build.config.yml (no secrets there). */
export interface CircuitConfig {
  /** https://<site>.atlassian.net, when set */
  site?: string;
  projectKey?: string;
  spaceKey?: string;
  fields: JiraFieldMap;
  /** jira.ready_status: the status people set at refinement (default "Ready for Dev") */
  readyStatus: string;
  /** environments: branch pattern -> GitHub Environment (section 3) */
  environments: { branch: string; environment: string }[];
}

// ---------- Confluence design pages (one read-only listing per space) ----------

export interface DesignPage {
  id: string;
  title: string;
  url?: string;
  /** Confluence content status, e.g. "Approved", "Rough draft", "In progress", "Ready for review" */
  status?: string;
  /** unanswered rows of "Open questions" */
  openQuestions: number;
  /** feature slug from the label feature-<slug> */
  slug?: string;
  /** Lucid diagram link on the page */
  diagramUrl?: string;
}

/** A feature: a Jira epic with its design page, or a design page without an epic yet. */
export interface Feature {
  /** epic key, or "page-<id>" for a design page without an epic */
  id: string;
  title: string;
  slug?: string;
  epic?: JiraIssue;
  page?: DesignPage;
}

// ---------- GitHub ----------

export type CheckState = "success" | "failure" | "pending" | "missing";

export interface PrInfo {
  number: number;
  url: string;
  title: string;
  author: string;
  head: string;
  base: string;
  draft: boolean;
  state: "open" | "merged" | "closed";
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  mergeSha?: string;
  /** Jira key from feature/<KEY>-... or a title that starts with the key */
  storyKey?: string;
  /** the required `scan` check */
  scan: CheckState;
  scanUrl?: string;
  /** CodeRabbit's latest review */
  coderabbit: "approved" | "changes" | "pending";
  /** people (not bots) whose latest review approves */
  approvedBy: string[];
  /** people (not bots) whose latest review requests changes */
  changesBy: string[];
  autoMerge: boolean;
}

export interface DeployRun {
  id: number;
  branch: string;
  /** queued | in_progress | waiting | completed | ... */
  status: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
}

export interface RepoRef { owner: string; repo: string }

/** Repo setup facts for the Missing tab (names only; a secret value is never read). undefined = could not tell. */
export interface RepoSetup {
  /** environment branch -> exists */
  branches: Record<string, boolean>;
  /** at least one sprint/* branch */
  sprintBranch?: string;
  /** GitHub Environment -> exists, and whether it has a secret named SFDX_AUTH_URL */
  environments: Record<string, { exists: boolean; authUrl?: boolean }>;
  /** branch -> covered by an active ruleset */
  rulesets?: Record<string, boolean>;
  autoMerge?: boolean;
}

/** Everything the work model reads, gathered by the service. */
export interface WorkData {
  repo?: RepoRef;
  readyStatus: string;
  features: Feature[];
  /** stories of the current sprint (Jira open sprint, else the stories of open epics) */
  stories: JiraIssue[];
  /** test-case issues linked to those stories */
  tests: JiraIssue[];
  prs: PrInfo[];
  deploys: DeployRun[];
  /** current sprint branch (newest sprint/*) */
  sprint?: string;
  /** commits the sprint branch has that dev does not */
  sprintAhead?: number;
  setup?: RepoSetup;
  fields: JiraFieldMap;
  site?: string;
  /** whether design pages were read (else "no approved design" cannot be told) */
  designsRead: boolean;
  errors: string[];
}
