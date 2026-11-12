// Internal types of the project module (no vscode import). Public shapes live in core/contracts.ts.
// v3: features come from Jira epics and their Confluence design pages; nothing is read from .specify/specs.
import type { Feature, PrRef, Story, TestCaseRef } from "../core/contracts";

// ---------- Jira (normalised from `acli jira workitem ... --json`) ----------

/** One Jira link of an issue, seen from that issue. */
export interface JiraLink {
  /** link type name, e.g. "Blocks", "Relates", "Tests" */
  type: string;
  /** "inward" = the other issue points at this one (e.g. "is blocked by"), "outward" = this one points at the other */
  direction: "inward" | "outward";
  /** the link phrase seen from this issue ("is blocked by", "blocks", "is tested by") */
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
  /** Every field the CLI returned (custom fields included), raw, for the configured field ids. */
  fields: Record<string, unknown>;
}

/** Jira custom fields of the circuit. Ids come from build.config.yml `jira.fields`, names are matched otherwise. */
export interface JiraFieldMap {
  designPage?: string;
  approvedDesignVersion?: string;
  acceptanceCriteria?: string;
  testabilityConfirmed?: string;
}

/** The project's circuit settings read from build.config.yml (no secrets there). */
export interface CircuitConfig {
  /** https://<site>.atlassian.net, when set */
  site?: string;
  projectKey?: string;
  spaceKey?: string;
  fields: JiraFieldMap;
  /** Atlassian emails / account ids / display names of the architects (G1 approver check). Empty = cannot verify. */
  architects: string[];
  /** ai.max_attempts (Fix with AI cap) */
  maxAttempts: number;
}

// ---------- Confluence design page (read through the Atlassian MCP by a read-only Claude call) ----------

export interface PageVersion {
  number: number;
  /** author: email, account id or display name, whatever the reader returned */
  by?: string;
  at?: string;
  message?: string;
}

export interface Decision {
  date?: string;
  decision: string;
  who?: string;
  why?: string;
  source?: string;
}

export interface OrgSnapshot {
  pageId?: string;
  url?: string;
  title?: string;
  version?: number;
  objects: string[];
  fields: string[];
  flows: string[];
  permissionSets: string[];
  other?: string[];
}

/** What the reader returns for one design page (all optional except id: pages may be partially readable). */
export interface DesignPage {
  id: string;
  title?: string;
  url?: string;
  spaceKey?: string;
  /** Confluence content status, e.g. "Approved", "Rough draft", "In progress", "Ready for review" */
  status?: string;
  /** current page version number */
  version?: number;
  /** recent versions, newest first */
  versions: PageVersion[];
  /** headings on the page (to tell spec, plan and data model apart) */
  sections: string[];
  openQuestions: number;
  decisions: Decision[];
  /** source ids cited on the page (fireflies:<id>, upload:<id>) */
  sources: string[];
  orgSnapshot?: OrgSnapshot;
  /** ISO time this was read */
  readAt: string;
  /** set when the page could not be read */
  error?: string;
}

export type DesignState = "approved" | "changed" | "draft" | "unverified-approver" | "missing" | "unknown";

/** G1 evaluation of a design page. */
export interface DesignApproval {
  state: DesignState;
  /** the version that the Approved status refers to */
  approvedVersion?: number;
  approvedBy?: string;
  /** true = approver is a configured architect; false = not one; undefined = cannot tell (no architects configured) */
  approverIsArchitect?: boolean;
  /** current version is newer than the approved one */
  changedSinceApproval: boolean;
  /** one line for the UI */
  detail: string;
}

/** C5: the story's Approved design version compared with the page's current approved version. */
export type DesignSync = "ok" | "changed" | "missing" | "ahead" | "unknown";

// ---------- features ----------

export interface StoryInfo extends Story {
  status?: string;
  statusCategory?: string;
  labels: string[];
  acceptanceCriteria?: string;
  approvedDesignVersion?: number;
  testabilityConfirmed?: boolean;
  /** C5 against the feature's design page */
  designSync: DesignSync;
  /** keys of issues that block this story (Jira "is blocked by") */
  blockedBy: string[];
  url?: string;
}

/** A Feature (contract shape) with the v3 facts. Structurally a Feature, so it can be served as one. */
export interface FeatureInfo extends Feature {
  /** the Jira epic; absent while the feature is only a design page */
  epicKey?: string;
  stories: StoryInfo[];
  design?: {
    pageId: string;
    url?: string;
    title?: string;
    status?: string;
    version?: number;
    approval: DesignApproval;
    orgSnapshotUrl?: string;
    readAt?: string;
    error?: string;
  };
}

/** Raw inputs of one feature before gates and stages are computed. A feature is an epic with its design page, or a
 *  design page (label circuit-design) that has no epic yet (steps 2-4 come before the epic exists). */
export interface FeatureSource {
  epic?: JiraIssue;
  stories: JiraIssue[];
  /** test-case issues linked to the stories */
  tests: JiraIssue[];
  pageId?: string;
  page?: DesignPage;
  /** title/url of a page-only feature, from the design-page listing */
  pageListing?: DesignPageListing;
}

/** One design page found by the Confluence listing (label circuit-design in the project's space). */
export interface DesignPageListing { id: string; title: string; url?: string; status?: string; version?: number }

/** A PR with the fields gates need. prs() returns these (structurally PrRef). */
export interface PrInfo extends PrRef {
  state: "open" | "merged" | "closed";
  mergedAt?: string;
  headSha: string;
  /** paths changed by the PR (first 100), to tell whether the Tester's suite is on it */
  files?: string[];
}

export interface DeployRun {
  id: number;
  /** GitHub run status: queued | in_progress | waiting | completed | ... */
  status: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
  headSha: string;
}

export interface DeployInfo {
  runs: DeployRun[];
  /** commit date of the prod-deployed tag */
  prodDeployedAt?: string;
  prodDeployedSha?: string;
}

export interface RepoRef { owner: string; repo: string }

export type { TestCaseRef };
