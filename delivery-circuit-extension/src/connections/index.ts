// Connections + identity: who the person is (GitHub teams -> roles) and the logins the circuit needs. The rows are
// shown on the sidebar's Connections tab (src/views); this module has no page of its own.
import type { ConnectionsService } from "../core/contracts";
import type { ModuleBase } from "../core/util";
import { createIdentity, type IdentityInternals } from "./identity";
import { createConnections, type ConnectionsInternals } from "./service";

export function createIdentityAndConnections(base: ModuleBase): { identity: IdentityInternals; connections: ConnectionsInternals & ConnectionsService } {
  let identity: IdentityInternals | undefined;
  const { service: connections, gh } = createConnections(base, () => identity?.get() ?? null);
  identity = createIdentity(base, gh, () => ({ owner: connections.config().githubOrg, repo: connections.config().githubRepo }));
  // the GitHub row names the repo, which comes with the identity
  identity.onDidChange(() => { void connections.check("github"); });
  return { identity, connections };
}
