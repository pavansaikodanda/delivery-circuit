// Process runner used by the engine. The extension injects core/util.ts run() (array args, no shell strings with
// user input) so the engine itself stays free of VS Code and can be unit-tested or driven from a plain node script.

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<ExecResult>;

let current: Exec | undefined;

/** Called once by the testing service (or a script) before the engine spawns anything. */
export function setExec(exec: Exec): void {
  current = exec;
}

export function exec(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<ExecResult> {
  if (!current) throw new Error("Testing engine: no process runner configured (setExec was not called)");
  return current(cmd, args, opts);
}

/**
 * On Windows `sf` and `npx` are .cmd shims, so run() starts them through the shell, which joins arguments with
 * spaces. Arguments with spaces or shell punctuation are wrapped in double quotes. Callers only pass values that
 * contain no `"`, `%`, `^`, `&`, `|`, `<` or `>` (enforced here).
 */
export function shellArg(a: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return a;
  if (/["%^&|<>]/.test(a)) throw new Error(`Unsafe argument for a Windows shell: ${a.slice(0, 60)}`);
  return /[\s()',;=]/.test(a) ? `"${a}"` : a;
}
