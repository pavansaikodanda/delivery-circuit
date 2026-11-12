// Read models the Circuit MCP serves for one feature or story (design_get, decisions_get, org_snapshot_get,
// story_get). Pure functions (no vscode import).
import { designSyncText } from "./design";
import { slugify, storyPr, storyTestable } from "./gates";
import { AI_READY } from "./jira";
import type { DesignPage, FeatureInfo, PrInfo, StoryInfo } from "./model";
import { suitePath, tcIndexPath } from "./queue";

export function designDetail(f: FeatureInfo, page: DesignPage | undefined) {
  if (!f.design) return { featureId: f.id, epicKey: f.epicKey ?? null, state: "missing", detail: "No Confluence design page linked to this feature" };
  const a = f.design.approval;
  return {
    featureId: f.id, epicKey: f.epicKey ?? null, title: f.title,
    pageId: f.design.pageId, pageTitle: f.design.title ?? null, url: f.design.url ?? null,
    status: f.design.status ?? null, currentVersion: f.design.version ?? null,
    approvedVersion: a.approvedVersion ?? null, approvedBy: a.approvedBy ?? null, approverIsArchitect: a.approverIsArchitect ?? null,
    state: a.state, changedSinceApproval: a.changedSinceApproval, detail: a.detail,
    gate: { G1: f.gates.G1 ?? null },
    openQuestions: f.openQuestions, sections: page?.sections ?? [], decisions: page?.decisions.length ?? 0,
    orgSnapshotUrl: f.design.orgSnapshotUrl ?? null, readAt: f.design.readAt ?? null, error: f.design.error ?? null,
    howToRead: a.approvedVersion
      ? `Work from the approved version only: Atlassian MCP getConfluenceContentVersion for page ${f.design.pageId} version ${a.approvedVersion}.`
      : "The design is not approved yet (G1): do not plan or build from it.",
  };
}

export function decisionsDetail(f: FeatureInfo, page: DesignPage | undefined) {
  return {
    featureId: f.id, pageId: f.design?.pageId ?? null, url: f.design?.url ?? null, readAt: page?.readAt ?? null,
    decisions: page?.decisions ?? [],
    note: "Decision log (C1) from the design page's Decisions section. Add one with /record-decision.",
  };
}

export function orgSnapshotDetail(f: FeatureInfo, page: DesignPage | undefined) {
  return {
    featureId: f.id, designPageId: f.design?.pageId ?? null, readAt: page?.readAt ?? null,
    snapshot: page?.orgSnapshot ?? null,
    note: page?.orgSnapshot ? "Child page \"Org snapshot\" of the design page (C4)." : "No \"Org snapshot\" child page found under the design page.",
  };
}

export function storyDetail(f: FeatureInfo, s: StoryInfo, prs: PrInfo[]) {
  const pr = storyPr(prs, s.jiraKey);
  const key = s.jiraKey!;
  return {
    key, featureId: f.id, epicKey: f.epicKey ?? null, num: s.num, title: s.title, status: s.status ?? null, url: s.url ?? null,
    labels: s.labels, acceptanceCriteria: s.acceptanceCriteria ?? null,
    design: {
      pageId: f.design?.pageId ?? null, url: f.design?.url ?? null,
      storyApprovedVersion: s.approvedDesignVersion ?? null, pageApprovedVersion: f.design?.approval.approvedVersion ?? null,
      c5: s.designSync, c5Detail: designSyncText(s.designSync, s.approvedDesignVersion, f.design?.approval.approvedVersion),
    },
    testability: { aiReady: s.labels.includes(AI_READY), confirmed: s.testabilityConfirmed ?? null, g2: storyTestable(s) },
    blockedBy: s.blockedBy,
    testCases: s.testCases,
    branch: pr?.branch ?? `feature/${key}-${slugify(s.title)}`,
    prTitle: `${key} ${s.title}`,
    suite: suitePath(key), tcIndex: tcIndexPath(key), plan: `docs/plans/${key}/PLAN.md`, testPlan: `docs/plans/${key}/TESTPLAN.md`,
    pr: pr ? { number: pr.number, url: pr.url, state: pr.state, draft: pr.draft, author: pr.author, labels: pr.labels, checks: pr.checks } : null,
  };
}
