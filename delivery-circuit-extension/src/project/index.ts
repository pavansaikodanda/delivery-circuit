// OWNER: project module (agent B). Replace this stub.
import * as vscode from "vscode";
import type { ConnectionsService, IdentityService, ProjectContextService } from "../core/contracts";
import type { ModuleBase } from "../core/util";

export function createProject(base: ModuleBase, deps: { identity: IdentityService; connections: ConnectionsService }): ProjectContextService {
  const ev = new vscode.EventEmitter<void>(); void base; void deps;
  return {
    features: async () => [], feature: async () => undefined, prs: async () => [], queue: async () => [], jiraMap: async () => ({}),
    jiraBrowseUrl: () => undefined, sources: async () => [], firefliesRecent: async () => [], indexFireflies: async () => { throw new Error("not implemented"); }, addUpload: async () => { throw new Error("not implemented"); },
    transcript: async () => { throw new Error("not implemented"); }, refresh: async () => {}, onDidChange: ev.event,
  };
}
