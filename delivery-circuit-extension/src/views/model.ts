// View models for the sidebar, persona panel and feature panel. No "vscode" import: everything here is pure and
// unit-tested (test/unit/views*.test.ts). index.ts loads data through the contracts and hands it to these builders;
// the webview pages only render what they receive.
//
// v3 (docs/CIRCUIT-V3.md): a feature is a Jira epic with a Confluence design page. The page status and version are G1;
// each story carries the approved design version it was planned on (C5). Stories start from the Developer's queue
// ("Start story") and get their tests from the Tester ("Add tests"). Specs are not in the repo: no spec-file links.
import {
  GATES, PERSONAS, canAct, canView,
  type ActionRef, type CheckState, type ConnectionStatus, type DeepLink, type Feature, type GateId, type GateState,
  type Identity, type Persona, type PrRef, type QueueItem, type ReviewSignal, type SourceRef, type StageId, type Story,
} from "../core/contracts";

// ---------- v3 fields, read structurally until the contract names them (contract request) ----------
// The project module serves FeatureInfo / StoryInfo (src/project/model.ts) as contract Features. This module must not
// import it, so the shapes below mirror the fields the views read; designOf() / storyOf() normalise them.

/** G1 evaluation as the project module sends it (FeatureInfo.design.approval). */
export interface DesignApprovalRaw {
  state?: "approved" | "changed" | "draft" | "unverified-approver" | "missing" | "unknown";
  approvedVersion?: number;
  approvedBy?: string;
  /** true = a configured architect; false = not one; undefined = cannot tell */
  approverIsArchitect?: boolean;
  changedSinceApproval?: boolean;
  detail?: string;
}

/** Confluence design page of a feature (epic), normalised for the views. */
export interface DesignInfo {
  pageId?: string;
  url?: string;
  title?: string;
  /** Confluence content status name: "Approved", "In progress", "Rough draft", ... */
  status?: string;
  /** current page version */
  version?: number;
  /** page version an architect approved (G1) */
  approvedVersion?: number;
  approvedBy?: string;
  approvedAt?: string;
  /** false when whoever set Approved is not in the architects group (then it does not count) */
  approvedByArchitect?: boolean;
  /** true when the page changed after the approved version (else derived: version > approvedVersion) */
  changedSinceApproval?: boolean;
  /** project module's evaluation; its state wins over the derived one when present */
  approval?: DesignApprovalRaw;
  orgSnapshotUrl?: string;
  /** set when the page could not be read */
  error?: string;
}
/** A contract Feature as the views accept it: design may be partial (fixtures, a page read halfway). */
export type FeatureV3 = Omit<Feature, "design"> & { design?: DesignInfo; decisions?: number };
export type StoryV3 = Story & {
  /** Jira status name and category ("new" | "indeterminate" | "done") */
  status?: string;
  statusCategory?: string;
  labels?: string[];
  /** Approved design version recorded on the story (project module: approvedDesignVersion) */
  designVersion?: number;
  approvedDesignVersion?: number;
  /** C5 as computed by the project module */
  designSync?: "ok" | "changed" | "missing" | "ahead" | "unknown";
  /** G2: label ai-ready + Testability confirmed (derived from labels / testabilityConfirmed when absent) */
  aiReady?: boolean;
  testabilityConfirmed?: boolean;
  /** tests/<KEY>.tc.json is on the story PR (derived from the PR's files when absent) */
  testsOnPr?: boolean;
  /** Jira keys that block this story ("is blocked by") */
  blockedBy?: string[];
  url?: string;
};
const v3 = (f: FeatureV3) => f;
const isNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** The feature's design page with the project module's approval folded in. */
export function designOf(f: FeatureV3): DesignInfo {
  const d: DesignInfo = { ...(v3(f).design ?? {}) };
  const a = d.approval;
  if (a) {
    if (isNumber(a.approvedVersion) && (a.state === "approved" || a.state === "changed" || a.state === "unverified-approver")) d.approvedVersion = a.approvedVersion;
    if (a.approvedBy) d.approvedBy = a.approvedBy;
    if (a.approverIsArchitect !== undefined) d.approvedByArchitect = a.approverIsArchitect;
    if (a.state === "changed") d.changedSinceApproval = true;
    else if (a.changedSinceApproval !== undefined) d.changedSinceApproval = a.changedSinceApproval;
  }
  return d;
}

/** A story with the G2 / C5 / tests-on-PR facts the views need, whichever module filled them. */
export function storyOf(s: Story, pr?: PrRef & { files?: string[] }): StoryV3 {
  const r = s as StoryV3;
  const designVersion = isNumber(r.designVersion) ? r.designVersion : isNumber(r.approvedDesignVersion) ? r.approvedDesignVersion : undefined;
  const aiReady = r.aiReady ?? ((r.labels ?? []).includes("ai-ready") && r.testabilityConfirmed !== false);
  const testsOnPr = r.testsOnPr ?? (!!r.jiraKey && Array.isArray(pr?.files) && pr!.files!.includes(`tests/${r.jiraKey}.tc.json`));
  const prNumber = r.prNumber ?? (pr && pr.state !== "closed" ? pr.number : undefined);
  return { ...r, designVersion, aiReady, testsOnPr, ...(prNumber !== undefined ? { prNumber } : {}) };
}
const sv3 = (s: Story) => storyOf(s);
/** The id people use for a feature: the epic key in v3, the slug otherwise. */
export const featureKey = (f: FeatureV3): string => v3(f).epicKey || f.slug || f.id;

// ---------- labels ----------
export const PERSONA_LABEL: Record<Persona, string> = { architect: "Architect", developer: "Developer", tester: "Tester" };

/** v3 labels for the contract's stage ids: plan = the design page, signoff = design approved (G1), jira = ai-ready (G2). */
export const STAGES: { id: StageId; label: string }[] = [
  { id: "intake", label: "Intake" }, { id: "clarify", label: "Clarify" }, { id: "plan", label: "Design" },
  { id: "signoff", label: "Approved" }, { id: "stories", label: "Stories" }, { id: "tests", label: "Tests" },
  { id: "jira", label: "Ready" }, { id: "build", label: "Build" }, { id: "qa", label: "Review" }, { id: "release", label: "Release" },
];

export const GATE_IDS = Object.keys(GATES) as GateId[];

export const SIGNAL_SOURCES: { source: ReviewSignal["source"]; label: string }[] = [
  { source: "human", label: "Human" },
  { source: "coderabbit", label: "CodeRabbit" },
  { source: "ai-reviewer", label: "AI Reviewer" },
  { source: "code-analyzer", label: "Code Analyzer" },
  { source: "sf-ai-tester", label: "SF AI Tester" },
];

/** Check names shown first, in this order; gate/* follow, then anything else. */
export const CHECK_ORDER = ["guard", "static", "design-gate", "qa"];

const gateNum = (g?: GateId) => (g ? Number(g.slice(1)) : 99);

/** dot/badge class of the UI kit for a state */
export function stateClass(state: string | undefined): "ok" | "warn" | "err" | "info" | "" {
  switch (state) {
    case "connected": case "success": case "passed": case "done": case "pass": case "approved": return "ok";
    case "expiring": case "blocked": return "warn";
    case "pending": case "checking": case "waiting": case "active": return "info";
    case "error": case "failure": case "failed": case "changes-requested": case "block": return "err";
    default: return "";
  }
}

// ---------- persona visibility ----------
export function visiblePersonas(id: Identity | null): Persona[] {
  return id ? PERSONAS.filter((p) => canView(id, p)) : [];
}

export interface TabView { id: Persona; label: string; title?: string }

/** Tabs for the persona panel: only personas the identity can view. Picks requested, else active, else first. */
export function personaTabs(id: Identity | null, requested?: Persona | null): { tabs: TabView[]; selected: Persona | null } {
  const vis = visiblePersonas(id);
  const tabs = vis.map((p) => ({ id: p, label: PERSONA_LABEL[p], title: id && canAct(id, p) ? undefined : "View only" }));
  const selected = requested && vis.includes(requested) ? requested
    : id?.active && vis.includes(id.active) ? id.active : vis[0] ?? null;
  return { tabs, selected };
}

/** Header notice when viewing a persona the identity can't act as. */
export function viewOnlyNotice(id: Identity | null, view: Persona): string | undefined {
  if (!id || canAct(id, view)) return undefined;
  return id.active ? `View only — you act as ${PERSONA_LABEL[id.active]}` : "View only — choose a persona to act as";
}

// ---------- actions ----------
export type ArgKind = "feature" | "pr" | "source" | "story" | "none";
export type ActionView = ActionRef & { allowed: boolean; reason?: string };

/** Why an action is disabled, in words the person can act on. */
export function disabledReason(id: Identity | null, a: ActionRef, allowed: boolean): string | undefined {
  if (allowed) return undefined;
  if (!id) return "Sign in to GitHub first";
  if (!id.personas.includes(a.persona)) return `Only a ${PERSONA_LABEL[a.persona]} can run this`;
  if (id.active !== a.persona) return `Switch to ${PERSONA_LABEL[a.persona]} to run this`;
  return a.kind === "gate" ? "This gate is not ready yet" : "Not available right now";
}

/** A well-formed stand-in for an argument the panel asks for on click, so the persona rules can be checked first. */
const SAMPLE_ARG: Record<string, string | number> = { story: "ABC-1", pr: 1, feature: "ABC-1", source: "source" };

export function toActionView(id: Identity | null, a: ActionRef, allowed: (a: ActionRef) => boolean): ActionView {
  let ok = false;
  // An action still missing its argument (picked on click, then validated again by actions.run) is allowed when the
  // persona rules allow it with a valid argument; otherwise a named action would read as "Not available right now".
  const probe = needsArg(a) ? withArg(a, SAMPLE_ARG[String(a.args?.argKind)]) : a;
  try { ok = !!id && allowed(probe); } catch { ok = false; }
  return { ...a, allowed: ok, reason: disabledReason(id, a, ok) };
}

/** id: a v3 named action (src/actions/grammar.ts NAMED_ACTIONS); without it the id is "ai:<command>". */
interface AiSpec { command: string; label: string; argKind: ArgKind; intent?: string; id?: string }
const RECORD_DECISION: AiSpec = { id: "decision:record", command: "/record-decision", label: "Record decision", argKind: "feature" };
export const AI_ACTIONS: Record<Persona, AiSpec[]> = {
  architect: [
    { command: "/circuit-intake", label: "Intake from a source", argKind: "source" },
    { command: "/arch-design", label: "Design", argKind: "feature" },
    { command: "/arch-jira-push", label: "Push to Jira", argKind: "feature" },
    { command: "/arch-review-pr", label: "Review PR", argKind: "pr" },
    RECORD_DECISION,
  ],
  developer: [
    { command: "/dev-review-stories", label: "Review stories", argKind: "feature" },
    { id: "dev:start-story", command: "/dev-start-story", label: "Start story", argKind: "story" },
    { command: "/dev-review-plan", label: "Review plan", argKind: "pr" },
    { command: "/dev-review-pr", label: "Review PR", argKind: "pr" },
    { id: "dev:fix", command: "/dev-fix", label: "Fix with AI", argKind: "pr" },
    { id: "review:open-room", command: "/review-room", label: "Open review room", argKind: "pr" },
    { id: "review:record-verdict", command: "/review-room", label: "Record verdict", argKind: "pr" },
    // A person takes over a PR after the AI attempts ran out (label needs-human): a Developer session on that PR.
    { command: "/dev-review-pr", label: "Take over", argKind: "pr", intent: "takeover" },
    RECORD_DECISION,
  ],
  tester: [
    { command: "/qa-design-tests", label: "Design tests", argKind: "feature" },
    { command: "/qa-push-tests", label: "Push tests", argKind: "feature" },
    { id: "qa:add-tests", command: "/qa-add-tests", label: "Add tests", argKind: "story" },
    { command: "/qa-review-testplan", label: "Review test plan", argKind: "pr" },
    { command: "/qa-explore", label: "Explore on QA", argKind: "pr" },
    RECORD_DECISION,
  ],
};

/** Persona AI actions as ActionRefs: "ai:/arch-design" or a named id such as "dev:start-story"; args {command, argKind, arg?}. */
export function aiActions(persona: Persona, preset: { feature?: string; pr?: number; story?: string } = {}): ActionRef[] {
  return AI_ACTIONS[persona].map((x) => {
    const args: Record<string, string | number> = { command: x.command, argKind: x.argKind };
    if (x.intent) args.intent = x.intent;
    const arg = x.argKind === "feature" ? preset.feature : x.argKind === "pr" ? preset.pr : x.argKind === "story" ? preset.story : undefined;
    if (arg !== undefined) args.arg = arg;
    return { id: x.id ?? `ai:${x.command}`, label: x.label, persona, kind: "ai" as const, args };
  });
}

export function needsArg(a: ActionRef): boolean {
  const k = a.args?.argKind;
  return (k === "feature" || k === "pr" || k === "source" || k === "story") && (a.args?.arg === undefined || a.args?.arg === "");
}

export function withArg(a: ActionRef, value: string | number): ActionRef {
  return { ...a, args: { ...(a.args ?? {}), arg: value } };
}

export interface PickItem { label: string; description?: string; detail?: string; value: string | number }

/** QuickPick items for an action's argument, best candidates first. */
export function argPickItems(a: ActionRef, data: { features: FeatureV3[]; prs: PrRef[]; sources: SourceRef[] }): PickItem[] {
  const kind = a.args?.argKind;
  const cmd = String(a.args?.command ?? "");
  if (kind === "feature") {
    return [...data.features].sort((x, y) => x.id.localeCompare(y.id)).map((f) => ({
      label: featureKey(f), description: f.title,
      detail: [`${f.stories.length} stories`, `${f.openQuestions} open questions`, designView(f).text].join(" · "), value: featureKey(f),
    }));
  }
  if (kind === "story") {
    const rows = data.features.flatMap((f) => {
      const d = designView(f);
      return f.stories.filter((s) => !!s.jiraKey).map((s) => ({ f, s: sv3(s), blocked: storyBlocked(sv3(s), d) !== undefined }));
    });
    const score = ({ s, blocked }: { s: StoryV3; blocked: boolean }): number => {
      if (cmd === "/dev-start-story") return s.aiReady && !s.prNumber && !blocked ? 0 : !s.prNumber ? 1 : 2;
      if (cmd === "/qa-add-tests") return s.prNumber && !s.testsOnPr ? 0 : s.prNumber ? 1 : 2;
      return 1;
    };
    return rows.sort((x, y) => score(x) - score(y) || String(x.s.jiraKey).localeCompare(String(y.s.jiraKey), undefined, { numeric: true }))
      .map(({ f, s }) => ({
        label: `${s.jiraKey} ${s.title}`, description: featureKey(f),
        detail: [s.status, s.aiReady ? "ai-ready" : "not ai-ready yet", s.prNumber ? `PR #${s.prNumber}` : "no PR yet"].filter(Boolean).join(" · "),
        value: s.jiraKey!,
      }));
  }
  if (kind === "pr") {
    const score = (p: PrRef): number => {
      const build = p.branch.startsWith("feature/");
      if (a.args?.intent === "takeover") return p.labels.includes("needs-human") ? 0 : 2;
      if (cmd === "/dev-fix") return build && failing(p).length && !p.labels.includes("needs-human") ? 0 : build ? 1 : 2;
      if (a.id === "review:record-verdict") return build && p.labels.includes(REVIEW_ROOM) && !p.labels.includes(REVIEW_VERDICT) ? 0 : build ? 1 : 2;
      if (cmd === "/review-room") return build && !p.draft && !p.labels.includes("needs-human") && !p.labels.includes(REVIEW_ROOM) && !failing(p).length ? 0 : build ? 1 : 2;
      if (cmd === "/dev-review-plan") return build && p.draft && !p.labels.includes("plan-approved") ? 0 : build ? 1 : 2;
      if (cmd === "/qa-review-testplan") return build && p.draft && !p.labels.includes("testplan-approved") ? 0 : build ? 1 : 2;
      if (cmd === "/qa-explore") return p.labels.includes("needs-qa") ? 0 : build && !p.draft ? 1 : 2;
      if (cmd === "/dev-review-pr" || cmd === "/arch-review-pr") return build && !p.draft ? 0 : 1;
      return 1;
    };
    return [...data.prs]
      .sort((x, y) => (isDone(x) ? 3 : score(x)) - (isDone(y) ? 3 : score(y)) || y.updatedAt.localeCompare(x.updatedAt))
      .map((p) => ({
        label: `#${p.number} ${p.title}`,
        description: [p.storyKey, p.draft ? "draft" : ""].filter(Boolean).join(" · "),
        detail: [p.branch, ...p.labels].join(" · "), value: p.number,
      }));
  }
  if (kind === "source") {
    const seen = new Set<string>();
    return [...data.sources]
      .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
      .sort((x, y) => y.date.localeCompare(x.date))
      .map((s) => ({
        label: s.title, description: `${s.kind === "fireflies" ? "Fireflies" : "Upload"} · ${s.date.slice(0, 10)}`,
        detail: s.usedBy?.length ? `Cited by ${s.usedBy.join(", ")}` : "Not used by a spec yet", value: s.id,
      }));
  }
  return [];
}

// ---------- time ----------
export function ageLabel(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

// ---------- queue ----------
/** Oldest waiting first; undated last; then gate order; then title. */
export function sortQueue(items: QueueItem[]): QueueItem[] {
  const t = (i: QueueItem) => (i.since && !Number.isNaN(Date.parse(i.since)) ? Date.parse(i.since) : Number.POSITIVE_INFINITY);
  return [...items].sort((a, b) => t(a) - t(b) || gateNum(a.gate) - gateNum(b.gate) || a.title.localeCompare(b.title));
}

export interface QueueItemView {
  id: string; kind: QueueItem["kind"]; title: string; detail?: string;
  gate?: GateId; gateLabel?: string; age: string; since?: string;
  featureId?: string; prNumber?: number; storyKey?: string;
  links: DeepLink[]; actions: ActionView[];
}

export function queueView(items: QueueItem[], id: Identity | null, allowed: (a: ActionRef) => boolean, now: number, limit?: number): QueueItemView[] {
  const sorted = sortQueue(items);
  return (limit ? sorted.slice(0, limit) : sorted).map((q) => ({
    id: q.id, kind: q.kind, title: q.title, detail: q.detail,
    gate: q.gate, gateLabel: q.gate ? `${q.gate} ${GATES[q.gate].label}` : undefined,
    age: ageLabel(q.since, now), since: q.since, featureId: q.featureId, prNumber: q.prNumber, storyKey: q.storyKey,
    links: q.links ?? [], actions: (q.actions ?? []).map((a) => toActionView(id, a, allowed)),
  }));
}

// ---------- strips ----------
export interface StepView { id: string; label: string; state: string; title?: string; own?: boolean }

export function stageStrip(f: FeatureV3): StepView[] {
  return STAGES.map((s) => {
    const state = f.stages?.[s.id] ?? "todo";
    return { id: s.id, label: s.label, state, title: `${s.label}: ${state}` };
  });
}

/** G1..G9 with the persona's own gates flagged (highlighted in the UI). */
export function gateStrip(f: FeatureV3, persona: Persona | null): StepView[] {
  return GATE_IDS.map((g) => {
    const state: GateState = f.gates?.[g] ?? "not-started";
    const owner = GATES[g].owner;
    return { id: g, label: g, state, own: owner === persona, title: `${g} ${GATES[g].label} · ${PERSONA_LABEL[owner]} · ${state}` };
  });
}

export function nextGate(f: FeatureV3): { id: GateId; label: string; owner: Persona; ownerLabel: string; state: GateState } | undefined {
  for (const g of GATE_IDS) {
    const st = f.gates?.[g] ?? "not-started";
    if (st !== "done") return { id: g, label: GATES[g].label, owner: GATES[g].owner, ownerLabel: PERSONA_LABEL[GATES[g].owner], state: st };
  }
  return undefined;
}

// ---------- pull requests ----------
export interface BadgeView { name: string; state: CheckState; cls: string }

export function checkBadges(pr: PrRef): BadgeView[] {
  const names = Object.keys(pr.checks ?? {});
  const rank = (n: string) => { const i = CHECK_ORDER.indexOf(n); return i >= 0 ? i : n.startsWith("gate/") ? 10 : 20; };
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((n) => ({ name: n, state: pr.checks[n], cls: stateClass(pr.checks[n]) }));
}

export interface SignalView { author: string; state: ReviewSignal["state"]; cls: string; summary: string; at: string; links: DeepLink[] }
export interface SignalGroup { source: ReviewSignal["source"]; label: string; signals: SignalView[] }

const SIGNAL_LINK: Record<ReviewSignal["source"], { kind: DeepLink["kind"]; label: string }> = {
  human: { kind: "github", label: "Review" },
  coderabbit: { kind: "coderabbit", label: "CodeRabbit" },
  "ai-reviewer": { kind: "github", label: "Comment" },
  "code-analyzer": { kind: "github", label: "Results" },
  "sf-ai-tester": { kind: "github", label: "Verdict" },
};

/** Review signals grouped by source in a fixed order; latest signal per author; plus sources with nothing yet. */
export function groupSignals(reviews: ReviewSignal[]): { groups: SignalGroup[]; missing: string[] } {
  const groups: SignalGroup[] = [];
  const missing: string[] = [];
  for (const { source, label } of SIGNAL_SOURCES) {
    const latest = new Map<string, ReviewSignal>();
    for (const r of reviews ?? []) {
      if (r.source !== source) continue;
      const prev = latest.get(r.author);
      if (!prev || r.at > prev.at) latest.set(r.author, r);
    }
    const signals = [...latest.values()].sort((a, b) => b.at.localeCompare(a.at)).map((r) => ({
      author: r.author, state: r.state, cls: stateClass(r.state), summary: r.summary, at: r.at,
      links: r.url && /^https:\/\//.test(r.url) ? [{ kind: SIGNAL_LINK[source].kind, label: SIGNAL_LINK[source].label, target: r.url }] : [],
    }));
    if (signals.length) groups.push({ source, label, signals });
    else if (source !== "human") missing.push(label);
  }
  return { groups, missing };
}

/** v3 has one PR kind with gates: the story PR on feature/<KEY>-<slug>. Design and intake live in Confluence, so
 *  there are no spec/ or intake/ PRs and no spec-gate (G1 is read from the design page). */
export type PrKind = "build" | "other";
export function prKind(pr: PrRef): PrKind {
  return pr.branch.startsWith("feature/") ? "build" : "other";
}

function checkGate(c: CheckState | undefined, draft: boolean): GateState {
  if (c === "success") return "done";
  if (c === "failure") return "blocked";
  if (c === "pending") return "waiting";
  return draft ? "not-started" : "waiting";
}

// The PR gate strip and "needs you" follow the same rules as the queue (src/project/queue.ts buildQueue), so a PR card
// never says a gate waits on you when the queue does not list it, or the other way round:
//   G3 / G4  only for draft ai-generated PRs, until plan-approved / testplan-approved;
//   G5 / G6  on non-draft PRs from the gate/developer / gate/tester checks (labels play no part), not on your own PR,
//            and G6 not while needs-human is set;
//   G7       on non-draft PRs from gate/architect, not while needs-human is set;
//   G8       non-draft, all gate/* checks and every other check green.
const has = (pr: PrRef, l: string) => pr.labels.includes(l);
/** Merged or closed: nothing waits on anyone there any more. */
const isDone = (pr: PrRef) => pr.state === "merged" || pr.state === "closed";
/** A story PR that carries a plan (G3) and a test plan (G4). In v3 the Developer's "Start story" opens it as a draft with
 *  PLAN.md and TESTPLAN.md, so every draft story PR counts, and so does one already labelled for its plans. */
const isAiPr = (pr: PrRef) => prKind(pr) === "build" && (pr.draft || ["ai-generated", "plan-review", "plan-approved", "testplan-approved"].some((l) => has(pr, l)));
/** Checks that failed on a PR (names, sorted); gate/* statuses are people's gates, not checks to fix. */
export const failing = (pr: PrRef): string[] => Object.entries(pr.checks ?? {}).filter(([k, v]) => v === "failure" && !k.startsWith("gate/")).map(([k]) => k).sort();
const nonGateGreen = (pr: PrRef) => Object.entries(pr.checks).every(([k, v]) => k.startsWith("gate/") || (v !== "failure" && v !== "pending"));
const allGatesGreen = (pr: PrRef) => ["gate/developer", "gate/tester", "gate/architect"].every((c) => pr.checks[c] === "success");

/** Plan / test plan approval (G3 / G4): asked only on draft story PRs. */
function planGate(pr: PrRef, label: string): GateState {
  if (has(pr, label)) return "done";
  return pr.draft && isAiPr(pr) ? "waiting" : "not-started";
}

/** The gates this persona owns on this PR, with their state. */
export function prGates(pr: PrRef, persona: Persona): StepView[] {
  const kind = prKind(pr);
  const mk = (g: GateId, state: GateState): StepView =>
    ({ id: g, label: g, state, own: true, title: `${g} ${GATES[g].label} · ${state}` });
  if (kind !== "build") return [];
  if (persona === "developer") {
    return [...(isAiPr(pr) ? [mk("G3", planGate(pr, "plan-approved"))] : []), mk("G5", checkGate(pr.checks["gate/developer"], pr.draft))];
  }
  if (persona === "tester") {
    return [...(isAiPr(pr) ? [mk("G4", planGate(pr, "testplan-approved"))] : []), mk("G6", checkGate(pr.checks["gate/tester"], pr.draft))];
  }
  const ready = !pr.draft && allGatesGreen(pr) && nonGateGreen(pr);
  return [mk("G7", checkGate(pr.checks["gate/architect"], pr.draft)), mk("G8", pr.state === "merged" ? "done" : ready ? "waiting" : "not-started")];
}

/** Whether the PR is waiting on this persona now (same predicates as the persona's queue). `login`: the viewer,
 *  whose own PRs are not theirs to review. */
export function prNeedsPersona(pr: PrRef, persona: Persona, login?: string): boolean {
  if (isDone(pr)) return false;
  if (prKind(pr) !== "build") return false;
  const mine = !!login && pr.author === login;
  const open = (c: string) => pr.checks[c] !== "success";
  switch (persona) {
    case "developer":
      if (has(pr, "needs-human")) return true;
      if (pr.draft && isAiPr(pr) && !has(pr, "plan-approved")) return true;
      // failed checks on the Developer's own story PR: "Fix with AI" (step 14)
      if (mine && failing(pr).length) return true;
      return !pr.draft && open("gate/developer") && !mine;
    case "tester":
      if (has(pr, "needs-qa")) return true;
      if (pr.draft && isAiPr(pr) && !has(pr, "testplan-approved")) return true;
      return !pr.draft && open("gate/tester") && !has(pr, "needs-human") && !mine;
    case "architect":
      if (!pr.draft && open("gate/architect") && !has(pr, "needs-human")) return true;
      return !pr.draft && allGatesGreen(pr) && nonGateGreen(pr);
  }
}

/** PRs relevant to a persona: Architect and Developer all; Tester story (build) PRs only. */
export function prsForPersona(prs: PrRef[], persona: Persona, login?: string): PrRef[] {
  const keep = (p: PrRef) => {
    if (persona === "tester") return prKind(p) === "build";
    return true;
  };
  return prs.filter(keep).sort((a, b) =>
    Number(prNeedsPersona(b, persona, login)) - Number(prNeedsPersona(a, persona, login)) || b.updatedAt.localeCompare(a.updatedAt));
}

export interface PrView {
  number: number; title: string; url: string; branch: string; draft: boolean; author: string; labels: string[];
  storyKey?: string; featureId?: string; aiAttempt?: number; age: string; needsYou: boolean;
  checks: BadgeView[]; gates: StepView[]; groups: SignalGroup[]; missing: string[]; links: DeepLink[];
  /** The persona's AI actions that fit this PR now, most relevant first (filled by buildPersona). */
  actions: ActionView[];
}

/** AI fix attempts per PR before needs-human (the same cap as MAX_AI_ATTEMPTS in src/actions/grammar.ts). */
export const MAX_FIX_ATTEMPTS = 3;
/** PR labels of the review room (the same as the project queue): opened, verdict recorded. */
export const REVIEW_ROOM = "review-room";
export const REVIEW_VERDICT = "review-verdict";
/** The Tester's suite and tc index are on the PR (when the PR's file list is known; unknown counts as not yet). */
const testsOn = (pr: PrRef & { files?: string[] }): boolean =>
  !!pr.storyKey && Array.isArray(pr.files) && pr.files.includes(`tests/${pr.storyKey}.tc.json`) && pr.files.includes(`test-cases/${pr.storyKey}.sf-tests.yaml`);

/** AI actions a persona would run on this PR now, most relevant first, with the PR number preset.
 *  Developer: take over (needs-human) > fix with AI (failed checks, attempts left) > review the plan (draft story PR,
 *  plan not approved) > review the PR > open the review room > record its verdict.
 *  Tester: add tests (draft story PR) > review the test plan > explore on QA. Architect: review the PR (not draft). */
export function prActions(pr: PrRef, persona: Persona): ActionRef[] {
  if (isDone(pr)) return [];
  const kind = prKind(pr);
  const all = aiActions(persona, { pr: pr.number });
  const pick = (command: string, intent?: string) =>
    all.find((a) => a.id.startsWith("ai:") && a.args?.command === command && (intent ? a.args?.intent === intent : a.args?.intent === undefined));
  const named = (id: string, extra: Record<string, string | number> = {}) => {
    const a = all.find((x) => x.id === id);
    return a ? { ...a, args: { ...(a.args ?? {}), ...extra } } : undefined;
  };
  const out: (ActionRef | undefined)[] = [];
  const stuck = has(pr, "needs-human");
  if (persona === "developer") {
    if (kind === "build" && stuck) out.push(pick("/dev-review-pr", "takeover"));
    const failed = failing(pr);
    const attempt = pr.aiAttempt ?? 0;
    if (kind === "build" && failed.length && !stuck && attempt < MAX_FIX_ATTEMPTS) {
      // attempt: the AI attempt this run would be; the action reads the failed check runs for the failure context.
      out.push(named("dev:fix", { attempt: attempt + 1, checks: failed.join(",") }));
    }
    if (pr.draft && isAiPr(pr) && !has(pr, "plan-approved")) out.push(pick("/dev-review-plan"));
    // Step 12 (same rule as the queue): G3 + G4 and the tests on the branch -> build; built and green -> mark ready.
    const files = (pr as PrRef & { files?: string[] }).files;
    const built = Array.isArray(files) && files.some((f) => f.startsWith("force-app/"));
    const greenNow = Object.entries(pr.checks ?? {}).every(([k, v]) => k.startsWith("gate/") || v === "success" || v === "missing");
    if (kind === "build" && pr.draft && !stuck && pr.storyKey && has(pr, "plan-approved") && has(pr, "testplan-approved") && !failed.length) {
      const build = testsOn(pr) && !built ? named("dev:start-story", { arg: `${pr.storyKey} build`, storyKey: pr.storyKey, pr: pr.number, phase: "build" }) : undefined;
      if (build) out.push({ ...build, label: "Build with AI" });
      // The action pins to the PR's head at confirmation time (it reads it with the person's login).
      if (built && greenNow) out.push({ id: "gate:ready", label: "Mark ready for review", persona, kind: "gate", args: { pr: pr.number } });
    }
    if (!pr.draft) out.push(pick("/dev-review-pr"));
    // Review room (steps 15-16): open it once checks are green; record the verdict once it is open.
    const green = Object.entries(pr.checks ?? {}).every(([k, v]) => k.startsWith("gate/") || v === "success" || v === "missing");
    if (kind === "build" && !pr.draft && !stuck && green && !has(pr, REVIEW_ROOM)) out.push(named("review:open-room"));
    if (kind === "build" && !stuck && has(pr, REVIEW_ROOM) && !has(pr, REVIEW_VERDICT)) out.push(named("review:record-verdict"));
  } else if (persona === "tester") {
    const filesKnown = Array.isArray((pr as PrRef & { files?: string[] }).files);
    if (kind === "build" && pr.storyKey && !testsOn(pr) && (pr.draft || filesKnown)) out.push(named("qa:add-tests", { arg: pr.storyKey, storyKey: pr.storyKey }));
    if (pr.draft && isAiPr(pr) && !has(pr, "testplan-approved")) out.push(pick("/qa-review-testplan"));
    if (kind === "build" && (has(pr, "needs-qa") || !pr.draft)) out.push(pick("/qa-explore"));
  } else if (!pr.draft) {
    out.push(pick("/arch-review-pr"));
  }
  return out.filter((a): a is ActionRef => !!a);
}

export function prView(pr: PrRef, persona: Persona, jiraUrl: (key: string) => string | undefined, now: number, login?: string): PrView {
  const { groups, missing } = groupSignals(pr.reviews ?? []);
  const links: DeepLink[] = [{ kind: "github", label: `PR #${pr.number}`, target: pr.url }];
  const ju = pr.storyKey ? jiraUrl(pr.storyKey) : undefined;
  if (ju && pr.storyKey) links.push({ kind: "jira", label: pr.storyKey, target: ju });
  if (pr.reviews?.some((r) => r.source === "coderabbit")) links.push({ kind: "coderabbit", label: "CodeRabbit", target: `${pr.url}#pullrequestreview` });
  links.push({ kind: "github", label: "Checks", target: `${pr.url}/checks` });
  return {
    number: pr.number, title: pr.title, url: pr.url, branch: pr.branch, draft: pr.draft, author: pr.author, labels: pr.labels,
    storyKey: pr.storyKey, featureId: pr.featureId, aiAttempt: pr.aiAttempt, age: ageLabel(pr.updatedAt, now),
    needsYou: prNeedsPersona(pr, persona, login), checks: checkBadges(pr), gates: prGates(pr, persona), groups, missing, links, actions: [],
  };
}

// ---------- design page (G1, C5) ----------
export type DesignState = "approved" | "changed" | "unverified" | "draft" | "missing" | "unknown";
export interface DesignView {
  state: DesignState;
  /** one status phrase: "Approved v7", "Changed since v7 (now v9)", "In progress · v3", "No design page yet" */
  text: string;
  tone: "ok" | "warn" | "info" | "muted";
  url?: string;
  status?: string;
  version?: number;
  approvedVersion?: number;
  approvedBy?: string;
  approvedAt?: string;
}

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const httpsOnly = (u: unknown): string | undefined => (typeof u === "string" && /^https:\/\/[^\s]+$/.test(u) ? u : undefined);

/** Where the feature's design page stands: approved (and at which version), changed since, or still a draft. */
export function designView(f: FeatureV3): DesignView {
  const d = designOf(f);
  const url = httpsOnly(d.url) ?? (f.links ?? []).find((l) => l.kind === "confluence" && httpsOnly(l.target) && !/snapshot/i.test(l.label))?.target;
  const base = { url, status: d.status, version: isNum(d.version) ? d.version : undefined, approvedVersion: isNum(d.approvedVersion) ? d.approvedVersion : undefined,
    approvedBy: d.approvedBy, approvedAt: d.approvedAt };
  const ap = d.approval?.state;
  if (ap === "missing" || (!url && !d.status && base.version === undefined && !d.pageId)) return { ...base, state: "missing", text: "No design page yet", tone: "muted" };
  if (ap === "unknown" && !d.status) return { ...base, state: "unknown", text: d.approval?.detail || d.error || "Design page not read yet", tone: "muted" };
  const approved = base.approvedVersion !== undefined;
  if (approved && d.approvedByArchitect === false) {
    return { ...base, state: "unverified", text: `Approved by ${d.approvedBy ?? "someone"} outside architects: not counted`, tone: "warn" };
  }
  const changed = approved && (d.changedSinceApproval === true || (d.changedSinceApproval === undefined && base.version !== undefined && base.version > base.approvedVersion!));
  if (changed) return { ...base, state: "changed", text: `Changed since approved v${base.approvedVersion}${base.version !== undefined ? ` (now v${base.version})` : ""}`, tone: "warn" };
  if (approved) return { ...base, state: "approved", text: `Approved v${base.approvedVersion}${d.approvedBy ? ` by ${d.approvedBy}` : ""}`, tone: "ok" };
  const st = d.status && d.status.trim() ? d.status.trim() : "Draft";
  return { ...base, state: "draft", text: base.version !== undefined ? `${st} · v${base.version}` : st, tone: "info" };
}

/** "arch:approve-design" for a feature: opens the Confluence page; the person approves there (G1). */
export function approveDesignAction(f: FeatureV3): ActionRef {
  const args: Record<string, string | number> = { featureId: f.id };
  const key = v3(f).epicKey;
  if (key) args.key = key;
  const pageId = designOf(f).pageId;
  if (pageId) args.pageId = pageId;
  const url = designView(f).url;
  if (url) args.url = url;
  return { id: "arch:approve-design", label: "Approve design", persona: "architect", kind: "gate", args };
}

// ---------- features ----------
export interface FeatureCardView {
  /** slug: the epic key in v3 (what the row shows as its title) */
  id: string; slug: string; title: string; score?: number; openQuestions: number; stories: number;
  /** design approved (G1) */
  signedOff: boolean;
  epicKey?: string; design: DesignView;
  stages: StepView[]; gates: StepView[]; next?: ReturnType<typeof nextGate>; links: DeepLink[];
}

/** Feature links without spec files: in v3 the spec lives in Confluence, not in the repo. */
const featureLinks = (f: FeatureV3): DeepLink[] => (f.links ?? []).filter((l) => l.kind !== "file" && l.kind !== "report");

export function featureCard(f: FeatureV3, persona: Persona | null): FeatureCardView {
  const design = designView(f);
  return {
    id: f.id, slug: featureKey(f), title: f.title, score: f.score, openQuestions: f.openQuestions, stories: f.stories.length,
    signedOff: design.state === "approved" || (design.state === "missing" && f.signedOff), epicKey: v3(f).epicKey, design,
    stages: stageStrip(f), gates: gateStrip(f, persona), next: nextGate(f), links: featureLinks(f),
  };
}

// ---------- connections and navigation ----------
const ATTENTION: ConnectionStatus["state"][] = ["disconnected", "expiring", "error"];

/** Connections needing attention that matter to this person (or to everyone). Review tools count too. */
export function connectionsAttention(list: ConnectionStatus[], id: Identity | null): number {
  return list.filter((c) => ATTENTION.includes(c.state)
    && (!id || !c.neededBy?.length || c.neededBy.some((p) => id.personas.includes(p)))).length;
}

export interface NavItem { target: string; label: string; detail?: string; count?: number; cls?: string }

export function navItems(id: Identity, attention: number): NavItem[] {
  const out: NavItem[] = visiblePersonas(id).map((p) => ({
    target: `persona:${p}`, label: `${PERSONA_LABEL[p]} view`, detail: canAct(id, p) ? undefined : "view only",
  }));
  if (id.personas.includes("tester") || id.personas.includes("architect")) out.push({ target: "testing", label: "Testing" });
  // Sources (transcripts, notes, Fireflies, Wispr Flow) are the Architect's: step 1 of the flow.
  if (id.personas.includes("architect")) out.push({ target: "sources", label: "Sources", detail: "transcripts and notes for intake" });
  out.push({
    target: "connections", label: "Connections", count: attention || undefined, cls: attention ? "warn" : undefined,
    detail: attention ? `${attention} need${attention === 1 ? "s" : ""} attention` : "tools, review tools and MCP servers",
  });
  if (id.isAdmin) out.push({ target: "setup", label: "Project setup" });
  return out;
}

/** Targets the sidebar may ask for (validated in index.ts). */
export function navAllowed(id: Identity | null, target: string): boolean {
  if (!id) return target === "connections";
  if (target.startsWith("persona:")) { const p = target.slice(8) as Persona; return PERSONAS.includes(p) && canView(id, p); }
  if (target === "testing") return id.personas.includes("tester") || id.personas.includes("architect");
  if (target === "setup") return id.isAdmin;
  if (target === "sources") return id.personas.includes("architect");
  return target === "connections";
}

// ---------- sidebar ----------
export type HomeMode = "ready" | "no-remote" | "signin" | "loading" | "no-persona";

export interface HomeInput {
  hasRemote: boolean;
  identity: Identity | null;
  githubConnected: boolean;
  circuitInstalled: boolean;
  connections: ConnectionStatus[];
  queue: QueueItem[];
  allowed: (a: ActionRef) => boolean;
  teams: Record<string, string>;
  now: number;
  error?: string;
}

export interface HomeState {
  mode: HomeMode;
  identity?: { login: string; active: Persona | null; activeLabel: string; personas: Persona[]; canSwitch: boolean; owner: string; repo: string; orgOwned: boolean; isAdmin: boolean };
  waiting: QueueItemView[];
  /** Work items only: "connect" items are notices, not work, and are not counted. */
  waitingTotal: number;
  /** Queue items of kind "connect" (e.g. GitHub could not be read), shown as notices above the list */
  notices: QueueItemView[];
  nav: NavItem[];
  setupNeeded: boolean;
  teams: Record<string, string>;
  attention: number;
  /** Identity notice from connections (why personas are missing), shown under the header */
  notice?: string;
  error?: string;
  updated: string;
}

export const WAITING_LIMIT = 8;

export function homeMode(i: Pick<HomeInput, "hasRemote" | "identity" | "githubConnected">): HomeMode {
  if (!i.hasRemote) return "no-remote";
  if (!i.identity) return i.githubConnected ? "loading" : "signin";
  if (!i.identity.personas.length) return "no-persona";
  return "ready";
}

export function buildHome(i: HomeInput): HomeState {
  const mode = homeMode(i);
  const id = i.identity;
  const attention = connectionsAttention(i.connections, id);
  const base: HomeState = {
    mode, waiting: [], waitingTotal: 0, notices: [], nav: [], setupNeeded: !i.circuitInstalled, teams: i.teams, attention,
    error: i.error, updated: new Date(i.now).toISOString(),
  };
  if (id?.notice) base.notice = id.notice;
  if (id) {
    base.identity = {
      login: id.login, active: id.active, activeLabel: id.active ? PERSONA_LABEL[id.active] : "no persona",
      personas: id.personas, canSwitch: id.personas.length > 1, owner: id.owner, repo: id.repo, orgOwned: id.orgOwned, isAdmin: id.isAdmin,
    };
  }
  if (mode !== "ready" || !id) {
    if (id) base.nav = navItems(id, attention).filter((n) => n.target === "connections" || n.target === "setup");
    return base;
  }
  const own = i.queue.filter((q) => !id.active || q.persona === id.active);
  const work = own.filter((q) => q.kind !== "connect");
  base.notices = queueView(own.filter((q) => q.kind === "connect"), id, i.allowed, i.now);
  base.waiting = queueView(work, id, i.allowed, i.now, WAITING_LIMIT);
  base.waitingTotal = work.length;
  base.nav = navItems(id, attention);
  return base;
}

export function statusText(id: Identity | null, waiting: number): { text: string; tooltip: string } {
  if (!id) return { text: "$(circle-outline) Circuit: sign in", tooltip: "Delivery Circuit: sign in to GitHub" };
  if (!id.active) return { text: "$(circle-outline) Circuit: no persona", tooltip: "Delivery Circuit: no persona from your GitHub teams" };
  const p = PERSONA_LABEL[id.active];
  return { text: `$(checklist) Circuit: ${p} · ${waiting} waiting`, tooltip: `Delivery Circuit: ${waiting} item${waiting === 1 ? "" : "s"} waiting on you as ${p}` };
}

const repoLabel = (id: Identity | null | undefined) => (id && id.owner && id.repo ? `${id.owner}/${id.repo}` : undefined);

// ---------- persona panel ----------
export interface PersonaInput {
  identity: Identity | null;
  requested?: Persona | null;
  queue: QueueItem[];
  features: FeatureV3[];
  prs: PrRef[];
  allowed: (a: ActionRef) => boolean;
  jiraUrl: (key: string) => string | undefined;
  now: number;
  error?: string;
}

export interface PersonaState {
  login?: string;
  /** "owner/repo" of the workspace, for the header line */
  repo?: string;
  active: Persona | null;
  /** The personas the identity holds (the header chip offers a switch when there are several). */
  personas: Persona[];
  tabs: TabView[];
  selected: Persona | null;
  selectedLabel: string;
  notice?: string;
  canAct: boolean;
  queue: QueueItemView[];
  features: FeatureCardView[];
  prs: PrView[];
  aiActions: ActionView[];
  error?: string;
  updated: string;
}

export function buildPersona(i: PersonaInput): PersonaState {
  const { tabs, selected } = personaTabs(i.identity, i.requested);
  const st: PersonaState = {
    login: i.identity?.login, repo: repoLabel(i.identity), active: i.identity?.active ?? null, personas: i.identity?.personas ?? [], tabs, selected,
    selectedLabel: selected ? PERSONA_LABEL[selected] : "", canAct: false, queue: [], features: [], prs: [], aiActions: [],
    error: i.error, updated: new Date(i.now).toISOString(),
  };
  if (!i.identity || !selected) {
    st.notice = !i.identity ? "Sign in to GitHub to see persona views." : "You have no persona yet. Ask an admin to add you to a persona team.";
    return st;
  }
  const id = i.identity;
  st.canAct = canAct(id, selected);
  st.notice = viewOnlyNotice(id, selected);
  st.queue = queueView(i.queue.filter((q) => q.persona === selected), id, i.allowed, i.now);
  st.features = [...i.features].sort((a, b) => a.id.localeCompare(b.id)).map((f) => featureCard(f, selected));
  st.prs = prsForPersona(i.prs, selected, id.login).map((p) => ({
    ...prView(p, selected, i.jiraUrl, i.now, id.login), actions: prActions(p, selected).map((a) => toActionView(id, a, i.allowed)),
  }));
  st.aiActions = aiActions(selected).map((a) => toActionView(id, a, i.allowed));
  return st;
}

// ---------- feature panel ----------
export type StoryPrState = "open" | "draft" | "merged" | "closed";
export interface StoryRow {
  num: string; title: string; jiraKey?: string;
  counts: { ui: number; unit: number; manual: number }; total: number; prNumber?: number; links: DeepLink[];
  /** State of the story's PR when the PR list knows it (open PRs and recently merged ones). */
  prState?: StoryPrState;
  /** Jira status */
  jiraStatus?: string;
  aiReady: boolean;
  designVersion?: number;
  /** C5: the story was planned on an older approved design than the page's current approved version */
  designChanged: boolean;
  /** one status phrase for the row */
  status: { tone: "ok" | "warn" | "info" | "muted" | "err"; text: string };
  /** Start story (Developer) / Add tests (Tester), for the personas the viewer can see; disabled with a reason */
  actions: ActionView[];
}
export interface GateRow {
  id: GateId; label: string; owner: Persona; ownerLabel: string; state: GateState; own: boolean; cls: string;
  /** The gate waits on the viewer now: it is the viewer's gate, not done, and the first open gate or already waiting. */
  waitsOnViewer: boolean;
  /** Spec Kit actions that move this gate (owner persona's feature actions), allowed/reason per viewer. */
  actions: ActionView[];
}

/** Feature-level commands that work towards each gate. G3-G9 are moved on the story PRs (e.g. G3 = /dev-review-plan
 *  on the draft PR), so the feature page shows them on the PR/story rows instead. G1 also has "Approve design". */
export const GATE_COMMANDS: Partial<Record<GateId, string[]>> = {
  G1: ["/arch-design", "/arch-jira-push"],
  G2: ["/qa-design-tests", "/qa-push-tests"],
};

/** Which gate a feature-level action belongs to (undefined: not tied to a gate). */
export function gateOfCommand(command: string): GateId | undefined {
  for (const [g, cmds] of Object.entries(GATE_COMMANDS)) if (cmds?.includes(command)) return g as GateId;
  return undefined;
}

const gateOfAction = (a: ActionRef): GateId | undefined => (a.id === "arch:approve-design" ? "G1" : gateOfCommand(String(a.args?.command ?? "")));

export function storyPrState(pr: PrRef | undefined): StoryPrState | undefined {
  if (!pr) return undefined;
  if (pr.state === "merged" || pr.state === "closed") return pr.state;
  return pr.draft ? "draft" : "open";
}
export interface SourceRow { id: string; kind: SourceRef["kind"]; title: string; date: string; links: DeepLink[]; canOpen: boolean }

export interface FeatureInput {
  feature: FeatureV3 | undefined;
  featureId: string;
  identity: Identity | null;
  sources: SourceRef[];
  prs: PrRef[];
  owner: string;
  repo: string;
  jiraUrl: (key: string) => string | undefined;
  allowed: (a: ActionRef) => boolean;
  now: number;
  error?: string;
}

export interface FeatureState {
  found: boolean;
  featureId: string;
  viewer: Persona | null;
  viewerLabel: string;
  login?: string;
  /** The personas the identity holds (header chip). */
  personas: Persona[];
  /** slug: the epic key in v3 */
  feature?: { id: string; slug: string; epicKey?: string; title: string; score?: number; openQuestions: number; signedOff: boolean; links: DeepLink[] };
  /** The Confluence design page: status, version, approved version (G1) */
  design?: DesignView;
  /** Design row actions: Approve design (Architect), Design (AI), Record decision (the viewer's persona) */
  designActions: ActionView[];
  stages: StepView[];
  gates: GateRow[];
  next?: ReturnType<typeof nextGate>;
  stories: StoryRow[];
  /** null when the viewer may not see sources (Architect only) */
  sources: SourceRow[] | null;
  actions: ActionView[];
  error?: string;
  updated: string;
}

/** Why a story may not start yet because of its design (C5), or undefined. */
export function storyBlocked(s: StoryV3, design: DesignView): string | undefined {
  const sv = isNum(s.designVersion) ? s.designVersion : undefined;
  if (sv !== undefined && design.approvedVersion !== undefined && sv < design.approvedVersion) {
    return `Design changed since this story was planned (v${sv}, now approved v${design.approvedVersion}): re-plan the story first`;
  }
  if (design.state === "changed") return `The design page changed after approval (now v${design.version ?? "?"}): an architect re-approves it first`;
  if (design.state === "unverified") return "The design approval was not set by an architect: an architect approves it first";
  if (design.state === "draft") return "The design is not approved yet (G1)";
  if (design.state === "unknown") return "The design page could not be read: sign in to the Atlassian MCP in Claude Code (/mcp) and refresh";
  if (s.designSync === "missing" && design.state === "approved") return "The story has no Approved design version: the Architect records it first (arch-jira-push)";
  return undefined;
}

/** Why a story waits on other stories (Jira "is blocked by", e.g. Story 00 first), or undefined. */
export function storyWaitsFor(s: StoryV3, doneKeys: Set<string>): string | undefined {
  const open = (s.blockedBy ?? []).filter((k) => !doneKeys.has(k));
  return open.length ? `Waits for ${open.join(", ")} (blocks this story)` : undefined;
}

/** The story row's Start story / Add tests actions (disabled with a reason when the story or its design is not ready). */
function storyActions(s: StoryV3, prState: StoryPrState | undefined, design: DesignView, i: FeatureInput, doneKeys: Set<string>): ActionView[] {
  if (!s.jiraKey || !i.identity) return [];
  const id = i.identity;
  const out: ActionView[] = [];
  const hasPr = !!s.prNumber && prState !== "closed";
  if (!hasPr && canView(id, "developer")) {
    const a = findAi("developer", "dev:start-story", s.jiraKey);
    const v = toActionView(id, a, i.allowed);
    const why = storyBlocked(s, design) ?? (!s.aiReady ? "Waits for G2: the Tester confirms testability (ai-ready)" : undefined) ?? storyWaitsFor(s, doneKeys);
    out.push(why && v.allowed ? { ...v, allowed: false, reason: why } : v);
  }
  if (hasPr && prState !== "merged" && !s.testsOnPr && canView(id, "tester")) {
    out.push(toActionView(id, findAi("tester", "qa:add-tests", s.jiraKey, { pr: s.prNumber! }), i.allowed));
  }
  return out;
}

const findAi = (persona: Persona, id: string, story: string, extra: Record<string, string | number> = {}): ActionRef => {
  const a = aiActions(persona, { story }).find((x) => x.id === id)!;
  return { ...a, args: { ...(a.args ?? {}), ...extra } };
};

function storyStatus(s: StoryV3, prState: StoryPrState | undefined, designChanged: boolean): StoryRow["status"] {
  if (designChanged) return { tone: "warn", text: s.designVersion !== undefined ? `design changed since v${s.designVersion}` : "design changed: re-plan" };
  if (s.prNumber && prState) {
    const word = { merged: "merged", open: "in review", draft: "draft", closed: "closed" }[prState];
    return { tone: prState === "merged" ? "ok" : prState === "open" ? "info" : "muted", text: `PR #${s.prNumber} ${word}` };
  }
  if (s.prNumber) return { tone: "info", text: `PR #${s.prNumber}` };
  if (s.aiReady) return { tone: "info", text: "ready to start" };
  if (!s.jiraKey) return { tone: "muted", text: "not in Jira yet" };
  return { tone: "muted", text: s.status ? `${s.status} · not ai-ready` : "not ai-ready yet" };
}

export function firefliesUrl(sourceId: string): string | undefined {
  const m = sourceId.match(/^fireflies:(.+)$/);
  return m ? `https://app.fireflies.ai/view/${encodeURIComponent(m[1])}` : undefined;
}

export function buildFeature(i: FeatureInput): FeatureState {
  const viewer = i.identity?.active ?? i.identity?.personas[0] ?? null;
  const st: FeatureState = {
    found: !!i.feature, featureId: i.featureId, viewer, viewerLabel: viewer ? PERSONA_LABEL[viewer] : "",
    login: i.identity?.login, personas: i.identity?.personas ?? [], designActions: [],
    stages: [], gates: [], stories: [], sources: null, actions: [], error: i.error, updated: new Date(i.now).toISOString(),
  };
  const f = i.feature;
  if (!f) return st;
  const key = featureKey(f);
  const design = designView(f);
  st.design = design;
  st.feature = { id: f.id, slug: key, epicKey: v3(f).epicKey, title: f.title, score: f.score, openQuestions: f.openQuestions,
    signedOff: design.state === "approved" || (design.state === "missing" && f.signedOff), links: featureLinks(f) };
  st.stages = stageStrip(f);
  st.next = nextGate(f);
  const approve = approveDesignAction(f);
  const featureActs = (p: Persona) => aiActions(p, { feature: key }).filter((a) => a.args?.argKind === "feature" && (a.id !== "decision:record" || p === viewer));
  // Approve design leads G1 while the design is not (or no longer) approved; it follows Design once it is.
  const needsApproval = design.state !== "approved";
  const archActs = featureActs("architect");
  const acts: ActionRef[] = [
    ...(needsApproval ? [approve, ...archActs] : [...archActs.slice(0, 1), approve, ...archActs.slice(1)]),
    ...featureActs("developer"),
    ...featureActs("tester"),
  ];
  const visible = acts.filter((a) => !!i.identity && canView(i.identity, a.persona));
  st.actions = visible.map((a) => toActionView(i.identity, a, i.allowed));
  const approveView = st.actions.find((a) => a.id === "arch:approve-design");
  if (approveView && design.state === "missing" && approveView.allowed) Object.assign(approveView, { allowed: false, reason: "Run Design first: there is no design page yet" });
  st.designActions = st.actions.filter((a) => a.id === "arch:approve-design" || a.args?.command === "/arch-design" || a.id === "decision:record");
  st.gates = GATE_IDS.map((g) => {
    const state = f.gates?.[g] ?? "not-started";
    const owner = GATES[g].owner;
    const own = owner === viewer;
    const waitsOnViewer = own && state !== "done" && (state === "waiting" || st.next?.id === g);
    const actions = st.actions.filter((a) => gateOfAction(a) === g);
    return { id: g, label: GATES[g].label, owner, ownerLabel: PERSONA_LABEL[owner], state, own, cls: stateClass(state), waitsOnViewer, actions };
  });
  const prByNum = new Map(i.prs.map((p) => [p.number, p]));
  /** the story's PR: by number when the project linked it, else the open (or merged) PR whose branch names the key */
  const prOf = (raw: Story) => (raw.prNumber ? prByNum.get(raw.prNumber) : undefined)
    ?? i.prs.find((p) => p.storyKey === raw.jiraKey && p.state !== "closed" && p.state !== "merged")
    ?? i.prs.find((p) => p.storyKey === raw.jiraKey && p.state === "merged");
  const all = f.stories.map((raw) => storyOf(raw, prOf(raw)));
  const doneKeys = new Set(all.filter((s) => s.jiraKey && (s.statusCategory === "done" || /^(done|closed|resolved)$/i.test(s.status ?? "")
    || (s.prNumber !== undefined && prByNum.get(s.prNumber)?.state === "merged"))).map((s) => s.jiraKey!));
  st.stories = all.sort((a, b) => a.num.localeCompare(b.num)).map((s) => {
    const counts = { ui: 0, unit: 0, manual: 0 };
    for (const tc of s.testCases ?? []) counts[tc.level] = (counts[tc.level] ?? 0) + 1;
    const links: DeepLink[] = [];
    const ju = s.jiraKey ? i.jiraUrl(s.jiraKey) ?? httpsOnly(s.url) : undefined;
    if (ju && s.jiraKey) links.push({ kind: "jira", label: s.jiraKey, target: ju });
    if (s.prNumber) {
      const url = prByNum.get(s.prNumber)?.url ?? (i.owner && i.repo ? `https://github.com/${i.owner}/${i.repo}/pull/${s.prNumber}` : undefined);
      if (url) links.push({ kind: "github", label: `PR #${s.prNumber}`, target: url });
    }
    const prState = s.prNumber ? storyPrState(prByNum.get(s.prNumber)) : undefined;
    const designVersion = isNum(s.designVersion) ? s.designVersion : undefined;
    const designChanged = prState !== "merged" && (s.designSync === "changed"
      || (designVersion !== undefined && design.approvedVersion !== undefined && designVersion < design.approvedVersion));
    return {
      num: s.num, title: s.title, jiraKey: s.jiraKey, counts, total: s.testCases?.length ?? 0, prNumber: s.prNumber, links, prState,
      jiraStatus: s.status, aiReady: !!s.aiReady, designVersion, designChanged,
      status: storyStatus(s, prState, designChanged), actions: storyActions(s, prState, design, i, doneKeys),
    };
  });
  if (i.identity?.personas.includes("architect")) {
    const byId = new Map(i.sources.map((s) => [s.id, s]));
    st.sources = f.sources.map((sid) => {
      const s = byId.get(sid);
      const kind: SourceRef["kind"] = s?.kind ?? (sid.startsWith("fireflies:") ? "fireflies" : "upload");
      const ff = kind === "fireflies" ? firefliesUrl(sid) : undefined;
      return {
        id: sid, kind, title: s?.title ?? sid, date: s?.date?.slice(0, 10) ?? "",
        links: ff ? [{ kind: "fireflies", label: "Fireflies", target: ff }] : [], canOpen: true,
      };
    });
  }
  return st;
}
