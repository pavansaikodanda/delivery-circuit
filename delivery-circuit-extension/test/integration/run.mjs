// Integration test: downloads VS Code into .vscode-test, opens a throw-away copy of ../salesDemoOrg and runs
// test/integration/suite/index.js inside the extension host with this folder as the development extension.
//   npm run test:integration          (builds dist/ first)
// One VS Code run; the suite checks every role (Architect, Developer, QA, Lead) through the test identity hook.
// The read-only Claude reader is turned off in the copy's settings, so the run never starts `claude -p`.
// Env: DC_VSCODE_VERSION (default "stable"), DC_KEEP_WORKSPACE=1 to keep the temp copy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runTests } from "@vscode/test-electron";

const extRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sample = path.resolve(extRoot, "..", "salesDemoOrg");
if (!fs.existsSync(sample)) {
  console.error(`Sample repo not found: ${sample}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(process.env.DC_EXTENSION_PATH || extRoot, "dist", "extension.js"))) {
  console.error("dist/extension.js is missing: run `node build.mjs` first (npm run test:integration does).");
  process.exit(1);
}

// Copy without node_modules, .sf and .sfdx (local org auth and caches never leave the sample repo).
const SKIP = new Set(["node_modules", ".sf", ".sfdx"]);

// When this runs from a VS Code terminal (or another Electron host), ELECTRON_RUN_AS_NODE makes Code.exe start as
// plain Node and treat the workspace path as a script.
delete process.env.ELECTRON_RUN_AS_NODE;

const failed = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dc-int-run-"));
const workspace = path.join(tmp, "salesDemoOrg");
fs.cpSync(sample, workspace, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
const settingsFile = path.join(workspace, ".vscode", "settings.json");
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch { /* none or not plain JSON: start fresh */ }
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, "deliveryCircuit.designReader": "off" }, null, 2));
console.log(`workspace copy: ${workspace}`);
try {
  await runTests({
    version: process.env.DC_VSCODE_VERSION || "stable",
    // DC_EXTENSION_PATH: run the suite against another copy of the extension (vsix.mjs passes the unpacked VSIX).
    extensionDevelopmentPath: process.env.DC_EXTENSION_PATH || extRoot,
    extensionTestsPath: path.join(extRoot, "test", "integration", "suite", "index.js"),
    launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--user-data-dir", path.join(tmp, "user-data")],
    extensionTestsEnv: { DC_INTEGRATION_WORKSPACE: workspace },
  });
} catch (e) {
  console.error(`Integration tests failed: ${e?.message ?? e}`);
  failed.push("suite");
} finally {
  // Stop every VS Code process still using this run's temp profile, so no test instance keeps running.
  killLeftovers(tmp);
  if (!process.env.DC_KEEP_WORKSPACE) {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
    catch (e) { console.warn(`Could not remove ${tmp}: ${e?.code ?? e}`); }
  }
}
const left = countLeftovers();
if (left) { console.error(`${left} VS Code process(es) from this run are still running.`); failed.push("leftover processes"); }
console.log("");
console.log(failed.length ? `FAILED: ${failed.join(", ")}` : "Integration tests passed");
const code = failed.length ? 1 : 0;
process.exit(code);

/** VS Code processes still running from any dc-int-* temp profile of this or an earlier run. */
function countLeftovers() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match 'dc-int-' -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne $PID }).Count`],
        { encoding: "utf8", timeout: 30000 });
      return Number(out.trim()) || 0;
    }
    const out = execFileSync("pgrep", ["-f", "dc-int-"], { encoding: "utf8", timeout: 30000 });
    return out.split(/\r?\n/).filter(Boolean).length;
  } catch { return 0; }
}

function killLeftovers(dir) {
  try {
    if (process.platform === "win32") {
      const needle = dir.replace(/'/g, "''");
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne $PID } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`],
        { stdio: "ignore", timeout: 30000 });
    } else {
      execFileSync("pkill", ["-f", dir], { stdio: "ignore", timeout: 30000 });
    }
  } catch { /* nothing left to stop */ }
}
