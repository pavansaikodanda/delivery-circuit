// Project Setup wizard (admins only): phases B0-B13 of the bundled plugin's circuit-bootstrap skill (v3), with state
// in build-state.md in the repo (same table the skill writes). Command: deliveryCircuit.openSetup.
// v3 stores no credentials: there is no secret step; the wizard only reports (and offers to delete) leftover v2 secrets.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { CircuitServices } from "../core/contracts";
import { openLink } from "../core/util";
import { openPanel } from "../core/webview";
import { eolOf, parseBuildState, serializeBuildState, setToolVersions, updatePhase, type BuildState } from "./buildState";
import { readForm, validateForm, writeForm } from "./config";
import { PHASE_IDS, phases, type PhaseDef, type StepDef } from "./phases";
import { SetupSteps, type StepResult } from "./steps";
import { buildView, evidenceOf, type SetupView } from "./view";

const STORE_KEY = "deliveryCircuit.setup.v1";
interface Stored { results: Record<string, StepResult>; ticks: Record<string, boolean[]>; selected: string }

const DEFAULT_STATE = `# Build state

Updated by Claude after every step. Resume from here after an interruption.

| Phase | Status | Verified | Evidence | Notes |
|---|---|---|---|---|
`;

export function registerSetupUI(s: CircuitServices): void {
  const log = (m: string) => s.log(m);
  const steps = new SetupSteps(s, log);
  const stored = (): Stored => ({ results: {}, ticks: {}, selected: "B0", ...(s.ctx.workspaceState.get<Stored>(STORE_KEY) ?? {}) });
  let mem: Stored = stored();
  let busy: string | null = null;
  let formErrors: { key: string; message: string }[] = [];
  let panel: vscode.WebviewPanel | undefined;

  const save = () => s.ctx.workspaceState.update(STORE_KEY, mem);
  const bsPath = () => path.join(s.root, "build-state.md");
  const cfgPath = () => path.join(s.root, "build.config.yml");

  function readState(): { state: BuildState; exists: boolean; eol: string } {
    const f = bsPath();
    if (!fs.existsSync(f)) {
      const tpl = path.join(s.pluginRoot, "templates", "bootstrap", "build-state.md");
      const text = fs.existsSync(tpl) ? fs.readFileSync(tpl, "utf8") : DEFAULT_STATE;
      return { state: parseBuildState(text), exists: false, eol: "\n" };
    }
    const text = fs.readFileSync(f, "utf8");
    return { state: parseBuildState(text), exists: true, eol: eolOf(text) };
  }

  function writeState(mutate: (st: BuildState) => BuildState) {
    const { state, eol } = readState();
    fs.writeFileSync(bsPath(), serializeBuildState(mutate(state), eol), "utf8");
  }

  function defs(): PhaseDef[] { return phases(steps.phaseCtx()); }
  function findStep(stepId: string): StepDef | undefined { return defs().flatMap((p) => p.steps).find((x) => x.id === stepId); }

  function view(): SetupView {
    const id = s.identity.get();
    const { state, exists } = readState();
    const cfgExists = fs.existsSync(cfgPath());
    let values: Record<string, string> = {};
    try { values = cfgExists ? readForm(fs.readFileSync(cfgPath(), "utf8")) : {}; } catch (e: any) { formErrors = [{ key: "", message: `build.config.yml: ${e?.message ?? e}` }]; }
    return buildView({
      login: id?.login ?? "", admin: !!id?.isAdmin, owner: id?.owner ?? "", repo: id?.repo ?? "",
      defs: defs(), state, buildStateExists: exists, results: mem.results, ticks: mem.ticks,
      selected: mem.selected, busy, config: { exists: cfgExists, values, errors: formErrors },
    });
  }

  function post() { panel?.webview.postMessage({ type: "state", data: view() }); }

  async function withBusy(key: string, fn: () => Promise<void>) {
    if (busy) { vscode.window.showInformationMessage("Another setup step is still running."); return; }
    busy = key; post();
    try { await fn(); }
    catch (e: any) {
      const msg = e?.message ?? String(e);
      log(`setup: ${key} failed: ${msg}`);
      mem.results[key] = { state: "err", text: msg, at: new Date().toISOString() };
    } finally { busy = null; await save(); post(); }
  }

  function record(stepId: string, r: Omit<StepResult, "at"> | undefined) {
    if (!r) return;
    mem.results[stepId] = { ...r, at: new Date().toISOString() };
    log(`setup: ${stepId}: ${r.state} ${r.text}`);
  }

  async function verifyPhase(phaseId: string) {
    const p = defs().find((d) => d.id === phaseId);
    if (!p) return;
    await withBusy(phaseId, async () => {
      for (const st of p.steps.filter((x) => x.verify)) {
        busy = st.id; post();
        try { record(st.id, await steps.verify(st, mem.ticks[st.id] ?? [])); }
        catch (e: any) { record(st.id, { state: "err", text: e?.message ?? String(e) }); }
      }
    });
  }

  async function onMessage(msg: any) {
    const id = s.identity.get();
    if (!id?.isAdmin) { vscode.window.showWarningMessage("Project Setup is for organisation or repository admins."); return; }
    switch (msg?.type) {
      case "ready": post(); break;
      case "select":
        if (PHASE_IDS.includes(msg.phase)) { mem.selected = msg.phase; await save(); post(); }
        break;
      case "check": await verifyPhase(String(msg.phase)); break;
      case "verify": {
        const st = findStep(String(msg.step));
        if (!st) return;
        await withBusy(st.id, async () => {
          record(st.id, await steps.verify(st, mem.ticks[st.id] ?? []));
        });
        break;
      }
      case "run": {
        const st = findStep(String(msg.step));
        if (!st) return;
        await withBusy(st.id, async () => {
          if (st.id === "b0.tools") {
            const r = await steps.verify(st, []);
            record(st.id, r);
            if (r.lines?.length) {
              writeState((b) => setToolVersions(b, new Date().toISOString(), r.lines!.join(", ")));
              log("setup: tool versions recorded in build-state.md");
            }
            return;
          }
          if (st.kind === "terminal" || (st.kind === "human" && st.action)) { await steps.terminal(st); return; }
          const r = await steps.run(st);
          if (!r) return;
          record(st.id, r);
          if (st.verify && r.state !== "err") record(st.id, mergeRun(mem.results[st.id], await steps.verify(st, mem.ticks[st.id] ?? []).catch(() => undefined)));
        });
        break;
      }
      case "tick": {
        const st = findStep(String(msg.step));
        if (!st?.checklist) return;
        const t = (mem.ticks[st.id] ?? st.checklist.map(() => false)).slice();
        t[Number(msg.index)] = !!msg.value;
        mem.ticks[st.id] = t;
        await save(); post();
        break;
      }
      case "setStatus": {
        const phaseId = String(msg.phase);
        const status = String(msg.status ?? "").toUpperCase();
        if (!PHASE_IDS.includes(phaseId) || !/^(TODO|PARTIAL|DONE|BLOCKED|COMPLETE)$/.test(status)) return;
        const p = view().phases.find((x) => x.id === phaseId)!;
        if (status === "DONE" || status === "COMPLETE") {
          if (!p.ready) {
            const go = await vscode.window.showWarningMessage(`Not every check of ${phaseId} passed. Mark it ${status} anyway?`, { modal: true, detail: "The bootstrap marks a phase DONE only when its Verify steps pass." }, `Mark ${status}`);
            if (!go) return;
          }
        }
        const notes = typeof msg.notes === "string" ? msg.notes : undefined;
        const today = new Date().toISOString().slice(0, 10);
        writeState((b) => updatePhase(b, phaseId, {
          status,
          ...(status === "DONE" || status === "COMPLETE" ? { verified: today, evidence: evidenceOf(p) || p.evidence } : {}),
          ...(notes !== undefined ? { notes } : {}),
        }, defs().find((d) => d.id === phaseId)?.name));
        log(`setup: ${phaseId} marked ${status} in build-state.md by ${id.login}`);
        post();
        break;
      }
      case "saveConfig": {
        const values = msg.values && typeof msg.values === "object" ? msg.values as Record<string, string> : {};
        formErrors = validateForm(values);
        if (formErrors.length) { post(); return; }
        const f = cfgPath();
        const tpl = path.join(s.pluginRoot, "templates", "bootstrap", "build.config.yml");
        const base = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : fs.existsSync(tpl) ? fs.readFileSync(tpl, "utf8") : "";
        fs.writeFileSync(f, writeForm(base, values), "utf8");
        log(`setup: build.config.yml saved by ${id.login}`);
        vscode.window.showInformationMessage("build.config.yml saved.");
        const st = findStep("b0.config");
        if (st) record(st.id, await steps.verify(st, []));
        await save(); post();
        break;
      }
      case "openLink":
        if (msg.link) await openLink(s.root, msg.link).catch((e) => vscode.window.showErrorMessage(e?.message ?? String(e)));
        break;
    }
  }

  function open() {
    const id = s.identity.get();
    if (!id) { vscode.window.showWarningMessage("Sign in to GitHub first (Delivery Circuit: Connections)."); return; }
    if (!id.isAdmin) { vscode.window.showWarningMessage(`Project Setup is for admins of ${id.owner}/${id.repo}. Ask an admin to run it.`); return; }
    mem = stored();
    panel = openPanel(s.ctx, { module: "setup", page: "setup", title: "Project Setup" }, async (m) => { try { await onMessage(m); } catch (e: any) { vscode.window.showErrorMessage(e?.message ?? String(e)); } });
    panel.onDidDispose(() => { panel = undefined; });
    log(`setup: opened by ${id.login}`);
    if (mem.selected) void verifyPhase(mem.selected);
  }

  s.ctx.subscriptions.push(vscode.commands.registerCommand("deliveryCircuit.openSetup", open));
  s.ctx.subscriptions.push(s.identity.onDidChange(() => post()));
  // keep the page in sync when someone (or Claude) edits build-state.md by hand
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(s.root, "{build-state.md,build.config.yml}"));
  s.ctx.subscriptions.push(watcher, watcher.onDidChange(() => post()), watcher.onDidCreate(() => post()));
}

function mergeRun(runResult: StepResult | undefined, verify: Omit<StepResult, "at"> | undefined): Omit<StepResult, "at"> | undefined {
  if (!verify) return runResult;
  if (!runResult) return verify;
  // keep the run's own output lines (installer log, created items) under the verify verdict
  return { state: verify.state, text: `${runResult.text}. Check: ${verify.text}`, lines: [...(runResult.lines ?? []), ...(verify.lines ?? [])] };
}

