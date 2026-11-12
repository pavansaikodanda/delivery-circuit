// Sources page host (docs/CIRCUIT-V3.md step 1, Architect only): paste or dictate text, attach a local file
// (txt md docx vtt srt pdf), list Fireflies meetings through the person's Fireflies MCP (a Claude Agent SDK call with
// their logged-in Claude), import from Wispr Flow (paste, file, or its local history read-only after explicit consent)
// and watch a folder outside the repo. Storage goes through ProjectContextService: encrypted in the extension's local
// storage, indexed in .circuit/sources.json (ids, titles, dates only).
import { promises as fsp } from "fs";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { ActionRef, CircuitServices, ProjectContextService, SourceRef } from "../core/contracts";
import { canAct } from "../core/contracts";
import { loadAgentSdk } from "../core/claude";
import { openLink } from "../core/util";
import { openPanel } from "../core/webview";
import { PdfTextError, pdfToText } from "./pdf";
import type { ConnectionsInternals } from "./service";
import {
  buildSourcesState, cleanTitle, combineWispr, defaultTitle, extOf, FIREFLIES_SCHEMA, firefliesPrompt, insideRepo, isAllowedFirefliesTool,
  isOrigin, MEETING_ID_RE, parseFirefliesMeetings, PROJECT_EXTRACTS, readWisprHistory, SOURCE_ID_RE, subscriptionEnv, titleFromFile,
  validateAttach, validateText, wisprDbCandidates, wisprPreview, type FirefliesMeeting, type SourceOrigin, type SourcesState,
} from "./sourcesCore";
import { SqliteReader } from "./sqlite";

const K = {
  origins: "deliveryCircuit.sources.origins",
  watchFolder: "deliveryCircuit.sources.watchFolder",
  watchSince: "deliveryCircuit.sources.watchSince",
  watchSeen: "deliveryCircuit.sources.watchSeen",
};
const FIREFLIES_TIMEOUT_MS = 180_000;

export function registerSourcesUI(s: CircuitServices, connections: ConnectionsInternals): void {
  const { ctx, root, log, identity } = s;
  const project: ProjectContextService = s.project;
  let panel: vscode.WebviewPanel | undefined;
  let pending: NodeJS.Timeout | undefined;
  let sources: SourceRef[] = [];
  let sourcesError: string | undefined;
  const busy = new Set<string>();
  const ff: { status: SourcesState["fireflies"]["status"]; meetings: FirefliesMeeting[]; error?: string; loadedAt?: string } = { status: "idle", meetings: [] };
  let watch: SourcesState["watch"] = { active: false };
  let watcher: vscode.FileSystemWatcher | undefined;
  const platformPaths = { home: os.homedir(), appData: process.env.APPDATA, localAppData: process.env.LOCALAPPDATA };
  const wisprCandidates = wisprDbCandidates(process.platform, platformPaths);

  const origins = (): Record<string, SourceOrigin> => ctx.workspaceState.get<Record<string, SourceOrigin>>(K.origins) ?? {};
  const setOrigin = async (id: string, o: SourceOrigin) => { await ctx.workspaceState.update(K.origins, { ...origins(), [id]: o }); };

  function state(): SourcesState {
    const mcp = connections.cached().find((c) => c.id === "mcp-fireflies");
    return buildSourcesState({
      identity: identity.get(), sources, origins: origins(), sourcesError,
      fireflies: { mcpState: mcp?.state ?? "unknown", mcpDetail: mcp?.detail, ...ff },
      wispr: { platform: process.platform, candidates: wisprCandidates, found: wisprCandidates.find((f) => fs.existsSync(f)) },
      watch, busy,
    });
  }
  const post = () => { if (panel) void panel.webview.postMessage({ type: "state", data: state() }); };
  const schedulePost = () => { if (pending) clearTimeout(pending); pending = setTimeout(post, 80); };
  const event = (data: Record<string, unknown>) => { if (panel) void panel.webview.postMessage({ type: "event", ...data }); };
  async function loadSources() {
    try { sources = await project.sources(); sourcesError = undefined; } catch (e: any) { sourcesError = String(e?.message ?? e); }
    schedulePost();
  }
  async function withBusy<T>(key: string, f: () => Promise<T>): Promise<T | undefined> {
    if (busy.has(key)) return undefined;
    busy.add(key); post();
    try { return await f(); } finally { busy.delete(key); post(); }
  }
  function requireArchitect(): void {
    const id = identity.get();
    if (!id || !canAct(id, "architect")) throw new Error("Only the Architect (acting as Architect) adds sources and reads transcripts.");
  }

  // ---------- storing ----------
  async function addText(text: string, title: string, origin: SourceOrigin): Promise<SourceRef> {
    const bad = validateText(text);
    if (bad) throw new Error(bad);
    // Stored encrypted by the project module straight from memory: no temp file.
    const ref = await project.addText(text, { title, origin });
    await setOrigin(ref.id, origin);
    return ref;
  }

  async function importFile(file: string, origin: SourceOrigin, title?: string): Promise<SourceRef> {
    const st = await fsp.stat(file);
    const name = path.basename(file);
    const bad = validateAttach(name, st.size);
    if (bad) throw new Error(bad);
    const t = cleanTitle(title, titleFromFile(name));
    let ref: SourceRef;
    if (PROJECT_EXTRACTS.includes(extOf(name))) ref = await project.addUpload(vscode.Uri.file(file), t);
    else {
      let text: string;
      try { text = pdfToText(await fsp.readFile(file)); } catch (e) { throw new Error(`${name}: ${e instanceof PdfTextError ? e.message : String((e as any)?.message ?? e)}`); }
      ref = await addText(text, t, origin);
    }
    await setOrigin(ref.id, origin);
    if (insideRepo(file, root)) void vscode.window.showWarningMessage(`${name} is inside the repo. The circuit stored an encrypted copy; keep the file itself out of git (.gitignore) or delete it.`);
    return ref;
  }

  async function attach(origin: SourceOrigin): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      title: origin === "fireflies-export" ? "Attach a Fireflies export" : origin === "wispr-flow" ? "Attach a Wispr Flow export" : "Attach transcripts or notes",
      canSelectMany: true, openLabel: "Add", filters: { "Transcripts and notes": ["txt", "md", "docx", "vtt", "srt", "pdf"] },
    });
    if (!picks?.length) return;
    const added: string[] = []; const failed: string[] = [];
    for (const u of picks) {
      try { added.push((await importFile(u.fsPath, origin)).title); } catch (e: any) { failed.push(String(e?.message ?? e)); }
    }
    await loadSources();
    if (added.length) event({ kind: "added", text: added.length === 1 ? `Added ${added[0]}` : `Added ${added.length} sources` });
    if (failed.length) void vscode.window.showErrorMessage(`Sources: ${failed.join(" · ")}`);
  }

  // ---------- Fireflies (the person's Fireflies MCP, through their logged-in Claude) ----------
  async function loadFireflies(limit = 20): Promise<void> {
    ff.status = "loading"; ff.error = undefined; post();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FIREFLIES_TIMEOUT_MS);
    try {
      const { query } = await loadAgentSdk();
      let out: { meetings: FirefliesMeeting[]; error?: string } | undefined;
      let failure: string | undefined;
      const q = query({
        prompt: firefliesPrompt(limit),
        options: {
          cwd: root, env: subscriptionEnv(process.env), maxTurns: 6, abortController: abort,
          // the person's MCP servers (user scope and claude.ai connectors) are where Fireflies lives
          settingSources: ["user", "project", "local"], permissionMode: "default", allowedTools: [],
          canUseTool: async (name, input) => isAllowedFirefliesTool(name)
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "Only the Fireflies listing tools are allowed here." },
          outputFormat: { type: "json_schema", schema: FIREFLIES_SCHEMA as unknown as Record<string, unknown> },
        },
      });
      for await (const m of q) {
        if (m.type !== "result") continue;
        if (m.subtype === "success" && m.structured_output) out = parseFirefliesMeetings(m.structured_output);
        else if (m.subtype !== "success") failure = m.subtype;
      }
      if (!out) throw new Error(failure ? `Claude stopped (${failure}).` : "Claude returned no meeting list.");
      ff.meetings = out.meetings; ff.loadedAt = new Date().toISOString();
      ff.status = out.error && !out.meetings.length ? "error" : "ready";
      ff.error = out.error && !out.meetings.length ? `${out.error} Check the Fireflies MCP row on the Connections page.` : undefined;
    } catch (e: any) {
      ff.status = "error";
      ff.error = abort.signal.aborted ? "Fireflies listing timed out." : String(e?.message ?? e).slice(0, 300);
      log(`sources: Fireflies listing failed: ${ff.error}`);
    } finally { clearTimeout(timer); post(); }
  }

  async function addFireflies(meetingId: string): Promise<void> {
    const m = ff.meetings.find((x) => x.id === meetingId);
    if (!m || !MEETING_ID_RE.test(meetingId)) throw new Error("Unknown Fireflies meeting. Load the list again.");
    // Fireflies transcripts stay at their source: the index gets id, title and date only.
    const ref = await project.indexFireflies(meetingId, { title: m.title, date: m.date });
    await setOrigin(ref.id, "fireflies");
    await loadSources();
    event({ kind: "added", text: `Indexed ${ref.title}` });
  }

  // ---------- Wispr Flow history (read-only, explicit consent each time) ----------
  async function importWispr(): Promise<void> {
    const found = wisprCandidates.find((f) => fs.existsSync(f));
    if (!found) {
      void vscode.window.showInformationMessage(wisprCandidates.length
        ? `Wispr Flow's history was not found (looked in ${wisprCandidates.join(", ")}). Dictate into the text box, or attach an export.`
        : "Wispr Flow has no app for this platform. Dictate into the text box or attach a file.");
      return;
    }
    const ok = await vscode.window.showWarningMessage("Read your Wispr Flow history?", {
      modal: true,
      detail: `Delivery Circuit will read (never change) Wispr Flow's local history at\n${found}\nto list your recent dictations. Nothing leaves this machine. Only the dictations you pick are stored, encrypted, as one source.`,
    }, "Read history");
    if (ok !== "Read history") return;
    let entries;
    try {
      const db = await fsp.readFile(found);
      const wal = await fsp.readFile(found + "-wal").catch(() => undefined);
      entries = readWisprHistory(new SqliteReader(db, wal)).entries;
    } catch (e: any) {
      throw new Error(`Could not read Wispr Flow's history (${String(e?.message ?? e)}). Paste or attach instead.`);
    }
    if (!entries.length) { void vscode.window.showInformationMessage("No dictations found in Wispr Flow's history."); return; }
    const picks = await vscode.window.showQuickPick(entries.map((e) => ({ ...wisprPreview(e), entry: e })), {
      canPickMany: true, title: "Wispr Flow: pick the dictations for this source", placeHolder: "Newest first. Picked dictations become one source.", ignoreFocusOut: true, matchOnDescription: true,
    });
    if (!picks?.length) return;
    const title = await vscode.window.showInputBox({ title: "Source title", value: defaultTitle("wispr-flow"), ignoreFocusOut: true });
    if (title === undefined) return;
    const ref = await addText(combineWispr(picks.map((p) => p.entry)), cleanTitle(title, defaultTitle("wispr-flow")), "wispr-flow");
    await loadSources();
    event({ kind: "added", text: `Added ${ref.title}` });
  }

  // ---------- watch folder ----------
  function stopWatcher() { watcher?.dispose(); watcher = undefined; watch = { ...watch, active: false }; }
  const timers = new Map<string, NodeJS.Timeout>();
  function startWatcher(folder: string) {
    stopWatcher();
    if (!fs.existsSync(folder)) { watch = { folder, active: false, error: "The folder no longer exists." }; return; }
    watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), "*.{txt,md,docx,vtt,srt,pdf}"));
    const onFile = (u: vscode.Uri) => {
      const f = u.fsPath;
      clearTimeout(timers.get(f));
      // wait until the file stops changing (exports are written in pieces)
      timers.set(f, setTimeout(() => { timers.delete(f); void importWatched(f); }, 2500));
    };
    watcher.onDidCreate(onFile); watcher.onDidChange(onFile);
    watch = { ...watch, folder, active: true, error: undefined };
  }
  async function importWatched(file: string) {
    try {
      const st = await fsp.stat(file);
      const since = ctx.workspaceState.get<number>(K.watchSince) ?? Date.now();
      if (st.mtimeMs < since) return;
      const key = `${file}|${st.size}|${Math.round(st.mtimeMs)}`;
      const seen = ctx.workspaceState.get<string[]>(K.watchSeen) ?? [];
      if (seen.includes(key)) return;
      const id = identity.get();
      if (!id || !canAct(id, "architect")) { log(`sources: watch folder skipped ${path.basename(file)} (not acting as Architect)`); return; }
      await ctx.workspaceState.update(K.watchSeen, [...seen, key].slice(-500));
      const ref = await importFile(file, "watch-folder");
      watch = { ...watch, last: { title: ref.title, at: new Date().toISOString() } };
      await loadSources();
      void vscode.window.showInformationMessage(`Delivery Circuit: added "${ref.title}" from the watch folder.`);
    } catch (e: any) {
      watch = { ...watch, error: `${path.basename(file)}: ${String(e?.message ?? e)}` };
      schedulePost();
    }
  }
  async function chooseWatchFolder() {
    const pick = await vscode.window.showOpenDialog({ title: "Watch a folder for new transcripts", canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Watch" });
    const folder = pick?.[0]?.fsPath;
    if (!folder) return;
    if (insideRepo(folder, root)) throw new Error("Choose a folder outside the repo: transcripts must never enter git.");
    await ctx.workspaceState.update(K.watchFolder, folder);
    await ctx.workspaceState.update(K.watchSince, Date.now());
    startWatcher(folder);
    event({ kind: "info", text: "New files in the folder are added as sources." });
  }
  const saved = ctx.workspaceState.get<string>(K.watchFolder);
  if (saved && !insideRepo(saved, root)) startWatcher(saved);
  ctx.subscriptions.push({ dispose: () => { stopWatcher(); timers.forEach(clearTimeout); } });

  // ---------- messages ----------
  const INTAKE = (id: string): ActionRef => ({ id: "ai:/circuit-intake", label: "Start intake", persona: "architect", kind: "ai",
    args: { command: "/circuit-intake", argKind: "source", arg: id } });

  const onMessage = async (m: any) => {
    try {
      switch (m?.type) {
        case "ready": post(); void loadSources(); void connections.checkRow("mcp-fireflies").then(schedulePost, () => undefined); return;
        case "refresh": await loadSources(); return;
        case "openLink": if (m.link && typeof m.link.target === "string") await openLink(root, m.link); return;
        case "addText": {
          requireArchitect();
          const text = String(m.text ?? "");
          await withBusy("paste", async () => {
            const ref = await addText(text, cleanTitle(m.title, defaultTitle("paste")), isOrigin(m.origin) && (m.origin === "wispr-flow" || m.origin === "paste") ? m.origin : "paste");
            await loadSources();
            event({ kind: "cleared" });
            event({ kind: "added", text: `Added ${ref.title}` });
          });
          return;
        }
        case "attach": requireArchitect(); await withBusy("attach", () => attach(isOrigin(m.origin) ? m.origin : "file")); return;
        case "firefliesLoad": requireArchitect(); await withBusy("fireflies", () => loadFireflies(20)); return;
        case "firefliesAdd": requireArchitect(); await withBusy(`ff:${m.id}`, () => addFireflies(String(m.id ?? ""))); return;
        case "wisprImport": requireArchitect(); await withBusy("wispr", importWispr); return;
        case "watchChoose": requireArchitect(); await withBusy("watch", chooseWatchFolder); return;
        case "watchStop":
          await ctx.workspaceState.update(K.watchFolder, undefined);
          stopWatcher(); watch = { active: false }; post(); return;
        case "excerpt": {
          requireArchitect();
          const id = String(m.id ?? "");
          if (!SOURCE_ID_RE.test(id)) return;
          const text = await project.transcript(id);
          event({ kind: "excerpt", id, text: text.slice(0, 600) + (text.length > 600 ? "…" : "") });
          return;
        }
        case "action": {
          const id = String(m.action?.args?.arg ?? "");
          if (m.action?.id !== "ai:/circuit-intake" || !SOURCE_ID_RE.test(id)) return;
          requireArchitect();
          const a = INTAKE(id);
          if (!s.actions.allowed(a)) throw new Error("Start intake is not available to you right now.");
          await s.actions.run(a);
          return;
        }
        case "openConnections": await vscode.commands.executeCommand("deliveryCircuit.openConnections"); return;
      }
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Sources: ${e?.message ?? e}`);
      event({ kind: "error", text: String(e?.message ?? e) });
    }
  };

  ctx.subscriptions.push(
    identity.onDidChange(schedulePost), connections.onDidChange(schedulePost),
    project.onDidChange(() => { if (panel) void loadSources(); }),
    vscode.commands.registerCommand("deliveryCircuit.openSources", () => {
      panel = openPanel(ctx, { module: "connections", page: "sources", title: "Sources" }, onMessage);
      panel.onDidDispose(() => { panel = undefined; });
      post();
    }),
  );
}
