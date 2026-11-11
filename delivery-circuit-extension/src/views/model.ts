// View models for the sidebar, persona panel and feature panel. No "vscode" import: everything here is pure and
// unit-tested (test/unit/views*.test.ts). index.ts loads data through the contracts and hands it to these builders;
// the webview pages only render what they receive.
import {
  GATES, PERSONAS, canAct, canView,
  type ActionRef, type CheckState, type ConnectionStatus, type DeepLink, type Feature, type GateId, type GateState,
  type Identity, type Persona, type PrRef, type QueueItem, type ReviewSignal, type SourceRef, type StageId,
} from "../core/contracts";

// ---------- labels ----------
export const PERSONA_LABEL: Record<Persona, string> = { architect: "Architect", developer: "Developer", tester: "Tester" };

export const STAGES: { id: StageId; label: string }[] = [
  { id: "intake", label: "Intake" }, { id: "clarify", label: "Clarify" }, { id: "plan", label: "Plan" },
  { id: "signoff", label: "Sign-off" }, { id: "stories", label: "Stories" }, { id: "tests", label: "Tests" },
  { id: "jira", label: "Jira" }, { id: "build", label: "Build" }, { id: "qa", label: "QA" }, { id: "release", label: "Release" },
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
export const CHECK_ORDER = ["guard", "static", "qa", "spec-gate"];

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
export type ArgKind = "feature" | "pr" | "source" | "none";
export type ActionView = ActionRef & { allowed: boolean; reason?: string };

/** Why an action is disabled, in words the person can act on. */
export function disabledReason(id: Identity | null, a: ActionRef, allowed: boolean): string | undefined {
  if (allowed) return undefined;
  if (!id) return "Sign in to GitHub first";
  if (!id.personas.includes(a.persona)) return `Only a ${PERSONA_LABEL[a.persona]} can run this`;
  if (id.active !== a.persona) return `Switch to ${PERSONA_LABEL[a.persona]} to run this`;
  return a.kind === "gate" ? "This gate is not ready yet" : "Not available right now";
}

export function toActionView(id: Identity | null, a: ActionRef, allowed: (a: ActionRef) => boolean): ActionView {
  let ok = false;
  try { ok = !!id && allowed(a); } catch { ok = false; }
  return { ...a, allowed: ok, reason: disabledReason(id, a, ok) };
}

interface AiSpec { command: string; label: string; argKind: ArgKind; intent?: string }
export const AI_ACTIONS: Record<Persona, AiSpec[]> = {
  architect: [
    { command: "/circuit-intake", label: "Intake from a source", argKind: "source" },
    { command: "/arch-design", label: "Design", argKind: "feature" },
    { command: "/arch-jira-push", label: "Push to Jira", argKind: "feature" },
    { command: "/arch-review-pr", label: "Review PR", argKind: "pr" },
  ],
  developer: [
    { command: "/dev-review-stories", label: "Review stories", argKind: "feature" },
    { command: "/dev-review-plan", label: "Review plan", argKind: "pr" },
    { command: "/dev-review-pr", label: "Review PR", argKind: "pr" },
    // Take over a PR the AI fix loop gave up on (label needs-human): a Developer session on that PR.
    { command: "/dev-review-pr", label: "Take over", argKind: "pr", intent: "takeover" },
  ],
  tester: [
    { command: "/qa-design-tests", label: "Design tests", argKind: "feature" },
    { command: "/qa-push-tests", label: "Push tests", argKind: "feature" },
    { command: "/qa-review-testplan", label: "Review test plan", argKind: "pr" },
    { command: "/qa-explore", label: "Explore on QA", argKind: "pr" },
  ],
};

/** Persona AI actions as ActionRefs ("ai:/arch-design" with args {command, argKind, arg?}). */
export function aiActions(persona: Persona, preset: { feature?: string; pr?: number } = {}): ActionRef[] {
  return AI_ACTIONS[persona].map((x) => {
    const args: Record<string, string | number> = { command: x.command, argKind: x.argKind };
    if (x.intent) args.intent = x.intent;
    const arg = x.argKind === "feature" ? preset.feature : x.argKind === "pr" ? preset.pr : undefined;
    if (arg !== undefined) args.arg = arg;
    return { id: `ai:${x.command}`, label: x.label, persona, kind: "ai" as const, args };
  });
}

export function needsArg(a: ActionRef): boolean {
  const k = a.args?.argKind;
  return (k === "feature" || k === "pr" || k === "source") && (a.args?.arg === undefined || a.args?.arg === "");
}

export function withArg(a: ActionRef, value: string | number): ActionRef {
  return { ...a, args: { ...(a.args ?? {}), arg: value } };
}

export interface PickItem { label: string; description?: string; detail?: string; value: string | number }

/** QuickPick items for an action's argument, best candidates first. */
export function argPickItems(a: ActionRef, data: { features: Feature[]; prs: PrRef[]; sources: SourceRef[] }): PickItem[] {
  const kind = a.args?.argKind;
  const cmd = String(a.args?.command ?? "");
  if (kind === "feature") {
    return [...data.features].sort((x, y) => x.id.localeCompare(y.id)).map((f) => ({
      label: f.slug, description: f.title,
      detail: `${f.stories.length} stories · ${f.openQuestions} open questions${f.signedOff ? " · signed off" : ""}`, value: f.slug,
    }));
  }
  if (kind === "pr") {
    const score = (p: PrRef): number => {
      const build = p.branch.startsWith("feature/");
      if (a.args?.intent === "takeover") return p.labels.includes("needs-human") ? 0 : 2;
      if (cmd === "/dev-review-plan") return build && p.draft && !p.labels.includes("plan-approved") ? 0 : build ? 1 : 2;
      if (cmd === "/qa-review-testplan") return build && p.draft && !p.labels.includes("testplan-approved") ? 0 : build ? 1 : 2;
      if (cmd === "/qa-explore") return p.labels.includes("needs-qa") ? 0 : build && !p.draft ? 1 : 2;
      if (cmd === "/dev-review-pr" || cmd === "/arch-review-pr") return build && !p.draft ? 0 : 1;
      return 1;
    };
    return [...data.prs]
      .sort((x, y) => score(x) - score(y) || y.updatedAt.localeCompare(x.updatedAt))
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

export function stageStrip(f: Feature): StepView[] {
  return STAGES.map((s) => {
    const state = f.stages?.[s.id] ?? "todo";
    return { id: s.id, label: s.label, state, title: `${s.label}: ${state}` };
  });
}

/** G1..G9 with the persona's own gates flagged (highlighted in the UI). */
export function gateStrip(f: Feature, persona: Persona | null): StepView[] {
  return GATE_IDS.map((g) => {
    const state: GateState = f.gates?.[g] ?? "not-started";
    const owner = GATES[g].owner;
    return { id: g, label: g, state, own: owner === persona, title: `${g} ${GATES[g].label} · ${PERSONA_LABEL[owner]} · ${state}` };
  });
}

export function nextGate(f: Feature): { id: GateId; label: string; owner: Persona; ownerLabel: string; state: GateState } | undefined {
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

export type PrKind = "build" | "spec" | "intake" | "other";
export function prKind(pr: PrRef): PrKind {
  if (pr.branch.startsWith("feature/")) return "build";
  if (pr.branch.startsWith("spec/")) return "spec";
  if (pr.branch.startsWith("intake/")) return "intake";
  return "other";
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
const isAiPr = (pr: PrRef) => has(pr, "ai-generated");
const nonGateGreen = (pr: PrRef) => Object.entries(pr.checks).every(([k, v]) => k.startsWith("gate/") || (v !== "failure" && v !== "pending"));
const allGatesGreen = (pr: PrRef) => ["gate/developer", "gate/tester", "gate/architect"].every((c) => pr.checks[c] === "success");

/** AI plan / test plan approval (G3 / G4): asked only on draft ai-generated PRs. */
function planGate(pr: PrRef, label: string): GateState {
  if (has(pr, label)) return "done";
  return pr.draft && isAiPr(pr) ? "waiting" : "not-started";
}

/** The gates this persona owns on this PR, with their state. */
export function prGates(pr: PrRef, persona: Persona): StepView[] {
  const kind = prKind(pr);
  const mk = (g: GateId, state: GateState): StepView =>
    ({ id: g, label: g, state, own: true, title: `${g} ${GATES[g].label} · ${state}` });
  if (kind === "spec" || kind === "intake") {
    if (persona !== "architect") return [];
    const sg = pr.checks["spec-gate"];
    return [mk("G1", sg === "success" ? "done" : sg === "failure" ? "blocked" : "waiting")];
  }
  if (kind !== "build") return [];
  if (persona === "developer") {
    return [...(isAiPr(pr) ? [mk("G3", planGate(pr, "plan-approved"))] : []), mk("G5", checkGate(pr.checks["gate/developer"], pr.draft))];
  }
  if (persona === "tester") {
    return [...(isAiPr(pr) ? [mk("G4", planGate(pr, "testplan-approved"))] : []), mk("G6", checkGate(pr.checks["gate/tester"], pr.draft))];
  }
  const ready = !pr.draft && allGatesGreen(pr) && nonGateGreen(pr);
  return [mk("G7", checkGate(pr.checks["gate/architect"], pr.draft)), mk("G8", ready ? "waiting" : "not-started")];
}

/** Whether the PR is waiting on this persona now (same predicates as the persona's queue). `login`: the viewer,
 *  whose own PRs are not theirs to review. */
export function prNeedsPersona(pr: PrRef, persona: Persona, login?: string): boolean {
  const kind = prKind(pr);
  if (kind === "spec" || kind === "intake") return persona === "architect" && prGates(pr, persona).some((g) => g.state === "waiting" || g.state === "blocked");
  if (kind !== "build") return false;
  const mine = !!login && pr.author === login;
  const open = (c: string) => pr.checks[c] !== "success";
  switch (persona) {
    case "developer":
      if (has(pr, "needs-human")) return true;
      if (pr.draft && isAiPr(pr) && !has(pr, "plan-approved")) return true;
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

/** PRs relevant to a persona: Architect all; Developer build, spec and other PRs; Tester build and spec PRs. */
export function prsForPersona(prs: PrRef[], persona: Persona, login?: string): PrRef[] {
  const keep = (p: PrRef) => {
    const k = prKind(p);
    if (persona === "architect") return true;
    if (persona === "developer") return k !== "intake";
    return k === "build" || k === "spec";
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

/** AI actions a persona would run on this PR now, most relevant first, with the PR number preset.
 *  Developer: take over (needs-human) > review the AI plan (draft ai-generated, plan not approved) > review the PR.
 *  Tester: review the AI test plan > explore on QA. Architect: review the PR (build, not draft) or the spec PR. */
export function prActions(pr: PrRef, persona: Persona): ActionRef[] {
  const kind = prKind(pr);
  const all = aiActions(persona, { pr: pr.number });
  const pick = (command: string, intent?: string) =>
    all.find((a) => a.args?.command === command && (intent ? a.args?.intent === intent : a.args?.intent === undefined));
  const out: (ActionRef | undefined)[] = [];
  if (persona === "developer") {
    if (kind === "build" && has(pr, "needs-human")) out.push(pick("/dev-review-pr", "takeover"));
    if (pr.draft && isAiPr(pr) && !has(pr, "plan-approved")) out.push(pick("/dev-review-plan"));
    if (kind !== "intake" && !pr.draft) out.push(pick("/dev-review-pr"));
  } else if (persona === "tester") {
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

// ---------- features ----------
export interface FeatureCardView {
  id: string; slug: string; title: string; score?: number; openQuestions: number; stories: number; signedOff: boolean;
  stages: StepView[]; gates: StepView[]; next?: ReturnType<typeof nextGate>; links: DeepLink[];
}

export function featureCard(f: Feature, persona: Persona | null): FeatureCardView {
  return {
    id: f.id, slug: f.slug, title: f.title, score: f.score, openQuestions: f.openQuestions, stories: f.stories.length,
    signedOff: f.signedOff, stages: stageStrip(f), gates: gateStrip(f, persona), next: nextGate(f), links: f.links ?? [],
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
  features: Feature[];
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
  num: string; title: string; file: string; jiraKey?: string;
  counts: { ui: number; unit: number; manual: number }; total: number; prNumber?: number; links: DeepLink[];
  /** State of the story's PR when the PR list knows it (open PRs and recently merged ones). */
  prState?: StoryPrState;
}
export interface GateRow {
  id: GateId; label: string; owner: Persona; ownerLabel: string; state: GateState; own: boolean; cls: string;
  /** The gate waits on the viewer now: it is the viewer's gate, not done, and the first open gate or already waiting. */
  waitsOnViewer: boolean;
  /** Spec Kit actions that move this gate (owner persona's feature actions), allowed/reason per viewer. */
  actions: ActionView[];
}

/** Feature-level Spec Kit commands that work towards each gate. G3-G9 are moved on the story PRs
 *  (e.g. G3 = /dev-review-plan on the draft PR), so the feature page shows them on the PR/story rows instead. */
export const GATE_COMMANDS: Partial<Record<GateId, string[]>> = {
  G1: ["/arch-design", "/arch-jira-push"],
  G2: ["/qa-design-tests", "/qa-push-tests"],
};

/** Which gate a feature-level action belongs to (undefined: not tied to a gate). */
export function gateOfCommand(command: string): GateId | undefined {
  for (const [g, cmds] of Object.entries(GATE_COMMANDS)) if (cmds?.includes(command)) return g as GateId;
  return undefined;
}

export function storyPrState(pr: PrRef | undefined): StoryPrState | undefined {
  if (!pr) return undefined;
  if (pr.state === "merged" || pr.state === "closed") return pr.state;
  return pr.draft ? "draft" : "open";
}
export interface SourceRow { id: string; kind: SourceRef["kind"]; title: string; date: string; links: DeepLink[]; canOpen: boolean }

export interface FeatureInput {
  feature: Feature | undefined;
  featureId: string;
  identity: Identity | null;
  sources: SourceRef[];
  prs: PrRef[];
  owner: string;
  repo: string;
  jiraUrl: (key: string) => string | undefined;
  existingFiles: string[];
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
  feature?: { id: string; slug: string; title: string; score?: number; openQuestions: number; signedOff: boolean; dir: string; links: DeepLink[] };
  stages: StepView[];
  gates: GateRow[];
  next?: ReturnType<typeof nextGate>;
  stories: StoryRow[];
  /** null when the viewer may not see sources (Architect only) */
  sources: SourceRow[] | null;
  files: DeepLink[];
  actions: ActionView[];
  error?: string;
  updated: string;
}

export function firefliesUrl(sourceId: string): string | undefined {
  const m = sourceId.match(/^fireflies:(.+)$/);
  return m ? `https://app.fireflies.ai/view/${encodeURIComponent(m[1])}` : undefined;
}

export function buildFeature(i: FeatureInput): FeatureState {
  const viewer = i.identity?.active ?? i.identity?.personas[0] ?? null;
  const st: FeatureState = {
    found: !!i.feature, featureId: i.featureId, viewer, viewerLabel: viewer ? PERSONA_LABEL[viewer] : "",
    login: i.identity?.login, personas: i.identity?.personas ?? [],
    stages: [], gates: [], stories: [], sources: null, files: [], actions: [], error: i.error, updated: new Date(i.now).toISOString(),
  };
  const f = i.feature;
  if (!f) return st;
  st.feature = { id: f.id, slug: f.slug, title: f.title, score: f.score, openQuestions: f.openQuestions, signedOff: f.signedOff, dir: f.dir, links: f.links ?? [] };
  st.stages = stageStrip(f);
  st.next = nextGate(f);
  const acts: ActionRef[] = [
    ...aiActions("architect", { feature: f.slug }).filter((a) => a.args?.argKind === "feature"),
    ...aiActions("developer", { feature: f.slug }).filter((a) => a.args?.argKind === "feature"),
    ...aiActions("tester", { feature: f.slug }).filter((a) => a.args?.argKind === "feature"),
  ];
  const visible = acts.filter((a) => !!i.identity && canView(i.identity, a.persona));
  st.actions = visible.map((a) => toActionView(i.identity, a, i.allowed));
  st.gates = GATE_IDS.map((g) => {
    const state = f.gates?.[g] ?? "not-started";
    const owner = GATES[g].owner;
    const own = owner === viewer;
    const waitsOnViewer = own && state !== "done" && (state === "waiting" || st.next?.id === g);
    const actions = st.actions.filter((a) => gateOfCommand(String(a.args?.command ?? "")) === g);
    return { id: g, label: GATES[g].label, owner, ownerLabel: PERSONA_LABEL[owner], state, own, cls: stateClass(state), waitsOnViewer, actions };
  });
  const prByNum = new Map(i.prs.map((p) => [p.number, p]));
  st.stories = [...f.stories].sort((a, b) => a.num.localeCompare(b.num)).map((s) => {
    const counts = { ui: 0, unit: 0, manual: 0 };
    for (const tc of s.testCases ?? []) counts[tc.level] = (counts[tc.level] ?? 0) + 1;
    const links: DeepLink[] = [{ kind: "file", label: "Story", target: s.file }];
    const ju = s.jiraKey ? i.jiraUrl(s.jiraKey) : undefined;
    if (ju && s.jiraKey) links.push({ kind: "jira", label: s.jiraKey, target: ju });
    if (s.prNumber) {
      const url = prByNum.get(s.prNumber)?.url ?? (i.owner && i.repo ? `https://github.com/${i.owner}/${i.repo}/pull/${s.prNumber}` : undefined);
      if (url) links.push({ kind: "github", label: `PR #${s.prNumber}`, target: url });
    }
    const prState = s.prNumber ? storyPrState(prByNum.get(s.prNumber)) : undefined;
    return { num: s.num, title: s.title, file: s.file, jiraKey: s.jiraKey, counts, total: s.testCases?.length ?? 0, prNumber: s.prNumber, links, prState };
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
  const dir = f.dir.replace(/\\/g, "/").replace(/\/$/, "");
  st.files = ["spec.md", "plan.md", "data-model.md", "jira-map.json"]
    .map((n) => `${dir}/${n}`)
    .filter((p) => i.existingFiles.includes(p))
    .map((p) => ({ kind: "file" as const, label: p.split("/").pop()!, target: p }));
  return st;
}
