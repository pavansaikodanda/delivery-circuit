import { describe, expect, it } from "vitest";
import { addUser, claudeEnv, newChat, reduce, sdkOptions, toolLabel, toolSummary, vendorServers } from "../../src/sessions/chat";
import { buildTerminalSpec, parseCmdShim, resolveClaude, unsafeForCmd, type FsProbe } from "../../src/sessions/terminal";

const fsOf = (files: Record<string, string>): FsProbe => ({ exists: (p) => p in files, read: (p) => files[p] ?? "" });
const native = { shellPath: "C:\\bin\\claude.exe", prefixArgs: [], viaCmdShim: false };

describe("terminal args", () => {
  it("builds claude --agent --mcp-config --strict-mcp-config <prompt> with the persona env", () => {
    const t = buildTerminalSpec("developer", "/dev-review-plan 42", "D:\\repo", "D:\\repo\\.claude\\personas\\developer.local.mcp.json", native);
    expect(t.name).toBe("Claude · Developer");
    expect(t.cwd).toBe("D:\\repo");
    expect(t.shellPath).toBe("C:\\bin\\claude.exe");
    expect(t.shellArgs).toEqual(["--agent", "developer", "--mcp-config", "D:\\repo\\.claude\\personas\\developer.local.mcp.json", "--strict-mcp-config", "/dev-review-plan 42"]);
    expect(t.env).toEqual({ CIRCUIT_PERSONA: "developer", ANTHROPIC_API_KEY: null, ANTHROPIC_AUTH_TOKEN: null });
  });
  it("keeps a hostile prompt as exactly one argv element", () => {
    const evil = `review "this"; rm -rf / && echo $(whoami) | calc & 'x'`;
    const t = buildTerminalSpec("tester", evil, "/r", "/r/c.json", { shellPath: "/usr/bin/claude", prefixArgs: [], viaCmdShim: false });
    expect(t.shellArgs.at(-1)).toBe(evil);
    expect(t.shellArgs.filter((a) => a.includes("rm -rf"))).toHaveLength(1);
    expect(t.shellArgs).toHaveLength(6);
  });
  it("ends option parsing before a prompt that starts with a dash, and omits an empty prompt", () => {
    expect(buildTerminalSpec("architect", "--dangerously-skip-permissions", "/r", "/c", native).shellArgs.slice(-2)).toEqual(["--", "--dangerously-skip-permissions"]);
    expect(buildTerminalSpec("architect", "  ", "/r", "/c", native).shellArgs.at(-1)).toBe("--strict-mcp-config");
  });
  it("refuses cmd metacharacters when only a .cmd shim exists", () => {
    const shim = { shellPath: "C:\\npm\\claude.cmd", prefixArgs: [], viaCmdShim: true };
    expect(() => buildTerminalSpec("developer", "a & calc", "/r", "/c", shim)).toThrow(/cmd\.exe/);
    expect(buildTerminalSpec("developer", "/dev-review-pr 12", "/r", "/c", shim).shellArgs.at(-1)).toBe("/dev-review-pr 12");
    expect(unsafeForCmd("100%")).toBe(true);
    expect(unsafeForCmd("/qa-explore 3")).toBe(false);
  });
  it("puts node + cli.js before Claude's arguments", () => {
    const t = buildTerminalSpec("tester", "hi", "/r", "/c", { shellPath: "node.exe", prefixArgs: ["C:\\npm\\cli.js"], viaCmdShim: false });
    expect(t.shellArgs.slice(0, 3)).toEqual(["C:\\npm\\cli.js", "--agent", "tester"]);
  });
});

describe("resolving claude", () => {
  it("prefers claude.exe on PATH (Windows)", () => {
    const r = resolveClaude("C:\\a;C:\\b", "win32", fsOf({ "C:\\b\\claude.exe": "", "C:\\a\\claude.cmd": "" }));
    expect(r).toEqual({ shellPath: "C:\\b\\claude.exe", prefixArgs: [], viaCmdShim: false });
  });
  it("follows an npm shim to bin/claude.exe", () => {
    const shim = `@ECHO off\r\nGOTO start\r\n:start\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`;
    const exe = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
    expect(resolveClaude("C:\\npm", "win32", fsOf({ "C:\\npm\\claude.cmd": shim, [exe]: "" }))).toEqual({ shellPath: exe, prefixArgs: [], viaCmdShim: false });
  });
  it("follows an older shim to node + cli.js", () => {
    const shim = `"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*`;
    const js = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    expect(parseCmdShim(shim, "C:\\npm")).toEqual({ script: js });
    const r = resolveClaude("C:\\npm", "win32", fsOf({ "C:\\npm\\claude.cmd": shim, [js]: "", "C:\\npm\\node.exe": "" }));
    expect(r).toEqual({ shellPath: "C:\\npm\\node.exe", prefixArgs: [js], viaCmdShim: false });
  });
  it("falls back to the shim, flagged, when its target is unknown", () => {
    expect(resolveClaude("C:\\x", "win32", fsOf({ "C:\\x\\claude.cmd": "@echo off" }))).toEqual({ shellPath: "C:\\x\\claude.cmd", prefixArgs: [], viaCmdShim: true });
  });
  it("uses PATH on POSIX", () => {
    expect(resolveClaude("/usr/local/bin:/home/u/.local/bin", "linux", fsOf({ "/home/u/.local/bin/claude": "" })).shellPath).toBe("/home/u/.local/bin/claude");
    expect(resolveClaude("", "darwin", fsOf({})).shellPath).toBe("claude");
  });
});

describe("panel chat", () => {
  it("removes API-key auth from Claude's environment and sets the persona", () => {
    const env = claudeEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o" }, "tester");
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "o", CIRCUIT_PERSONA: "tester" });
  });
  it("takes vendor servers from the persona config, skipping the Circuit server and VERIFY placeholders", () => {
    const r = vendorServers({ mcpServers: {
      circuit: { type: "http", url: "http://127.0.0.1:1/mcp" },
      github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
      atlassian: { type: "http", url: "VERIFY: Atlassian URL" },
      slack: { url: "https://mcp.slack.com/mcp" },
      salesforce: { command: "npx", args: ["-y", "@salesforce/mcp"] },
    } });
    expect(Object.keys(r.servers)).toEqual(["github", "slack", "salesforce"]);
    expect(r.servers.slack).toEqual({ url: "https://mcp.slack.com/mcp", type: "http" });
    expect(r.skipped).toEqual(["atlassian"]);
  });
  it("builds SDK options with the repo settings, the persona agent and strict MCP", () => {
    const ac = new AbortController();
    const o = sdkOptions({ persona: "developer", root: "/r", circuit: { type: "sdk", name: "circuit" }, vendor: { github: { type: "http", url: "https://x" } },
      env: { A: "1" }, abortController: ac, canUseTool: () => null, resume: "s1" });
    expect(o).toMatchObject({ cwd: "/r", agent: "developer", settingSources: ["user", "project", "local"], strictMcpConfig: true, permissionMode: "default", includePartialMessages: true, resume: "s1" });
    expect(Object.keys(o.mcpServers as object)).toEqual(["github", "circuit"]);
    expect(o.abortController).toBe(ac);
    expect("resume" in sdkOptions({ persona: "tester", root: "/r", circuit: undefined, vendor: {}, env: {}, abortController: ac, canUseTool: null })).toBe(false);
  });
  it("reduces a streamed conversation into compact rows and a footer", () => {
    let s = addUser(newChat("developer"), "/dev-review-plan 42");
    s = { ...s, running: true };
    s = reduce(s, { type: "system", subtype: "init", session_id: "S", model: "claude-sonnet-5-5", mcp_servers: [{ name: "circuit", status: "connected" }, { name: "atlassian", status: "needs-auth" }] });
    expect(s.mcpIssues).toEqual([{ name: "atlassian", status: "needs-auth" }]);
    s = reduce(s, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Read" } }, parent_tool_use_id: null });
    s = reduce(s, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ing the plan" } }, parent_tool_use_id: null });
    expect(s.items.at(-1)).toMatchObject({ kind: "assistant", text: "Reading the plan", streaming: true });
    s = reduce(s, { type: "assistant", parent_tool_use_id: null, message: { content: [
      { type: "text", text: "Reading the plan." },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/r/docs/plans/ABC-1/PLAN.md" } },
      { type: "tool_use", id: "t2", name: "mcp__circuit__feature_status", input: { id: "001" } },
    ] } });
    expect(s.items.filter((i) => i.streaming)).toHaveLength(0);
    expect(s.items.find((i) => i.id === "t1")).toMatchObject({ kind: "tool", tool: "Read", text: "/r/docs/plans/ABC-1/PLAN.md", status: "running", file: "/r/docs/plans/ABC-1/PLAN.md" });
    expect(s.items.find((i) => i.id === "t2")).toMatchObject({ tool: "circuit · feature_status" });
    s = reduce(s, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }, { type: "tool_result", tool_use_id: "t2", is_error: true }] } });
    expect(s.items.find((i) => i.id === "t1")!.status).toBe("ok");
    expect(s.items.find((i) => i.id === "t2")!.status).toBe("error");
    s = reduce(s, { type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.0123, session_id: "S", permission_denials: [] });
    expect(s).toMatchObject({ running: false, turns: 3, costUsd: 0.0123, sessionId: "S", model: "claude-sonnet-5-5" });
  });
  it("shows sub-agent tool calls nested, hides their text, and reports error results", () => {
    let s = newChat("tester");
    s = reduce(s, { type: "assistant", parent_tool_use_id: "p", message: { content: [{ type: "text", text: "inner" }, { type: "tool_use", id: "n1", name: "Bash", input: { command: "sf org list" } }] } });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ nested: true, text: "sf org list" });
    s = reduce(s, { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 80, total_cost_usd: 1 });
    expect(s.items.at(-1)).toMatchObject({ kind: "error", text: "Stopped: maximum turns reached" });
    expect(s.items[0].status).toBe("ok");
    expect(reduce(s, { type: "rate_limit_event" })).toBe(s);
  });
  it("summarises tool input compactly", () => {
    expect(toolSummary("Grep", { pattern: "TC:", path: "force-app" })).toBe("TC:  in force-app");
    expect(toolSummary("Bash", { command: "x".repeat(300) })).toHaveLength(140);
    expect(toolLabel("mcp__github__get_pull_request")).toBe("github · get_pull_request");
  });
});
