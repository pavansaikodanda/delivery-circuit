// Sessions: start Claude Code in an integrated terminal as a role (`claude --agent <agent> ... "/skill KEY"`). It runs
// as the person's logged-in claude: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN are removed.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ROLE_LABEL, type CircuitMcpService, type IdentityService, type Role, type SessionsService } from "../core/contracts";
import type { ModuleBase } from "../core/util";
import { buildTerminalSpec, resolveClaude } from "./terminal";

export function createSessions(base: ModuleBase, deps: { identity: IdentityService; mcp: CircuitMcpService }): SessionsService {
  const { identity, mcp } = deps;
  return {
    async start(role: Role, prompt: string) {
      const id = identity.get();
      if (!id) throw new Error("Sign in to GitHub first.");
      if (id.active !== role) throw new Error(`Switch to ${ROLE_LABEL[role]} first.`);
      const configPath = await mcp.writeSessionConfig(role);
      const exe = resolveClaude(process.env.PATH ?? process.env.Path ?? "", process.platform, {
        exists: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
        read: (p) => fs.readFileSync(p, "utf8"),
      });
      const spec = buildTerminalSpec(role, prompt, base.root, configPath, exe);
      const term = vscode.window.createTerminal({ name: spec.name, cwd: spec.cwd, shellPath: spec.shellPath, shellArgs: spec.shellArgs, env: spec.env });
      term.show();
      base.log(`session: ${ROLE_LABEL[role]} ${path.basename(exe.shellPath)} (prompt ${prompt.length} chars)`);
    },
  };
}
