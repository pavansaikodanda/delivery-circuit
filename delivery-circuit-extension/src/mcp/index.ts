// OWNER: mcp module (agent B). Replace this stub.
import type { CircuitMcpService, ConnectionsService, IdentityService, ProjectContextService } from "../core/contracts";
import type { ModuleBase } from "../core/util";

export function createMcp(base: ModuleBase, deps: { identity: IdentityService; connections: ConnectionsService; project: ProjectContextService }): CircuitMcpService {
  void base; void deps;
  return {
    endpoint: async () => { throw new Error("not implemented"); }, writePersonaConfig: async () => { throw new Error("not implemented"); },
    sdkServer: () => undefined, stop: async () => {},
  };
}
