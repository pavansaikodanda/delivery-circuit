// Terminal session: argv for `claude [--agent <agent>] [--mcp-config <file>] <prompt>`. No vscode import.
// The prompt is always ONE argv element; nothing here builds a shell string.
import { ROLE_AGENT, ROLE_LABEL, type Role } from "../core/contracts";
import type { ClaudeExecutable } from "../core/claude";

export { resolveClaude, parseCmdShim, type ClaudeExecutable, type FsProbe } from "../core/claude";

/** Characters cmd.exe interprets even inside an argument; refused when only a .cmd shim is available. */
export function unsafeForCmd(s: string): boolean {
  return /[&|<>^%!"\r\n]/.test(s);
}

export interface TerminalSpec {
  name: string;
  cwd: string;
  shellPath: string;
  shellArgs: string[];
  env: Record<string, string | null>;
}

export function buildTerminalSpec(role: Role, prompt: string, root: string, mcpConfigPath: string | undefined, exe: ClaudeExecutable): TerminalSpec {
  const args = [...exe.prefixArgs];
  const agent = ROLE_AGENT[role];
  if (agent) args.push("--agent", agent);
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  if (prompt.trim()) {
    if (exe.viaCmdShim && unsafeForCmd(prompt)) {
      throw new Error("Only claude.cmd was found, and the prompt has characters cmd.exe would interpret. Install the native claude.exe.");
    }
    // A prompt starting with "-" would be read as an option: "--" ends option parsing first.
    if (prompt.startsWith("-")) args.push("--");
    args.push(prompt);
  }
  return {
    name: `Claude · ${ROLE_LABEL[role]}`,
    cwd: root,
    shellPath: exe.shellPath,
    shellArgs: args,
    // null removes the variable: the person's logged-in claude only, never an API key or a stored OAuth token.
    env: { CIRCUIT_ROLE: role, ANTHROPIC_API_KEY: null, ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null },
  };
}
