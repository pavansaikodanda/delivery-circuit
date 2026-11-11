// Circuit MCP service: a loopback Streamable HTTP server (started lazily, random port, one bearer token per
// persona), persona config files for Claude Code sessions, and in-process servers for Agent SDK sessions.
import type {
  CircuitMcpService, ConnectionsService, Identity, IdentityService, McpEndpoint, Persona, ProjectContextService,
} from "../core/contracts";
import type { ModuleBase } from "../core/util";
import { newToken, startCircuitHttp, type CircuitHttp } from "./http";
import { writePersonaConfigFile } from "./personaConfig";
import { readTestResults } from "./testResults";
import { createCircuitServer, SERVER_NAME, type CircuitData } from "./tools";

export function createMcp(base: ModuleBase, deps: { identity: IdentityService; connections: ConnectionsService; project: ProjectContextService }): CircuitMcpService {
  const { root, log } = base;
  const { identity, connections, project } = deps;
  let tokens: Record<Persona, string> | undefined;
  let host: CircuitHttp | undefined;
  let starting: Promise<CircuitHttp> | undefined;

  const who = (persona: Persona): Identity => identity.get() ?? {
    login: "", personas: [persona], active: persona, isAdmin: false, owner: "", repo: "", orgOwned: true,
  };

  /** Only personas the signed-in person holds get an endpoint (Architect transcripts stay with architects). */
  function assertPersona(persona: Persona): void {
    const id = identity.get();
    if (!id) throw new Error("Sign in to GitHub first: the Circuit MCP is bound to your persona.");
    if (!id.personas.includes(persona)) throw new Error(`${id.login || "You"} ${id.login ? "is" : "are"} not in the ${persona} team, so no ${persona} Circuit MCP endpoint is issued.`);
  }

  const data: CircuitData = {
    features: () => project.features(),
    feature: (id) => project.feature(id),
    queue: (p) => project.queue(who(p), p),
    jiraMap: (id) => project.jiraMap(id),
    testResults: (suite) => readTestResults(root, suite),
    prs: () => project.prs(),
    sources: () => project.sources(),
    transcript: (id) => project.transcript(id),
    connections: () => connections.list(),
  };

  async function ensureHost(): Promise<CircuitHttp> {
    if (host) return host;
    starting ??= (async () => {
      tokens = { architect: newToken(), developer: newToken(), tester: newToken() };
      const h = await startCircuitHttp({ tokens, makeServer: (p) => createCircuitServer(p, data), log });
      log(`Circuit MCP listening on 127.0.0.1:${h.port}`);
      return h;
    })();
    try { host = await starting; return host; } finally { starting = undefined; }
  }

  async function endpoint(persona: Persona): Promise<McpEndpoint> {
    assertPersona(persona);
    const h = await ensureHost();
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
      return { type: "sdk", name: SERVER_NAME, instance: createCircuitServer(persona, data) };
    },
    async stop() {
      const h = host;
      host = undefined; tokens = undefined;
      if (h) { await h.close(); log("Circuit MCP stopped"); }
    },
  };
}
