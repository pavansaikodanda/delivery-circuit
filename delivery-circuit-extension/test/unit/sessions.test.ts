import { describe, expect, it } from "vitest";
import { buildTerminalSpec, parseCmdShim, resolveClaude, unsafeForCmd, type FsProbe } from "../../src/sessions/terminal";

const fsOf = (files: Record<string, string>): FsProbe => ({ exists: (p) => p in files, read: (p) => files[p] ?? "" });
const native = { shellPath: "C:\\bin\\claude.exe", prefixArgs: [], viaCmdShim: false };

describe("terminal args", () => {
  it("builds claude --agent --mcp-config <prompt> with the role env", () => {
    const t = buildTerminalSpec("developer", "/dev-review-plan 42", "D:\\repo", "D:\\repo\\.claude\\personas\\developer.local.mcp.json", native);
    expect(t.name).toBe("Claude · Developer");
    expect(t.cwd).toBe("D:\\repo");
    expect(t.shellPath).toBe("C:\\bin\\claude.exe");
    expect(t.shellArgs).toEqual(["--agent", "developer", "--mcp-config", "D:\\repo\\.claude\\personas\\developer.local.mcp.json", "/dev-review-plan 42"]);
    expect(t.env).toEqual({ CIRCUIT_ROLE: "developer", ANTHROPIC_API_KEY: null, ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null });
  });
  it("keeps a hostile prompt as exactly one argv element", () => {
    const evil = `review "this"; rm -rf / && echo $(whoami) | calc & 'x'`;
    const t = buildTerminalSpec("tester", evil, "/r", "/r/c.json", { shellPath: "/usr/bin/claude", prefixArgs: [], viaCmdShim: false });
    expect(t.shellArgs.at(-1)).toBe(evil);
    expect(t.shellArgs.filter((a) => a.includes("rm -rf"))).toHaveLength(1);
    expect(t.shellArgs).toHaveLength(5);
  });
  it("ends option parsing before a prompt that starts with a dash, and omits an empty prompt", () => {
    expect(buildTerminalSpec("architect", "--dangerously-skip-permissions", "/r", "/c", native).shellArgs.slice(-2)).toEqual(["--", "--dangerously-skip-permissions"]);
    expect(buildTerminalSpec("architect", "  ", "/r", "/c", native).shellArgs).toEqual(["--agent", "architect", "--mcp-config", "/c"]);
  });
  it("a Lead runs plain claude (no agent), QA runs the tester agent, no config file is optional", () => {
    expect(buildTerminalSpec("lead", "/circuit-bootstrap", "/r", undefined, native)).toMatchObject({ name: "Claude · Lead", shellArgs: ["/circuit-bootstrap"] });
    expect(buildTerminalSpec("tester", "/qa-explore ACME-12", "/r", undefined, native)).toMatchObject({ name: "Claude · QA", shellArgs: ["--agent", "tester", "/qa-explore ACME-12"] });
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
