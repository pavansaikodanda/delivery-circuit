// Builds the Testing page state from the engine. No VS Code here (URIs come in through PageContext), so it is
// unit-tested and the preview fixtures follow the same shape.
import * as path from "path";
import type { DeepLink, Persona } from "../core/contracts";
import type { EngineEvent, EngineSettings, TestingEngine, ValidationResult } from "./engine/core";
import type { CaseRow, SuiteRecord } from "./engine/catalog";
import type { ModeStatus } from "./engine/status";
import { evidenceFiles, isImage, type RunInfo } from "./engine/runs";
import type { Route } from "./engine/verdict";

export interface PageContext {
  root: string;
  login?: string;
  active: Persona | null;
  canSee: boolean;
  canRun: boolean;
  reason?: string;
  busy?: string;
  settings: EngineSettings;
  aliases: Partial<Record<"dev" | "qa", string>>;
  /** instance URL per org role, when a login has been saved */
  salesforce: Partial<Record<"dev" | "qa", string>>;
  jiraUrl: (key: string) => string | undefined;
  /** webview URI for a local image */
  imageUri: (abs: string) => string;
}

export interface PageView {
  selected?: string;
  runId?: string;
  notice?: { kind: "ok" | "warn" | "err" | "info"; text: string };
  validation?: ValidationResult & { key: string };
  generate?: { busy: boolean; log: string[]; result?: { key: string; count: number; model: string; validation: ValidationResult }; error?: string };
  exportFiles?: string[];
}

export interface LiveRun {
  running: boolean;
  suite?: string;
  mode?: string;
  orgRole?: string;
  startedAt?: string;
  total?: number;
  done: number;
  current?: { caseId: string; mode?: string; model?: string };
  needsUser?: string;
  error?: string;
  /** set when the user asked to cancel this run */
  cancelled?: boolean;
  lastRunDir?: string;
  results: { caseId: string; mode?: string; status: string; summary?: string }[];
  log: string[];
}

const LOG_MAX = 400;

export function initialLive(): LiveRun {
  return { running: false, done: 0, results: [], log: [] };
}

/** Folds one engine event into the live run (pure). */
export function applyEvent(live: LiveRun, e: EngineEvent): LiveRun {
  const next: LiveRun = { ...live };
  switch (e.type) {
    case "log":
      next.log = [...live.log, e.message ?? ""].slice(-LOG_MAX);
      break;
    case "needsUser":
      next.needsUser = e.message;
      next.log = [...live.log, e.message ?? ""].slice(-LOG_MAX);
      break;
    case "caseStart":
      next.needsUser = undefined;
      next.current = { caseId: e.caseId ?? "", mode: e.mode, model: e.model };
      break;
    case "escalate":
      next.current = { caseId: e.caseId ?? "", mode: e.mode, model: e.model };
      break;
    case "caseEnd":
      next.done = live.done + 1;
      next.current = undefined;
      next.results = [...live.results, { caseId: e.caseId ?? "", mode: e.mode, status: e.status ?? "error", summary: e.message }];
      if (e.runDir) next.lastRunDir = e.runDir;
      break;
    case "runEnd":
      next.current = undefined;
      next.needsUser = undefined;
      if (e.runDir) next.lastRunDir = e.runDir;
      break;
    case "error":
      next.error = e.message;
      break;
  }
  return next;
}

const rel = (root: string, abs: string) => path.relative(root, abs).replace(/\\/g, "/");
const iso = (t?: number) => (t ? new Date(t).toISOString() : undefined);

function modeView(s?: ModeStatus & { stale: boolean }) {
  if (!s) return undefined;
  return { status: s.status, summary: s.summary, at: iso(s.at), model: s.model, defects: s.defects, stale: s.stale, specFile: s.specFile };
}

function jiraLink(ctx: PageContext, key?: string): DeepLink[] {
  if (!key) return [];
  const url = ctx.jiraUrl(key);
  return url && /^https:\/\//.test(url) ? [{ kind: "jira", label: key, target: url }] : [];
}

function suiteLinks(ctx: PageContext, s: SuiteRecord): DeepLink[] {
  return [{ kind: "file", label: "Suite file", target: s.key }, ...jiraLink(ctx, s.storyKey)];
}

type ModeView = NonNullable<ReturnType<typeof modeView>>;

/** The one status a case row shows: the mode that ran last (manual or automation); the other goes in the expanded row. */
export function latestOf(manual?: ModeView, automation?: ModeView): (ModeView & { mode: "manual" | "automation" }) | undefined {
  const t = (m?: ModeView) => (m?.at ? Date.parse(m.at) || 0 : 0);
  if (!manual && !automation) return undefined;
  if (manual && (!automation || t(manual) >= t(automation))) return { ...manual, mode: "manual" };
  return { ...(automation as ModeView), mode: "automation" };
}

function caseView(ctx: PageContext, s: SuiteRecord, c: CaseRow) {
  const links: DeepLink[] = [...jiraLink(ctx, c.jiraKey)];
  const spec = c.automation?.specFile;
  if (spec) links.push({ kind: "file", label: "Spec", target: spec });
  const manual = modeView(c.manual);
  const automation = modeView(c.automation);
  return {
    id: c.id,
    title: c.title,
    section: c.section,
    target: c.target,
    steps: c.steps,
    jiraKey: c.jiraKey,
    manual,
    automation,
    latest: latestOf(manual, automation),
    links,
  };
}

function runLinks(ctx: PageContext, r: RunInfo, role?: "dev" | "qa"): DeepLink[] {
  const links: DeepLink[] = [
    { kind: "report", label: "Report", target: rel(ctx.root, r.reportPath) },
    { kind: "file", label: "results.json", target: rel(ctx.root, path.join(r.runDir, "results.json")) },
  ];
  const sf = role ? ctx.salesforce[role] : undefined;
  if (sf) links.push({ kind: "salesforce", label: "Org", target: `${sf}/lightning/page/home` });
  return links;
}

function roleOf(ctx: PageContext, org?: string): "dev" | "qa" | undefined {
  if (!org) return undefined;
  return (["qa", "dev"] as const).find((r) => ctx.aliases[r] === org);
}

export function runView(ctx: PageContext, r: RunInfo, s?: SuiteRecord) {
  const role = roleOf(ctx, r.org);
  const caseJira = new Map((s?.cases ?? []).map((c) => [c.id, c.jiraKey] as const));
  return {
    id: r.id,
    suite: r.suite,
    startedAt: r.startedAt,
    org: r.org,
    total: r.total,
    counts: r.counts,
    route: r.route,
    links: runLinks(ctx, r, role),
    analysis: r.analysis ? { headline: r.analysis.headline, summary: r.analysis.summary, groups: r.analysis.groups } : undefined,
    cases: r.results.map((c) => ({
      id: c.id,
      title: c.title,
      mode: c.mode,
      status: c.status,
      summary: c.summary,
      model: c.model,
      durationSec: Math.round((c.durationMs ?? 0) / 1000),
      costUsd: Math.round((c.costUsd ?? 0) * 100) / 100,
      steps: (c.steps ?? []).map((st) => ({ step: st.step, status: st.status, actual: st.actual })),
      attempts: (c.attempts ?? []).map((a) => ({ model: a.model, status: a.status })),
      defects: c.defects ?? [],
      evidence: evidenceFiles(r, c).map((f) => ({
        name: path.basename(f),
        uri: isImage(f) ? ctx.imageUri(f) : undefined,
        link: { kind: "file", label: path.basename(f), target: rel(ctx.root, f) } as DeepLink,
      })),
      links: jiraLink(ctx, caseJira.get(c.id)),
    })),
  };
}

export const ROUTE_TEXT: Record<Route, string> = {
  pass: "Pass: every case passed",
  dev: "Developer: a case failed (defect)",
  qa: "QA: a case was blocked (suite, data or permission)",
  infra: "Infra: nothing ran or the agent errored",
};

export type Tone = "ok" | "warn" | "err" | "info";

/** The run panel (the one box on the Testing page): heading, tone, progress and one dot per case. */
export interface RunPanel {
  state: "running" | "finished" | "cancelled" | "stopped";
  tone: Tone;
  title: string;
  done: number;
  total?: number;
  counts: { passed: number; failed: number; blocked: number; error: number };
  cases: { caseId: string; mode?: string; status: string }[];
  report?: DeepLink;
}

const toneOfCounts = (c: RunPanel["counts"]): Tone => (c.failed || c.error ? "err" : c.blocked ? "warn" : "ok");

export function runPanel(live: LiveRun): RunPanel | undefined {
  if (!live.running && !live.log.length && !live.results.length && !live.error) return undefined;
  const counts = { passed: 0, failed: 0, blocked: 0, error: 0 };
  for (const r of live.results) {
    const k = r.status in counts ? (r.status as keyof typeof counts) : "error";
    counts[k]++;
  }
  const cases: RunPanel["cases"] = live.results.map((r) => ({ caseId: r.caseId, mode: r.mode, status: r.status }));
  if (live.running && live.current) cases.push({ caseId: live.current.caseId, mode: live.current.mode, status: "running" });
  const of = live.total ? ` of ${live.total}` : "";
  const report: DeepLink | undefined = !live.running && live.lastRunDir && !path.isAbsolute(live.lastRunDir)
    ? { kind: "report", label: "Report", target: `${live.lastRunDir.split("\\").join("/")}/report.html` } : undefined;
  const base = { done: live.done, total: live.total, counts, cases, report };
  if (live.running) {
    const cur = live.current ? ` · ${live.current.caseId}${live.current.mode ? " " + live.current.mode : ""}` : "";
    return { ...base, state: "running", tone: "info", title: live.cancelled ? `Cancelling · ${live.done}${of} done` : `Running · ${live.done}${of}${cur}` };
  }
  if (live.cancelled) return { ...base, state: "cancelled", tone: "warn", title: `Cancelled · ${live.done}${of} done` };
  if (live.error) return { ...base, state: "stopped", tone: "err", title: `Stopped · ${live.error}` };
  const n = live.results.length;
  return { ...base, state: "finished", tone: n ? toneOfCounts(counts) : "info", title: n ? `Finished · ${counts.passed} of ${n} passed` : "Last run log" };
}

/** Toast text for a finished run ("Smoke - Account finished: 2/2 passed · route pass"). */
export function finishToast(sum: { suite: string; total: number; counts: { passed?: number }; route: Route }): { kind: Tone; text: string } {
  const kind: Tone = sum.route === "pass" ? "ok" : sum.route === "dev" ? "err" : "warn";
  return { kind, text: `${sum.suite} finished: ${sum.counts.passed ?? 0}/${sum.total} passed · route ${sum.route}` };
}

/** Whole page state. */
export function buildPageState(engine: Pick<TestingEngine, "suites" | "runs">, ctx: PageContext, view: PageView, live: LiveRun) {
  const persona = { login: ctx.login, active: ctx.active, canSee: ctx.canSee, canRun: ctx.canRun, reason: ctx.reason };
  if (!ctx.canSee) return { persona, denied: ctx.reason ?? "Not available for your persona." };
  const suites = engine.suites();
  const runs = engine.runs(30);
  const selected = suites.find((x) => x.key === view.selected) ?? suites[0];
  const runFor = view.runId ? runs.find((r) => r.id === view.runId) : selected ? runs.find((r) => r.suite === selected.name) : undefined;
  return {
    persona,
    busy: ctx.busy,
    settings: ctx.settings,
    orgs: (["qa", "dev"] as const).map((role) => ({
      role,
      alias: ctx.aliases[role],
      links: ctx.salesforce[role] ? [{ kind: "salesforce", label: "Org", target: `${ctx.salesforce[role]}/lightning/page/home` } as DeepLink] : [],
    })),
    suites: suites.map((s) => ({
      key: s.key,
      name: s.name,
      cases: s.cases.length,
      last: s.last,
      notRun: s.notRun,
      storyKey: s.storyKey,
      error: s.error,
      links: suiteLinks(ctx, s),
    })),
    selected: selected?.key,
    detail: selected
      ? {
          key: selected.key,
          name: selected.name,
          context: selected.context,
          error: selected.error,
          storyKey: selected.storyKey,
          links: suiteLinks(ctx, selected),
          cases: selected.cases.map((c) => caseView(ctx, selected, c)),
        }
      : undefined,
    live,
    run: runPanel(live),
    result: runFor ? { ...runView(ctx, runFor, suites.find((x) => x.name === runFor.suite)), routeText: ROUTE_TEXT[runFor.route] } : undefined,
    runs: runs.map((r) => ({ id: r.id, suite: r.suite, startedAt: r.startedAt, org: r.org, total: r.total, counts: r.counts, route: r.route, links: runLinks(ctx, r, roleOf(ctx, r.org)) })),
    generate: view.generate,
    validation: view.validation,
    exportFiles: view.exportFiles,
    notice: view.notice,
  };
}
