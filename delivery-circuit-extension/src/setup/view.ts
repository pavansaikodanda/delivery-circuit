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
  secrets?: { name: string; set: boolean | null }[];
  env?: string;
  verify: boolean;
  links: DeepLink[];
  result?: StepResultView;
}

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

export function buildView(p: {
  login: string; admin: boolean; owner: string; repo: string;
  defs: PhaseDef[]; state: BuildState | undefined; buildStateExists: boolean;
  results: Record<string, StepResultView>; ticks: Record<string, boolean[]>;
  secretNames: Record<string, string[]> | undefined;
  selected: string; busy: string | null;
  config: { exists: boolean; values: Record<string, string>; errors: FormError[] };
}): SetupView {
  const phases = p.defs.map((d): PhaseView => {
    const row = p.state?.rows.find((r) => r.id === d.id);
    const steps = d.steps.map((s): StepView => {
      const names = p.secretNames?.[s.env ?? ""];
      return {
        id: s.id, kind: s.kind, title: s.title, detail: s.detail, hc: s.hc, action: s.action, env: s.env, verify: !!s.verify,
        checklist: s.checklist?.map((text, i) => ({ text, done: !!p.ticks[s.id]?.[i] })),
        secrets: s.secrets?.map((name) => ({ name, set: names ? names.includes(name) : null })),
        links: (s.urls ?? []).map((u) => ({ kind: linkKind(u.url), label: u.label, target: u.url })),
        result: p.results[s.id],
      };
    });
    const verifiable = steps.filter((s) => s.verify);
    return {
      id: d.id, name: d.name, summary: d.summary,
      status: row?.status || "TODO", kind: statusKind(row?.status ?? ""), verified: row?.verified ?? "", evidence: row?.evidence ?? "", notes: row?.notes ?? "",
      steps, ready: verifiable.length > 0 && verifiable.every((s) => s.result?.state === "ok"),
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
