// OWNER: testing module (agent D). Replace this stub.
import * as vscode from "vscode";
import type { CircuitServices, ConnectionsService, TestingService } from "../core/contracts";
import type { ModuleBase } from "../core/util";

export function createTesting(base: ModuleBase, deps: { connections: ConnectionsService }): TestingService {
  const ev = new vscode.EventEmitter<void>(); void base; void deps;
  return { suites: async () => [], run: async () => { throw new Error("not implemented"); }, cancel: () => {}, runs: async () => [], onDidChange: ev.event };
}
export function registerTestingUI(s: CircuitServices): void { void s; }
