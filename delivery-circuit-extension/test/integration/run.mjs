// Integration test: downloads VS Code into .vscode-test, opens a throw-away copy of ../salesDemoOrg and runs
// test/integration/suite/index.js inside the extension host with this folder as the development extension.
//   npm run test:integration          (builds dist/ first)
// Runs the suite once per persona (architect, developer, tester) via deliveryCircuit.personaOverride.
// Env: DC_VSCODE_VERSION (default "stable"), DC_KEEP_WORKSPACE=1 to keep the temp copies, DC_PERSONAS=a,b to limit.
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

// One run per persona. Each run gets its own copy of the sample repo with deliveryCircuit.personaOverride set in the
// workspace settings, its own VS Code profile, and its own VS Code process, so nothing carries over between personas.
//   DC_PERSONAS=developer,tester   run only some personas (default: all three)
const PERSONAS = (process.env.DC_PERSONAS || "architect,developer,tester").split(",").map((p) => p.trim()).filter(Boolean);
for (const p of PERSONAS) if (!["architect", "developer", "tester"].includes(p)) { console.error(`Unknown persona ${p}`); process.exit(1); }

// Copy without node_modules, .sf and .sfdx (local org auth and caches never leave the sample repo).
const SKIP = new Set(["node_modules", ".sf", ".sfdx"]);

// When this runs from a VS Code terminal (or another Electron host), ELECTRON_RUN_AS_NODE makes Code.exe start as
// plain Node and treat the workspace path as a script.
delete process.env.ELECTRON_RUN_AS_NODE;

const failed = [];
for (const persona of PERSONAS) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `dc-int-${persona}-`));
  const workspace = path.join(tmp, "salesDemoOrg");
  fs.cpSync(sample, workspace, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
  const settingsFile = path.join(workspace, ".vscode", "settings.json");
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch { /* none or not plain JSON: start fresh */ }
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, "deliveryCircuit.personaOverride": persona }, null, 2));
  console.log("");
  console.log(`=== ${persona} === workspace copy: ${workspace}`);
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
      extensionTestsEnv: { DC_INTEGRATION_WORKSPACE: workspace, DC_PERSONA: persona },
    });
  } catch (e) {
    console.error(`Integration tests failed for ${persona}: ${e?.message ?? e}`);
    failed.push(persona);
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
}
const left = countLeftovers();
if (left) { console.error(`${left} VS Code process(es) from this run are still running.`); failed.push("leftover processes"); }
console.log("");
console.log(failed.length ? `FAILED: ${failed.join(", ")}` : `All personas passed: ${PERSONAS.join(", ")}`);
const code = failed.length ? 1 : 0;
process.exit(code);

/** VS Code processes still running from any dc-int-* temp profile of this or an earlier run. */
function countLeftovers() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match 'dc-int-(architect|developer|tester)-' -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne $PID }).Count`],
        { encoding: "utf8", timeout: 30000 });
      return Number(out.trim()) || 0;
    }
    const out = execFileSync("pgrep", ["-f", "dc-int-(architect|developer|tester)-"], { encoding: "utf8", timeout: 30000 });
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
