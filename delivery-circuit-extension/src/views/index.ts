// Views: the one sidebar view ("deliveryCircuit.home": Work / Connections / Missing tabs) and the story panel, plus
// the four commands (Refresh, Switch Role, New Design from Transcript, Open Story). Data comes through the
// CircuitServices contracts; view models are built in model.ts; webview messages are checked in messages.ts.
import * as vscode from "vscode";
import {
  roleChoices, ROLE_LABEL, type CircuitServices, type Role, type RunSpec, type SourceRef, type StoryDetail, type WorkSnapshot,
} from "../core/contracts";
import { openPanel, pageHtml } from "../core/webview";
import { UPLOAD_EXTENSIONS } from "../project/sources";
import { buildHome, buildStory, type HomeState } from "./model";
import { isStoryKey, parseHomeMessage, parseStoryMessage } from "./messages";

export interface ViewsHandle {
  homeResolved(): boolean;
  /** The sidebar model (used by the integration test). */
  homeState(): Promise<HomeState>;
}

export function registerViews(s: CircuitServices): ViewsHandle {
  const c = new ViewsController(s);
  s.ctx.subscriptions.push(c);
  return { homeResolved: () => c.homeResolved(), homeState: () => c.homeState() };
}

const errText = (e: unknown) => String((e as any)?.message ?? e);

class ViewsController implements vscode.Disposable, vscode.WebviewViewProvider {
  private home?: vscode.WebviewView;
  private story?: { panel: vscode.WebviewPanel; key: string; detail?: StoryDetail };
  private readonly subs: vscode.Disposable[] = [];
  private work = new Map<Role, WorkSnapshot>();
  /** run specs of the rows last sent to the sidebar, by row id */
  private runs = new Map<string, RunSpec>();
  private pending?: ReturnType<typeof setTimeout>;
  private loading?: Promise<void>;
  private loadAgain = false;

  constructor(private readonly s: CircuitServices) {
    const cmd = (id: string, fn: (...a: any[]) => unknown) => vscode.commands.registerCommand(id, async (...a: any[]) => {
      try { await fn(...a); } catch (e) { void vscode.window.showErrorMessage(errText(e)); }
    });
    this.subs.push(
      vscode.window.registerWebviewViewProvider("deliveryCircuit.home", this, { webviewOptions: { retainContextWhenHidden: true } }),
      cmd("deliveryCircuit.refresh", () => this.refreshAll()),
      cmd("deliveryCircuit.switchRole", (r?: unknown) => this.switchRole(r)),
      cmd("deliveryCircuit.newDesign", () => this.intake()),
      cmd("deliveryCircuit.openStory", (k?: unknown) => this.openStory(k)),
      s.identity.onDidChange(() => this.schedule()),
      s.project.onDidChange(() => this.schedule()),
      s.connections.onDidChange(() => this.schedule()),
    );
    this.schedule();
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending);
    this.subs.forEach((d) => d.dispose());
  }

  homeResolved(): boolean { return !!this.home; }
  async homeState(): Promise<HomeState> { await this.loadWork(); return this.buildHome(); }

  // ---------- sidebar ----------
  resolveWebviewView(view: vscode.WebviewView): void {
    this.home = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.s.ctx.extensionUri, "media")] };
    view.webview.html = pageHtml(view.webview, this.s.ctx.extensionUri, { module: "views", page: "home", title: "Circuit" });
    view.webview.onDidReceiveMessage((m) => this.onHome(m));
    view.onDidChangeVisibility(() => { if (view.visible) this.schedule(); });
    view.onDidDispose(() => { if (this.home === view) this.home = undefined; });
  }

  private buildHome(): HomeState {
    const id = this.s.identity.get();
    const role = id?.active ?? null;
    const state = buildHome(id, this.s.connections.cached(), role ? this.work.get(role) : undefined);
    const work = role ? this.work.get(role) : undefined;
    this.runs = new Map([...(work?.next ?? []), ...(work?.missing ?? [])].map((r) => [r.id, r.run]));
    return state;
  }

  private post(): void {
    const state = this.buildHome();
    if (this.home) {
      this.home.badge = state.missingCount ? { value: state.missingCount, tooltip: `${state.missingCount} missing` } : undefined;
      void this.home.webview.postMessage({ type: "state", data: state });
    }
  }

  /** Posts what is known at once, then reads Jira and GitHub for the active role and posts again. */
  private schedule(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => { this.pending = undefined; this.post(); void this.loadWork().then(() => this.post()); }, 150);
  }

  /** Reads the work of the active role; a call while a read runs makes that read go round once more and waits for it. */
  private loadWork(): Promise<void> {
    if (this.loading) { this.loadAgain = true; return this.loading; }
    this.loading = (async () => {
      try {
        do {
          this.loadAgain = false;
          const id = this.s.identity.get();
          if (!id?.active || !id.owner) return;
          const conns = await this.s.connections.list();
          this.work.set(id.active, await this.s.project.work(id.active, id.login, conns));
        } while (this.loadAgain);
      } catch (e) {
        this.s.log(`views: reading work failed: ${errText(e)}`);
      }
      if (this.story) void this.sendStory();
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async refreshAll(): Promise<void> {
    await this.s.identity.refresh();
    await Promise.all([this.s.project.refresh(), this.s.connections.list()]);
    this.schedule();
  }

  private async onHome(raw: unknown): Promise<void> {
    const m = parseHomeMessage(raw);
    if (!m) return;
    try {
      switch (m.type) {
        case "ready": this.post(); void this.s.identity.refresh().then(() => this.schedule()); return;
        case "refresh": await this.refreshAll(); return;
        case "connectGithub": await this.s.connections.connect("github"); await this.s.identity.refresh(); return;
        case "switchRole": await this.switchRole(m.role); return;
        case "connect": await this.s.connections.connect(m.id); return;
        case "check": await this.s.connections.check(m.id); return;
        case "openStory": await this.openStory(m.key); return;
        case "run": {
          const spec = this.runs.get(m.id);
          if (spec) await this.run(spec);
          return;
        }
      }
    } catch (e) {
      void vscode.window.showErrorMessage(errText(e));
    }
  }

  // ---------- actions ----------
  private async run(spec: RunSpec): Promise<void> {
    switch (spec.kind) {
      case "skill": await this.s.sessions.start(spec.role, spec.arg ? `${spec.command} ${spec.arg}` : spec.command); return;
      case "url":
        if (!/^https:\/\//.test(spec.url)) throw new Error("Refusing to open a non-https link");
        await vscode.env.openExternal(vscode.Uri.parse(spec.url, true));
        return;
      case "intake": await this.intake(); return;
      case "connect": await this.s.connections.connect(spec.id); return;
      case "story": await this.openStory(spec.key); return;
      case "bootstrap": {
        const role = this.s.identity.get()?.active;
        if (!role) throw new Error("Pick a role first.");
        await this.s.sessions.start(role, "/circuit-bootstrap");
        return;
      }
    }
  }

  private async switchRole(arg?: unknown): Promise<void> {
    const id = this.s.identity.get() ?? await this.s.identity.refresh();
    if (!id) { void vscode.window.showWarningMessage("Sign in to GitHub first."); return; }
    const choices = roleChoices(id);
    let role = choices.find((r) => r === arg);
    if (!role) {
      const pick = await vscode.window.showQuickPick(choices.map((r) => ({ label: ROLE_LABEL[r], description: r === id.active ? "current" : undefined, role: r })),
        { title: "Switch role", placeHolder: "The role you work as in this folder" });
      role = pick?.role;
    }
    if (role && role !== id.active) await this.s.identity.setActive(role);
  }

  /** New design from transcript: paste, a file or a Fireflies meeting, then /circuit-intake as the Architect. */
  private async intake(): Promise<void> {
    const id = this.s.identity.get();
    if (!id) throw new Error("Sign in to GitHub first.");
    if (!roleChoices(id).includes("architect")) throw new Error("New designs are started by an Architect.");
    const how = await vscode.window.showQuickPick([
      { label: "$(clippy) Paste", description: "the transcript you copied", id: "paste" },
      { label: "$(file) File", description: UPLOAD_EXTENSIONS.map((e) => "." + e).join(" "), id: "file" },
      { label: "$(mic) Fireflies", description: "a recent meeting", id: "fireflies" },
    ], { title: "New design from transcript", placeHolder: "Where is the transcript? It stays on this machine and is never committed." });
    if (!how) return;
    let source: SourceRef | undefined;
    if (how.id === "paste") {
      const text = await vscode.env.clipboard.readText();
      if (!text.trim()) throw new Error("The clipboard is empty. Copy the transcript first.");
      const title = await vscode.window.showInputBox({ title: "Name this transcript", value: "Call transcript", prompt: `${text.length.toLocaleString()} characters from the clipboard` });
      if (title === undefined) return;
      source = await this.s.project.addText(text, { title, origin: "paste" });
    } else if (how.id === "file") {
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Use", filters: { Transcripts: UPLOAD_EXTENSIONS } });
      if (!files?.[0]) return;
      source = await this.s.project.addFile(files[0].fsPath);
    } else {
      const list = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Reading Fireflies" }, () => this.s.project.firefliesRecent(15));
      if (!list.length) throw new Error("No Fireflies meetings found. Connect Fireflies on the Connections tab.");
      const pick = await vscode.window.showQuickPick(list.map((m) => ({ label: m.title, description: m.date.slice(0, 10), m })), { title: "Fireflies meeting" });
      source = pick?.m;
    }
    if (!source) return;
    if (id.active !== "architect") await this.s.identity.setActive("architect");
    await this.s.sessions.start("architect", `/circuit-intake ${source.id}`);
  }

  // ---------- story panel ----------
  private async openStory(arg?: unknown): Promise<void> {
    let key = isStoryKey(arg) ? arg : undefined;
    if (!key) {
      const input = await vscode.window.showInputBox({ title: "Open story", prompt: "Jira key, e.g. ACME-12", validateInput: (v) => (isStoryKey(v.trim().toUpperCase()) ? undefined : "A Jira key like ACME-12") });
      key = input?.trim().toUpperCase();
    }
    if (!key) return;
    const panel = openPanel(this.s.ctx, { module: "views", page: "story", title: key }, (m) => this.onStory(m), "views/story");
    if (this.story?.panel !== panel) panel.onDidDispose(() => { if (this.story?.panel === panel) this.story = undefined; });
    panel.title = key;
    this.story = { panel, key };
    void panel.webview.postMessage({ type: "state", data: { loading: true } });
    await this.sendStory();
  }

  private async sendStory(): Promise<void> {
    const st = this.story;
    if (!st) return;
    try {
      const detail = await this.s.project.story(st.key);
      if (this.story !== st) return;
      st.detail = detail;
      if (detail) st.panel.title = `${detail.key} ${detail.title}`.slice(0, 50);
      void st.panel.webview.postMessage({ type: "state", data: buildStory(detail) });
    } catch (e) {
      void st.panel.webview.postMessage({ type: "state", data: { error: errText(e) } });
    }
  }

  private async onStory(raw: unknown): Promise<void> {
    const m = parseStoryMessage(raw);
    if (!m || !this.story) return;
    if (m.type !== "openLink") {
      if (m.type === "refresh") await this.s.project.refresh();
      await this.sendStory();
      return;
    }
    // only the links the panel was given
    if (this.story.detail?.links.some((l) => l.target === m.target) || this.story.detail?.pr?.scanUrl === m.target) {
      await vscode.env.openExternal(vscode.Uri.parse(m.target, true));
    }
  }
}
