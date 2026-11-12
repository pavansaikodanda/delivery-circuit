// v3 features (Jira epic + Confluence design page), their stages and gates G1..G9 from the design page, Jira, PRs and
// production deploys. Pure functions (no vscode import), unit-tested.
import type { DeepLink, Feature, GateId, GateState, StageState } from "../core/contracts";
import { designApproval, designSync } from "./design";
import {
  acceptanceCriteriaOf, AI_READY, approvedDesignVersionOf, blockedByOf, designPageOf, storyNumbers, storyTitleOf,
  testabilityOf, testCasesFor,
} from "./jira";
import type { CircuitConfig, DeployInfo, DesignApproval, FeatureInfo, FeatureSource, PrInfo, RepoRef, StoryInfo } from "./model";

export interface BuildOptions {
  repo?: RepoRef;
  jiraBrowseUrl?: (key: string) => string | undefined;
}

type Mark = "ok" | "waiting" | "blocked" | "none";

/** done when every story is ok; blocked wins; waiting when anything moved; not-started otherwise */
export function aggregate(marks: Mark[]): GateState {
  if (marks.length === 0) return "not-started";
  if (marks.every((m) => m === "ok")) return "done";
  if (marks.includes("blocked")) return "blocked";
  if (marks.includes("waiting") || marks.includes("ok")) return "waiting";
  return "not-started";
}

const isSuccess = (pr: PrInfo, ctx: string) => pr.checks[ctx] === "success";

/** Story PRs get the feature (epic key) of their story. Mutates and returns prs. */
export function linkPrs(features: { id: string; stories: { jiraKey?: string }[] }[], prs: PrInfo[]): PrInfo[] {
  const byKey = new Map<string, string>();
  for (const f of features) for (const s of f.stories) if (s.jiraKey) byKey.set(s.jiraKey, f.id);
  for (const pr of prs) {
    const fid = pr.storyKey ? byKey.get(pr.storyKey) : undefined;
    if (fid) pr.featureId = fid;
  }
  return prs;
}

/** The PR that represents a story: the open one if any, else the latest merged one. Closed-unmerged PRs are ignored. */
export function storyPr(prs: PrInfo[], key: string | undefined): PrInfo | undefined {
  if (!key) return undefined;
  const mine = prs.filter((p) => p.storyKey === key && p.state !== "closed");
  return mine.find((p) => p.state === "open") ?? mine.filter((p) => p.state === "merged").sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""))[0];
}

/** G2 for one story: label ai-ready and Testability confirmed (when the project records it). */
export const storyTestable = (s: StoryInfo) => s.labels.includes(AI_READY) && s.testabilityConfirmed !== false;

export function g1State(a: DesignApproval): GateState {
  switch (a.state) {
    case "approved": return "done";
    case "unverified-approver": return "blocked";
    case "missing": return "not-started";
    default: return "waiting";
  }
}

export function computeGates(f: FeatureInfo, prs: PrInfo[], deploy?: DeployInfo): Partial<Record<GateId, GateState>> {
  const g: Partial<Record<GateId, GateState>> = {};
  g.G1 = f.design ? g1State(f.design.approval) : "not-started";
  g.G2 = f.stories.length === 0 ? "not-started" : aggregate(f.stories.map((s) => (storyTestable(s) ? "ok" : "waiting")));

  const story = f.stories.map((s) => storyPr(prs, s.jiraKey));
  const label = (l: string): Mark[] => story.map((pr) => (!pr ? "none" : pr.state === "merged" || pr.labels.includes(l) ? "ok" : "waiting"));
  g.G3 = aggregate(label("plan-approved"));
  g.G4 = aggregate(label("testplan-approved"));
  const review = (ctx: string, blockLabel?: string): Mark[] => story.map((pr) => {
    if (!pr) return "none";
    if (pr.state === "merged" || isSuccess(pr, ctx)) return "ok";
    if (blockLabel && pr.labels.includes(blockLabel)) return "blocked";
    return pr.draft ? "none" : "waiting";
  });
  g.G5 = aggregate(review("gate/developer", "needs-human"));
  g.G6 = aggregate(review("gate/tester", "needs-qa"));
  g.G7 = aggregate(review("gate/architect"));
  g.G8 = aggregate(story.map((pr) => (!pr ? "none" : pr.state === "merged" ? "ok"
    : !pr.draft && ["gate/developer", "gate/tester", "gate/architect"].every((c) => isSuccess(pr, c)) ? "waiting" : "none")));
  g.G9 = productionGate(g.G8, story, deploy);
  return g;
}

function productionGate(g8: GateState, story: (PrInfo | undefined)[], deploy?: DeployInfo): GateState {
  if (g8 !== "done") return "not-started";
  const lastMerge = story.map((p) => p?.mergedAt ?? "").sort().pop() ?? "";
  if (!deploy) return "waiting";
  if (deploy.prodDeployedAt && deploy.prodDeployedAt >= lastMerge) return "done";
  const after = deploy.runs.filter((r) => r.createdAt >= lastMerge).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (after.some((r) => r.status === "waiting")) return "waiting";
  const latest = after[0];
  if (latest && latest.status === "completed" && latest.conclusion && latest.conclusion !== "success") return "blocked";
  if (latest && latest.status === "completed" && latest.conclusion === "success" && !deploy.prodDeployedSha) return "done";
  return "waiting";
}

/** Stage strip, in contract stage ids. "jira" now means testability (G2): the stories live in Jira from the start. */
export function computeStages(f: FeatureInfo, gates: Partial<Record<GateId, GateState>>, prs: PrInfo[], sections: string[] = []): Feature["stages"] {
  const s = {} as Record<keyof Feature["stages"], StageState>;
  const n = f.stories.length;
  const hasPage = !!f.design;
  s.intake = hasPage ? "done" : "active";
  s.clarify = !hasPage ? "todo" : f.openQuestions > 0 ? "active" : "done";
  const planned = gates.G1 === "done" || sections.some((h) => /\b(technical )?plan\b|data model/i.test(h));
  s.plan = planned ? "done" : s.clarify === "done" ? "active" : "todo";
  s.signoff = gates.G1 === "done" ? "done" : gates.G1 === "blocked" ? "blocked" : hasPage ? "active" : "todo";
  s.stories = n > 0 ? (f.stories.some((x) => x.num === "00") ? "done" : "active") : s.signoff === "done" ? "active" : "todo";
  s.tests = n > 0 && f.stories.every((x) => x.testCases.length > 0) ? "done" : n > 0 ? "active" : "todo";
  s.jira = gates.G2 === "done" ? "done" : n > 0 ? "active" : "todo";
  const story = f.stories.map((x) => storyPr(prs, x.jiraKey));
  const open = story.filter((p): p is PrInfo => !!p && p.state === "open");
  s.build = n > 0 && story.every((p) => p?.state === "merged") ? "done"
    : open.some((p) => p.labels.includes("needs-human")) ? "blocked"
    : story.some((p) => !!p) ? "active" : "todo";
  s.qa = gates.G6 === "done" ? "done" : gates.G6 === "blocked" ? "blocked" : open.some((p) => !p.draft) ? "active" : "todo";
  s.release = gates.G9 === "done" ? "done" : gates.G9 === "blocked" ? "blocked" : gates.G8 === "done" || story.some((p) => p?.state === "merged") ? "active" : "todo";
  return s;
}

const ghBase = (r: RepoRef) => `https://github.com/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
export const ghBlobUrl = (r: RepoRef, ref: string, file: string) =>
  `${ghBase(r)}/blob/${ref.split("/").map(encodeURIComponent).join("/")}/${file.split("/").map(encodeURIComponent).join("/")}`;

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

/** "Feature: Case escalation" / "[Epic] Case escalation" -> "Case escalation" */
const epicTitle = (summary: string) => summary.replace(/^\s*(?:\[(?:epic|feature)\]|(?:epic|feature)\s*[:\-–—])\s*/i, "").trim() || summary;

/** Build v3 features (stages, gates, stories with C5, links). Returns new objects; PRs get their featureId. */
export function buildFeatures(sources: FeatureSource[], prs: PrInfo[], deploy: DeployInfo | undefined, cfg: CircuitConfig, opt: BuildOptions = {}): FeatureInfo[] {
  const features = sources.map((src) => buildFeature(src, cfg, opt));
  linkPrs(features, prs);
  for (const f of features) {
    for (const s of f.stories) { const pr = storyPr(prs, s.jiraKey); if (pr) s.prNumber = pr.number; }
    f.gates = computeGates(f, prs, deploy);
    f.stages = computeStages(f, f.gates, prs, sources[features.indexOf(f)]?.page?.sections ?? []);
    f.signedOff = f.gates.G1 === "done";
  }
  return features;
}

/** Feature id of a design page that has no epic yet. */
export const pageFeatureId = (pageId: string) => `page-${pageId}`;

function buildFeature(src: FeatureSource, cfg: CircuitConfig, opt: BuildOptions): FeatureInfo {
  const { epic, page } = src;
  const approval = src.pageId
    ? page ? designApproval(page, cfg.architects) : { state: "unknown" as const, changedSinceApproval: false, detail: "Design page not read yet (sign in to the Atlassian MCP in Claude Code: /mcp)" }
    : designApproval(undefined, cfg.architects);
  const nums = storyNumbers(src.stories);
  const stories: StoryInfo[] = src.stories.map((st) => {
    const s: StoryInfo = {
      num: nums.get(st.key)!, title: storyTitleOf(st.summary), jiraKey: st.key,
      testCases: testCasesFor(st.key, src.tests), labels: [...st.labels], status: st.status,
      designSync: "unknown", blockedBy: blockedByOf(st),
    };
    if (st.statusCategory) s.statusCategory = st.statusCategory;
    const ac = acceptanceCriteriaOf(st, cfg.fields); if (ac) s.acceptanceCriteria = ac;
    const v = approvedDesignVersionOf(st, cfg.fields); if (v) s.approvedDesignVersion = v;
    const t = testabilityOf(st, cfg.fields); if (t !== undefined) s.testabilityConfirmed = t;
    s.designSync = designSync(v, src.pageId ? approval : undefined);
    const u = opt.jiraBrowseUrl?.(st.key); if (u) s.url = u;
    return s;
  });
  const links: DeepLink[] = [];
  const epicUrl = epic ? opt.jiraBrowseUrl?.(epic.key) : undefined;
  if (epic && epicUrl) links.push({ kind: "jira", label: `Epic ${epic.key}`, target: epicUrl });
  const pageLink = epic ? designPageOf(epic, cfg.fields) : undefined;
  const pageUrl = page?.url ?? src.pageListing?.url ?? (pageLink?.id === src.pageId ? pageLink?.url : undefined);
  const pageTitle = page?.title ?? src.pageListing?.title;
  if (pageUrl) links.push({ kind: "confluence", label: pageTitle ? `Design: ${pageTitle}` : "Design page", target: pageUrl });
  if (page?.orgSnapshot?.url) links.push({ kind: "confluence", label: "Org snapshot", target: page.orgSnapshot.url });
  const id = epic ? epic.key : pageFeatureId(src.pageId ?? "0");
  const title = epic ? epicTitle(epic.summary) : (pageTitle ?? `Design page ${src.pageId}`).replace(/^\s*design\s*[:\-–—]\s*/i, "");
  const f: FeatureInfo = {
    id,
    slug: `${epic ? epic.key : src.pageId}-${slugify(title)}`.replace(/-$/, ""),
    title,
    stages: {} as Feature["stages"],
    gates: {},
    openQuestions: page?.openQuestions ?? 0,
    signedOff: false,
    stories,
    sources: page?.sources ?? [],
    links,
  };
  if (epic) f.epicKey = epic.key;
  if (src.pageId) {
    f.design = { pageId: src.pageId, approval };
    if (pageUrl) f.design.url = pageUrl;
    if (pageTitle) f.design.title = pageTitle;
    const status = page?.status ?? src.pageListing?.status; if (status) f.design.status = status;
    const version = page?.version ?? src.pageListing?.version; if (version) f.design.version = version;
    if (page?.orgSnapshot?.url) f.design.orgSnapshotUrl = page.orgSnapshot.url;
    if (page?.readAt) f.design.readAt = page.readAt;
    if (page?.error) f.design.error = page.error;
  }
  return f;
}

/** Which gate is next and who owns it. */
export function nextGate(f: Feature): GateId | undefined {
  const order: GateId[] = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9"];
  return order.find((g) => f.gates[g] !== undefined && f.gates[g] !== "done");
}
