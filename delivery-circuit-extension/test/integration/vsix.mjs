// Checks the packaged VSIX: unpacks delivery-circuit.vsix, verifies the files activation needs are inside (the one
// bundle, media) and that removed pages and node_modules are not, then runs the integration suite against it.
//   npm run package && npm run test:vsix
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileURLToPath } from "node:url";

const extRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const vsix = path.resolve(extRoot, process.argv[2] || "delivery-circuit.vsix");
if (!fs.existsSync(vsix)) { console.error(`${vsix} not found: run npm run package first.`); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dc-vsix-"));
// A VSIX is a zip. bsdtar unpacks zips (Windows 10+ ships it as System32\tar.exe, macOS as tar); GNU tar (Git Bash,
// most Linux) does not, so fall back to unzip. The archive is passed by its relative name from its own folder.
const sysTar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
const unpackers = [[sysTar, ["-xf", path.basename(vsix), "-C", tmp]], ["unzip", ["-q", path.basename(vsix), "-d", tmp]]];
const unpacked = unpackers.some(([cmd, args]) => spawnSync(cmd, args, { stdio: "inherit", cwd: path.dirname(vsix) }).status === 0);
if (!unpacked) { console.error("Could not unpack the VSIX (needs bsdtar or unzip)."); process.exit(1); }
const ext = path.join(tmp, "extension");

const problems = [];
const must = (rel) => { if (!fs.existsSync(path.join(ext, rel))) problems.push(`missing ${rel}`); };
const mustNot = (rel) => { if (fs.existsSync(path.join(ext, rel))) problems.push(`should not ship ${rel}`); };

const pkg = JSON.parse(fs.readFileSync(path.join(ext, "package.json"), "utf8"));
must(pkg.main.replace(/^\.\//, ""));
mustNot("dist/circuit-mcp.js");
must("media/shared/ui.js");
must("media/shared/icon.svg");
must("media/shared/codicons/codicon.css");
must("media/shared/codicons/codicon.ttf");
must("media/shared/brands.js");
must("media/shared/base.css");
must("media/views/home.js");
must("media/views/story.js");
for (const m of ["connections", "testing", "setup", "sessions"]) mustNot(`media/${m}`);
mustNot("plugin");
mustNot("node_modules");
mustNot("src");
mustNot("test");

const count = (dir) => { let n = 0; for (const d of fs.readdirSync(dir, { withFileTypes: true })) n += d.isDirectory() ? count(path.join(dir, d.name)) : 1; return n; };
console.log(`VSIX ${path.basename(vsix)}: ${(fs.statSync(vsix).size / 1048576).toFixed(1)} MB, ${count(ext)} files`);
if (problems.length) {
  console.error(`VSIX content check failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("VSIX content check passed.");

const r = spawnSync(process.execPath, [path.join(extRoot, "test", "integration", "run.mjs")], {
  stdio: "inherit", env: { ...process.env, DC_EXTENSION_PATH: ext },
});
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* temp leftovers are harmless */ }
process.exit(r.status ?? 1);
