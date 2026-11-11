// Testing module: the ported SF AI Tester engine (./engine) as the circuit's TestingService, plus the Testing page.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { canAct, canView } from "../core/contracts";
import type { CircuitServices, ConnectionsService, DeepLink, RunRequest, RunSummary, SuiteSummary, TestingService, TestStatus } from "../core/contracts";
import { openLink, run as runProcess, type ModuleBase } from "../core/util";
import { openPanel } from "../core/webview";
import { setExec } from "./engine/exec";
import { TestingEngine, type EngineEvent, type EngineSettings } from "./engine/core";
import type { RunInfo } from "./engine/runs";
import { buildPageState, initialLive, applyEvent, type LiveRun, type PageContext, type PageView } from "./page";

const DEFAULT_MODELS = ["claude-haiku-4-5", "claude-sonnet-5-5"];

function readSettings(): EngineSettings {
  const c = vscode.workspace.getConfiguration("deliveryCircuit.testing");
  const models = (c.get<string[]>("models", DEFAULT_MODELS) ?? DEFAULT_MODELS).map((m) => String(m).trim()).filter(Boolean);
  return {
    headless: c.get<boolean>("headless", true) ?? true,
    models: models.length ? models : DEFAULT_MODELS,
    workers: Math.max(1, Math.min(4, Math.round(c.get<number>("workers", 2) ?? 2))),
    maxTurns: Math.max(5, Math.round(c.get<number>("maxTurns", 80) ?? 80)),
  };
}

/** Shared between createTesting and registerTestingUI (same module; other modules only see TestingService). */
interface TestingInternals {
  root: string;
  engine: TestingEngine;
  service: TestingService;
  changed: vscode.EventEmitter<void>;
  live: LiveRun;
  /** listeners for live run events (the open page) */
  listeners: Set<(e: EngineEvent) => void>;
  log: (m: string) => void;
}
let internals: TestingInternals | undefined;

const rel = (root: string, abs: string) => path.relative(root, abs).replace(/\\/g, "/");

function toSummary(root: string, r: RunInfo): RunSummary {
  return { runDir: rel(root, r.runDir), suite: r.suite, total: r.total, counts: r.counts, route: r.route, reportPath: rel(root, r.reportPath),
    ...(r.startedAt ? { startedAt: r.startedAt } : {}), ...(r.org ? { org: r.org } : {}) };
}

export function createTesting(base: ModuleBase, deps: { connections: ConnectionsService }): TestingService {
  // All engine processes go through core/util.ts run() (array args, no shell strings with user input).
  setExec((cmd, args, opts) => runProcess(cmd, args, opts));
  const changed = new vscode.EventEmitter<void>();
  base.ctx.subscriptions.push(changed);
  const engine = new TestingEngine({
    workspaceDir: base.root,
    toolRoot: base.ctx.extensionPath,
    settings: readSettings,
    sfAlias: (role) => deps.connections.sfAlias(role),
    log: (m) => base.log(`[testing] ${m}`),
  });
  const listeners = new Set<(e: EngineEvent) => void>();
  const st: TestingInternals = { root: base.root, engine, service: undefined as unknown as TestingService, changed, live: initialLive(), listeners, log: base.log };

  const service: TestingService = {
    async suites(): Promise<SuiteSummary[]> {
      return engine.suites().map((s) => ({ file: s.key, name: s.name, cases: s.cases.length, last: s.last, storyKey: s.storyKey, ...(s.error ? { error: s.error } : {}) }));
    },
    async run(req: RunRequest, onEvent) {
      let total: number | undefined;
      try {
        const n = req.caseIds?.length || engine.suite(req.suite).cases.length;
        total = n * (req.mode === "both" ? 2 : 1);
      } catch {
        total = undefined;
      }
      st.live = { ...initialLive(), running: true, suite: req.suite, mode: req.mode, orgRole: req.orgRole, startedAt: new Date().toISOString(), total };
      const emit = (e: EngineEvent) => {
        st.live = applyEvent(st.live, e);
        try {
          onEvent?.({ type: e.type, message: e.message, caseId: e.caseId, status: e.status as TestStatus | undefined });
        } catch {
          /* a caller's listener must not break the run */
        }
        for (const l of listeners) l(e);
        if (e.type === "caseEnd") changed.fire();
      };
      try {
        const info = await engine.run(req, emit);
        st.live = { ...st.live, running: false, lastRunDir: rel(base.root, info.runDir) };
        return toSummary(base.root, info);
      } catch (e) {
        const message = (e as Error).message;
        st.live = { ...st.live, running: false, error: message };
        for (const l of listeners) l({ type: "error", message });
        throw e;
      } finally {
        changed.fire();
      }
    },
    cancel() {
      engine.cancel();
    },
    async runs(limit = 20) {
      return engine.runs(limit).map((r) => toSummary(base.root, r));
    },
    onDidChange: changed.event,
  };
  st.service = service;
  internals = st;

  // Suites edited outside the page (editor, git pull, AI sessions) refresh the page and the persona views.
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base.root, "test-cases/*.sf-tests.{yaml,yml}"));
  base.ctx.subscriptions.push(watcher, watcher.onDidChange(() => changed.fire()), watcher.onDidCreate(() => changed.fire()), watcher.onDidDelete(() => changed.fire()));
  return service;
}

// ------------------------------------------------------------------ Testing page

export function registerTestingUI(s: CircuitServices): void {
  const st = internals;
  let panel: vscode.WebviewPanel | undefined;
  /** page-side choices the extension needs to rebuild state */
  const view: PageView = { selected: undefined, runId: undefined, notice: undefined, validation: undefined, generate: undefined, exportFiles: undefined };

  const persona = () => {
    const id = s.identity.get();
    const visible = !!id && canView(id, "tester");
    const runnable = !!id && canAct(id, "tester");
    let reason: string | undefined;
    if (!id) reason = "Sign in to GitHub on the Connections page to see your persona.";
    else if (!visible) reason = "The Testing page is for Testers and Architects.";
    else if (!runnable && id.personas.includes("architect") && !id.personas.includes("tester")) reason = "View only — you act as Architect";
    else if (!runnable) reason = "Switch your persona to Tester to run tests.";
    return { id, visible, runnable, reason };
  };

  const ctx = (): PageContext => {
    const p = persona();
    const salesforce: Partial<Record<"dev" | "qa", string>> = {};
    const aliases: Partial<Record<"dev" | "qa", string>> = {};
    for (const role of ["dev", "qa"] as const) {
      let alias = "";
      try {
        alias = s.connections.sfAlias(role);
      } catch {
        alias = "";
      }
      aliases[role] = alias || undefined;
      const url = alias ? instanceUrl(s.root, alias) : undefined;
      if (url) salesforce[role] = url;
    }
    return {
      root: s.root,
      login: p.id?.login,
      active: p.id?.active ?? null,
      canSee: p.visible,
      canRun: p.runnable,
      reason: p.reason,
      busy: st?.engine.busy,
      settings: readSettings(),
      aliases,
      salesforce,
      jiraUrl: (key) => {
        try {
          return s.project.jiraBrowseUrl(key);
        } catch {
          return undefined;
        }
      },
      imageUri: (abs) => (panel ? panel.webview.asWebviewUri(vscode.Uri.file(abs)).toString() : abs),
    };
  };

  const push = () => {
    if (!panel || !st) return;
    try {
      const data = buildPageState(st.engine, ctx(), view, st.live);
      void panel.webview.postMessage({ type: "state", data });
    } catch (e) {
      void panel.webview.postMessage({ type: "state", data: { error: (e as Error).message } });
    }
  };
  const notice = (kind: "ok" | "warn" | "err" | "info", text: string) => {
    view.notice = { kind, text };
    push();
  };

  if (st) {
    st.listeners.add((e) => {
      if (!panel) return;
      if (e.type === "log" || e.type === "needsUser") void panel.webview.postMessage({ type: "log", line: e.message ?? "", needsUser: e.type === "needsUser" });
      else push();
    });
    s.ctx.subscriptions.push(st.service.onDidChange(() => push()));
  }
  s.ctx.subscriptions.push(s.identity.onDidChange(() => push()));

  const guardRun = (): boolean => {
    const p = persona();
    if (p.runnable) return true;
    notice("warn", p.reason ?? "Not available for your persona.");
    return false;
  };

  const onMessage = async (m: any) => {
    if (!st) return;
    const p = persona();
    try {
      switch (m?.type) {
        case "ready":
        case "refresh":
          return push();
        case "openLink":
          return await openPageLink(s.root, m.link);
        case "dismiss":
          view.notice = undefined;
          return push();
      }
      // Everything below needs at least the right to see the page (Developers never get it).
      if (!p.visible) return notice("warn", p.reason ?? "Not available for your persona.");
      switch (m.type) {
        case "select":
          view.selected = typeof m.key === "string" ? m.key : undefined;
          view.runId = undefined;
          view.validation = undefined;
          return push();
        case "showRun":
          view.runId = typeof m.runId === "string" && /^[\w-]+$/.test(m.runId) ? m.runId : undefined;
          if (view.runId) {
            const r = st.engine.runs(200).find((x) => x.id === view.runId);
            const match = r && st.engine.suites().find((x) => x.name === r.suite);
            if (match) view.selected = match.key;
          }
          return push();
        case "validate": {
          const key = String(m.key ?? view.selected ?? "");
          const res = await st.engine.validate(key);
          view.validation = { key, ...res };
          return push();
        }
        case "run": {
          if (!guardRun()) return;
          const key = String(m.key ?? "");
          const mode = (["manual", "automation", "both"] as const).find((x) => x === m.mode) ?? "manual";
          const orgRole = m.orgRole === "dev" ? "dev" : "qa";
          const caseIds = Array.isArray(m.caseIds) ? m.caseIds.map(String) : undefined;
          view.selected = key;
          view.runId = undefined;
          view.notice = undefined;
          push();
          try {
            const sum = await st.service.run({ suite: key, caseIds, mode, orgRole });
            const kind = sum.route === "pass" ? "ok" : sum.route === "dev" ? "err" : "warn";
            notice(kind, `Run finished: ${sum.counts.passed}/${sum.total} passed, route ${sum.route}.`);
          } catch (e) {
            notice("err", (e as Error).message);
          }
          return;
        }
        case "cancel":
          if (!guardRun()) return;
          st.engine.cancel();
          return notice("info", "Cancelling — the current step finishes first.");
        case "generate": {
          if (!guardRun()) return;
          view.generate = { busy: true, log: [], result: undefined };
          push();
          const log = (line: string) => {
            view.generate?.log.push(line);
            st.log(`[testing] ${line}`);
            void panel?.webview.postMessage({ type: "genLog", line });
          };
          try {
            const res = await st.engine.generate(
              { requirement: String(m.requirement ?? ""), count: Number(m.count) || 5, orgRole: m.orgRole === "dev" ? "dev" : "qa", name: m.name ? String(m.name) : undefined, explore: !!m.explore },
              log,
            );
            view.generate = { busy: false, log: view.generate?.log ?? [], result: { key: res.key, count: res.cases.length, model: res.model, validation: res.validation } };
            view.selected = res.key;
            st.changed.fire();
          } catch (e) {
            view.generate = { busy: false, log: view.generate?.log ?? [], result: undefined, error: (e as Error).message };
          }
          return push();
        }
        case "export": {
          const formats = (Array.isArray(m.formats) ? m.formats : ["xlsx"]).filter((f: string) => f === "xlsx" || f === "pdf");
          const files = await st.engine.export(formats.length ? formats : ["xlsx"]);
          view.exportFiles = files.map((f) => rel(s.root, f));
          return notice("ok", `Exported ${view.exportFiles.join(", ")}`);
        }
        case "openSettings":
          return void vscode.commands.executeCommand("workbench.action.openSettings", "deliveryCircuit.testing");
      }
    } catch (e) {
      notice("err", (e as Error).message);
    }
  };

  s.ctx.subscriptions.push(
    vscode.commands.registerCommand("deliveryCircuit.openTesting", (arg?: { suite?: string } | string) => {
      const want = typeof arg === "string" ? arg : arg?.suite;
      if (want && st) {
        const all = st.engine.suites();
        const hit = all.find((x) => x.key === want || path.basename(x.key) === want || x.name === want || x.key === `test-cases/${want}`);
        if (hit) {
          view.selected = hit.key;
          view.runId = undefined;
        }
      }
      const opened = openPanel(s.ctx, { module: "testing", page: "testing", title: "Testing" }, (msg) => onMessage(msg));
      if (opened !== panel) {
        panel = opened;
        opened.onDidDispose(() => {
          if (panel === opened) panel = undefined;
        });
      }
      push();
    }),
  );
}

/** Instance URL saved by the last login for an alias (.sf-ai-tester/auth/<alias>.meta.json), for Salesforce links. */
function instanceUrl(root: string, alias: string): string | undefined {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(root, ".sf-ai-tester", "auth", `${alias.replace(/[^A-Za-z0-9_-]/g, "_")}.meta.json`), "utf8"));
    return typeof meta.instanceUrl === "string" && /^https:\/\//.test(meta.instanceUrl) ? meta.instanceUrl : undefined;
  } catch {
    return undefined;
  }
}

/** Page links: images and other non-text files open with VS Code's default viewer; the rest via core openLink. */
async function openPageLink(root: string, link: DeepLink): Promise<void> {
  if (!link || typeof link.target !== "string") return;
  if (link.kind === "file") {
    const abs = path.resolve(root, link.target);
    const r = path.relative(root, abs);
    if (r.startsWith("..") || path.isAbsolute(r)) throw new Error("File links must stay inside the workspace.");
    if (!/\.(ya?ml|json|md|ts|js|txt|log|html)$/i.test(abs)) {
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(abs));
      return;
    }
  }
  await openLink(root, link);
}
