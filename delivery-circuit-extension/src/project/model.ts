// Internal types of the project module (no vscode import). Public shapes live in core/contracts.ts.
import type { Feature, PrRef } from "../core/contracts";

/** Facts read from a feature folder that the contracts' Feature does not carry. */
export interface FeatureFacts {
  hasSpec: boolean;
  hasClarification: boolean;
  hasPlan: boolean;
  hasDataModel: boolean;
  /** /speckit-sf-review report present (review*.md in the feature folder) */
  hasReview: boolean;
  /** story numbers that have tests/story_NN.tc.json */
  tcStories: string[];
  /** jira-map.json refs */
  jiraRefs: Record<string, string>;
  /** files of the clarification report(s), workspace-relative */
  clarificationFiles: string[];
}

export interface ParsedFeature { feature: Feature; facts: FeatureFacts }

/** A PR with the fields gates need. prs() returns these (structurally PrRef). */
export interface PrInfo extends PrRef {
  state: "open" | "merged" | "closed";
  mergedAt?: string;
  headSha: string;
  /** "NN" when the story key resolves through a jira-map.json */
  storyNum?: string;
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

/** Jira labels per issue key; undefined when Jira is not connected. */
export type JiraLabels = Record<string, string[]> | undefined;

export interface RepoRef { owner: string; repo: string }
