// Stages and gates G1..G9 of each feature from repo facts, PRs, Jira labels and production deploys.
// Pure functions (no vscode import), unit-tested.
import type { DeepLink, Feature, GateId, GateState, StageState } from "../core/contracts";
import type { DeployInfo, FeatureFacts, JiraLabels, ParsedFeature, PrInfo, RepoRef } from "./model";

export interface EnrichOptions {
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

/** Resolve each story PR's feature and story number through the jira-map refs. Mutates and returns prs. */
export function linkPrs(parsed: ParsedFeature[], prs: PrInfo[]): PrInfo[] {
  const byKey = new Map<string, { featureId: string; num: string }>();
  for (const p of parsed) {
    for (const [ref, key] of Object.entries(p.facts.jiraRefs)) if (/^\d{2}$/.test(ref)) byKey.set(key, { featureId: p.feature.id, num: ref });
    for (const s of p.feature.stories) if (s.jiraKey && !byKey.has(s.jiraKey)) byKey.set(s.jiraKey, { featureId: p.feature.id, num: s.num });
  }
  for (const pr of prs) {
    const hit = pr.storyKey ? byKey.get(pr.storyKey) : undefined;
    if (hit) { pr.featureId = hit.featureId; pr.storyNum = hit.num; }
  }
  return prs;
}

/** The PR that represents a story: the open one if any, else the latest merged one. Closed-unmerged PRs are ignored. */
export function storyPr(prs: PrInfo[], key: string | undefined): PrInfo | undefined {
  if (!key) return undefined;
  const mine = prs.filter((p) => p.storyKey === key && p.state !== "closed");
  return mine.find((p) => p.state === "open") ?? mine.filter((p) => p.state === "merged").sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""))[0];
}

export function computeGates(feature: Feature, facts: FeatureFacts, prs: PrInfo[], jira: JiraLabels, deploy?: DeployInfo): Partial<Record<GateId, GateState>> {
  const g: Partial<Record<GateId, GateState>> = {};
  g.G1 = feature.signedOff ? "done" : facts.hasPlan ? "waiting" : "not-started";

  const keys = feature.stories.map((s) => s.jiraKey).filter((k): k is string => !!k);
  if (jira) {
    if (keys.length === 0) g.G2 = "not-started";
    else g.G2 = aggregate(feature.stories.map((s) => (!s.jiraKey ? "none" : (jira[s.jiraKey] ?? []).includes("ai-ready") ? "ok" : "waiting")));
  }

  const story = feature.stories.map((s) => storyPr(prs, s.jiraKey));
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

export function computeStages(feature: Feature, facts: FeatureFacts, gates: Partial<Record<GateId, GateState>>, prs: PrInfo[]): Feature["stages"] {
  const s = {} as Feature["stages"];
  const n = feature.stories.length;
  s.intake = facts.hasSpec ? "done" : "active";
  s.clarify = !facts.hasSpec ? "todo" : feature.openQuestions > 0 ? "active" : "done";
  s.plan = facts.hasPlan ? "done" : s.clarify === "done" ? "active" : "todo";
  s.signoff = feature.signedOff ? "done" : facts.hasPlan ? "active" : "todo";
  s.stories = n > 0 ? (feature.stories.some((x) => x.num === "00") ? "done" : "active") : s.signoff === "done" ? "active" : "todo";
  s.tests = n > 0 && feature.stories.every((x) => facts.tcStories.includes(x.num)) ? "done" : n > 0 ? "active" : "todo";
  const refs = facts.jiraRefs;
  const tcIds = feature.stories.flatMap((x) => x.testCases.map((t) => t.id));
  const jiraDone = n > 0 && !!refs.epic && feature.stories.every((x) => !!refs[x.num]) && tcIds.every((id) => !!refs[id]);
  s.jira = jiraDone ? "done" : Object.keys(refs).length > 0 || s.tests === "done" ? "active" : "todo";
  const story = feature.stories.map((x) => storyPr(prs, x.jiraKey));
  const open = story.filter((p): p is PrInfo => !!p && p.state === "open");
  s.build = n > 0 && story.every((p) => p?.state === "merged") ? "done"
    : open.some((p) => p.labels.includes("needs-human")) ? "blocked"
    : story.some((p) => !!p) ? "active" : "todo";
  s.qa = gates.G6 === "done" ? "done" : gates.G6 === "blocked" ? "blocked" : open.some((p) => !p.draft) ? "active" : "todo";
  s.release = gates.G9 === "done" ? "done" : gates.G9 === "blocked" ? "blocked" : gates.G8 === "done" || story.some((p) => p?.state === "merged") ? "active" : "todo";
  return s as Record<keyof Feature["stages"], StageState>;
}

const ghBase = (r: RepoRef) => `https://github.com/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
export const ghBlobUrl = (r: RepoRef, ref: string, file: string) =>
  `${ghBase(r)}/blob/${ref.split("/").map(encodeURIComponent).join("/")}/${file.split("/").map(encodeURIComponent).join("/")}`;

/** Fill stages, gates, story PR numbers and outside links. Returns new Feature objects. */
export function enrichFeatures(parsed: ParsedFeature[], prs: PrInfo[], jira: JiraLabels, deploy: DeployInfo | undefined, opt: EnrichOptions = {}): Feature[] {
  linkPrs(parsed, prs);
  return parsed.map(({ feature, facts }) => {
    const f: Feature = { ...feature, stories: feature.stories.map((s) => ({ ...s, testCases: [...s.testCases] })), links: [...feature.links] };
    for (const s of f.stories) {
      const pr = storyPr(prs, s.jiraKey);
      if (pr) s.prNumber = pr.number;
    }
    f.gates = computeGates(f, facts, prs, jira, deploy);
    f.stages = computeStages(f, facts, f.gates, prs);
    const extra: DeepLink[] = [];
    if (opt.repo) extra.push({ kind: "github", label: "Spec folder on GitHub", target: `${ghBase(opt.repo)}/tree/main/${f.dir}` });
    const specPr = prs.find((p) => p.state === "open" && !p.storyKey && p.featureId === f.id);
    if (specPr) extra.push({ kind: "github", label: `Spec PR #${specPr.number}`, target: specPr.url });
    const epic = facts.jiraRefs.epic;
    const epicUrl = epic ? opt.jiraBrowseUrl?.(epic) : undefined;
    if (epic && epicUrl) extra.push({ kind: "jira", label: `Epic ${epic}`, target: epicUrl });
    f.links = [...f.links, ...extra];
    return f;
  });
}

/** Which gate is next and who owns it. */
export function nextGate(f: Feature): GateId | undefined {
  const order: GateId[] = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9"];
  return order.find((g) => f.gates[g] !== undefined && f.gates[g] !== "done");
}
