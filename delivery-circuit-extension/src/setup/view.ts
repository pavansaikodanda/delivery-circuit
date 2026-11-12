// Page state for media/setup/setup.js, built from phase definitions + build-state.md + step results. No vscode import.
import type { DeepLink } from "../core/contracts";
import { statusKind, type BuildState, type StatusKind } from "./buildState";
import { CONFIG_FIELDS, type ConfigField, type FormError } from "./config";
import type { PhaseDef, StepKind } from "./phases";

export interface StepResultView { state: "ok" | "warn" | "err"; text: string; at: string; lines?: string[] }

export interface StepView {
  id: string;
  kind: StepKind;
  title: string;
  detail: string;
  hc?: string;
  action?: string;
  checklist?: { text: string; done: boolean }[];
  /** commands the person copies (runner registration, logins); never a credential */
  commands?: string[];
  notes?: string[];
  verify: boolean;
  links: DeepLink[];
  result?: StepResultView;
  /** the one status shown on the collapsed row */
  status: StepStatus;
  /** what the row offers; the first is the row's primary action, the rest go to its menu and expanded panel */
  actions: StepAction[];
  /** the last result passed */
  done: boolean;
}

export type Tone = "ok" | "warn" | "err" | "info" | "muted";
export interface StepStatus { tone: Tone; text: string; busy?: boolean }
/** run = post {type:"run"}, verify = {type:"verify"}, form = switch to the config tab. v3 has no secret steps. */
export interface StepAction { do: "run" | "verify" | "form"; label: string }

export interface PhaseView {
  id: string;
  name: string;
  summary: string;
  status: string;
  kind: StatusKind;
  verified: string;
  evidence: string;
  notes: string;
  steps: StepView[];
  /** all verifiable steps passed: offer "Mark DONE" */
  ready: boolean;
  /** steps whose last result passed, of all steps */
  progress: { done: number; total: number };
}

export interface SetupView {
  login: string;
  admin: boolean;
  repo: { owner: string; repo: string; url: string };
  buildState: { exists: boolean; repaired: boolean; path: string };
  selected: string;
  busy: string | null;
  phases: PhaseView[];
  config: { exists: boolean; fields: ConfigField[]; values: Record<string, string>; errors: FormError[] };
}

/** Kind of deep link for a vendor URL (drives the link label in the UI kit). */
export function linkKind(url: string): DeepLink["kind"] {
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (/github\.com$/.test(host)) return "github";
  if (/atlassian\.(net|com)$/.test(host) && /\/wiki\//.test(url)) return "confluence";
  if (/atlassian\.(net|com)$/.test(host)) return "jira";
  if (/salesforce\.com$|force\.com$/.test(host)) return "salesforce";
  if (/slack\.(com|dev)$/.test(host)) return "slack";
  if (/lucid\.(co|app)$/.test(host)) return "lucid";
  if (/fireflies\.ai$/.test(host)) return "fireflies";
  return "url";
}

type StepCore = Omit<StepView, "status" | "actions" | "done">;

/** One status phrase for a step row (DESIGN.md §6.6): working, passed/done, needs attention, failed, or what is open. */
export function stepStatus(s: StepCore, busy: string | null): StepStatus {
  if (busy && busy === s.id) return { tone: "info", text: "working", busy: true };
  const r = s.result;
  if (r?.state === "ok") return { tone: "ok", text: s.kind === "check" ? "passed" : "done" };
  if (r?.state === "warn") return { tone: "warn", text: "needs attention" };
  if (r?.state === "err") return { tone: "err", text: "failed" };
  if (s.kind === "human") {
    const list = s.checklist ?? [];
    const ticked = list.filter((c) => c.done).length;
    if (list.length && ticked === list.length) return { tone: "info", text: "ready to verify" };
    return { tone: "info", text: list.length && ticked ? `${ticked} of ${list.length} ticked` : "waiting for you" };
  }
  if (s.kind === "check" || s.kind === "form") return { tone: "muted", text: "not checked" };
  return { tone: "muted", text: "not run" };
}

/** Actions a step offers, primary first: the open thing to do comes before re-checking. */
export function stepActions(s: StepCore): StepAction[] {
  const out: StepAction[] = [];
  const verify: StepAction | null = s.verify ? { do: "verify", label: s.kind === "human" ? "Verify" : "Check" } : null;
  if (s.kind === "form") {
    out.push({ do: "form", label: "Open form" });
    if (verify) out.push(verify);
    return out;
  }
  const run: StepAction | null = s.action ? { do: "run", label: s.action } : null;
  // a check reads first; its follow-up (record versions, delete leftovers) comes second
  if (s.kind === "check") {
    if (verify) out.push(verify);
    if (run) out.push(run);
    return out;
  }
  if (run) out.push(run);
  if (verify) out.push(verify);
  if (!out.length && s.kind === "terminal") out.push({ do: "run", label: "Open terminal" });
  return out;
}

export function buildView(p: {
  login: string; admin: boolean; owner: string; repo: string;
  defs: PhaseDef[]; state: BuildState | undefined; buildStateExists: boolean;
  results: Record<string, StepResultView>; ticks: Record<string, boolean[]>;
  selected: string; busy: string | null;
  config: { exists: boolean; values: Record<string, string>; errors: FormError[] };
}): SetupView {
  const phases = p.defs.map((d): PhaseView => {
    const row = p.state?.rows.find((r) => r.id === d.id);
    const steps = d.steps.map((s): StepView => {
      const core: StepCore = {
        id: s.id, kind: s.kind, title: s.title, detail: s.detail, hc: s.hc, action: s.action, verify: !!s.verify,
        checklist: s.checklist?.map((text, i) => ({ text, done: !!p.ticks[s.id]?.[i] })),
        ...(s.commands?.length ? { commands: s.commands } : {}),
        ...(s.notes?.length ? { notes: s.notes } : {}),
        links: (s.urls ?? []).map((u) => ({ kind: linkKind(u.url), label: u.label, target: u.url })),
        result: p.results[s.id],
      };
      return { ...core, status: stepStatus(core, p.busy), actions: stepActions(core), done: core.result?.state === "ok" };
    });
    const verifiable = steps.filter((s) => s.verify);
    return {
      id: d.id, name: d.name, summary: d.summary,
      status: row?.status || "TODO", kind: statusKind(row?.status ?? ""), verified: row?.verified ?? "", evidence: row?.evidence ?? "", notes: row?.notes ?? "",
      steps, ready: verifiable.length > 0 && verifiable.every((s) => s.result?.state === "ok"),
      progress: { done: steps.filter((s) => s.done).length, total: steps.length },
    };
  });
  return {
    login: p.login, admin: p.admin,
    repo: { owner: p.owner, repo: p.repo, url: p.owner && p.repo ? `https://github.com/${p.owner}/${p.repo}` : "" },
    buildState: { exists: p.buildStateExists, repaired: !!p.state?.repaired, path: "build-state.md" },
    selected: p.selected, busy: p.busy, phases,
    config: { exists: p.config.exists, fields: CONFIG_FIELDS, values: p.config.values, errors: p.config.errors },
  };
}

/** Evidence line for build-state.md from the passing step results of a phase (short, no secrets). */
export function evidenceOf(phase: PhaseView): string {
  return phase.steps.filter((s) => s.result?.state === "ok").map((s) => s.result!.text).join("; ").slice(0, 300);
}
