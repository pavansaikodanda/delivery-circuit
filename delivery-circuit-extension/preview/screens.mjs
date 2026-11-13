// Retakes design/screens/*.png from the preview harness with Playwright: each sidebar tab and the story panel, light
// and dark. Starts preview/serve.mjs on a free port, shoots, stops it.
//   npm run screens
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "design", "screens");
const SHOTS = [
  { name: "work", page: "views/home", fixture: "developer", hash: "tab=work", sidebar: true },
  { name: "connections", page: "views/home", fixture: "developer", hash: "tab=connections", sidebar: true },
  { name: "missing", page: "views/home", fixture: "developer", hash: "tab=missing", sidebar: true },
  { name: "work-architect", page: "views/home", fixture: "architect", hash: "tab=work", sidebar: true },
  { name: "work-lead", page: "views/home", fixture: "lead", hash: "tab=work", sidebar: true },
  { name: "story", page: "views/story", fixture: "default", hash: "", sidebar: false },
];

const port = await new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const server = spawn(process.execPath, [path.join(root, "preview", "serve.mjs")], { env: { ...process.env, PREVIEW_PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve, reject) => { server.stdout.on("data", (d) => { if (String(d).includes("preview:")) resolve(); }); server.on("exit", reject); });

const browser = await chromium.launch();
try {
  fs.mkdirSync(out, { recursive: true });
  for (const s of SHOTS) {
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width: s.sidebar ? 360 : 760, height: s.sidebar ? 760 : 520 }, deviceScaleFactor: 2 });
      const url = `http://127.0.0.1:${port}/page/${s.page}?fixture=${s.fixture}&theme=${theme}${s.sidebar ? "&sidebar" : ""}${s.hash ? "#" + s.hash : ""}`;
      await page.goto(url);
      await page.waitForSelector("main#app > :not(.dc-skeleton)");
      // the preview footer logs posted messages; it is not part of the design
      await page.addStyleTag({ content: "#dc-preview-log{display:none}" });
      await page.waitForTimeout(250);
      const file = path.join(out, `${s.name}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(path.relative(root, file));
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.kill();
}
