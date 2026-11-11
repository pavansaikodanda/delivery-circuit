// Delivery Circuit entry point. Owned by the integrator: it only wires modules together in dependency order.
//   connections+identity -> project -> mcp -> sessions -> actions -> testing -> UIs
import * as vscode from "vscode";
import type { CircuitServices } from "./core/contracts";
import type { ModuleBase } from "./core/util";
import { createIdentityAndConnections, registerConnectionsUI } from "./connections";
import { createProject } from "./project";
import { createMcp } from "./mcp";
import { createSessions } from "./sessions";
import { createActions } from "./actions";
import { createTesting, registerTestingUI } from "./testing";
import { registerSetupUI } from "./setup";
import { registerViews } from "./views";

let services: CircuitServices | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<CircuitServices | undefined> {
  const out = vscode.window.createOutputChannel("Delivery Circuit");
  ctx.subscriptions.push(out);
  const log = (msg: string) => out.appendLine(`[${new Date().toISOString()}] ${msg}`);

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { log("No workspace folder open; Delivery Circuit is idle."); return undefined; }

  const base: ModuleBase = { ctx, root, log };
  const { identity, connections } = createIdentityAndConnections(base);
  const project = createProject(base, { identity, connections });
  const mcp = createMcp(base, { identity, connections, project });
  const sessions = createSessions(base, { identity, mcp });
  const actions = createActions(base, { identity, connections, sessions, project });
  const testing = createTesting(base, { connections });

  services = { ctx, root, log, identity, connections, project, mcp, testing, actions, sessions };

  registerViews(services);
  registerConnectionsUI(services);
  registerTestingUI(services);
  registerSetupUI(services);

  ctx.subscriptions.push(vscode.commands.registerCommand("deliveryCircuit.refresh", async () => {
    await identity.refresh();
    await project.refresh();
  }));

  identity.refresh().catch((e) => log(`identity: ${e?.message ?? e}`));
  log(`Activated for ${root}`);
  return services;
}

export async function deactivate(): Promise<void> {
  await services?.mcp.stop().catch(() => {});
}
