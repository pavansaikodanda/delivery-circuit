// Delivery Circuit entry point: wires the modules together in dependency order.
//   connections + identity -> project -> Circuit MCP -> sessions -> views
import * as vscode from "vscode";
import type { CircuitServices, Identity, IdentityService, Role } from "./core/contracts";
import type { ModuleBase } from "./core/util";
import { createIdentityAndConnections } from "./connections";
import { createProject } from "./project";
import { createMcp } from "./mcp";
import { createSessions } from "./sessions";
import { registerViews, type ViewsHandle } from "./views";

/** Only present when VS Code runs the extension under test (ExtensionMode.Test, e.g. @vscode/test-electron). */
export interface TestHooks {
  /** Replace the GitHub identity (null = signed out; undefined = back to the real one). */
  setIdentity(id: Identity | null | undefined): void;
  homeResolved(): boolean;
  homeState: ViewsHandle["homeState"];
  /** The Circuit MCP endpoint (Architect only). */
  mcpEndpoint(): Promise<{ url: string; token: string }>;
}

export type ActivationResult = CircuitServices & { test?: TestHooks };

let services: CircuitServices | undefined;

/** In test mode the identity can be replaced, so role-bound features run without a GitHub sign-in. */
function overridableIdentity(real: IdentityService): { identity: IdentityService; set: (id: Identity | null | undefined) => void } {
  const ev = new vscode.EventEmitter<Identity | null>();
  let override: Identity | null | undefined;
  real.onDidChange((id) => { if (override === undefined) ev.fire(id); });
  const current = () => (override === undefined ? real.get() : override);
  return {
    identity: {
      get: current,
      refresh: async () => (override === undefined ? real.refresh() : override),
      setActive: async (r: Role) => {
        if (override === undefined) return real.setActive(r);
        if (!override) throw new Error("Sign in to GitHub first.");
        override = { ...override, active: r }; ev.fire(override);
      },
      onDidChange: ev.event,
    },
    set: (id) => { override = id; ev.fire(current()); },
  };
}

export async function activate(ctx: vscode.ExtensionContext): Promise<ActivationResult | undefined> {
  const out = vscode.window.createOutputChannel("Delivery Circuit");
  ctx.subscriptions.push(out);
  const log = (msg: string) => out.appendLine(`[${new Date().toISOString()}] ${msg}`);

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { log("No workspace folder open; Delivery Circuit is idle."); return undefined; }

  const base: ModuleBase = { ctx, root, log };
  const real = createIdentityAndConnections(base);
  const connections = real.connections;
  const testMode = ctx.extensionMode === vscode.ExtensionMode.Test;
  const over = testMode ? overridableIdentity(real.identity) : undefined;
  const identity = over?.identity ?? real.identity;
  const repo = () => { const id = identity.get(); return id?.owner ? { owner: id.owner, repo: id.repo } : undefined; };
  const project = createProject(base, { connections, repo });
  const mcp = createMcp(base, { identity, project });
  const sessions = createSessions(base, { identity, mcp });

  services = { ctx, root, log, identity, connections, project, mcp, sessions };
  const views = registerViews(services);

  identity.refresh().catch((e) => log(`identity: ${e?.message ?? e}`));
  log(`Activated for ${root}`);
  const result: ActivationResult = { ...services };
  if (over) {
    result.test = {
      setIdentity: over.set,
      homeResolved: () => views.homeResolved(),
      homeState: () => views.homeState(),
      mcpEndpoint: () => mcp.endpoint(),
    };
  }
  return result;
}

export async function deactivate(): Promise<void> {
  await services?.mcp.stop().catch(() => {});
}
