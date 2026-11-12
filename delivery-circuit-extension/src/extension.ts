// Delivery Circuit entry point. Owned by the integrator: it only wires modules together in dependency order.
//   connections+identity -> project -> mcp -> sessions -> actions -> testing -> UIs
import * as vscode from "vscode";
import type { ActionRef, CircuitServices, Identity, IdentityService } from "./core/contracts";
import * as path from "path";
import type { ModuleBase } from "./core/util";
import { createIdentityAndConnections, registerConnectionsUI } from "./connections";
import { createProject } from "./project";
import { createMcp } from "./mcp";
import { createSessions } from "./sessions";
import { createActions } from "./actions";
import { createTesting, registerTestingUI } from "./testing";
import { registerSetupUI } from "./setup";
import { registerViews, type ViewsHandle } from "./views";
import { resolveIdentity } from "./connections/identityCore";
import { denyReason } from "./actions/grammar";

/** Only present when VS Code runs the extension under test (ExtensionMode.Test, e.g. @vscode/test-electron). */
export interface TestHooks {
  /** Replace the GitHub identity (null = signed out; undefined = back to the real one). */
  setIdentity(id: Identity | null | undefined): void;
  homeResolved(): boolean;
  /**
   * Resolve the identity the way a personal-account repo does: personas from deliveryCircuit.personaOverride in the
   * workspace settings, through the real resolver. Only the GitHub repo lookup is stubbed (a user-owned repo), since
   * the test profile has no GitHub sign-in. Sets and returns that identity.
   */
  identityFromSettings(): Promise<Identity>;
  /** The sidebar and persona-panel models the webviews render. */
  views: Pick<ViewsHandle, "homeState" | "personaState">;
  /** Why the current identity may not run an action (null = allowed). */
  denyReason(action: ActionRef): string | null;
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
  if (over) {
    const o = over;
    result.test = {
      setIdentity: o.set,
      homeResolved: () => views.homeResolved(),
      async identityFromSettings() {
        const cfg = vscode.workspace.getConfiguration("deliveryCircuit");
        const r = await resolveIdentity({
          login: "integration-test", owner: "acme-demo", repo: "sales", teams: {},
          override: cfg.get<string>("personaOverride", "") ?? "", previousActive: null,
          get: async (p: string) => {
            if (p === "/repos/acme-demo/sales") return { owner: { type: "User" }, permissions: { admin: false } } as any;
            throw Object.assign(new Error(`not stubbed: ${p}`), { status: 404 });
          },
        });
        o.set(r.identity);
        return r.identity;
      },
      views: { homeState: () => views.homeState(), personaState: (p) => views.personaState(p) },
      denyReason: (a) => denyReason(identity.get(), a),
    };
  }
  return result;
}

export async function deactivate(): Promise<void> {
  await services?.mcp.stop().catch(() => {});
}
