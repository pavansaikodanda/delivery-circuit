// Circuit MCP service: a loopback Streamable HTTP server (started lazily, random port, one bearer token per
// persona), persona config files for Claude Code sessions, and in-process servers for Agent SDK sessions.
import type {
  CircuitMcpService, ConnectionsService, Identity, IdentityService, McpEndpoint, Persona, ProjectContextService,
} from "../core/contracts";
import * as fs from "fs";
import type { ModuleBase } from "../core/util";
import { newToken, startCircuitHttp, type CircuitHttp } from "./http";
import { localPersonaFile, writePersonaConfigFile } from "./personaConfig";
import { readTestResults } from "./testResults";
import { createCircuitServer, SERVER_NAME, type CircuitData } from "./tools";

export function createMcp(base: ModuleBase, deps: { identity: IdentityService; connections: ConnectionsService; project: ProjectContextService }): CircuitMcpService {
  const { root, log } = base;
  const { identity, connections, project } = deps;
  let tokens: Record<Persona, string> | undefined;
  let host: CircuitHttp | undefined;
  let starting: Promise<CircuitHttp> | undefined;
  /** GitHub login the current tokens were issued to. */
  let boundLogin: string | undefined;
  const ALL: Persona[] = ["architect", "developer", "tester"];

  const who = (persona: Persona): Identity => identity.get() ?? {
    login: "", personas: [persona], active: persona, isAdmin: false, owner: "", repo: "", orgOwned: true,
  };

  /** Only personas the signed-in person holds get an endpoint (Architect transcripts stay with architects). */
  function assertPersona(persona: Persona): void {
    const id = identity.get();
    if (!id) throw new Error("Sign in to GitHub first: the Circuit MCP is bound to your persona.");
    if (!id.personas.includes(persona)) throw new Error(`${id.login || "You"} ${id.login ? "is" : "are"} not in the ${persona} team, so no ${persona} Circuit MCP endpoint is issued.`);
  }

  /** Checked on every request and tool call, not only when an endpoint is issued: a token stops working as soon as
   *  the signed-in person changes or leaves the persona's team. */
  function allowed(persona: Persona): boolean {
    const id = identity.get();
    return !!id && !!id.login && id.login === boundLogin && id.personas.includes(persona);
  }

  /** Rotates the tokens of personas the person no longer holds (all of them when the login changed) and deletes their
   *  .local.mcp.json files, so a running or future Claude session can't keep using an old bearer token. */
  function onIdentity(id: Identity | null): void {
    const login = id?.login || undefined;
    if (tokens) {
      const lost = ALL.filter((p) => !login || login !== boundLogin || !id!.personas.includes(p));
      for (const p of lost) {
        tokens[p] = newToken(); // the HTTP host reads this same object, so the old token is refused from now on
        try { fs.rmSync(localPersonaFile(root, p), { force: true }); } catch { /* best effort */ }
      }
      if (lost.length) log(`Circuit MCP: revoked ${lost.join(", ")} access after an identity change`);
    }
    boundLogin = login;
  }
  const sub = identity.onDidChange((id) => onIdentity(id));
  base.ctx.subscriptions?.push(sub);

  const data: CircuitData = {
    features: () => project.features(),
    feature: (id) => project.feature(id),
    queue: (p) => project.queue(who(p), p),
    testResults: (suite) => readTestResults(root, suite),
    prs: () => project.prs(),
    sources: () => project.sources(),
    transcript: (id) => project.transcript(id),
    connections: () => connections.list(),
  };
  // v3 detail reads (design_get, decisions_get, org_snapshot_get, story_get), served by the project service.
  data.story = (key: string) => project.story(key);
  data.design = (id: string) => project.design(id);
  data.decisions = (id: string) => project.decisions(id);
  data.orgSnapshot = (id: string) => project.orgSnapshot(id);

  async function ensureHost(): Promise<CircuitHttp> {
    if (host) return host;
    starting ??= (async () => {
      tokens = { architect: newToken(), developer: newToken(), tester: newToken() };
      boundLogin = identity.get()?.login;
      const h = await startCircuitHttp({ tokens, authorize: allowed, makeServer: (p) => createCircuitServer(p, guarded(p)), log });
      log(`Circuit MCP listening on 127.0.0.1:${h.port}`);
      return h;
    })();
    try { host = await starting; return host; } finally { starting = undefined; }
  }

  /** The data callbacks for one persona, refusing once that persona is no longer the person's. */
  function guarded(persona: Persona): CircuitData {
    const check = () => { if (!allowed(persona)) throw new Error(`Circuit MCP access for ${persona} was revoked: the signed-in GitHub identity no longer holds that persona.`); };
    return Object.fromEntries(Object.entries(data).map(([k, fn]) => [k, (...a: unknown[]) => { check(); return (fn as (...x: unknown[]) => unknown)(...a); }])) as unknown as CircuitData;
  }

  async function endpoint(persona: Persona): Promise<McpEndpoint> {
    assertPersona(persona);
    const h = await ensureHost();
    // Tokens were issued to someone else (sign-out / sign-in in this window): start over with fresh ones.
    if (identity.get()?.login !== boundLogin) onIdentity(identity.get());
    return { url: h.url, token: tokens![persona], persona };
  }

  return {
    endpoint,
    async writePersonaConfig(persona) {
      const ep = await endpoint(persona);
      const r = await writePersonaConfigFile(root, persona, ep);
      if (r.fixed.length) log(`Circuit MCP: ${persona} config used verified URLs for ${r.fixed.join(", ")}`);
      if (r.dropped.length) log(`Circuit MCP: ${persona} config left out servers without a valid URL: ${r.dropped.join(", ")}`);
      return r.file;
    },
    sdkServer(persona) {
      assertPersona(persona);
      // Same shape as createSdkMcpServer() from @anthropic-ai/claude-agent-sdk: { type: "sdk", name, instance }.
      if (identity.get()?.login !== boundLogin) onIdentity(identity.get());
      return { type: "sdk", name: SERVER_NAME, instance: createCircuitServer(persona, guarded(persona)) };
    },
    async stop() {
      const h = host;
      host = undefined; tokens = undefined; boundLogin = undefined;
      if (h) { await h.close(); log("Circuit MCP stopped"); }
    },
  };
}
