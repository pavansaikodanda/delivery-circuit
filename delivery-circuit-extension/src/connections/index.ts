// OWNER: connections module (agent A). Replace this stub.
import * as vscode from "vscode";
import type { CircuitServices, ConnectionsService, IdentityService } from "../core/contracts";
import type { ModuleBase } from "../core/util";

export function createIdentityAndConnections(base: ModuleBase): { identity: IdentityService; connections: ConnectionsService } {
  const idEv = new vscode.EventEmitter<any>(); const cEv = new vscode.EventEmitter<void>();
  const identity: IdentityService = { get: () => null, refresh: async () => null, setActive: async () => {}, onDidChange: idEv.event };
  const connections: ConnectionsService = {
    list: async () => [], check: async (id) => ({ id, label: id, scope: "personal", state: "unknown", neededBy: [] }),
    connect: async (id) => ({ id, label: id, scope: "personal", state: "unknown", neededBy: [] }), disconnect: async () => {},
    onDidChange: cEv.event, githubToken: async () => { throw new Error("not implemented"); }, jira: async () => undefined,
    firefliesKey: async () => undefined, sfAlias: (r) => r,
  };
  void base; return { identity, connections };
}
export function registerConnectionsUI(s: CircuitServices): void { void s; }
