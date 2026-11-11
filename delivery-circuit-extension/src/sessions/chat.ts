// Panel-mode chat: turns Agent SDK messages into a compact chat state, and builds the SDK options.
// No vscode import, no SDK import (shapes are read structurally), so it is unit-tested directly.
import type { Persona } from "../core/contracts";
import { PERSONA_TITLE } from "./terminal";

export type ChatKind = "user" | "assistant" | "tool" | "system" | "error";
export interface ChatItem {
  id: string;
  kind: ChatKind;
  text: string;
  /** tool rows */
  tool?: string;
  status?: "running" | "ok" | "error";
  /** assistant text still streaming */
  streaming?: boolean;
  /** from a sub-agent (parent_tool_use_id set) */
  nested?: boolean;
  /** file a tool read or wrote (absolute, as Claude gave it) */
  file?: string;
  /** workspace-relative link target for that file (filled in by the host) */
  link?: { kind: "file"; label: string; target: string };
}
export interface ChatState {
  persona: Persona;
  title: string;
  items: ChatItem[];
  running: boolean;
  sessionId?: string;
  model?: string;
  costUsd: number;
  turns: number;
  /** MCP servers that are not connected (name + status) */
  mcpIssues: { name: string; status: string }[];
}

export function newChat(persona: Persona, title?: string): ChatState {
  return { persona, title: title ?? `Claude · ${PERSONA_TITLE[persona]}`, items: [], running: false, costUsd: 0, turns: 0, mcpIssues: [] };
}

/** Footer line under the composer: "claude-sonnet-5-5 · 3 turns · $0.012" (cost only once something was spent). */
export function chatMeta(s: Pick<ChatState, "model" | "turns" | "costUsd">): string {
  const turns = Number.isFinite(s.turns) ? s.turns : 0;
  const cost = Number.isFinite(s.costUsd) ? s.costUsd : 0;
  return [
    s.model || null,
    `${turns} ${turns === 1 ? "turn" : "turns"}`,
    cost > 0 ? "$" + (cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)) : null,
  ].filter(Boolean).join(" · ");
}

let seq = 0;
const nid = (p: string) => `${p}${++seq}`;

/** One short line describing a tool call. */
export function toolSummary(name: string, input: any): string {
  const i = input ?? {};
  const cut = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  if (name === "Bash" || name === "PowerShell") return cut(String(i.command ?? ""));
  if (["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) return cut(String(i.file_path ?? i.notebook_path ?? ""));
  if (name === "Grep" || name === "Glob") return cut(`${i.pattern ?? ""}${i.path ? "  in " + i.path : ""}`);
  if (name === "WebFetch") return cut(String(i.url ?? ""));
  if (name === "Task" || name === "Agent") return cut(String(i.description ?? i.subagent_type ?? ""));
  if (name === "Skill") return cut(String(i.skill ?? i.name ?? ""));
  const keys = Object.keys(i);
  if (!keys.length) return "";
  try { return cut(JSON.stringify(i)); } catch { return ""; }
}

/** Display name: mcp__server__tool -> "server · tool". */
export function toolLabel(name: string): string {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[1]} · ${m[2]}` : name;
}

export function addUser(s: ChatState, text: string): ChatState {
  return { ...s, items: [...s.items, { id: nid("u"), kind: "user", text }] };
}
export function addError(s: ChatState, text: string): ChatState {
  return { ...s, items: [...s.items, { id: nid("e"), kind: "error", text }], running: false };
}
export function addSystem(s: ChatState, text: string): ChatState {
  return { ...s, items: [...s.items, { id: nid("s"), kind: "system", text }] };
}

/** Apply one SDK message. Unknown message types leave the state unchanged. */
export function reduce(s: ChatState, m: any): ChatState {
  if (!m || typeof m !== "object") return s;
  const nested = !!m.parent_tool_use_id;
  switch (m.type) {
    case "system": {
      if (m.subtype !== "init") return s;
      const issues = (m.mcp_servers ?? []).filter((x: any) => x && x.status !== "connected").map((x: any) => ({ name: String(x.name), status: String(x.status) }));
      return { ...s, sessionId: m.session_id ?? s.sessionId, model: m.model ?? s.model, mcpIssues: issues };
    }
    case "stream_event": {
      if (nested) return s;
      const ev = m.event ?? {};
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        const items = s.items.slice();
        const last = items[items.length - 1];
        if (last && last.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, text: last.text + ev.delta.text };
        else items.push({ id: nid("a"), kind: "assistant", text: ev.delta.text, streaming: true });
        return { ...s, items };
      }
      return s;
    }
    case "assistant": {
      const blocks: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
      // A complete message replaces the streamed preview of it.
      let items = s.items.filter((i) => !(i.kind === "assistant" && i.streaming));
      for (const b of blocks) {
        if (b?.type === "text" && !nested && String(b.text ?? "").trim()) items = [...items, { id: nid("a"), kind: "assistant", text: String(b.text) }];
        else if (b?.type === "tool_use") {
          items = [...items, { id: String(b.id ?? nid("t")), kind: "tool", tool: toolLabel(String(b.name ?? "tool")), text: toolSummary(String(b.name ?? ""), b.input), status: "running", nested,
            file: typeof b.input?.file_path === "string" ? b.input.file_path : undefined }];
        }
      }
      if (m.error && !blocks.length) items = [...items, { id: nid("e"), kind: "error", text: String(m.error) }];
      return { ...s, items };
    }
    case "user": {
      const blocks: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
      const results = blocks.filter((b) => b?.type === "tool_result");
      if (!results.length) return s;
      const items = s.items.map((i) => {
        const r = results.find((b) => b.tool_use_id === i.id);
        return r && i.kind === "tool" ? { ...i, status: r.is_error ? "error" as const : "ok" as const } : i;
      });
      return { ...s, items };
    }
    case "result": {
      const items = s.items.map((i) => (i.kind === "tool" && i.status === "running" ? { ...i, status: "ok" as const } : i.streaming ? { ...i, streaming: false } : i));
      const next: ChatState = {
        ...s, items, running: false, sessionId: m.session_id ?? s.sessionId,
        costUsd: s.costUsd + (typeof m.total_cost_usd === "number" ? m.total_cost_usd : 0),
        turns: s.turns + (typeof m.num_turns === "number" ? m.num_turns : 0),
      };
      if (m.subtype !== "success" || m.is_error) {
        const why = ({ error_max_turns: "Stopped: maximum turns reached", error_max_budget_usd: "Stopped: budget reached",
          error_during_execution: "Stopped by an error" } as Record<string, string>)[m.subtype] ?? (m.is_error ? String(m.result ?? "The session ended with an error") : `Ended: ${m.subtype}`);
        return addError(next, why);
      }
      if (Array.isArray(m.permission_denials) && m.permission_denials.length) {
        return addSystem(next, `${m.permission_denials.length} tool call(s) were denied.`);
      }
      return next;
    }
    default:
      return s;
  }
}

/** Environment for Claude: the parent environment without API-key auth (subscription only), plus the persona. */
export function claudeEnv(parent: NodeJS.ProcessEnv, persona: Persona): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN") continue;
    out[k] = v;
  }
  out.CIRCUIT_PERSONA = persona;
  return out;
}

/** Vendor MCP servers from a persona config file (everything except the Circuit server, and no unfilled VERIFY placeholders). */
export function vendorServers(config: any): { servers: Record<string, unknown>; skipped: string[] } {
  const servers: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [name, def] of Object.entries<any>(config?.mcpServers ?? {})) {
    if (name === "circuit") continue;
    if (!def || typeof def !== "object") { skipped.push(name); continue; }
    if (typeof def.url === "string" && !/^https?:\/\//.test(def.url)) { skipped.push(name); continue; }
    if (typeof def.url === "string" && !def.type) { servers[name] = { ...def, type: "http" }; continue; }
    servers[name] = def;
  }
  return { servers, skipped };
}

/** Agent SDK options for a persona session (field names from @anthropic-ai/claude-agent-sdk 0.3.x). */
export function sdkOptions(p: {
  persona: Persona; root: string; circuit: unknown; vendor: Record<string, unknown>; env: Record<string, string>;
  abortController: AbortController; canUseTool: unknown; resume?: string; stderr?: (s: string) => void;
}): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = { ...p.vendor };
  if (p.circuit) mcpServers.circuit = p.circuit;
  return {
    cwd: p.root,
    // user + project + local: the repo's .claude agents, skills, settings, permissions and the circuit-guard hook apply.
    settingSources: ["user", "project", "local"],
    agent: p.persona,
    mcpServers,
    strictMcpConfig: true,
    env: p.env,
    permissionMode: "default",
    canUseTool: p.canUseTool,
    includePartialMessages: true,
    abortController: p.abortController,
    ...(p.resume ? { resume: p.resume } : {}),
    ...(p.stderr ? { stderr: p.stderr } : {}),
  };
}
