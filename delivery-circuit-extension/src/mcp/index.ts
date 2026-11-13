// Circuit MCP service: a loopback Streamable HTTP server (started lazily, random port, one bearer token) that serves
// transcript_get to the Architect's Claude session, and the per-session MCP config files.
import * as fs from "fs";
import type { CircuitMcpService, IdentityService, McpEndpoint, ProjectService, Role } from "../core/contracts";
import { ROLE_AGENT } from "../core/contracts";
import type { ModuleBase } from "../core/util";
import { newToken, startCircuitHttp, type CircuitHttp } from "./http";
import { localPersonaFile, personaFile, writePersonaConfigFile } from "./personaConfig";
import { createCircuitServer, type CircuitData } from "./tools";

const SCOPE = "architect";

export function createMcp(base: ModuleBase, deps: { identity: IdentityService; project: Pick<ProjectService, "transcript"> }): CircuitMcpService & { endpoint(): Promise<McpEndpoint> } {
  const { root, log } = base;
  const { identity, project } = deps;
  let tokens: Record<string, string> | undefined;
  let host: CircuitHttp | undefined;
  let starting: Promise<CircuitHttp> | undefined;
  /** GitHub login the token was issued to. */
  let boundLogin: string | undefined;

  /** Checked on every request: the token stops working as soon as the person stops acting as Architect or signs out. */
  const allowed = () => {
    const id = identity.get();
    return !!id && !!id.login && id.login === boundLogin && id.active === "architect";
  };

  function rotate(): void {
    if (tokens) tokens[SCOPE] = newToken(); // the HTTP host reads this same object: the old token is refused from now on
    try { fs.rmSync(localPersonaFile(root, SCOPE), { force: true }); } catch { /* best effort */ }
  }
  base.ctx.subscriptions?.push(identity.onDidChange((id) => {
    if (tokens && (!id || id.login !== boundLogin || id.active !== "architect")) { rotate(); log("Circuit MCP: token revoked after an identity or role change"); }
    boundLogin = id?.login || undefined;
  }));

  const data: CircuitData = {
    transcript: (sourceId) => {
      if (!allowed()) throw new Error("transcript_get is for the Architect only.");
      return project.transcript(sourceId);
    },
  };

  async function ensureHost(): Promise<CircuitHttp> {
    if (host) return host;
    starting ??= (async () => {
      tokens = { [SCOPE]: newToken() };
      boundLogin = identity.get()?.login;
      const h = await startCircuitHttp({ tokens, authorize: allowed, makeServer: () => createCircuitServer(data), log });
      log(`Circuit MCP listening on 127.0.0.1:${h.port}`);
      return h;
    })();
    try { host = await starting; return host; } finally { starting = undefined; }
  }

  async function endpoint(): Promise<McpEndpoint> {
    const id = identity.get();
    if (!id?.login) throw new Error("Sign in to GitHub first.");
    if (id.active !== "architect") throw new Error("The Circuit MCP is for the Architect role only.");
    const h = await ensureHost();
    if (id.login !== boundLogin) { rotate(); boundLogin = id.login; }
    return { url: h.url, token: tokens![SCOPE] };
  }

  return {
    endpoint,
    async writeSessionConfig(role: Role) {
      const agent = ROLE_AGENT[role];
      if (!agent) return undefined;
      if (role !== "architect") return fs.existsSync(personaFile(root, agent)) ? personaFile(root, agent) : undefined;
      const r = await writePersonaConfigFile(root, agent, await endpoint());
      if (r.fixed.length) log(`Circuit MCP: session config used verified URLs for ${r.fixed.join(", ")}`);
      if (r.dropped.length) log(`Circuit MCP: session config left out servers without a valid URL: ${r.dropped.join(", ")}`);
      return r.file;
    },
    async stop() {
      const h = host;
      host = undefined; tokens = undefined; boundLogin = undefined;
      if (h) { await h.close(); log("Circuit MCP stopped"); }
    },
  };
}
