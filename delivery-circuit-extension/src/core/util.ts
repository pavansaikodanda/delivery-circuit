// Small shared helpers. No module-specific logic here.
import { execFile } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import type { DeepLink } from "./contracts";

export interface ModuleBase {
  ctx: vscode.ExtensionContext;
  root: string;
  /** bundled sf-delivery-circuit plugin */
  pluginRoot: string;
  log: (msg: string) => void;
}

export interface ExecResult { code: number; stdout: string; stderr: string }

/** Run a program without a shell (no injection). Never pass secrets in args; use env. */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      // sf, gh, claude are .cmd shims on Windows
      shell: process.platform === "win32",
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
  const r = await run("git", ["remote", "get-url", "origin"], { cwd: root, timeoutMs: 10_000 });
  const m = r.stdout.trim().match(/github\.com[:/]([^/]+)\/([^/.\s]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

export async function gitBranch(root: string): Promise<string> {
  const r = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, timeoutMs: 10_000 });
  return r.stdout.trim();
}

/** Open any deep link: external URL in the browser, file in the editor, report in the browser. */
export async function openLink(root: string, link: DeepLink): Promise<void> {
  if (link.kind === "file") {
    const doc = await vscode.workspace.openTextDocument(path.join(root, link.target));
    await vscode.window.showTextDocument(doc, { preview: false });
    return;
  }
  if (link.kind === "report") {
    await vscode.env.openExternal(vscode.Uri.file(path.join(root, link.target)));
    return;
  }
  if (!/^https:\/\//.test(link.target)) throw new Error(`Refusing to open non-https link: ${link.target}`);
  await vscode.env.openExternal(vscode.Uri.parse(link.target));
}

export function nonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
