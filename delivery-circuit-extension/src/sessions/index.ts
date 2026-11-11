// OWNER: sessions module (agent E). Replace this stub.
import type { CircuitMcpService, IdentityService, SessionsService } from "../core/contracts";
import type { ModuleBase } from "../core/util";

export function createSessions(base: ModuleBase, deps: { identity: IdentityService; mcp: CircuitMcpService }): SessionsService {
  void base; void deps;
  return { start: async () => { throw new Error("not implemented"); } };
}
