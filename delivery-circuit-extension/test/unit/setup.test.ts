import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { parseBuildState, serializeBuildState, setToolVersions, splitRow, statusKind, updatePhase } from "../../src/setup/buildState";
import {
  acliInstall, acliStatus, installCommand, LABELS, leftoverCredentials, parseInstallOutput, parseRunners, prodAliases, rulesetWithTeam, runnerGuide,
  runnerLogins, runnerReady, shellArg, STORED_CREDENTIALS, variablesFor,
} from "../../src/setup/commands";
import { looksLikeSecret, readConfig, readForm, textToPeople, validateForm, writeForm } from "../../src/setup/config";
import { fillMcpUrls, PHASE_IDS, phases } from "../../src/setup/phases";
import { buildView, linkKind, stepActions, stepStatus } from "../../src/setup/view";

const FX = path.join(__dirname, "..", "fixtures", "setup");
const STATE = fs.readFileSync(path.join(FX, "build-state.salesDemoOrg.md"), "utf8");
const CONFIG = fs.readFileSync(path.join(FX, "build.config.yml"), "utf8");
const CTX = {
  owner: "acme-org", repo: "acme-salesforce", org: "acme-org", jiraSite: "https://acme.atlassian.net", jiraKey: "ACME", spaceKey: "SD",
  devAlias: "dev", qaAlias: "qa", prodAlias: "prod", platform: "linux" as NodeJS.Platform,
  runners: { circuit: { name: "circuit-1", os: "linux", labels: ["circuit"] }, release: { name: "circuit-release-1", os: "linux", labels: ["circuit-release"] } },
};

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
    expect(f["salesforce.prod_alias"]).toBe("prod");
    expect(f["runners.release.os"]).toBe("linux");
    expect(f["slack.channels.review"]).toBe("review-room");
    expect(f["people.architects"]).toBe("");
    expect(f["ai.sf_ai_tester_in_ci"]).toBe("false");
    const c = readConfig(CONFIG);
    expect(c.runners).toEqual({ circuit: { name: "circuit-1", os: "linux", labels: ["circuit"] }, release: { name: "circuit-release-1", os: "linux", labels: ["circuit-release"] } });
    expect([c.devAlias, c.qaAlias, c.prodAlias, c.architectsGroup, c.slackTransport]).toEqual(["dev", "qa", "prod", "architects", "claude"]);
    expect(textToPeople("@pat, pat@acme.io, @pat\n\n sam ")).toEqual([{ gh: "pat", atlassian: "pat@acme.io", slack: "pat" }, { gh: "sam", atlassian: "", slack: "" }]);
  });
  it("writes back keeping comments and untouched keys", () => {
    const out = writeForm(CONFIG, { "people.architects": "pat, pat@acme.io, pat", "jira.project_key": "CRM", "ai.max_attempts": "2", "ai.sf_ai_tester_in_ci": "true" });
    expect(out).toContain("Filled in by a person at HC-1");
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
    const errs = validateForm({ "jira.site": "http://acme.atlassian.net", "people.architects": "pat", "people.testers": "Pat", "slack.workspace": "xoxp-123", "jira.test_tool": "qtest", "github.org": "a b",
      "salesforce.prod_alias": "prod & calc" });
    expect(errs.map((e) => e.key).sort()).toEqual(["github.org", "jira.site", "jira.test_tool", "people.testers", "salesforce.prod_alias", "slack.workspace"]);
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
  it("derives variables (names and flags only), labels and ruleset payloads", () => {
    const vars = Object.fromEntries(variablesFor(readConfig(CONFIG)).map((v) => [v.name, v.value]));
    expect(vars).toEqual({ MAX_AI_ATTEMPTS: "3", CIRCUIT_QA_ALIAS: "qa", CIRCUIT_PROD_ALIAS: "prod", CIRCUIT_RELEASE_ALIAS: "prod",
      DESIGN_PENDING_STATUSES: "Backlog,Design Review", SLACK_CHANNEL_DEV: "dev-gate", SLACK_CHANNEL_QA: "qa-gate", CIRCUIT_SLACK_TRANSPORT: "claude",
      SF_AI_TESTER_IN_CI: "false", SF_AI_TESTER_MODE: "manual", SF_AI_TESTER_REF: "8a5b5c276901e1d6bf3a764015da0d3bf1cf0b78" });
    expect(Object.keys(vars).some((k) => /TOKEN|KEY|SECRET|WEBHOOK|JWT/.test(k))).toBe(false);
    expect(LABELS.map((l) => l.name)).toEqual(expect.arrayContaining(["plan-approved", "testplan-approved", "ai-ready", "needs-fix", "needs-human", "needs-qa", "ai-attempt-3", "review-room", "review-verdict"]));
    expect(LABELS.map((l) => l.name)).not.toContain("sdd");
    const tpl = '{ "name": "m", "bypass_actors": [ { "actor_id": "ARCHITECTS_TEAM_ID", "actor_type": "Team" } ] }';
    expect(rulesetWithTeam(tpl, 42).bypass_actors[0].actor_id).toBe(42);
  });
  it("finds leftover stored credentials (v3 stores none)", () => {
    expect(STORED_CREDENTIALS).toEqual(expect.arrayContaining(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "SF_JWT_KEY_PROD", "JIRA_API_TOKEN", "SLACK_WEBHOOK_DEV"]));
    expect(leftoverCredentials(["CLAUDE_CODE_OAUTH_TOKEN", "SF_JWT_KEY_QA", "JIRA_EMAIL", "SLACK_WEBHOOK_ARCH", "SOME_API_KEY", "CODECOV_FLAGS"]))
      .toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "SF_JWT_KEY_QA", "JIRA_EMAIL", "SLACK_WEBHOOK_ARCH", "SOME_API_KEY"]);
    expect(leftoverCredentials([])).toEqual([]);
  });
});

describe("self-hosted runners and acli", () => {
  const circuit = { name: "circuit-1", os: "linux", labels: ["circuit"] };
  it("builds registration guides without any token value", () => {
    const lin = runnerGuide("acme-org", "acme-salesforce", circuit, "circuit");
    expect(lin.commands.join("\n")).toContain("./config.sh --url https://github.com/acme-org/acme-salesforce --token \"$(gh api -X POST repos/acme-org/acme-salesforce/actions/runners/registration-token --jq .token)\" --name circuit-1 --labels circuit");
    expect(lin.commands.join("\n")).toContain("sudo ./svc.sh install");
    const win = runnerGuide("acme-org", "acme-salesforce", { name: "", os: "windows", labels: ["circuit-release"] }, "release");
    expect(win.commands.join("\n")).toMatch(/config\.cmd --url https:\/\/github\.com\/acme-org\/acme-salesforce --token \$t --name circuit-release-1 --labels circuit-release/);
    expect(win.notes.join(" ")).toMatch(/production/);
    const mac = runnerGuide("acme-org", "acme-salesforce", { ...circuit, os: "macos" }, "circuit");
    expect(mac.commands).toContain("./svc.sh install && ./svc.sh start");
    for (const g of [lin, win, mac]) expect(g.commands.join(" ")).not.toMatch(/gh[pousr]_|github_pat_|sk-ant-/);
  });
  it("lists the runner service-user logins; production only on the release runner", () => {
    const c = runnerLogins({ devAlias: "dev", qaAlias: "qa", prodAlias: "prod" }, "circuit");
    expect(c).toEqual(expect.arrayContaining(["acli jira auth login --web", "gh auth login    # scopes repo, read:org"]));
    expect(c.join(" ")).toContain("--not-sf prod");
    expect(c.join(" ")).not.toMatch(/login web --alias prod/);
    expect(runnerLogins({ devAlias: "dev", qaAlias: "qa", prodAlias: "live-org" }, "release")[0]).toMatch(/^sf org login web --alias live-org/);
  });
  it("reads runners from the API and needs every label, online", () => {
    const list = parseRunners({ total_count: 3, runners: [
      { id: 1, name: "circuit-1", os: "Linux", status: "online", busy: false, labels: [{ name: "self-hosted" }, { name: "Linux" }, { name: "circuit" }] },
      { id: 2, name: "circuit-release-1", os: "Linux", status: "offline", busy: false, labels: [{ name: "self-hosted" }, { name: "circuit-release" }] },
    ] });
    expect(runnerReady(list, ["circuit"])).toEqual({ ok: true, line: "[self-hosted, circuit]: circuit-1 online" });
    expect(runnerReady(list, ["circuit-release"])).toEqual({ ok: false, line: "[self-hosted, circuit-release]: circuit-release-1 offline" });
    expect(runnerReady(list, ["CIRCUIT"]).ok).toBe(true); // labels are case-insensitive
    expect(runnerReady([], ["circuit"]).line).toMatch(/no runner registered/);
    expect(parseRunners(undefined)).toEqual([]);
  });
  it("installs acli per platform and reads its auth status defensively", () => {
    expect(acliInstall("win32")[0]).toBe("Invoke-WebRequest -Uri https://acli.atlassian.com/windows/latest/acli_windows_amd64/acli.exe -OutFile acli.exe");
    expect(acliInstall("win32", "arm64")[0]).toContain("acli_windows_arm64");
    expect(acliInstall("darwin")[0]).toBe("brew tap atlassian/homebrew-acli && brew install acli");
    expect(acliInstall("linux")[0]).toContain("acli_linux_amd64");
    expect(acliStatus(0, "✓ Authenticated\n  Site: acme.atlassian.net\n  Email: demo.user@example.com")).toEqual({ signedIn: true, detail: "signed in to acme.atlassian.net" });
    expect(acliStatus(0, "You are not logged in. Run acli jira auth login").signedIn).toBe(false);
    expect(acliStatus(1, "").signedIn).toBe(false);
    expect(prodAliases("Prod-Org")).toEqual(["prod-org", "prod", "production", "live"]);
  });
});

describe("phases", () => {
  const ctx = CTX;
  it("covers B0-B13 with unique step ids", () => {
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
    expect(steps.filter((x) => x.hc).map((x) => x.hc)).toEqual(["HC-1", "HC-2", "HC-3", "HC-5", "HC-6", "HC-7", "HC-8", "HC-9", "HC-10"]);
    expect(PHASE_IDS).toEqual(["B0", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12", "B13"]);
  });
  it("stores no credentials: no secret steps, no token in any text or command", () => {
    const steps = phases(ctx).flatMap((x) => x.steps);
    expect(steps.map((x) => x.kind)).not.toContain("secret");
    const text = JSON.stringify(steps);
    expect(text).not.toMatch(/setup-token|External Client App|jwt-key|SLACK_WEBHOOK_|JIRA_API_TOKEN|APP_PRIVATE_KEY/);
    expect(steps.flatMap((x) => x.commands ?? []).filter((c) => /^acli /.test(c) && /--token/.test(c))).toEqual([]);
    expect(steps.find((x) => x.id === "b2.circuit")!.commands!.join(" ")).toContain("--labels circuit");
    expect(steps.find((x) => x.id === "b2.release")!.commands!.join(" ")).toContain("--labels circuit-release");
    expect(steps.find((x) => x.id === "b6.acli")!.commands).toEqual(expect.arrayContaining(["acli jira auth login --web", "acli jira auth status"]));
    expect(steps.find((x) => x.id === "b1.nosecrets")).toMatchObject({ kind: "check", verify: true });
    expect(steps.find((x) => x.id === "b9.coderabbit")!.urls![0].url).toBe("https://github.com/apps/coderabbitai/installations/new");
    expect(steps.find((x) => x.id === "b6.app")!.title).toBe("GitHub for Atlassian");
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
      results: { "b7.space": { state: "ok", text: "Atlassian MCP connected", at: "2026-11-11T00:00:00Z" } }, ticks: { "b7.mcp": [true, true, true] },
      selected: "B7", busy: null, config: { exists: true, values: {}, errors: [] } });
    const b7 = v.phases.find((p) => p.id === "B7")!;
    expect(b7.ready).toBe(false);
    expect(b7.steps[1].checklist!.every((c) => c.done)).toBe(true);
    expect(v.phases.find((p) => p.id === "B0")!.kind).toBe("partial");
    const reg = v.phases.find((p) => p.id === "B2")!.steps.find((s) => s.id === "b2.circuit")!;
    expect(reg.commands!.length).toBeGreaterThan(1);
    expect(reg.notes![0]).toMatch(/expires after 1 hour/);
    expect(v.buildState.repaired).toBe(true);
    expect(linkKind("https://github.com/organizations/acme/settings/apps/new")).toBe("github");
    expect(linkKind("https://acme.atlassian.net/wiki/spaces/SD")).toBe("confluence");
    expect(linkKind("https://acme.atlassian.net/jira/settings/automation")).toBe("jira");
    expect(linkKind("https://acme--dev.sandbox.my.salesforce.com/lightning/setup/ManageUsers/home")).toBe("salesforce");
    expect(linkKind("https://api.slack.com/apps")).toBe("slack");
  });
});

describe("step rows (design v2: one status, one primary action)", () => {
  const base = { id: "x", kind: "run" as const, title: "T", detail: "", verify: true, links: [] };
  it("gives one status phrase per step", () => {
    expect(stepStatus(base, "x")).toEqual({ tone: "info", text: "working", busy: true });
    expect(stepStatus({ ...base, kind: "check", result: { state: "ok", text: "", at: "" } }, null)).toEqual({ tone: "ok", text: "passed" });
    expect(stepStatus({ ...base, result: { state: "ok", text: "", at: "" } }, "other")).toEqual({ tone: "ok", text: "done" });
    expect(stepStatus({ ...base, result: { state: "warn", text: "", at: "" } }, null).text).toBe("needs attention");
    expect(stepStatus({ ...base, result: { state: "err", text: "", at: "" } }, null).tone).toBe("err");
    expect(stepStatus(base, null)).toEqual({ tone: "muted", text: "not run" });
    expect(stepStatus({ ...base, kind: "check" }, null).text).toBe("not checked");
    const human = { ...base, kind: "human" as const, checklist: [{ text: "a", done: true }, { text: "b", done: false }] };
    expect(stepStatus(human, null)).toEqual({ tone: "info", text: "1 of 2 ticked" });
    expect(stepStatus({ ...human, checklist: [] }, null).text).toBe("waiting for you");
    expect(stepStatus({ ...human, checklist: [{ text: "a", done: true }] }, null).text).toBe("ready to verify");
  });
  it("puts the open thing to do first", () => {
    expect(stepActions({ ...base, action: "Create labels" }).map((a) => a.label)).toEqual(["Create labels", "Check"]);
    expect(stepActions({ ...base, kind: "form" }).map((a) => a.do)).toEqual(["form", "verify"]);
    expect(stepActions({ ...base, kind: "human" }).map((a) => a.label)).toEqual(["Verify"]);
    // a check reads first; its follow-up (delete leftovers, record versions) comes second
    expect(stepActions({ ...base, kind: "check", action: "Delete leftover secrets" }).map((a) => a.label)).toEqual(["Check", "Delete leftover secrets"]);
    expect(stepActions({ ...base, kind: "terminal", action: "Open terminal: acli jira auth login --web" }).map((a) => a.do)).toEqual(["run", "verify"]);
    expect(stepActions({ ...base, kind: "terminal", verify: false })).toEqual([{ do: "run", label: "Open terminal" }]);
  });
  it("adds status, actions and progress to the page state", () => {
    const v = buildView({ login: "pat", admin: true, owner: "acme", repo: "crm", defs: phases(CTX), state: parseBuildState(STATE), buildStateExists: true,
      results: { "b6.acli": { state: "ok", text: "acli signed in", at: "2026-11-11T00:00:00Z" } }, ticks: {},
      selected: "B6", busy: "b6.acli", config: { exists: true, values: {}, errors: [] } });
    const b6 = v.phases.find((p) => p.id === "B6")!;
    expect(b6.progress).toEqual({ done: 1, total: b6.steps.length });
    expect(b6.steps[0].done).toBe(true);
    expect(b6.steps[0].status.busy).toBe(true);
    expect(v.phases.every((p) => p.steps.every((s) => s.status.text && Array.isArray(s.actions)))).toBe(true);
  });
});
