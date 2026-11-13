// Locating Claude Code. No vscode import: used by sessions (terminal) and the read-only design-page reader.
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

