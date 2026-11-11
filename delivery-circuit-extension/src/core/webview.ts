// Webview shell shared by every page. Each page is: media/<module>/<page>.js (plain browser JS, no framework)
// plus the shared kit media/shared/base.css + media/shared/ui.js. Data flows only by postMessage:
//   extension -> page: { type: "state", data }   (whole page state; the page re-renders)
//                      { type: "event", ... }    (incremental, page-specific)
//   page -> extension: { type: "ready" } | { type: "openLink", link } | { type: "action", action } | page-specific
import * as vscode from "vscode";
import { nonce } from "./util";

export interface PageSpec {
  /** module folder under media/, e.g. "views" */
  module: string;
  /** script name without .js, e.g. "persona" */
  page: string;
  title: string;
}

export function pageHtml(webview: vscode.Webview, extUri: vscode.Uri, spec: PageSpec): string {
  const n = nonce();
  const u = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extUri, "media", ...p));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${n}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${u("shared", "base.css")}">
<title>${spec.title}</title></head>
<body data-page="${spec.module}/${spec.page}"><main id="app" aria-live="polite"><p class="muted">Loading…</p></main>
<script nonce="${n}" src="${u("shared", "ui.js")}"></script>
<script nonce="${n}" src="${u(spec.module, spec.page + ".js")}"></script>
</body></html>`;
}

/** Create (or reveal) a singleton editor panel for a page. */
const panels = new Map<string, vscode.WebviewPanel>();
export function openPanel(
  ctx: vscode.ExtensionContext,
  spec: PageSpec,
  onMessage: (msg: any, panel: vscode.WebviewPanel) => void | Promise<void>,
  key = `${spec.module}/${spec.page}`,
): vscode.WebviewPanel {
  const existing = panels.get(key);
  if (existing) { existing.reveal(); return existing; }
  const panel = vscode.window.createWebviewPanel(`deliveryCircuit.${key}`, spec.title, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "media"), ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? [])],
  });
  panel.webview.html = pageHtml(panel.webview, ctx.extensionUri, spec);
  panel.webview.onDidReceiveMessage((m) => onMessage(m, panel));
  panel.onDidDispose(() => panels.delete(key));
  panels.set(key, panel);
  return panel;
}
