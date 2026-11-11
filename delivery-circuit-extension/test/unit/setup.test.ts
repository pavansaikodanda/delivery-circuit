import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { parseBuildState, serializeBuildState, setToolVersions, splitRow, statusKind, updatePhase } from "../../src/setup/buildState";
import { FORBIDDEN_SECRETS, installCommand, LABELS, parseInstallOutput, rulesetWithTeam, secretNameOk, shellArg, variablesFor } from "../../src/setup/commands";
import { looksLikeSecret, readConfig, readForm, textToPeople, validateForm, writeForm } from "../../src/setup/config";
import { fillMcpUrls, PHASE_IDS, phases } from "../../src/setup/phases";
import { buildView, linkKind } from "../../src/setup/view";

const FX = path.join(__dirname, "..", "fixtures", "setup");
const STATE = fs.readFileSync(path.join(FX, "build-state.salesDemoOrg.md"), "utf8");
const CONFIG = fs.readFileSync(path.join(FX, "build.config.yml"), "utf8");

const CLEAN = `# Build state

| Phase | Status | Verified | Evidence | Notes |
|---|---|---|---|---|
| B0 Preflight | DONE | 2026-11-10 | versions below | |
| B1 GitHub org and bot | TODO | | | a \\| pipe |

## Tool versions (B0)
2026-11-10: git 2.53.0

## Open issues
- none`;

describe("build-state.md", () => {
  it("round-trips a clean file byte for byte", () => {
    const s = parseBuildState(CLEAN);
    expect(s.rows.map((r) => r.id)).toEqual(["B0", "B1"]);
    expect(s.rows[1].notes).toBe("a | pipe");
    expect(s.repaired).toBe(false);
    expect(serializeBuildState(s)).toBe(CLEAN);
  });
  it("updates one row and keeps everything else", () => {
    const s = updatePhase(parseBuildState(CLEAN), "B1", { status: "DONE", verified: "2026-11-11", evidence: "teams ok; labels ok" });
    const out = serializeBuildState(s);
    expect(out).toContain("| B1 GitHub org and bot | DONE | 2026-11-11 | teams ok; labels ok | a \\| pipe |");
    expect(out).toContain("| B0 Preflight | DONE | 2026-11-10 | versions below | |");
    expect(out.endsWith("## Open issues\n- none")).toBe(true);
    expect(parseBuildState(out).rows[1]).toMatchObject({ status: "DONE", notes: "a | pipe" });
  });
  it("adds a missing phase in B-order", () => {
    const s = updatePhase(parseBuildState(CLEAN), "B10", { status: "PARTIAL" }, "Persona workstations");
    const s2 = updatePhase(s, "B2", { status: "TODO" }, "Salesforce access");
    expect(s2.rows.map((r) => r.id)).toEqual(["B0", "B1", "B2", "B10"]);
    expect(s2.rows[3].phase).toBe("B10 Persona workstations");
  });
  it("folds rows glued outside the table (the real salesDemoOrg file) back into it", () => {
    const s = parseBuildState(STATE);
    expect(s.repaired).toBe(true);
    expect(s.rows).toHaveLength(13);
    const by = Object.fromEntries(s.rows.map((r) => [r.id, r]));
    expect(by.B0.status).toBe("PARTIAL");
    expect(by.B2.notes).toContain("SDO trial org");
    expect(by.B3.status).toBe("DONE (local)");
    expect(by.B4.evidence).toBe("commit 876212c on pipeline/speckit");
    expect(by.B5.status).toBe("TODO");
    expect(s.before[0]).toBe("# Build state");
    const out = serializeBuildState(s);
    expect(out.split("\n")[0]).toBe("# Build state");
    expect(out).not.toMatch(/\|\| B3/);
    const again = parseBuildState(out);
    expect(again.repaired).toBe(false);
    expect(again.rows).toEqual(s.rows);
    expect(serializeBuildState(again)).toBe(out);
    expect(out).toContain("## Tool versions (B0)");
    expect(out).toContain("## Deviations from the runbook (and why)");
  });
  it("creates a table in a file without one, and records tool versions", () => {
    const s = updatePhase(parseBuildState("# Build state\n"), "B0", { status: "PARTIAL" }, "Preflight");
    expect(serializeBuildState(s)).toContain("| B0 Preflight | PARTIAL |");
    const v = setToolVersions(parseBuildState(CLEAN), "2026-11-12T00:00:00Z", "git 2.54.0, gh 2.74.0");
    const out = serializeBuildState(v);
    expect(out).toContain("## Tool versions (B0)\n2026-11-12: git 2.54.0, gh 2.74.0\n");
    expect(out).not.toContain("2026-11-10: git 2.53.0");
    expect(serializeBuildState(setToolVersions(parseBuildState("| Phase | Status | Verified | Evidence | Notes |\n|---|---|---|---|---|"), "2026-01-01", "x"))).toContain("## Tool versions (B0)\n2026-01-01: x");
  });
  it("classifies statuses and splits escaped cells", () => {
    expect(["DONE", "DONE (local)", "COMPLETE"].map(statusKind)).toEqual(["done", "done", "done"]);
    expect(["PARTIAL", "BLOCKED", "TODO", ""].map(statusKind)).toEqual(["partial", "blocked", "todo", "todo"]);
    expect(splitRow("| a | b \\| c | |")).toEqual(["a", "b | c", ""]);
  });
});

describe("build.config.yml form", () => {
  it("reads values and people", () => {
    const f = readForm(CONFIG);
    expect(f["github.org"]).toBe("acme-org");
    expect(f["salesforce.dev_sandbox_url"]).toBe("https://acme-demo.my.salesforce.com");
    expect(f["people.architects"]).toBe("");
    expect(f["ai.sf_ai_tester_in_ci"]).toBe("false");
    expect(textToPeople("@pat, pat@acme.io, @pat\n\n sam ")).toEqual([{ gh: "pat", atlassian: "pat@acme.io", slack: "pat" }, { gh: "sam", atlassian: "", slack: "" }]);
  });
  it("writes back keeping comments and untouched keys", () => {
    const out = writeForm(CONFIG, { "people.architects": "pat, pat@acme.io, pat", "jira.project_key": "CRM", "ai.max_attempts": "2", "ai.sf_ai_tester_in_ci": "true" });
    expect(out).toContain("# Filled in by a person at HC-1");
    expect(out).toContain("# GitHub organisation");
    expect(out).toContain("project_key: CRM");
    const c = readConfig(out);
    expect(c.people.architects).toEqual([{ gh: "pat", atlassian: "pat@acme.io", slack: "pat" }]);
    expect(c.maxAttempts).toBe(2);
    expect(c.testerInCi).toBe(true);
    expect(c.org).toBe("acme-org");
  });
  it("refuses secrets, bad URLs and overlapping teams", () => {
    for (const s of ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github_pat_11AAA", "xoxb-1-2", "sk-ant-api03-x", "https://hooks.slack.com/services/T/B/X", "-----BEGIN RSA PRIVATE KEY-----"]) expect(looksLikeSecret(s), s).toBe(true);
    expect(looksLikeSecret("https://acme.atlassian.net")).toBe(false);
    const errs = validateForm({ "jira.site": "http://acme.atlassian.net", "people.architects": "pat", "people.testers": "Pat", "slack.workspace": "xoxp-123", "jira.test_tool": "qtest", "github.org": "a b" });
    expect(errs.map((e) => e.key).sort()).toEqual(["github.org", "jira.site", "jira.test_tool", "people.testers", "slack.workspace"]);
    expect(validateForm(readForm(CONFIG))).toEqual([]);
  });
});

describe("commands", () => {
  it("builds the installer command without putting the repo path in the arguments", () => {
    const c = installCommand({ pluginRoot: "D:\\Agentic Implementation Circuit\\ext\\plugin", root: "D:\\Agentic Implementation Circuit\\salesDemoOrg", org: "acme-org", dryRun: true, platform: "win32" });
    expect(c.cmd).toBe("node");
    expect(c.cwd).toBe("D:\\Agentic Implementation Circuit\\salesDemoOrg");
    expect(c.args).toEqual([`"${c.script}"`, "--repo", ".", "--org", "acme-org", "--dry-run"]);
    expect(c.script).toMatch(/skills[\\/]circuit-bootstrap[\\/]scripts[\\/]install\.mjs$/);
    const real = installCommand({ pluginRoot: "/opt/ext/plugin", root: "/w/repo", org: "acme", projectName: "Acme Corp", dryRun: false, platform: "linux" });
    expect(real.args).toEqual(["/opt/ext/plugin/skills/circuit-bootstrap/scripts/install.mjs", "--repo", ".", "--org", "acme", "--project-name", "Acme Corp"]);
    expect(() => installCommand({ pluginRoot: "/p", root: "/r", org: "acme & calc", dryRun: true, platform: "win32" })).toThrow(/organisation/);
    expect(() => installCommand({ pluginRoot: "/p", root: "/r", org: "acme", projectName: "x\"; calc", dryRun: true, platform: "win32" })).toThrow(/Project name/);
  });
  it("quotes or refuses arguments for cmd.exe", () => {
    expect(shellArg("a b", "win32")).toBe('"a b"');
    expect(shellArg("plain", "win32")).toBe("plain");
    expect(() => shellArg("100%PATH%", "win32")).toThrow();
    expect(shellArg("a b", "linux")).toBe("a b");
  });
  it("parses installer output", () => {
    const p = parseInstallOutput("DRY RUN: delivery circuit -> . (org acme)\n  ADD    CLAUDE.md\n  SKIP   .coderabbit.yaml (exists; use --force to replace)\n  MERGE  .claude/settings.json (guard registered)\n  WARN   sf-ai-tester-suites skill not found");
    expect(p.add).toEqual(["CLAUDE.md"]);
    expect(p.skip).toHaveLength(1);
    expect(p.update).toHaveLength(1);
    expect(p.warn).toHaveLength(1);
    expect(p.other).toHaveLength(1);
  });
  it("derives variables, labels and ruleset payloads", () => {
    const vars = Object.fromEntries(variablesFor(readConfig(CONFIG)).map((v) => [v.name, v.value]));
    expect(vars).toEqual({ MAX_AI_ATTEMPTS: "3", SF_INSTANCE_URL_SANDBOX: "https://login.salesforce.com", SF_INSTANCE_URL_PROD: "https://login.salesforce.com",
      SF_AI_TESTER_IN_CI: "false", SF_AI_TESTER_MODE: "manual", SF_AI_TESTER_REF: "8a5b5c276901e1d6bf3a764015da0d3bf1cf0b78" });
    const sb = variablesFor({ ...readConfig(CONFIG), devUrl: "https://acme--dev.sandbox.my.salesforce.com" });
    expect(sb.find((v) => v.name === "SF_INSTANCE_URL_SANDBOX")!.value).toBe("https://test.salesforce.com");
    expect(LABELS.map((l) => l.name)).toEqual(expect.arrayContaining(["plan-approved", "testplan-approved", "ai-ready", "needs-human", "needs-qa", "ai-attempt-3"]));
    const tpl = '{ "name": "m", "bypass_actors": [ { "actor_id": "ARCHITECTS_TEAM_ID", "actor_type": "Team" } ] }';
    expect(rulesetWithTeam(tpl, 42).bypass_actors[0].actor_id).toBe(42);
  });
  it("never allows ANTHROPIC_API_KEY as a secret", () => {
    expect(FORBIDDEN_SECRETS).toContain("ANTHROPIC_API_KEY");
    expect(secretNameOk("ANTHROPIC_API_KEY")).toBe(false);
    expect(secretNameOk("CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
    expect(secretNameOk("GITHUB_TOKEN")).toBe(false);
    expect(secretNameOk("lower")).toBe(false);
  });
});

describe("phases", () => {
  const ctx = { owner: "acme", repo: "crm", org: "acme", devUrl: "https://acme--dev.sandbox.my.salesforce.com", qaUrl: "", jiraSite: "https://acme.atlassian.net", jiraKey: "CRM", spaceKey: "SD" };
  it("covers B0-B12 with unique step ids", () => {
    const p = phases(ctx);
    expect(p.map((x) => x.id)).toEqual(PHASE_IDS);
    const ids = p.flatMap((x) => x.steps.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("gives every human checkpoint a checklist and a Verify, and https-only vendor URLs", () => {
    const steps = phases(ctx).flatMap((x) => x.steps);
    for (const s of steps.filter((x) => x.kind === "human")) {
      expect(s.checklist?.length, s.id).toBeGreaterThan(0);
      expect(s.verify, s.id).toBe(true);
    }
    for (const s of steps) for (const u of s.urls ?? []) expect(u.url, s.id).toMatch(/^https:\/\//);
    expect(steps.filter((x) => x.hc).map((x) => x.hc)).toEqual(["HC-1", "HC-2", "HC-3", "HC-4", "HC-5", "HC-6", "HC-7", "HC-8", "HC-9"]);
    expect(steps.flatMap((x) => x.secrets ?? [])).not.toContain("ANTHROPIC_API_KEY");
    expect(steps.find((x) => x.id === "b2.hc5")!.env).toBe("production");
    expect(steps.find((x) => x.id === "b2.hc4")!.urls!.map((u) => u.label)).toEqual(["DEV users", "DEV External Client Apps"]);
  });
  it("fills VERIFY placeholders in persona MCP configs", () => {
    const r = fillMcpUrls(JSON.stringify({ mcpServers: { atlassian: { type: "http", url: "VERIFY: x" }, lucid: { url: "VERIFY: y" }, weird: { url: "VERIFY" }, github: { type: "http", url: "https://api.githubcopilot.com/mcp/" } } }));
    expect(r.changed).toEqual(["atlassian", "lucid"]);
    expect(r.unknown).toEqual(["weird"]);
    const cfg = JSON.parse(r.text);
    expect(cfg.mcpServers.atlassian.url).toBe("https://mcp.atlassian.com/v2/mcp");
    expect(cfg.mcpServers.lucid).toEqual({ url: "https://mcp.lucid.app/mcp", type: "http" });
  });
  it("builds the page state with readiness and deep links", () => {
    const v = buildView({ login: "pat", admin: true, owner: "acme", repo: "crm", defs: phases(ctx), state: parseBuildState(STATE), buildStateExists: true,
      results: { "b6.space": { state: "ok", text: "Space SD", at: "2026-11-11T00:00:00Z" } }, ticks: { "b6.hc": [true, true, true] },
      secretNames: { "": ["APP_ID"] }, selected: "B6", busy: null, config: { exists: true, values: {}, errors: [] } });
    const b6 = v.phases.find((p) => p.id === "B6")!;
    expect(b6.ready).toBe(false);
    expect(b6.steps[1].checklist!.every((c) => c.done)).toBe(true);
    expect(v.phases.find((p) => p.id === "B0")!.kind).toBe("partial");
    expect(v.phases.find((p) => p.id === "B1")!.steps.find((s) => s.id === "b1.app")!.secrets).toEqual([{ name: "APP_ID", set: true }, { name: "APP_PRIVATE_KEY", set: false }]);
    expect(v.phases.find((p) => p.id === "B2")!.steps.find((s) => s.id === "b2.hc5")!.secrets![0].set).toBeNull();
    expect(v.buildState.repaired).toBe(true);
    expect(linkKind("https://github.com/organizations/acme/settings/apps/new")).toBe("github");
    expect(linkKind("https://acme.atlassian.net/wiki/spaces/SD")).toBe("confluence");
    expect(linkKind("https://acme.atlassian.net/jira/settings/automation")).toBe("jira");
    expect(linkKind("https://acme--dev.sandbox.my.salesforce.com/lightning/setup/ManageUsers/home")).toBe("salesforce");
    expect(linkKind("https://api.slack.com/apps")).toBe("slack");
  });
});
