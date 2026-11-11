// Views module: the sidebar ("deliveryCircuit.home"), the persona panel and the per-feature panel, plus the status
// bar item. Data comes only through the CircuitServices contracts; view models are built in model.ts (pure);
// webview messages are validated in messages.ts before anything runs.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { ActionRef, CircuitServices, Feature, Identity, Persona, SourceRef } from "../core/contracts";
import { gitRemote, openLink } from "../core/util";
import { openPanel, pageHtml } from "../core/webview";
import * as M from "./model";
import { sanitizeAction, sanitizeFeatureId, sanitizeLink, sanitizePersona, sanitizeSourceId } from "./messages";

type Surface = { kind: "home" } | { kind: "persona" } | { kind: "feature"; id: string };

const DEFAULT_TEAMS = { architect: "architects", developer: "developers", tester: "testers" };
const SETTINGS = ["deliveryCircuit.personaOverride", "deliveryCircuit.githubTeams", "deliveryCircuit.refreshSeconds"];

export interface ViewsHandle {
  /** True once VS Code has resolved the sidebar webview ("deliveryCircuit.home"). */
  homeResolved(): boolean;
}

export function registerViews(s: CircuitServices): ViewsHandle {
  const c = new ViewsController(s);
  s.ctx.subscriptions.push(c);
  return { homeResolved: () => c.homeResolved() };
}

class ViewsController implements vscode.Disposable, vscode.WebviewViewProvider {
  private home?: vscode.WebviewView;
  private persona?: { panel: vscode.WebviewPanel; requested: Persona | null };
  private readonly featurePanels = new Map<string, vscode.WebviewPanel>();
  private readonly status: vscode.StatusBarItem;
  private readonly subs: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private pending?: ReturnType<typeof setTimeout>;
  private updating = false;
  private updateAgain = false;
  private refreshing = false;
  private remote: { owner: string; repo: string } | null | undefined;

  constructor(private readonly s: CircuitServices) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = "deliveryCircuit.home.focus";
    this.status.text = "$(circle-outline) Circuit";
    this.status.tooltip = "Delivery Circuit";
    this.status.show();

    this.subs.push(
      vscode.window.registerWebviewViewProvider("deliveryCircuit.home", this, { webviewOptions: { retainContextWhenHidden: true } }),
      // openPersona(persona?, { featureId? }): the actions module's nav:feature passes a feature to open as well.
      vscode.commands.registerCommand("deliveryCircuit.openPersona", (arg?: unknown, opts?: unknown) => {
        const fid = opts && typeof opts === "object" ? sanitizeFeatureId((opts as { featureId?: unknown }).featureId) : undefined;
        if (fid) { this.openFeature(fid); return; }
        this.openPersona(arg);
      }),
      vscode.commands.registerCommand("deliveryCircuit.views.openFeature", (arg?: unknown) => {
        const id = sanitizeFeatureId(arg);
        if (id) this.openFeature(id);
      }),
      s.identity.onDidChange(() => { this.remote = undefined; this.schedule(); }),
      s.project.onDidChange(() => this.schedule()),
      s.connections.onDidChange(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("deliveryCircuit.refreshSeconds")) this.restartTimer();
        if (e.affectsConfiguration("deliveryCircuit")) this.schedule();
      }),
    );
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(s.root, "{.specify/*,.claude/hooks/circuit-guard.mjs}"), false, true, false);
    watcher.onDidCreate(() => this.schedule());
    watcher.onDidDelete(() => this.schedule());
    this.subs.push(watcher);
    this.restartTimer();
    this.schedule();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.status.dispose();
    this.subs.forEach((d) => d.dispose());
  }

  homeResolved(): boolean { return !!this.home; }

  // ---------- sidebar ----------
  resolveWebviewView(view: vscode.WebviewView): void {
    this.home = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.s.ctx.extensionUri, "media")] };
    view.webview.html = pageHtml(view.webview, this.s.ctx.extensionUri, { module: "views", page: "home", title: "Circuit" });
    view.webview.onDidReceiveMessage((m) => this.onMessage({ kind: "home" }, m));
    view.onDidChangeVisibility(() => { if (view.visible) void this.send({ kind: "home" }); });
    view.onDidDispose(() => { if (this.home === view) this.home = undefined; });
  }

  // ---------- panels ----------
  private openPersona(arg?: unknown): void {
    const requested = sanitizePersona(arg) ?? null;
    const panel = openPanel(this.s.ctx, { module: "views", page: "persona", title: "Circuit" },
      (m) => this.onMessage({ kind: "persona" }, m), "views/persona");
    if (this.persona?.panel === panel) {
      this.persona.requested = requested ?? this.persona.requested;
      void this.send({ kind: "persona" });
      return;
    }
    this.persona = { panel, requested };
    panel.onDidDispose(() => { if (this.persona?.panel === panel) this.persona = undefined; });
    panel.onDidChangeViewState(() => { if (panel.visible) void this.send({ kind: "persona" }); });
  }

  private openFeature(id: string): void {
    const panel = openPanel(this.s.ctx, { module: "views", page: "feature", title: `Feature ${id}` },
      (m) => this.onMessage({ kind: "feature", id }, m), `views/feature/${id}`);
    if (this.featurePanels.get(id) === panel) { void this.send({ kind: "feature", id }); return; }
    this.featurePanels.set(id, panel);
    panel.onDidDispose(() => { if (this.featurePanels.get(id) === panel) this.featurePanels.delete(id); });
    panel.onDidChangeViewState(() => { if (panel.visible) void this.send({ kind: "feature", id }); });
  }

  // ---------- refresh ----------
  private refreshMs(): number {
    const sec = Number(vscode.workspace.getConfiguration("deliveryCircuit").get("refreshSeconds", 60));
    return Math.max(15, Number.isFinite(sec) ? sec : 60) * 1000;
  }

  private restartTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { if (this.anyVisible()) void this.backgroundRefresh(); }, this.refreshMs());
  }

  private anyVisible(): boolean {
    return !!this.home?.visible || !!this.persona?.panel.visible || [...this.featurePanels.values()].some((p) => p.visible);
  }

  private async backgroundRefresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try { await this.s.project.refresh(); } catch (e) { this.s.log(`views: refresh failed: ${errText(e)}`); }
    finally { this.refreshing = false; }
    this.schedule();
  }

  private async refreshAll(): Promise<void> {
    this.remote = undefined;
    try { await this.s.identity.refresh(); } catch (e) { this.s.log(`views: identity refresh failed: ${errText(e)}`); }
    await this.backgroundRefresh();
  }

  private schedule(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => { this.pending = undefined; void this.updateNow(); }, 250);
  }

  private async updateNow(): Promise<void> {
    if (this.updating) { this.updateAgain = true; return; }
    this.updating = true;
    try {
      const home = await this.loadHome();
      this.applyStatus(home);
      if (this.home?.visible) void this.home.webview.postMessage({ type: "state", data: home });
      if (this.persona?.panel.visible) await this.send({ kind: "persona" });
      for (const [id, p] of this.featurePanels) if (p.visible) await this.send({ kind: "feature", id });
    } catch (e) {
      this.s.log(`views: update failed: ${errText(e)}`);
    } finally {
      this.updating = false;
      if (this.updateAgain) { this.updateAgain = false; this.schedule(); }
    }
  }

  private applyStatus(home: M.HomeState): void {
    const st = M.statusText(this.s.identity.get(), home.waitingTotal);
    this.status.text = st.text;
    this.status.tooltip = st.tooltip;
  }

  private async send(surface: Surface): Promise<void> {
    try {
      if (surface.kind === "home") {
        if (!this.home) return;
        const data = await this.loadHome();
        this.applyStatus(data);
        await this.home.webview.postMessage({ type: "state", data });
      } else if (surface.kind === "persona") {
        if (!this.persona) return;
        const data = await this.loadPersona(this.persona.requested);
        if (data.selected) this.persona.panel.title = `Circuit · ${data.selectedLabel}`;
        await this.persona.panel.webview.postMessage({ type: "state", data });
      } else {
        const panel = this.featurePanels.get(surface.id);
        if (!panel) return;
        const data = await this.loadFeature(surface.id);
        if (data.feature) panel.title = `Feature ${data.feature.slug}`;
        await panel.webview.postMessage({ type: "state", data });
      }
    } catch (e) {
      this.s.log(`views: render ${surface.kind} failed: ${errText(e)}`);
    }
  }

  // ---------- data ----------
  private async safe<T>(what: string, fn: () => Promise<T>, fallback: T, errs: string[]): Promise<T> {
    try { return await fn(); } catch (e) {
      const msg = errText(e);
      this.s.log(`views: ${what}: ${msg}`);
      errs.push(`${what}: ${msg}`);
      return fallback;
    }
  }

  private allowed = (a: ActionRef): boolean => { try { return this.s.actions.allowed(a); } catch { return false; } };
  private jiraUrl = (key: string): string | undefined => { try { return this.s.project.jiraBrowseUrl(key); } catch { return undefined; } };

  private async getRemote(): Promise<{ owner: string; repo: string } | null> {
    if (this.remote === undefined) {
      try { this.remote = (await gitRemote(this.s.root)) ?? null; } catch { this.remote = null; }
    }
    return this.remote;
  }

  private circuitInstalled(): boolean {
    return fs.existsSync(path.join(this.s.root, ".specify")) && fs.existsSync(path.join(this.s.root, ".claude", "hooks", "circuit-guard.mjs"));
  }

  private teams(): Record<string, string> {
    const t = vscode.workspace.getConfiguration("deliveryCircuit").get<Record<string, string>>("githubTeams");
    return t && typeof t === "object" ? { ...DEFAULT_TEAMS, ...t } : { ...DEFAULT_TEAMS };
  }

  private async loadHome(): Promise<M.HomeState> {
    const errs: string[] = [];
    const id = this.s.identity.get();
    const remote = await this.getRemote();
    const connections = await this.safe("connections", () => this.s.connections.list(), [], errs);
    const githubConnected = connections.some((c) => c.id === "github" && (c.state === "connected" || c.state === "expiring"));
    const active = id?.active;
    const queue = id && active ? await this.safe("queue", () => this.s.project.queue(id, active), [], errs) : [];
    return M.buildHome({
      hasRemote: !!remote || !!id, identity: id, githubConnected, circuitInstalled: this.circuitInstalled(),
      connections, queue, allowed: this.allowed, teams: this.teams(), now: Date.now(), error: errs.join(" · ") || undefined,
    });
  }

  private async loadPersona(requested: Persona | null): Promise<M.PersonaState> {
    const errs: string[] = [];
    const id = this.s.identity.get();
    const { selected } = M.personaTabs(id, requested);
    let queue: Awaited<ReturnType<CircuitServices["project"]["queue"]>> = [];
    let features: Feature[] = [];
    let prs: Awaited<ReturnType<CircuitServices["project"]["prs"]>> = [];
    if (id && selected) {
      [queue, features, prs] = await Promise.all([
        this.safe("queue", () => this.s.project.queue(id, selected), [], errs),
        this.safe("features", () => this.s.project.features(), [], errs),
        this.safe("pull requests", () => this.s.project.prs(), [], errs),
      ]);
    }
    return M.buildPersona({
      identity: id, requested: selected, queue, features, prs, allowed: this.allowed, jiraUrl: this.jiraUrl,
      now: Date.now(), error: errs.join(" · ") || undefined,
    });
  }

  private async findFeature(fid: string, errs: string[]): Promise<Feature | undefined> {
    const direct = await this.safe("feature", () => this.s.project.feature(fid), undefined, errs);
    if (direct) return direct;
    const all = await this.safe("features", () => this.s.project.features(), [], errs);
    return all.find((f) => f.id === fid || f.slug === fid);
  }

  private async loadFeature(fid: string): Promise<M.FeatureState> {
    const errs: string[] = [];
    const id = this.s.identity.get();
    const feature = await this.findFeature(fid, errs);
    const [prs, sources] = await Promise.all([
      this.safe("pull requests", () => this.s.project.prs(), [], errs),
      id?.personas.includes("architect") ? this.safe("sources", () => this.s.project.sources(), [], errs) : Promise.resolve([] as SourceRef[]),
    ]);
    const existingFiles: string[] = [];
    if (feature) {
      const dir = feature.dir.replace(/\\/g, "/").replace(/\/$/, "");
      for (const n of ["spec.md", "plan.md", "data-model.md", "jira-map.json"]) {
        const rel = `${dir}/${n}`;
        if (fs.existsSync(path.join(this.s.root, rel))) existingFiles.push(rel);
      }
    }
    const remote = await this.getRemote();
    return M.buildFeature({
      feature, featureId: fid, identity: id, sources, prs, owner: id?.owner ?? remote?.owner ?? "", repo: id?.repo ?? remote?.repo ?? "",
      jiraUrl: this.jiraUrl, existingFiles, allowed: this.allowed, now: Date.now(), error: errs.join(" · ") || undefined,
    });
  }

  // ---------- messages ----------
  private async onMessage(surface: Surface, msg: unknown): Promise<void> {
    const m = (msg && typeof msg === "object" ? msg : {}) as Record<string, unknown>;
    try {
      switch (m.type) {
        case "ready": await this.send(surface); return;
        case "refresh": await this.refreshAll(); return;
        case "openLink": {
          const link = sanitizeLink(m.link);
          if (!link) { void vscode.window.showWarningMessage("Delivery Circuit: that link can't be opened."); return; }
          await openLink(this.s.root, link);
          return;
        }
        case "action": {
          const a = sanitizeAction(m.action);
          if (a) await this.runAction(a);
          return;
        }
        case "nav": if (typeof m.target === "string") await this.nav(m.target); return;
        case "connectGithub":
          await this.s.connections.connect("github");
          this.remote = undefined;
          await this.s.identity.refresh();
          this.schedule();
          return;
        case "switchPersona": await this.switchPersona(sanitizePersona(m.persona)); return;
        case "openSettings": {
          const key = typeof m.setting === "string" && SETTINGS.includes(m.setting) ? m.setting : "deliveryCircuit";
          await vscode.commands.executeCommand("workbench.action.openSettings", key);
          return;
        }
        case "selectTab": {
          const p = sanitizePersona(m.persona);
          if (p && this.persona) { this.persona.requested = p; await this.send({ kind: "persona" }); }
          return;
        }
        case "openFeature": { const id = sanitizeFeatureId(m.id); if (id) this.openFeature(id); return; }
        case "openSource": { const id = sanitizeSourceId(m.id); if (id) await this.openSource(id); return; }
        default: return;
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Delivery Circuit: ${errText(e)}`);
    }
  }

  private async runAction(input: ActionRef): Promise<void> {
    let a = input;
    if (M.needsArg(a)) {
      const v = await this.pickArg(a);
      if (v === undefined) return;
      a = M.withArg(a, v);
    }
    if (!this.allowed(a)) {
      const reason = M.disabledReason(this.s.identity.get(), a, false);
      void vscode.window.showWarningMessage(`${a.label}: ${reason}`);
      return;
    }
    await this.s.actions.run(a);
    void this.backgroundRefresh();
  }

  private async loadSources(): Promise<{ sources: SourceRef[]; indexed: Set<string> }> {
    const errs: string[] = [];
    const [indexed, recent] = await Promise.all([
      this.safe("sources", () => this.s.project.sources(), [], errs),
      this.safe("Fireflies", () => this.s.project.firefliesRecent(15), [], errs),
    ]);
    return { sources: [...indexed, ...recent], indexed: new Set(indexed.map((x) => x.id)) };
  }

  private async pickArg(a: ActionRef): Promise<string | number | undefined> {
    const kind = a.args?.argKind;
    const what = kind === "feature" ? "feature" : kind === "pr" ? "pull request" : "source";
    const errs: string[] = [];
    let indexed = new Set<string>();
    const data = { features: [] as Feature[], prs: [] as Awaited<ReturnType<CircuitServices["project"]["prs"]>>, sources: [] as SourceRef[] };
    if (kind === "feature") data.features = await this.safe("features", () => this.s.project.features(), [], errs);
    if (kind === "pr") data.prs = await this.safe("pull requests", () => this.s.project.prs(), [], errs);
    if (kind === "source") { const r = await this.loadSources(); data.sources = r.sources; indexed = r.indexed; }
    type Item = vscode.QuickPickItem & { value?: string | number; upload?: boolean };
    const items: Item[] = M.argPickItems(a, data).map((p) => ({ label: p.label, description: p.description, detail: p.detail, value: p.value }));
    if (kind === "source") items.push({ label: "$(cloud-upload) Upload a transcript file…", detail: "Stored encrypted on this machine, never in git", upload: true });
    if (!items.length) {
      void vscode.window.showInformationMessage(errs.length ? `Delivery Circuit: couldn't load ${what}s (${errs[0]}).`
        : kind === "pr" ? "Delivery Circuit: no open pull requests." : "Delivery Circuit: no features yet. Start with Intake.");
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: `${a.label} (${M.PERSONA_LABEL[a.persona]})`, placeHolder: `Choose a ${what}`, matchOnDescription: true, matchOnDetail: true,
    });
    if (!pick) return undefined;
    if (pick.upload) {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false, openLabel: "Use transcript", filters: { Transcripts: ["txt", "md", "vtt", "srt", "json", "docx"] },
      });
      if (!uris?.[0]) return undefined;
      const ref = await this.s.project.addUpload(uris[0]);
      return ref.id;
    }
    if (kind === "source" && typeof pick.value === "string" && pick.value.startsWith("fireflies:") && !indexed.has(pick.value)) {
      const ref = await this.s.project.indexFireflies(pick.value.slice("fireflies:".length));
      return ref.id;
    }
    return pick.value;
  }

  private async nav(target: string): Promise<void> {
    const id = this.s.identity.get();
    if (!M.navAllowed(id, target)) return;
    if (target.startsWith("persona:")) { this.openPersona(target.slice(8)); return; }
    const cmd = { testing: "deliveryCircuit.openTesting", connections: "deliveryCircuit.openConnections", setup: "deliveryCircuit.openSetup" }[target];
    if (cmd) await this.exec(cmd, target === "setup" ? "Project setup" : target === "testing" ? "Testing" : "Connections");
  }

  private async exec(cmd: string, label: string): Promise<boolean> {
    try { await vscode.commands.executeCommand(cmd); return true; } catch (e) {
      if (/not found/i.test(errText(e))) { void vscode.window.showInformationMessage(`Delivery Circuit: ${label} is not available in this build.`); return false; }
      throw e;
    }
  }

  private async switchPersona(to?: Persona): Promise<void> {
    // The header chip names the persona: switch straight to it when the identity holds it (never to one it lacks).
    if (to) {
      const id = this.s.identity.get();
      if (id && id.personas.includes(to)) { if (id.active !== to) await this.s.identity.setActive(to); return; }
    }
    try { await vscode.commands.executeCommand("deliveryCircuit.switchPersona"); return; } catch (e) {
      if (!/not found/i.test(errText(e))) throw e;
    }
    // Fallback while no other module registers the command: pick among the identity's own personas.
    const id = this.s.identity.get();
    if (!id || !id.personas.length) { void vscode.window.showInformationMessage("Delivery Circuit: you have no persona to switch to."); return; }
    const pick = await vscode.window.showQuickPick(
      id.personas.map((p) => ({ label: M.PERSONA_LABEL[p], description: p === id.active ? "current" : undefined, p })),
      { title: "Act as", placeHolder: "Choose the persona you act as" });
    if (pick && pick.p !== id.active) await this.s.identity.setActive(pick.p);
  }

  private async openSource(sourceId: string): Promise<void> {
    const id: Identity | null = this.s.identity.get();
    if (!id?.personas.includes("architect")) {
      void vscode.window.showWarningMessage("Delivery Circuit: transcripts are available to the Architect only.");
      return;
    }
    const text = await this.s.project.transcript(sourceId);
    const doc = await vscode.workspace.openTextDocument({ content: text, language: "plaintext" });
    await vscode.window.showTextDocument(doc, { preview: true });
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
