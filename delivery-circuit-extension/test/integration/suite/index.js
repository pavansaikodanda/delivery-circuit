// Runs inside the VS Code extension host (CommonJS). A tiny sequential runner: no mocha needed.
// run.mjs opens one VS Code on a throw-away copy of ../salesDemoOrg; every role (Architect, Developer, QA, Lead) is
// checked by switching the test identity, so no GitHub sign-in is needed.
const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

const EXT_ID = "conscendo.delivery-circuit";
const pkg = require(path.join(__dirname, "..", "..", "..", "package.json"));
const ROLES = ["architect", "developer", "tester", "lead"];
const LABEL = { architect: "Architect", developer: "Developer", tester: "QA", lead: "Lead" };
const ROWS = {
  architect: ["github", "claude", "sf-dev", "atlassian", "lucid", "fireflies"],
  developer: ["github", "claude", "sf-dev", "atlassian", "coderabbit"],
  tester: ["github", "claude", "sf-qa", "atlassian"],
  lead: ["github", "atlassian", "coderabbit"],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await fn()) return; await sleep(250); }
  throw new Error(`Timed out waiting for ${what}`);
}

async function listTools(endpoint) {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "dc-integration", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } } }));
  try { return (await client.listTools()).tools.map((t) => t.name); } finally { await client.close().catch(() => {}); }
}

const identity = (active) => ({ login: "integration-test", roles: [], active, isAdmin: false, owner: "acme-org", repo: "acme-salesforce", orgOwned: false });

let api;
const tests = [
  ["workspace is the salesDemoOrg copy", async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root, "no workspace folder");
    assert.equal(path.resolve(root).toLowerCase(), path.resolve(process.env.DC_INTEGRATION_WORKSPACE).toLowerCase());
  }],
  ["activation returns the services", async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found`);
    api = await ext.activate();
    assert.ok(api, "activate() returned nothing");
    for (const k of ["identity", "connections", "project", "mcp", "sessions"]) assert.ok(api[k], `services.${k} missing`);
    assert.ok(api.test, "test hooks missing (extension not in ExtensionMode.Test?)");
  }],
  ["exactly the four commands are contributed and registered", async () => {
    const ids = pkg.contributes.commands.map((c) => c.command);
    assert.deepEqual(ids, ["deliveryCircuit.refresh", "deliveryCircuit.switchRole", "deliveryCircuit.newDesign", "deliveryCircuit.openStory"]);
    const all = new Set(await vscode.commands.getCommands(true));
    assert.deepEqual(ids.filter((c) => !all.has(c)), []);
    for (const gone of ["deliveryCircuit.openPersona", "deliveryCircuit.openSources", "deliveryCircuit.openTesting", "deliveryCircuit.openSetup", "deliveryCircuit.openConnections"]) {
      assert.ok(!all.has(gone), `${gone} is still registered`);
    }
  }],
  ["signed out: the sidebar asks to sign in", async () => {
    api.test.setIdentity(null);
    await vscode.commands.executeCommand("workbench.view.extension.deliveryCircuit");
    await vscode.commands.executeCommand("deliveryCircuit.home.focus");
    await waitFor("deliveryCircuit.home to resolve", () => api.test.homeResolved());
    assert.equal((await api.test.homeState()).mode, "signin");
  }],
  ...ROLES.map((role) => [`${LABEL[role]}: role chip, Connections rows and the Work tab`, async () => {
    api.test.setIdentity(identity(role));
    const home = await api.test.homeState();
    assert.equal(home.mode, "ready");
    assert.equal(home.user.role, role);
    assert.equal(home.user.roleLabel, LABEL[role]);
    assert.deepEqual(home.user.roles.map((r) => r.id), ROLES, "no team: every role is offered by the chip");
    assert.deepEqual(home.connections.map((c) => c.id), ROWS[role]);
    for (const c of home.connections) assert.ok(["Connect", "Fix", "Check"].includes(c.button), `${c.id}: ${c.button}`);
    assert.ok(home.work, "work not loaded");
    assert.ok(home.work.next.length <= 5);
    if (role === "architect") assert.equal(home.work.next[0].title, "New design from transcript");
    assert.ok(Array.isArray(home.missing));
    assert.equal(home.missingCount, home.missing.length);
    assert.doesNotMatch(JSON.stringify(home), /\bG[1-9]\b|persona|token|webhook|runner/i);
  }]),
  ["Switch Role command changes the role", async () => {
    api.test.setIdentity(identity("developer"));
    await vscode.commands.executeCommand("deliveryCircuit.switchRole", "lead");
    assert.equal(api.identity.get().active, "lead");
  }],
  ["Circuit MCP serves transcript_get to the Architect only", async () => {
    api.test.setIdentity(identity("architect"));
    const ep = await api.test.mcpEndpoint();
    assert.match(ep.url, /^http:\/\/127\.0\.0\.1:\d+\//);
    assert.deepEqual(await listTools(ep), ["transcript_get"]);
    api.test.setIdentity(identity("developer"));
    await assert.rejects(() => api.test.mcpEndpoint(), /Architect role only/);
  }],
  ["Open Story opens the story panel", async () => {
    await vscode.commands.executeCommand("deliveryCircuit.openStory", "ABC-1");
    await waitFor("the story panel", () => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label.startsWith("ABC-1"))), 10000);
  }],
];

exports.run = async function run() {
  const failures = [];
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try {
      await fn();
      console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
    } catch (e) {
      failures.push(name);
      console.log(`  FAIL ${name}: ${e && e.stack ? e.stack : e}`);
      if (!api && name.startsWith("activation")) break;
    }
  }
  try { if (api && api.test) api.test.setIdentity(undefined); } catch { /* ignore */ }
  console.log(`${tests.length - failures.length} of ${tests.length} integration tests passed`);
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed: ${failures.join("; ")}`);
};
