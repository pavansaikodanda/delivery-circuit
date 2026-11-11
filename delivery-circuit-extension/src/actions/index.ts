// OWNER: actions module (agent E). Replace this stub.
import type { ActionsService, ConnectionsService, IdentityService, ProjectContextService, SessionsService } from "../core/contracts";
import type { ModuleBase } from "../core/util";

export function createActions(base: ModuleBase, deps: { identity: IdentityService; connections: ConnectionsService; sessions: SessionsService; project: ProjectContextService }): ActionsService {
  void base; void deps;
  return { run: async () => { throw new Error("not implemented"); }, allowed: () => false };
}
