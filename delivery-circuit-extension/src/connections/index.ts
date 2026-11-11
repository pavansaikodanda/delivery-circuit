// Connections + identity module: who the person is (GitHub teams -> personas) and every outside connection the circuit
// needs (personal, Claude MCP, review tools, project secrets), with a Connections page.
import * as vscode from "vscode";
import { PERSONAS, type CircuitServices, type ConnectionsService, type IdentityService, type Persona } from "../core/contracts";
import { openLink, type ModuleBase } from "../core/util";
import { openPanel } from "../core/webview";
import { def, isConnectionId } from "./catalog";
import { createIdentity, type IdentityInternals } from "./identity";
import { buildPanelState, type ProjectInfo } from "./panelState";
import { validateEnvironmentName, validateSecretName } from "./secrets";
import { createConnections, type ConnectionsInternals } from "./service";

let internals: { identity: IdentityInternals; connections: ConnectionsInternals } | undefined;

export function createIdentityAndConnections(base: ModuleBase): { identity: IdentityService; connections: ConnectionsService } {
  let identity: IdentityInternals | undefined;
  const { service: connections, gh } = createConnections(base, () => identity?.get() ?? null);
  identity = createIdentity(base, gh, () => ({ owner: connections.config().githubOrg, repo: connections.config().githubRepo }));
  // GitHub row text depends on identity (repo, admin)
  identity.onDidChange(() => { void connections.check("github"); });
  internals = { identity, connections };
  return { identity, connections };
}

export function registerConnectionsUI(s: CircuitServices): void {
  const { ctx, root, log } = s;
  const identity = internals?.identity;
  const connections = internals?.connections;
  if (!identity || !connections) { log("connections: UI registered without the connections module"); return; }

  let panel: vscode.WebviewPanel | undefined;
  let project: ProjectInfo | undefined;
  let pending: NodeJS.Timeout | undefined;

  const post = () => {
    if (!panel) return;
    const state = buildPanelState({ identity: identity.get(), notice: identity.notice(), statuses: connections.cached(), links: connections.links(), project });
    void panel.webview.postMessage({ type: "state", data: state });
  };
  const schedulePost = () => { if (pending) clearTimeout(pending); pending = setTimeout(post, 80); };
  const loadProject = async () => { project = await connections.projectInfo().catch((e) => ({ secrets: [], webhooks: [], environments: [], reminders: [], error: String(e?.message ?? e) })); schedulePost(); };

  ctx.subscriptions.push(connections.onDidChange(schedulePost), identity.onDidChange(schedulePost));

  const onMessage = async (m: any) => {
    try {
      switch (m?.type) {
        case "ready":
          post();
          void identity.refresh().then(() => connections.checkAll()).then(loadProject);
          return;
        case "openLink":
          if (m.link && typeof m.link.target === "string") await openLink(root, m.link);
          return;
        case "refresh":
          await identity.refresh(); await connections.checkAll(); await loadProject(); return;
        case "connect": case "check": case "disconnect": case "manage": {
          if (!isConnectionId(m.id)) return;
          if (m.type === "connect") await connections.connect(m.id);
          else if (m.type === "check") await connections.check(m.id);
          else if (m.type === "disconnect") await connections.disconnect(m.id);
          else {
            const url = connections.cached().find((c) => c.id === m.id)?.manageUrl ?? def(m.id).manageUrl;
            if (url) await openLink(root, { kind: "url", label: "Manage", target: url });
          }
          if (m.id === "ai-reviewer" || m.id === "github") await loadProject();
          return;
        }
        case "switchPersona":
          if (PERSONAS.includes(m.persona as Persona)) await identity.setActive(m.persona);
          return;
        case "setSecret": {
          const name = String(m.name ?? "");
          const env = m.env ? String(m.env) : undefined;
          const bad = validateSecretName(name) ?? (env ? validateEnvironmentName(env) : undefined);
          if (bad) throw new Error(bad);
          const known = [...(project?.secrets ?? []), ...(project?.webhooks ?? [])].some((r) => r.name === name);
          if (!known) throw new Error(`${name} is not a secret the circuit's workflows use.`);
          await connections.setProjectSecret(name, env);
          await loadProject();
          return;
        }
      }
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Connections: ${e?.message ?? e}`);
    }
  };

  ctx.subscriptions.push(vscode.commands.registerCommand("deliveryCircuit.openConnections", () => {
    panel = openPanel(ctx, { module: "connections", page: "connections", title: "Connections" }, onMessage);
    panel.onDidDispose(() => { panel = undefined; });
    post();
  }));
}

