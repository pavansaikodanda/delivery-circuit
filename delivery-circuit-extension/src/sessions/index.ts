// Sessions: start Claude Code as a persona, either in an integrated terminal (`claude --agent <persona> ...`) or in a
// chat panel driven by the Agent SDK. Subscription auth only: ANTHROPIC_API_KEY is removed from Claude's environment.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { canAct, PERSONAS, type CircuitMcpService, type IdentityService, type Persona, type SessionsService } from "../core/contracts";
import { openLink, type ModuleBase } from "../core/util";
import { openPanel } from "../core/webview";
import { addError, addSystem, addUser, chatMeta, claudeEnv, newChat, reduce, sdkOptions, toolLabel, toolSummary, vendorServers, type ChatState } from "./chat";
import { buildTerminalSpec, PERSONA_TITLE, resolveClaude } from "./terminal";
import { loadAgentSdk } from "../core/claude";

type Deps = { identity: IdentityService; mcp: CircuitMcpService };

/** Async iterable of user messages for the SDK's streaming-input mode (follow-up messages in the same session). */
class InputQueue implements AsyncIterable<any> {
  private items: any[] = [];
  private waiting: ((r: IteratorResult<any>) => void) | undefined;
  private closed = false;
  push(text: string, sessionId = "") {
    const msg = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: sessionId };
    if (this.waiting) { const w = this.waiting; this.waiting = undefined; w({ value: msg, done: false }); } else this.items.push(msg);
  }
  close() { this.closed = true; if (this.waiting) { const w = this.waiting; this.waiting = undefined; w({ value: undefined, done: true }); } }
  [Symbol.asyncIterator](): AsyncIterator<any> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => { this.waiting = r; });
      },
    };
  }
}

export function createSessions(base: ModuleBase, deps: Deps): SessionsService {
  const { identity, mcp } = deps;
  const log = (m: string) => base.log(`session: ${m}`);
  let panelSeq = 0;

  function mode(): "terminal" | "panel" {
    return vscode.workspace.getConfiguration("deliveryCircuit").get<"terminal" | "panel">("sessionMode", "terminal") === "panel" ? "panel" : "terminal";
  }

  async function startTerminal(persona: Persona, prompt: string): Promise<void> {
    const configPath = await mcp.writePersonaConfig(persona);
    const exe = resolveClaude(process.env.PATH ?? process.env.Path ?? "", process.platform, {
      exists: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
      read: (p) => fs.readFileSync(p, "utf8"),
    });
    const spec = buildTerminalSpec(persona, prompt, base.root, configPath, exe);
    const term = vscode.window.createTerminal({ name: spec.name, cwd: spec.cwd, shellPath: spec.shellPath, shellArgs: spec.shellArgs, env: spec.env });
    term.show();
    log(`terminal ${persona}: ${path.basename(exe.shellPath)} --agent ${persona} (prompt ${prompt.length} chars)`);
  }

  async function startPanel(persona: Persona, prompt: string, title?: string): Promise<void> {
    let state: ChatState = newChat(persona, title ? `Claude · ${PERSONA_TITLE[persona]} · ${title}` : undefined);
    let queue: InputQueue | undefined;
    let abort: AbortController | undefined;
    let disposed = false;
    let timer: NodeJS.Timeout | undefined;

    const key = `sessions/session/${++panelSeq}`;
    const panel = openPanel(base.ctx, { module: "sessions", page: "session", title: state.title }, async (msg) => {
      try {
        if (msg?.type === "ready") flush();
        else if (msg?.type === "send" && typeof msg.text === "string" && msg.text.trim()) send(msg.text.trim());
        else if (msg?.type === "stop") stop();
        else if (msg?.type === "openLink" && msg.link) await openLink(base.root, msg.link);
      } catch (e: any) { vscode.window.showErrorMessage(e?.message ?? String(e)); }
    }, key);
    panel.onDidDispose(() => { disposed = true; stop(); });

    function view(): ChatState & { meta: string } {
      const root = base.root;
      return {
        ...state,
        meta: chatMeta(state),
        items: state.items.map((i) => {
          if (!i.file) return i;
          const rel = path.relative(root, path.resolve(root, i.file));
          return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? { ...i, link: { kind: "file" as const, label: "Open", target: rel.split(path.sep).join("/") } } : i;
        }),
      };
    }
    function flush() { if (timer) { clearTimeout(timer); timer = undefined; } if (!disposed) panel.webview.postMessage({ type: "state", data: view() }); }
    function update(next: ChatState, now = false) { state = next; if (now) flush(); else if (!timer) timer = setTimeout(flush, 80); }

    function stop() {
      if (abort) { abort.abort(); log(`${persona} panel stopped`); }
      abort = undefined; queue?.close(); queue = undefined;
      if (state.running) update(addSystem({ ...state, running: false }, "Stopped."), true);
    }

    function send(text: string) {
      update({ ...addUser(state, text), running: true }, true);
      if (queue) { queue.push(text, state.sessionId); return; }
      void runQuery(text);
    }

    async function canUseTool(toolName: string, input: Record<string, unknown>, opts: { title?: string; decisionReason?: string; suggestions?: unknown[] }) {
      const head = opts.title ?? `Claude (${PERSONA_TITLE[persona]}) wants to use ${toolLabel(toolName)}`;
      const detail = [toolSummary(toolName, input), opts.decisionReason].filter(Boolean).join("\n");
      const buttons = ["Allow", ...(opts.suggestions?.length ? ["Allow for this session"] : []), "Deny"];
      const pick = await vscode.window.showWarningMessage(head, { modal: true, detail }, ...buttons);
      log(`${persona} permission ${toolName}: ${pick ?? "dismissed"}`);
      if (pick === "Allow") return { behavior: "allow", updatedInput: input };
      if (pick === "Allow for this session") return { behavior: "allow", updatedInput: input, updatedPermissions: opts.suggestions };
      return { behavior: "deny", message: "The person denied this tool call." };
    }

    async function runQuery(first: string) {
      let sdk: any;
      try { sdk = await loadAgentSdk(); } catch (e: any) {
        update(addError(state, `The Claude Agent SDK is not available: ${e?.message ?? e}`), true); return;
      }
      let vendor: Record<string, unknown> = {};
      try {
        const cfgPath = await mcp.writePersonaConfig(persona);
        const parsed = vendorServers(JSON.parse(fs.readFileSync(cfgPath, "utf8")));
        vendor = parsed.servers;
        if (parsed.skipped.length) update(addSystem(state, `Skipped MCP servers without a valid URL: ${parsed.skipped.join(", ")}`));
      } catch (e: any) {
        log(`${persona} persona MCP config not available: ${e?.message ?? e}`);
      }
      queue = new InputQueue();
      abort = new AbortController();
      const myAbort = abort;
      queue.push(first, state.sessionId);
      const options = sdkOptions({
        persona, root: base.root, circuit: mcp.sdkServer(persona), vendor, env: claudeEnv(process.env, persona),
        abortController: myAbort, canUseTool, resume: state.sessionId,
        stderr: (s) => { const line = s.trim(); if (line) log(`${persona} stderr: ${line.slice(0, 300)}`); },
      });
      log(`${persona} panel query (${state.sessionId ? "resume" : "new"}), MCP: ${Object.keys(options.mcpServers as object).join(", ") || "none"}`);
      try {
        for await (const m of sdk.query({ prompt: queue, options })) {
          if (disposed) break;
          update(reduce(state, m), m?.type === "result" || m?.type === "assistant");
        }
      } catch (e: any) {
        if (!myAbort.signal.aborted) update(addError(state, e?.message ?? String(e)), true);
      } finally {
        if (abort === myAbort) { abort = undefined; queue?.close(); queue = undefined; }
        if (state.running) update({ ...state, running: false }, true);
      }
    }

    if (prompt.trim()) send(prompt.trim()); else flush();
  }

  async function start(persona: Persona, prompt: string, opts?: { mode?: "terminal" | "panel"; title?: string }): Promise<void> {
    const id = identity.get();
    if (!id || !canAct(id, persona)) {
      throw new Error(`You can start a ${PERSONA_TITLE[persona]} session only while acting as ${PERSONA_TITLE[persona]}`);
    }
    const m = opts?.mode ?? mode();
    log(`start ${persona} (${m}) for ${id.login}`);
    if (m === "panel") await startPanel(persona, prompt, opts?.title);
    else await startTerminal(persona, prompt);
  }

  // Command palette entry: start a session as the active persona with an optional prompt.
  try {
    base.ctx.subscriptions.push(vscode.commands.registerCommand("deliveryCircuit.startSession", async (persona?: Persona, prompt?: string) => {
      try {
        const id = identity.get();
        const p = persona && PERSONAS.includes(persona) ? persona : id?.active ?? undefined;
        if (!p) { vscode.window.showWarningMessage("No persona: sign in to GitHub and join a persona team first."); return; }
        const text = prompt ?? await vscode.window.showInputBox({ title: `Start Claude as ${PERSONA_TITLE[p]}`, prompt: "Prompt or skill command (optional), e.g. /dev-review-plan 42", ignoreFocusOut: true });
        if (text === undefined) return;
        await start(p, text);
      } catch (e: any) { vscode.window.showErrorMessage(e?.message ?? String(e)); }
    }));
  } catch (e: any) {
    log(`deliveryCircuit.startSession already registered elsewhere: ${e?.message ?? e}`);
  }

  return { start };
}
