// Connections + identity module: who the person is (GitHub teams -> personas) and every outside connection the circuit
// needs (personal logins, Claude MCP servers, review tools, the project's runner and GitHub apps), with a Connections
// page and the Architect's Sources page. v3: every connection is a login; nothing here asks for or stores a token.
import * as vscode from "vscode";
import { PERSONAS, type CircuitServices, type ConnectionsService, type IdentityService, type Persona } from "../core/contracts";
import { openLink, type ModuleBase } from "../core/util";
import { openPanel } from "../core/webview";
import { def, isConnectionId, type RowId } from "./catalog";
import { createIdentity, type IdentityInternals } from "./identity";
import { buildPanelState, type ProjectInfo } from "./panelState";
import { createConnections, type ConnectionsInternals } from "./service";
import { registerSourcesUI } from "./sources";

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
  // Checks the person started from the page: the row shows "Checking" until its own check returns.
  const checking = new Set<RowId>();
  let refreshing = false;

  const post = () => {
    if (!panel) return;
    const state = buildPanelState({ identity: identity.get(), notice: identity.notice(), statuses: connections.cached(), links: connections.links(), project,
      checking, refreshing });
    void panel.webview.postMessage({ type: "state", data: state });
  };
  const schedulePost = () => { if (pending) clearTimeout(pending); pending = setTimeout(post, 80); };
  const loadProject = async () => { project = await connections.projectInfo().catch((e): ProjectInfo => ({ settings: [], reminders: [], error: String(e?.message ?? e) })); schedulePost(); };

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
          if (refreshing) return;
          refreshing = true; post();
          try { await identity.refresh(); await connections.checkAll(); await loadProject(); } finally { refreshing = false; post(); }
          return;
        case "connect": case "check": case "disconnect": case "manage": {
          if (!isConnectionId(m.id)) return;
          if (m.type === "connect") await connections.connectRow(m.id);
          else if (m.type === "check") {
            if (checking.has(m.id)) return;
            checking.add(m.id); post();
            try { await connections.checkRow(m.id); } finally { checking.delete(m.id); post(); }
          }
          else if (m.type === "disconnect") await connections.disconnectRow(m.id);
          else {
            const url = connections.cached().find((c) => c.id === m.id)?.manageUrl ?? def(m.id).manageUrl;
            if (url) await openLink(root, { kind: "url", label: "Manage", target: url });
          }
          if (m.id === "ai-reviewer" || m.id === "github" || m.id === "runner") await loadProject();
          return;
        }
        case "switchPersona":
          if (PERSONAS.includes(m.persona as Persona)) await identity.setActive(m.persona);
          return;
        case "openSources":
          await vscode.commands.executeCommand("deliveryCircuit.openSources");
          return;
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

  registerSourcesUI(s, connections);
}

