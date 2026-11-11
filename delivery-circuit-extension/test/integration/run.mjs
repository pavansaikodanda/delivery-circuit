// Integration test: downloads VS Code into .vscode-test, opens a throw-away copy of ../salesDemoOrg and runs
// test/integration/suite/index.js inside the extension host with this folder as the development extension.
//   npm run test:integration          (builds dist/ first)
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dc-int-"));
const workspace = path.join(tmp, "salesDemoOrg");
fs.cpSync(sample, workspace, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
console.log(`Workspace copy: ${workspace}`);

// When this runs from a VS Code terminal (or another Electron host), ELECTRON_RUN_AS_NODE makes Code.exe start as
// plain Node and treat the workspace path as a script.
delete process.env.ELECTRON_RUN_AS_NODE;

let code = 0;
try {
  await runTests({
    version: process.env.DC_VSCODE_VERSION || "stable",
    // DC_EXTENSION_PATH: run the suite against another copy of the extension (vsix.mjs passes the unpacked VSIX).
    extensionDevelopmentPath: process.env.DC_EXTENSION_PATH || extRoot,
    extensionTestsPath: path.join(extRoot, "test", "integration", "suite", "index.js"),
    launchArgs: [
      workspace,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--user-data-dir", path.join(tmp, "user-data"),
    ],
    extensionTestsEnv: { DC_INTEGRATION_WORKSPACE: workspace },
  });
} catch (e) {
  console.error(`Integration tests failed: ${e?.message ?? e}`);
  code = 1;
} finally {
  // Stop every VS Code process still using this run's temp profile. Without this, a test copy that does not exit
  // keeps running (each holds ~150 MB) and repeated runs exhausted the machine's memory.
  killLeftovers(tmp);
  if (!process.env.DC_KEEP_WORKSPACE) {
    // Code.exe child processes can hold the folder for a moment after exit; a leftover temp copy is harmless.
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
    catch (e) { console.warn(`Could not remove ${tmp}: ${e?.code ?? e}`); }
  }
}
process.exit(code);

function killLeftovers(dir) {
  try {
    if (process.platform === "win32") {
      const needle = dir.replace(/'/g, "''");
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`],
        { stdio: "ignore", timeout: 30000 });
    } else {
      execFileSync("pkill", ["-f", dir], { stdio: "ignore", timeout: 30000 });
    }
  } catch { /* nothing left to stop */ }
}
