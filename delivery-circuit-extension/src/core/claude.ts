// Locating Claude Code. No vscode import: used by sessions (terminal + panel), setup checks and the testing engine.
import * as fs from "fs";
import { createRequire } from "module";
import * as path from "path";

export interface ClaudeExecutable {
  /** program to start */
  shellPath: string;
  /** arguments that come before Claude's own (e.g. the cli.js path when running through node) */
  prefixArgs: string[];
  /** true when only a .cmd shim was found: cmd.exe would re-parse the arguments */
  viaCmdShim: boolean;
}

export interface FsProbe {
  exists(p: string): boolean;
  read(p: string): string;
}

/**
 * Find claude on PATH. On Windows prefer claude.exe; for an npm claude.cmd shim, run the program the shim points at
 * (bin/claude.exe, or node + cli.js) so the arguments never pass through cmd.exe.
 */
export function resolveClaude(envPath: string, platform: NodeJS.Platform, fsp: FsProbe, pathExt = ".COM;.EXE;.BAT;.CMD"): ClaudeExecutable {
  const sep = platform === "win32" ? ";" : ":";
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const dirs = envPath.split(sep).map((d) => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
  if (platform !== "win32") {
    for (const d of dirs) { const p = join(d, "claude"); if (fsp.exists(p)) return { shellPath: p, prefixArgs: [], viaCmdShim: false }; }
    return { shellPath: "claude", prefixArgs: [], viaCmdShim: false };
  }
  void pathExt;
  for (const d of dirs) { const p = join(d, "claude.exe"); if (fsp.exists(p)) return { shellPath: p, prefixArgs: [], viaCmdShim: false }; }
  for (const d of dirs) {
    const shim = join(d, "claude.cmd");
    if (!fsp.exists(shim)) continue;
    const target = parseCmdShim(fsp.read(shim), d);
    if (target?.exe && fsp.exists(target.exe)) return { shellPath: target.exe, prefixArgs: [], viaCmdShim: false };
    if (target?.script && fsp.exists(target.script)) {
      const localNode = join(d, "node.exe");
      return { shellPath: fsp.exists(localNode) ? localNode : "node.exe", prefixArgs: [target.script], viaCmdShim: false };
    }
    return { shellPath: shim, prefixArgs: [], viaCmdShim: true };
  }
  return { shellPath: "claude.exe", prefixArgs: [], viaCmdShim: false };
}

/** Read the program an npm-style .cmd shim launches: "%dp0%\...\claude.exe" or "%dp0%\...\cli.js". */
export function parseCmdShim(content: string, dir: string): { exe?: string; script?: string } | undefined {
  const m = content.match(/"%(?:~)?dp0%?\\?([^"]+?\.(exe|js|mjs|cjs))"/i);
  if (!m) return undefined;
  const p = path.win32.join(dir, m[1].replace(/^\\+/, ""));
  return /\.exe$/i.test(p) ? { exe: p } : { script: p };
}


const realFs: FsProbe = { exists: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }, read: (p) => fs.readFileSync(p, "utf8") };

/** True when the Agent SDK's own platform package (with its bundled Claude Code binary) is installed next to it. */
export function bundledClaudeAvailable(platform = process.platform, arch = process.arch): boolean {
  const names = platform === "linux"
    ? [`@anthropic-ai/claude-agent-sdk-linux-${arch}`, `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`]
    : [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`];
  const req = createRequire(typeof __filename === "string" ? __filename : path.join(process.cwd(), "index.js"));
  return names.some((n) => { try { req.resolve(`${n}/package.json`); return true; } catch { return false; } });
}

let cachedExe: string | null | undefined;

/**
 * Executable for Agent SDK sessions. undefined = let the SDK use its bundled binary. The packaged VSIX leaves the
 * 300 MB platform binary out, so sessions then run the person's installed Claude Code (native claude.exe / claude,
 * or an npm install's cli.js). Returns undefined too when nothing usable is found; the SDK then explains.
 */
export function sdkClaudeExecutable(): string | undefined {
  if (cachedExe !== undefined) return cachedExe ?? undefined;
  cachedExe = null;
  if (bundledClaudeAvailable()) return undefined;
  const exe = resolveClaude(process.env.PATH ?? process.env.Path ?? "", process.platform, realFs);
  if (exe.viaCmdShim) return undefined;
  const target = exe.prefixArgs[0] ?? exe.shellPath;
  if (path.isAbsolute(target) && realFs.exists(target)) cachedExe = target;
  return cachedExe ?? undefined;
}

type AgentSdk = typeof import("@anthropic-ai/claude-agent-sdk", { with: { "resolution-mode": "import" } });

/**
 * Loads the ESM-only Agent SDK lazily (the extension bundle is CommonJS) and fills in pathToClaudeCodeExecutable
 * when the SDK's bundled binary is not installed. Use this instead of import("@anthropic-ai/claude-agent-sdk").
 */
export async function loadAgentSdk(): Promise<AgentSdk> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const withExe = <T extends { options?: any }>(params: T): T => {
    const exe = sdkClaudeExecutable();
    if (!exe || params?.options?.pathToClaudeCodeExecutable) return params;
    return { ...params, options: { ...(params.options ?? {}), pathToClaudeCodeExecutable: exe } };
  };
  return {
    ...sdk,
    query: ((params: any) => sdk.query(withExe(params))) as AgentSdk["query"],
    startup: ((params: any) => sdk.startup(withExe(params))) as AgentSdk["startup"],
  };
}
