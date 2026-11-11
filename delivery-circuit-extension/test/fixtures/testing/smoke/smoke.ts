// Real smoke run of the ported engine, outside VS Code:
//   npx esbuild test/fixtures/testing/smoke/smoke.ts --bundle --platform=node --format=cjs --outfile=test/fixtures/testing/smoke/smoke.cjs \
//     --external:@anthropic-ai/claude-agent-sdk --external:playwright --external:playwright-core --external:exceljs
//   node test/fixtures/testing/smoke/smoke.cjs <workspace> <suite> [qa|dev] [manual|automation|both]
// Uses the sf CLI alias of the role (no passwords) and the Claude subscription login (ANTHROPIC_API_KEY is stripped).
import { execFile } from "child_process";
import * as path from "path";
import { setExec } from "../../../../src/testing/engine/exec";
import { TestingEngine } from "../../../../src/testing/engine/core";
import { verdictFor } from "../../../../src/testing/engine/verdict";
import { describeOrg } from "../../../../src/testing/engine/sfcli";

// Same contract as core/util.ts run(): array args, shell only for Windows .cmd shims.
setExec((cmd, args, opts = {}) => new Promise((resolve) => {
  const child = execFile(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: process.platform === "win32" },
    (err, stdout, stderr) => resolve({ code: err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  void child;
}));

async function main() {
  const [ws, suite, role = "qa", mode = "manual"] = process.argv.slice(2);
  if (!ws || !suite) throw new Error("usage: smoke.cjs <workspace> <suite> [qa|dev] [manual|automation|both]");
  const engine = new TestingEngine({
    workspaceDir: path.resolve(ws),
    toolRoot: path.resolve(__dirname, "../../../.."),
    settings: () => ({ headless: true, models: ["claude-haiku-4-5", "claude-sonnet-5-5"], workers: 2, maxTurns: 80 }),
    sfAlias: (r) => r,
    // Smoke runs only against sandboxes / scratch orgs (no build.config.yml trial declaration here).
    guardOrg: async (r) => {
      const o = await describeOrg(r);
      return o?.connected && o.isSandbox ? { allowed: true } : { allowed: false, reason: `Alias ${r} is not a connected sandbox.` };
    },
  });
  const started = Date.now();
  const run = await engine.run({ suite, mode: mode as any, orgRole: role as any }, (e) => {
    if (e.type === "log") console.log(e.message);
    else if (e.type === "caseEnd") console.log(`#### ${e.caseId} ${e.mode} -> ${e.status}: ${e.message}`);
    else if (e.type === "needsUser") console.log(`!!!! needs user: ${e.message}`);
  });
  console.log("\n==== SMOKE RESULT ====");
  console.log(JSON.stringify({ runDir: run.runDir, suite: run.suite, org: run.org, total: run.total, counts: run.counts, route: run.route, seconds: Math.round((Date.now() - started) / 1000),
    cases: run.results.map((r) => ({ id: r.id, mode: r.mode, status: r.status, model: r.model, attempts: r.attempts?.map((a) => `${a.model}:${a.status}`), evidence: r.evidence.length })) }, null, 2));
  console.log("CI verdict (ai-tester-verdict routing over all runs in the folder):", JSON.stringify(verdictFor(path.dirname(run.runDir)).route));
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
