// Terminal-mode session: argv construction and locating the claude executable. No vscode import.
// The prompt is always ONE argv element; nothing here builds a shell string.
import * as path from "path";
import type { Persona } from "../core/contracts";

export const PERSONA_TITLE: Record<Persona, string> = { architect: "Architect", developer: "Developer", tester: "Tester" };

// The resolver lives in core so the testing engine's Agent SDK calls can use the installed Claude Code too.
export { resolveClaude, parseCmdShim, type ClaudeExecutable, type FsProbe } from "../core/claude";
import type { ClaudeExecutable } from "../core/claude";

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

/** createTerminal options for `claude --agent <persona> --mcp-config <file> --strict-mcp-config <prompt>`. */
export function buildTerminalSpec(persona: Persona, prompt: string, root: string, mcpConfigPath: string, exe: ClaudeExecutable): TerminalSpec {
  const args = [...exe.prefixArgs, "--agent", persona, "--mcp-config", mcpConfigPath, "--strict-mcp-config"];
  if (prompt.trim()) {
    if (exe.viaCmdShim && unsafeForCmd(prompt)) {
      throw new Error("Only claude.cmd was found, and the prompt has characters cmd.exe would interpret. Install the native claude.exe or use panel mode.");
    }
    // A prompt starting with "-" would be read as an option: "--" ends option parsing first.
    if (prompt.startsWith("-")) args.push("--");
    args.push(prompt);
  }
  return {
    name: `Claude · ${PERSONA_TITLE[persona]}`,
    cwd: root,
    shellPath: exe.shellPath,
    shellArgs: args,
    // null removes the variable: subscription auth only, never an API key.
    env: { CIRCUIT_PERSONA: persona, ANTHROPIC_API_KEY: null, ANTHROPIC_AUTH_TOKEN: null },
  };
}
