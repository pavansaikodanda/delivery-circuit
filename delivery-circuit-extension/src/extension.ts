// Delivery Circuit entry point. Owned by the integrator: it only wires modules together in dependency order.
//   connections+identity -> project -> mcp -> sessions -> actions -> testing -> UIs
import * as vscode from "vscode";
import type { CircuitServices, Identity, IdentityService } from "./core/contracts";
import * as path from "path";
import type { ModuleBase } from "./core/util";
import { createIdentityAndConnections, registerConnectionsUI } from "./connections";
import { createProject } from "./project";
import { createMcp } from "./mcp";
import { createSessions } from "./sessions";
import { createActions } from "./actions";
import { createTesting, registerTestingUI } from "./testing";
import { registerSetupUI } from "./setup";
import { registerViews } from "./views";

/** Only present when VS Code runs the extension under test (ExtensionMode.Test, e.g. @vscode/test-electron). */
export interface TestHooks {
  /** Replace the GitHub identity (null = signed out; undefined = back to the real one). */
  setIdentity(id: Identity | null | undefined): void;
  homeResolved(): boolean;
}

export type ActivationResult = CircuitServices & { test?: TestHooks };

let services: CircuitServices | undefined;

/** In test mode the identity can be replaced, so persona-bound features (Circuit MCP endpoints) run without GitHub. */
function overridableIdentity(real: IdentityService): { identity: IdentityService; set: (id: Identity | null | undefined) => void } {
  const ev = new vscode.EventEmitter<Identity | null>();
  let override: Identity | null | undefined;
  real.onDidChange((id) => { if (override === undefined) ev.fire(id); });
  const current = () => (override === undefined ? real.get() : override);
  return {
    identity: {
      get: current,
      refresh: async () => (override === undefined ? real.refresh() : override),
      setActive: async (p) => {
        if (override === undefined) return real.setActive(p);
        if (!override || !override.personas.includes(p)) throw new Error(`Not in the ${p} team.`);
        override = { ...override, active: p }; ev.fire(override);
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

  const pluginRoot = path.join(ctx.extensionPath, "plugin");
  const base: ModuleBase = { ctx, root, pluginRoot, log };
  const real = createIdentityAndConnections(base);
  const connections = real.connections;
  const testMode = ctx.extensionMode === vscode.ExtensionMode.Test;
  const over = testMode ? overridableIdentity(real.identity) : undefined;
  const identity = over?.identity ?? real.identity;
  const project = createProject(base, { identity, connections });
  const mcp = createMcp(base, { identity, connections, project });
  const sessions = createSessions(base, { identity, mcp });
  const actions = createActions(base, { identity, connections, sessions, project });
  const testing = createTesting(base, { connections });

  services = { ctx, root, pluginRoot, log, identity, connections, project, mcp, testing, actions, sessions };

  const views = registerViews(services);
  registerConnectionsUI(services);
  registerTestingUI(services);
  registerSetupUI(services);

  ctx.subscriptions.push(vscode.commands.registerCommand("deliveryCircuit.refresh", async () => {
    await identity.refresh();
    await Promise.all([project.refresh(), connections.list().then(() => undefined)]);
  }));

  identity.refresh().catch((e) => log(`identity: ${e?.message ?? e}`));
  log(`Activated for ${root}`);
  const result: ActivationResult = { ...services };
  if (over) result.test = { setIdentity: over.set, homeResolved: () => views.homeResolved() };
  return result;
}

export async function deactivate(): Promise<void> {
  await services?.mcp.stop().catch(() => {});
}
