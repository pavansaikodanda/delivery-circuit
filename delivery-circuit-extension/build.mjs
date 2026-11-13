import * as esbuild from "esbuild";
import fs from "node:fs";
import { writeBrands } from "./build-brands.mjs";

// Codicons for the webview kit (media/shared/ui.js DC.icon). Generated, not committed; packaged with media/.
fs.mkdirSync("media/shared/codicons", { recursive: true });
for (const f of ["codicon.css", "codicon.ttf"]) fs.copyFileSync(`node_modules/@vscode/codicons/dist/${f}`, `media/shared/codicons/${f}`);
// Monochrome app logos (CC0 paths from simple-icons, DESIGN.md §3.2) -> media/shared/brands.js (window.DC_BRANDS).
await writeBrands(process.cwd());

const ctx = await esbuild.context({
  bundle: true, platform: "node", format: "cjs", target: "node20", sourcemap: true, external: ["vscode"],
  entryPoints: ["src/extension.ts"], outfile: "dist/extension.js",
});
if (process.argv.includes("--watch")) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
