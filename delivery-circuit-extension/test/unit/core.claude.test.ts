import { describe, expect, it } from "vitest";
import { bundledClaudeAvailable, loadAgentSdk, resolveClaude, sdkClaudeExecutable, type FsProbe } from "../../src/core/claude";
import { resolveClaude as viaSessions } from "../../src/sessions/terminal";
import { buildHome } from "../../src/views/model";
import type { Identity } from "../../src/core/contracts";

const probe = (files: Record<string, string>): FsProbe => ({ exists: (p) => p in files, read: (p) => files[p] ?? "" });

describe("core/claude", () => {
  it("sessions re-exports the same resolver", () => {
    expect(viaSessions).toBe(resolveClaude);
  });

  it("finds the native claude.exe on PATH, or follows an npm shim", () => {
    expect(resolveClaude("C:\\a;C:\\b", "win32", probe({ "C:\\b\\claude.exe": "" })).shellPath).toBe("C:\\b\\claude.exe");
    const shim = '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
    const r = resolveClaude("C:\\npm", "win32", probe({ "C:\\npm\\claude.cmd": shim, "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe": "" }));
    expect(r).toEqual({ shellPath: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe", prefixArgs: [], viaCmdShim: false });
  });

  it("detects the SDK's platform package (installed for development)", () => {
    expect(bundledClaudeAvailable(process.platform, process.arch)).toBe(true);
    expect(bundledClaudeAvailable("aix" as NodeJS.Platform, "ppc64")).toBe(false);
  });

  it("leaves the executable to the SDK when its bundled binary is installed", () => {
    expect(sdkClaudeExecutable()).toBeUndefined();
  });

  it("loadAgentSdk wraps query/startup and keeps the rest of the SDK", async () => {
    const sdk = await loadAgentSdk();
    expect(typeof sdk.query).toBe("function");
    expect(typeof sdk.startup).toBe("function");
    expect(typeof sdk.createSdkMcpServer).toBe("function");
  });
});

describe("identity notice in the sidebar", () => {
  const id: Identity = { login: "pat", personas: [], active: null, isAdmin: false, owner: "acme", repo: "crm", orgOwned: true,
    notice: "You are not in any persona team of acme (architects, developers, testers). Ask an org admin to add you." };
  const input = { hasRemote: true, identity: id, githubConnected: true, circuitInstalled: true, connections: [], queue: [],
    allowed: () => false, teams: {}, now: Date.parse("2026-11-11T00:00:00Z") };

  it("passes Identity.notice through to the home state", () => {
    const st = buildHome(input);
    expect(st.mode).toBe("no-persona");
    expect(st.notice).toMatch(/not in any persona team/);
  });

  it("omits it when there is none", () => {
    expect(buildHome({ ...input, identity: { ...id, notice: undefined, personas: ["developer"], active: "developer" } }).notice).toBeUndefined();
  });
});
