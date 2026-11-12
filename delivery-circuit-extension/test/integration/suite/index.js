// Runs inside the VS Code extension host (CommonJS). A tiny sequential runner: no mocha needed.
// run.mjs starts one VS Code per persona with deliveryCircuit.personaOverride set in the workspace settings and passes
// that persona as DC_PERSONA, so every assertion below is checked for architect, developer and tester.
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

const PERSONAS = ["architect", "developer", "tester"];
const PERSONA = process.env.DC_PERSONA;
const LABEL = { architect: "Architect", developer: "Developer", tester: "Tester" };

// One action per persona-owned step, with valid args, so a refusal can only come from the persona rules.
const ACTIONS = [
  { id: "arch:approve-design", label: "Approve design", persona: "architect", kind: "gate", args: { featureId: "ACME-10" } },
  { id: "ai:/arch-design", label: "Design", persona: "architect", kind: "ai", args: { command: "/arch-design", arg: "ACME-10" } },
  { id: "gate:merge", label: "Merge", persona: "architect", kind: "gate", args: { pr: 42 } },
  { id: "dev:start-story", label: "Start story", persona: "developer", kind: "ai", args: { storyKey: "ACME-12" } },
  { id: "dev:fix", label: "Fix with AI", persona: "developer", kind: "ai", args: { pr: 42, attempt: 1 } },
  { id: "review:open-room", label: "Open review room", persona: "developer", kind: "ai", args: { pr: 42 } },
  { id: "qa:add-tests", label: "Add tests", persona: "tester", kind: "ai", args: { storyKey: "ACME-12", pr: 42 } },
  { id: "gate:label:testplan-approved", label: "Approve test plan", persona: "tester", kind: "gate", args: { pr: 42 } },
];
// v3 Circuit MCP tools every persona gets, the Architect-only ones, and the v2 tool that must be gone.
const SHARED_TOOLS = ["circuit_status", "feature_get", "queue_get", "prs_list", "pr_get", "design_get", "decisions_get",
  "org_snapshot_get", "story_get", "test_results_get", "connections_status"];
const ARCHITECT_ONLY_TOOLS = ["transcript_get", "sources_list"];

let api;
const tests = [
  ["workspace is the salesDemoOrg copy with the persona override", async () => {
    assert.ok(PERSONAS.includes(PERSONA), `DC_PERSONA must be one of ${PERSONAS.join(", ")} (got ${PERSONA})`);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root, "no workspace folder");
    assert.equal(path.resolve(root).toLowerCase(), path.resolve(process.env.DC_INTEGRATION_WORKSPACE).toLowerCase());
    assert.equal(vscode.workspace.getConfiguration("deliveryCircuit").get("personaOverride"), PERSONA);
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
    assert.ok(all.has("deliveryCircuit.openSources"), "Sources page command missing");
  }],
  ["personaOverride gives exactly this persona", async () => {
    const id = await api.test.identityFromSettings();
    assert.deepEqual(id.personas, [PERSONA]);
    assert.equal(id.active, PERSONA);
    assert.equal(id.orgOwned, false);
    assert.equal(api.identity.get().active, PERSONA);
  }],
  ["the sidebar view resolves for this persona", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.deliveryCircuit");
    await vscode.commands.executeCommand("deliveryCircuit.home.focus");
    await waitFor("deliveryCircuit.home to resolve", () => api.test.homeResolved());
    const home = await api.test.views.homeState();
    assert.ok(home.identity, `home has no identity (mode ${home.mode})`);
    assert.equal(home.identity.active, PERSONA);
    assert.equal(home.identity.activeLabel, LABEL[PERSONA]);
    assert.equal(home.identity.canSwitch, false, "one persona: nothing to switch to");
  }],
  ["persona panel shows the right tabs and lets the persona act", async () => {
    const st = await api.test.views.personaState(PERSONA);
    const expectTabs = PERSONA === "architect" ? PERSONAS : [PERSONA];
    assert.deepEqual(st.tabs.map((t) => t.id), expectTabs);
    assert.equal(st.selected, PERSONA);
    assert.equal(st.canAct, true);
    assert.equal(st.notice, undefined);
    assert.ok(st.aiActions.length > 0, "no AI actions offered");
    for (const a of st.aiActions) {
      assert.equal(a.persona, PERSONA, `${a.id} offered to ${PERSONA}`);
      assert.equal(a.allowed, true, `${a.id} should be allowed for ${PERSONA}: ${a.reason}`);
    }
  }],
  ["other personas' pages are view-only for the Architect and hidden for the others", async () => {
    for (const other of PERSONAS.filter((p) => p !== PERSONA)) {
      const st = await api.test.views.personaState(other);
      if (PERSONA === "architect") {
        assert.equal(st.selected, other, `architect should be able to view ${other}`);
        assert.equal(st.canAct, false);
        assert.match(st.notice || "", /View only/);
        assert.equal(st.tabs.find((t) => t.id === other).title, "View only");
        for (const a of st.aiActions) {
          assert.equal(a.allowed, false, `${a.id} should be refused for the architect`);
          assert.equal(a.reason, `Only a ${LABEL[other]} can run this`);
        }
      } else {
        assert.equal(st.selected, PERSONA, `${PERSONA} must not see the ${other} page`);
        assert.ok(!st.tabs.some((t) => t.id === other), `${other} tab visible to ${PERSONA}`);
      }
    }
  }],
  ["actions: own persona allowed, others refused with a reason", async () => {
    for (const a of ACTIONS) {
      const reason = api.test.denyReason(a);
      const allowed = api.actions.allowed(a);
      if (a.persona === PERSONA) {
        assert.equal(reason, null, `${a.id} refused for ${PERSONA}: ${reason}`);
        assert.equal(allowed, true, `${a.id}: actions.allowed disagrees`);
      } else {
        assert.equal(allowed, false, `${a.id} allowed for ${PERSONA}`);
        assert.equal(reason, `Only the ${a.persona} persona can do this`);
      }
    }
    // A named action filed under the wrong persona is refused, naming its owner.
    const misfiled = { ...ACTIONS.find((a) => a.id === "dev:start-story"), persona: PERSONA === "developer" ? "tester" : PERSONA };
    assert.equal(api.test.denyReason(misfiled), "Start story is a developer action");
  }],
  ["Circuit MCP lists this persona's tools", async () => {
    const ep = await api.mcp.endpoint(PERSONA);
    assert.match(ep.url, /^http:\/\/127\.0\.0\.1:\d+\//);
    const tools = await listTools(ep);
    for (const t of SHARED_TOOLS) assert.ok(tools.includes(t), `${t} missing; ${PERSONA} tools: ${tools.join(", ")}`);
    for (const t of ARCHITECT_ONLY_TOOLS) assert.equal(tools.includes(t), PERSONA === "architect", `${t} for ${PERSONA}; tools: ${tools.join(", ")}`);
    assert.ok(!tools.includes("jira_map_get"), "v2 tool jira_map_get is still listed");
  }],
  ["Circuit MCP refuses other personas' endpoints", async () => {
    for (const other of PERSONAS.filter((p) => p !== PERSONA)) {
      await assert.rejects(() => api.mcp.endpoint(other), new RegExp(`not in the ${other} team`));
    }
  }],
  ["persona, connections, sources and testing pages open", async () => {
    await vscode.commands.executeCommand("deliveryCircuit.openPersona", PERSONA);
    await vscode.commands.executeCommand("deliveryCircuit.openConnections");
    await vscode.commands.executeCommand("deliveryCircuit.openSources");
    await vscode.commands.executeCommand("deliveryCircuit.openTesting");
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
  console.log(`${PERSONA}: ${tests.length - failures.length} of ${tests.length} integration tests passed`);
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed: ${failures.join("; ")}`);
};
