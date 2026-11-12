import * as esbuild from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  // Loaded from node_modules at runtime: the SDK ships the Claude Code binary, Playwright ships browsers.
  external: ["vscode", "@anthropic-ai/claude-agent-sdk", "playwright", "playwright-core", "@playwright/*", "exceljs"],
};
import fs from "node:fs";
import { writeBrands } from "./build-brands.mjs";
// Bundle the sf-delivery-circuit plugin (templates, installer, skills) so the setup wizard works offline.
fs.rmSync("plugin", { recursive: true, force: true });
fs.cpSync("../sf-delivery-circuit", "plugin", { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });

// Codicons for the webview kit (media/shared/ui.js DC.icon). Generated, not committed; packaged with media/.
fs.mkdirSync("media/shared/codicons", { recursive: true });
for (const f of ["codicon.css", "codicon.ttf"]) fs.copyFileSync(`node_modules/@vscode/codicons/dist/${f}`, `media/shared/codicons/${f}`);
// Monochrome app logos (CC0 paths from simple-icons, DESIGN.md §3.2) -> media/shared/brands.js (window.DC_BRANDS).
await writeBrands(process.cwd());

const ctxs = await Promise.all([
  esbuild.context({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js" }),
  // Stand-alone stdio entry of the Circuit MCP server (used when Claude runs outside VS Code, e.g. CI).
  esbuild.context({ ...common, entryPoints: ["src/mcp/stdio.ts"], outfile: "dist/circuit-mcp.js" }),
]);
if (process.argv.includes("--watch")) {
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all(ctxs.map((c) => c.rebuild()));
  await Promise.all(ctxs.map((c) => c.dispose()));
}
