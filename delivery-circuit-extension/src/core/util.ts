// Small shared helpers. No module-specific logic here.
import { execFile } from "child_process";
import type * as vscode from "vscode";

export interface ModuleBase {
  ctx: vscode.ExtensionContext;
  root: string;
  log: (msg: string) => void;
}

export interface ExecResult { code: number; stdout: string; stderr: string }

/** Run a program. Never pass secrets in args; use env.
 *  On Windows the default is shell:true so .cmd shims (sf, gh, claude, npx) resolve; cmd.exe then joins the arguments
 *  with spaces, so callers must quote arguments themselves or send user text
 *  through `input`. Pass `shell: false` to run a real executable (git, node, an .exe) with arguments passed verbatim. */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; shell?: boolean } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      // sf, gh, claude are .cmd shims on Windows
      shell: opts.shell ?? process.platform === "win32",
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    if (opts.input !== undefined) { child.stdin?.end(opts.input); }
  });
}

/** Parse "--json" output of sf/gh; returns undefined on failure. */
export function parseJson<T = any>(text: string): T | undefined {
  try { return JSON.parse(text) as T; } catch { return undefined; }
}

/** owner/repo from the workspace's git remote "origin" (https or ssh form). */
export async function gitRemote(root: string): Promise<{ owner: string; repo: string } | undefined> {
  const r = await run("git", ["remote", "get-url", "origin"], { cwd: root, timeoutMs: 10_000, shell: false });
  const m = r.stdout.trim().match(/github\.com[:/]([^/]+)\/([^/.\s]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

export function nonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
