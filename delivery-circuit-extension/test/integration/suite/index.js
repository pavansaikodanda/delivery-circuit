// Runs inside the VS Code extension host (CommonJS). A tiny sequential runner: no mocha needed.
const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

const EXT_ID = "conscendo.delivery-circuit";
const pkg = require(path.join(__dirname, "..", "..", "..", "package.json"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Names of the tools a persona's Circuit MCP endpoint lists, using the real MCP client over Streamable HTTP. */
async function listTools(endpoint) {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "dc-integration", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
  });
  await client.connect(transport);
  try {
    const r = await client.listTools();
    return r.tools.map((t) => t.name);
  } finally {
    await client.close().catch(() => {});
  }
}

const identity = (personas, active) => ({
  login: "integration-test", personas, active, isAdmin: false, owner: "example", repo: "salesDemoOrg", orgOwned: true,
});

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
    for (const k of ["identity", "connections", "project", "mcp", "testing", "actions", "sessions"]) assert.ok(api[k], `services.${k} missing`);
    assert.ok(api.test, "test hooks missing (extension not in ExtensionMode.Test?)");
  }],
  ["every contributed command is registered", async () => {
    const all = new Set(await vscode.commands.getCommands(true));
    const missing = pkg.contributes.commands.map((c) => c.command).filter((c) => !all.has(c));
    assert.deepEqual(missing, []);
  }],
  ["the sidebar view resolves", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.deliveryCircuit");
    await vscode.commands.executeCommand("deliveryCircuit.home.focus");
    await waitFor("deliveryCircuit.home to resolve", () => api.test.homeResolved());
  }],
  ["persona, connections and testing pages open", async () => {
    api.test.setIdentity(identity(["architect"], "architect"));
    await vscode.commands.executeCommand("deliveryCircuit.openPersona", "developer");
    await vscode.commands.executeCommand("deliveryCircuit.openConnections");
    await vscode.commands.executeCommand("deliveryCircuit.openTesting");
  }],
  ["Circuit MCP: architect lists transcript_get", async () => {
    api.test.setIdentity(identity(["architect"], "architect"));
    const ep = await api.mcp.endpoint("architect");
    assert.match(ep.url, /^http:\/\/127\.0\.0\.1:\d+\//);
    const tools = await listTools(ep);
    for (const t of ["circuit_status", "feature_get", "transcript_get", "sources_list"]) assert.ok(tools.includes(t), `${t} missing; architect tools: ${tools.join(", ")}`);
  }],
  ["Circuit MCP: developer does not get transcript_get", async () => {
    api.test.setIdentity(identity(["developer"], "developer"));
    const ep = await api.mcp.endpoint("developer");
    const tools = await listTools(ep);
    assert.ok(tools.includes("circuit_status"), `developer tools: ${tools.join(", ")}`);
    assert.ok(!tools.includes("transcript_get"), `developer tools: ${tools.join(", ")}`);
    assert.ok(!tools.includes("sources_list"), `developer tools: ${tools.join(", ")}`);
    // A developer gets no architect endpoint at all.
    await assert.rejects(() => api.mcp.endpoint("architect"), /not in the architect team/);
  }],
  ["testing finds the smoke-account suite", async () => {
    const suites = await api.testing.suites();
    const smoke = suites.find((s) => /smoke-account/.test(s.file));
    assert.ok(smoke, `suites: ${suites.map((s) => s.file).join(", ")}`);
    assert.ok(smoke.cases >= 1, "smoke-account has no cases");
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
  try {
    if (api && api.test) api.test.setIdentity(undefined);
  } catch {
    /* ignore */
  }
  console.log(`${tests.length - failures.length} of ${tests.length} integration tests passed`);
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed: ${failures.join("; ")}`);
};
