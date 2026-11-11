// Preview harness: renders any webview page in a normal browser with fixture data and a VS Code-like theme.
//   npm run preview  ->  http://127.0.0.1:5178/
//   /page/<module>/<page>?fixture=<name>&theme=dark|light   (fixture file: preview/fixtures/<module>.<page>.<name>.json)
// Messages the page posts are logged to the console as "[post]" and shown in the footer, so clicks can be checked.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PREVIEW_PORT || 5178);

const THEMES = {
  dark: { "--vscode-editor-background": "#1f1f1f", "--vscode-foreground": "#cccccc", "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-panel-border": "#2b2b2b", "--vscode-sideBar-background": "#181818", "--vscode-list-hoverBackground": "#2a2d2e",
    "--vscode-textLink-foreground": "#4daafc", "--vscode-button-background": "#0078d4", "--vscode-button-foreground": "#ffffff",
    "--vscode-button-secondaryBackground": "#313131", "--vscode-button-secondaryForeground": "#cccccc", "--vscode-input-background": "#313131",
    "--vscode-input-border": "#3c3c3c", "--vscode-focusBorder": "#0078d4", "--vscode-font-family": "-apple-system, 'Segoe UI', sans-serif",
    "--vscode-font-size": "13px", "--vscode-editor-font-family": "Consolas, monospace" },
  light: { "--vscode-editor-background": "#ffffff", "--vscode-foreground": "#3b3b3b", "--vscode-descriptionForeground": "#717171",
    "--vscode-panel-border": "#e5e5e5", "--vscode-sideBar-background": "#f8f8f8", "--vscode-list-hoverBackground": "#f2f2f2",
    "--vscode-textLink-foreground": "#005fb8", "--vscode-button-background": "#005fb8", "--vscode-button-foreground": "#ffffff",
    "--vscode-button-secondaryBackground": "#e5e5e5", "--vscode-button-secondaryForeground": "#3b3b3b", "--vscode-input-background": "#ffffff",
    "--vscode-input-border": "#cecece", "--vscode-focusBorder": "#005fb8", "--vscode-font-family": "-apple-system, 'Segoe UI', sans-serif",
    "--vscode-font-size": "13px", "--vscode-editor-font-family": "Consolas, monospace" },
};

function listPages() {
  const dir = path.join(root, "preview", "fixtures");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  return files.map((f) => { const [mod, page, ...rest] = f.replace(/\.json$/, "").split("."); return { mod, page, fixture: rest.join(".") }; });
}

function pageHtml(mod, page, fixture, theme, sidebar) {
  const fx = path.join(root, "preview", "fixtures", `${mod}.${page}.${fixture}.json`);
  const data = fs.existsSync(fx) ? fs.readFileSync(fx, "utf8") : "null";
  const vars = Object.entries(THEMES[theme] || THEMES.dark).map(([k, v]) => `${k}:${v}`).join(";");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${mod}/${page} (${fixture})</title>
<link rel="stylesheet" href="/media/shared/base.css"><style>:root{${vars}} #dc-preview-log{position:fixed;bottom:0;left:0;right:0;
font:11px monospace;background:#0008;color:#eee;padding:2px 8px;max-height:60px;overflow:auto}</style></head>
<body class="${sidebar ? "sidebar" : ""}" data-page="${mod}/${page}" style="${sidebar ? "max-width:340px" : ""}"><main id="app"></main><div id="dc-preview-log"></div>
<script>
window.__FIXTURE__ = ${data};
window.acquireVsCodeApi = () => ({
  postMessage(m) {
    console.log("[post]", JSON.stringify(m));
    const log = document.getElementById("dc-preview-log"); log.textContent = "posted: " + JSON.stringify(m).slice(0, 300);
    if (m && m.type === "ready") setTimeout(() => window.postMessage({ type: "state", data: window.__FIXTURE__ }, "*"), 0);
  },
  getState() { return null; }, setState() {},
});
</script>
<script src="/media/shared/ui.js"></script><script src="/media/${mod}/${page}.js"></script></body></html>`;
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/") {
    const rows = listPages().map((p) => `<li><a href="/page/${p.mod}/${p.page}?fixture=${p.fixture}&theme=dark">${p.mod}/${p.page} · ${p.fixture}</a>
      · <a href="/page/${p.mod}/${p.page}?fixture=${p.fixture}&theme=light">light</a></li>`).join("");
    res.writeHead(200, { "content-type": "text/html" }); res.end(`<h3>Delivery Circuit previews</h3><ul>${rows}</ul>`); return;
  }
  const pm = url.pathname.match(/^\/page\/([\w-]+)\/([\w-]+)$/);
  if (pm) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(pageHtml(pm[1], pm[2], url.searchParams.get("fixture") || "default", url.searchParams.get("theme") || "dark", url.searchParams.has("sidebar")));
    return;
  }
  const file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(path.join(root, "media")) || !fs.existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
  const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
  res.writeHead(200, { "content-type": type }); fs.createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`preview: http://127.0.0.1:${PORT}/`));
