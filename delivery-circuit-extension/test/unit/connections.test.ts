import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { ConnectionStatus, Persona } from "../../src/core/contracts";
import { actionable, baseStatus, CONNECTIONS, visibleRows } from "../../src/connections/catalog";
import { isPlaceholder, normalizeSite, parseBuildConfig, parseDate, parseReminders, slackWorkspaceUrl } from "../../src/connections/config";
import { applyExpiry, claudeTokenExpiry, expiryState, expiryText } from "../../src/connections/expiry";
import { checkLoginUrl, classifySfUrl, safeRelPath, sfOrgDecision, terminalCommand } from "../../src/connections/safety";
import { isFileSecret, scanWorkflows, sealSecret, loadSodium, validateEnvironmentName, validateSecretName } from "../../src/connections/secrets";
import {
  findCodeAnalyzer, findServerFor, isSubscriptionAuth, mcpListStateFor, parseClaudeAuth, parseMcpConfigs, parseMcpList,
  parseSfOrgDisplay, parseSfPlugins, requiredBrowsers, browserDir,
} from "../../src/connections/parse";
import { GitHubClient, githubErrorMessage, type FetchLike } from "../../src/connections/github";
import { pickActive, resolveIdentity } from "../../src/connections/identityCore";
import { buildPanelState, buildProjectInfo } from "../../src/connections/panelState";

const FX = path.join(__dirname, "..", "fixtures", "connections");
const fx = (f: string) => fs.readFileSync(path.join(FX, f), "utf8");
const rows = (): ConnectionStatus[] => CONNECTIONS.map((c) => baseStatus(c.id));

describe("neededBy filtering", () => {
  it("matches the persona matrix", () => {
    const need = (p: Persona) => CONNECTIONS.filter((c) => c.scope === "personal" && c.neededBy.includes(p)).map((c) => c.id).sort();
    expect(need("architect")).toEqual(["claude", "confluence", "fireflies", "github", "jira", "lucid", "mcp-atlassian", "mcp-fireflies", "mcp-github",
      "mcp-lucid", "mcp-salesforce", "sf-dev", "slack"].sort());
    expect(need("developer")).toEqual(["claude", "github", "jira", "mcp-atlassian", "mcp-github", "mcp-salesforce", "sf-dev", "slack"].sort());
    expect(need("tester")).toEqual(["claude", "github", "jira", "mcp-atlassian", "mcp-salesforce", "sf-dev", "sf-qa", "slack", "testing-browsers"].sort());
  });
  it("review tools are project scope", () => {
    for (const id of ["coderabbit", "code-analyzer", "ai-reviewer"]) expect(CONNECTIONS.find((c) => c.id === id)!.scope).toBe("project");
  });
  it("architect sees everything", () => {
    expect(visibleRows(rows(), ["architect"], "architect")).toHaveLength(CONNECTIONS.length);
    expect(visibleRows(rows(), ["architect", "developer"], "developer")).toHaveLength(CONNECTIONS.length);
  });
  it("developer sees own personal rows plus project rows", () => {
    const ids = visibleRows(rows(), ["developer"], "developer").map((r) => r.id);
    expect(ids).toContain("coderabbit");
    expect(ids).toContain("mcp-github");
    expect(ids).not.toContain("sf-qa");
    expect(ids).not.toContain("fireflies");
    expect(ids).not.toContain("testing-browsers");
  });
  it("tester sees sf-qa and browsers but not confluence", () => {
    const ids = visibleRows(rows(), ["tester"], "tester").map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["sf-qa", "testing-browsers", "ai-reviewer"]));
    expect(ids).not.toContain("confluence");
    expect(ids).not.toContain("mcp-github");
  });
  it("no persona shows all rows", () => {
    expect(visibleRows(rows(), [], null)).toHaveLength(CONNECTIONS.length);
  });
  it("project rows are actionable only for admins", () => {
    expect(actionable({ scope: "project" }, false)).toBe(false);
    expect(actionable({ scope: "project" }, true)).toBe(true);
    expect(actionable({ scope: "personal" }, false)).toBe(true);
  });
  it("extra neededBy from persona configs is merged", () => {
    expect(baseStatus("mcp-slack", ["tester"]).neededBy).toEqual(["tester"]);
    expect(baseStatus("mcp-github", ["architect", "tester"]).neededBy.sort()).toEqual(["architect", "developer", "tester"]);
  });
});

describe("Salesforce URL safety", () => {
  it("classifies hosts", () => {
    expect(classifySfUrl("https://acme--uat.sandbox.my.salesforce.com")).toBe("sandbox");
    expect(classifySfUrl("https://acme--uat.my.salesforce.com")).toBe("sandbox");
    expect(classifySfUrl("https://cs42.salesforce.com")).toBe("sandbox");
    expect(classifySfUrl("https://test.salesforce.com")).toBe("test-login");
    expect(classifySfUrl("https://login.salesforce.com")).toBe("production-like");
    expect(classifySfUrl("https://acme.my.salesforce.com")).toBe("production-like");
    expect(classifySfUrl("https://acme-dev-ed.develop.my.salesforce.com")).toBe("dev-edition");
    expect(classifySfUrl("https://x.scratch.my.salesforce.com")).toBe("scratch");
    expect(classifySfUrl("http://acme.sandbox.my.salesforce.com")).toBe("invalid");
    expect(classifySfUrl("https://evil.example.com/salesforce.com")).toBe("invalid");
    expect(classifySfUrl("https://salesforce.com.evil.io")).toBe("invalid");
    expect(classifySfUrl(undefined)).toBe("invalid");
  });
  it("refuses production-looking URLs unless declared trial", () => {
    expect(checkLoginUrl("https://acme.my.salesforce.com", false).allowed).toBe(false);
    expect(checkLoginUrl("https://login.salesforce.com", false).allowed).toBe(false);
    const t = checkLoginUrl("https://acme.my.salesforce.com/", true);
    expect(t.allowed).toBe(true);
    expect(t.warning).toMatch(/production/);
    expect(t.url).toBe("https://acme.my.salesforce.com");
  });
  it("lets AI work only in sandbox-like orgs or declared trial orgs", () => {
    expect(sfOrgDecision("qa", "https://acme--uat.sandbox.my.salesforce.com", false)).toEqual({ allowed: true });
    expect(sfOrgDecision("dev", "https://acme-dev-ed.develop.my.salesforce.com", false).allowed).toBe(true);
    const prod = sfOrgDecision("qa", "https://acme.my.salesforce.com", false);
    expect(prod.allowed).toBe(false);
    expect(prod.reason).toMatch(/production-looking org \(acme\.my\.salesforce\.com\)/);
    expect(sfOrgDecision("qa", "https://acme.my.salesforce.com", true)).toMatchObject({ allowed: true, reason: expect.stringMatching(/trial/) });
    expect(sfOrgDecision("qa", undefined, true).allowed).toBe(false);
  });
  it("defaults to test.salesforce.com and allows sandboxes silently", () => {
    expect(checkLoginUrl(undefined, false)).toEqual({ allowed: true, url: "https://test.salesforce.com" });
    expect(checkLoginUrl("https://a--b.sandbox.my.salesforce.com", false).warning).toBeUndefined();
  });
  it("terminal commands only accept safe arguments", () => {
    expect(terminalCommand("sf", ["org", "login", "web", "--alias", "dev", "--instance-url", "https://a.my.salesforce.com"]))
      .toBe("sf org login web --alias dev --instance-url https://a.my.salesforce.com");
    expect(() => terminalCommand("sf", ["--alias", "dev; rm -rf /"])).toThrow();
    expect(() => terminalCommand("sf", ["$(whoami)"])).toThrow();
    expect(() => terminalCommand("claude", ["a b"])).toThrow();
    expect(safeRelPath(".claude\\personas\\tester.mcp.json")).toBe(".claude/personas/tester.mcp.json");
    expect(safeRelPath("../x.json")).toBeUndefined();
    expect(safeRelPath("C:/x.json")).toBeUndefined();
  });
});

describe("build.config.yml parsing", () => {
  it("reads the real client config", () => {
    const c = parseBuildConfig(fx("build.config.yml"));
    expect(c.githubOrg).toBe("acme-org");
    expect(c.githubRepo).toBe("salesDemoOrg");
    expect(c.jiraSite).toBeUndefined(); // https://<site>.atlassian.net is a placeholder
    expect(c.jiraProjectKey).toBe("ABC");
    expect(c.confluenceSpace).toBe("SD");
    expect(c.sf.devUrl).toBe("https://acme-demo.my.salesforce.com");
    expect(c.sf.prodUrl).toBeUndefined();
    expect(c.sf.devAlias).toBe("dev");
    expect(c.sf.qaAlias).toBe("qa");
    expect(c.sf.devIsTrial).toBe(true); // "# SDO trial org" comment
    expect(c.slackWorkspace).toBeUndefined();
    expect(c.slackChannels).toEqual({ arch: "arch-gate", dev: "dev-gate", qa: "qa-gate" });
    expect(c.transcriptsSource).toBe("file");
  });
  it("supports aliases and explicit org types; tolerates bad yaml", () => {
    const c = parseBuildConfig("salesforce:\n  dev_alias: mydev\n  qa_alias: 'bad alias'\n  dev_sandbox_url: https://a.my.salesforce.com\n  dev_org_type: trial\n  qa_sandbox_url: https://q.my.salesforce.com\n");
    expect(c.sf.devAlias).toBe("mydev");
    expect(c.sf.qaAlias).toBe("qa");
    expect(c.sf.devIsTrial).toBe(true);
    expect(c.sf.qaIsTrial).toBe(false);
    expect(parseBuildConfig(": : :\n  - [").sf.devAlias).toBe("dev");
  });
  it("placeholders and helpers", () => {
    expect(isPlaceholder("<name>")).toBe(true);
    expect(isPlaceholder("none")).toBe(true);
    expect(isPlaceholder("VERIFY: Lucid MCP URL")).toBe(true);
    expect(isPlaceholder("acme")).toBe(false);
    expect(normalizeSite("acme.atlassian.net/")).toBe("https://acme.atlassian.net");
    expect(normalizeSite("http://acme.atlassian.net")).toBeUndefined();
    expect(normalizeSite("https://user:pw@acme.atlassian.net")).toBeUndefined();
    expect(slackWorkspaceUrl("Acme")).toBe("https://acme.slack.com");
    expect(slackWorkspaceUrl("acme.slack.com")).toBe("https://acme.slack.com");
    expect(slackWorkspaceUrl("bad name")).toBeUndefined();
  });
  it("reads build-state.md reminders, skipping placeholders", () => {
    const md = "# State\n## Reminders\n- CLAUDE_CODE_OAUTH_TOKEN expires: <date + 1 year>\n- Jira PAT for Rule A expires: 2027-01-15\n- Salesforce JWT certificates expire: 1 Mar 2027\n## Next\n- x expires: 2030-01-01\n";
    expect(parseReminders(md)).toEqual([{ label: "Jira PAT for Rule A", date: "2027-01-15" }, { label: "Salesforce JWT certificates", date: "2027-03-01" }]);
    expect(parseDate("2027-02-30")).toBeUndefined();
    expect(parseDate("soon")).toBeUndefined();
  });
});

describe("secret names and workflow needs", () => {
  it("validates names", () => {
    expect(validateSecretName("SLACK_WEBHOOK_DEV")).toBeUndefined();
    expect(validateSecretName("_X1")).toBeUndefined();
    expect(validateSecretName("")).toBeDefined();
    expect(validateSecretName("1ABC")).toMatch(/digit/);
    expect(validateSecretName("GITHUB_TOKEN")).toMatch(/GITHUB_/);
    expect(validateSecretName("github_x")).toMatch(/GITHUB_/);
    expect(validateSecretName("A-B")).toBeDefined();
    expect(validateSecretName("A B")).toBeDefined();
    expect(validateSecretName("A".repeat(256))).toBeDefined();
    expect(validateEnvironmentName("production")).toBeUndefined();
    expect(validateEnvironmentName("prod/../x")).toBeDefined();
    expect(isFileSecret("SF_JWT_KEY_DEV")).toBe(true);
    expect(isFileSecret("APP_PRIVATE_KEY")).toBe(true);
    expect(isFileSecret("JIRA_EMAIL")).toBe(false);
  });
  it("scans workflows for secrets and environments", () => {
    const w = scanWorkflows([fx("pr-checks.yml"), fx("deploy-prod.yml")]);
    expect(w.secrets).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(w.secrets).toContain("SF_JWT_KEY_PROD");
    expect(w.secrets).not.toContain("GITHUB_TOKEN");
    expect(w.environments).toEqual(["production"]);
    expect(w.envOf.SF_JWT_KEY_PROD).toBe("production");
    expect(w.envOf.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
  it("seals with libsodium so only the key holder can open it", async () => {
    const sodium: any = await loadSodium();
    const kp = sodium.crypto_box_keypair();
    const sealed = await sealSecret("s3cret-value", sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL));
    expect(sealed).not.toContain("s3cret");
    const opened = sodium.crypto_box_seal_open(sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey);
    expect(sodium.to_string(opened)).toBe("s3cret-value");
  });
});

describe("expiry", () => {
  const now = new Date("2026-11-11T00:00:00Z");
  it("states", () => {
    expect(expiryState(undefined, now)).toBe("unknown");
    expect(expiryState("garbage", now)).toBe("unknown");
    expect(expiryState("2026-11-01", now)).toBe("expired");
    expect(expiryState("2026-12-10", now)).toBe("expiring");
    expect(expiryState("2026-12-12", now)).toBe("ok");
  });
  it("Claude token is one year from when it was set", () => {
    expect(claudeTokenExpiry("2026-11-11T10:00:00.000Z")).toBe("2027-11-11T10:00:00.000Z");
  });
  it("applies to connection state", () => {
    expect(applyExpiry("connected", "2026-11-20", now)).toBe("expiring");
    expect(applyExpiry("connected", "2026-11-01", now)).toBe("error");
    expect(applyExpiry("connected", "2027-11-01", now)).toBe("connected");
    expect(applyExpiry("disconnected", "2026-11-20", now)).toBe("disconnected");
    expect(applyExpiry("connected", undefined, now)).toBe("connected");
  });
  it("text", () => {
    expect(expiryText("2026-11-12T00:00:00Z", now)).toBe("expires in 1 day (2026-11-12)");
    expect(expiryText("2026-11-01", now)).toBe("expired 2026-11-01");
    expect(expiryText("2027-05-01", now)).toBe("expires 2027-05-01");
  });
});

describe("CLI parsers", () => {
  it("claude auth status JSON and text", () => {
    const j = parseClaudeAuth(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "a@b.io", subscriptionType: "max", loginExpiresAt: "2026-11-12T08:39:17.723Z" }))!;
    expect(isSubscriptionAuth(j)).toBe(true);
    expect(j.loginExpiresAt).toBe("2026-11-12T08:39:17.723Z");
    const t = parseClaudeAuth("Login method: Claude Max account\nOrganization: Acme\nEmail: a@b.io\nSign-in ends: any day now, by 2026-11-12 (2026-11-12T08:39:17.723Z)\n")!;
    expect(t).toMatchObject({ loggedIn: true, authMethod: "claude.ai", email: "a@b.io", subscriptionType: "max", loginExpiresAt: "2026-11-12T08:39:17.723Z" });
    expect(isSubscriptionAuth({ loggedIn: true, authMethod: "api_key" })).toBe(false);
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: false }))!.loggedIn).toBe(false);
  });
  it("sf org display drops the access token", () => {
    const out = JSON.stringify({ status: 0, result: { id: "00D", accessToken: "00D!SECRET", instanceUrl: "https://a.my.salesforce.com", username: "u@x", connectedStatus: "Connected", alias: "dev" } });
    const r = parseSfOrgDisplay(out);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(r.org).toEqual({ username: "u@x", alias: "dev", instanceUrl: "https://a.my.salesforce.com", orgId: "00D", connectedStatus: "Connected", expirationDate: undefined });
    expect(parseSfOrgDisplay(JSON.stringify({ status: 1, name: "NoOrgFound", message: "No authorization information found for qa." })).ok).toBe(false);
    expect(parseSfOrgDisplay(JSON.stringify({ status: 0, result: { connectedStatus: "RefreshTokenAuthError" } })).ok).toBe(false);
    expect(parseSfOrgDisplay("not json").ok).toBe(false);
  });
  it("sf plugins", () => {
    const p = parseSfPlugins(JSON.stringify([{ name: "@salesforce/cli", version: "2" }, { name: "@salesforce/plugin-code-analyzer", version: "5.1.0" }]));
    expect(findCodeAnalyzer(p)?.version).toBe("5.1.0");
    expect(findCodeAnalyzer(parseSfPlugins("[]"))).toBeUndefined();
  });
  it("claude mcp list (both glyph sets)", () => {
    const out = [
      "Checking MCP server health…", "",
      "claude.ai Slack: https://mcp.slack.com/mcp - √ Connected",
      "plugin:sales:atlassian: https://mcp.atlassian.com/v1/mcp (HTTP) - ! Needs authentication",
      "plugin:sales:zoom: https://mcp.zoom.us/mcp (HTTP) - ✘ Failed to connect — Incompatible auth server: does not support dynamic client registration",
      "plugin:sales:gmail:  (HTTP) - - Not configured",
      "github: https://api.githubcopilot.com/mcp/ (HTTP) - ✔ Connected",
    ].join("\n");
    const l = parseMcpList(out);
    expect(l).toHaveLength(5);
    expect(l[0]).toMatchObject({ name: "claude.ai Slack", target: "https://mcp.slack.com/mcp", state: "connected" });
    expect(l[1]).toMatchObject({ name: "plugin:sales:atlassian", transport: "HTTP", state: "needs-auth" });
    expect(l[2]).toMatchObject({ state: "failed", reason: "Incompatible auth server: does not support dynamic client registration" });
    expect(l[3]).toMatchObject({ name: "plugin:sales:gmail", target: "", state: "not-configured" });
    const servers = parseMcpConfigs([fx("architect.mcp.json")]);
    const atl = findServerFor("mcp-atlassian", servers)!;
    expect(atl.placeholder).toBe(true);
    expect(findServerFor("mcp-salesforce", servers)!.type).toBe("stdio");
    expect(mcpListStateFor("mcp-atlassian", atl, l)?.state).toBe("needs-auth");
    expect(mcpListStateFor("mcp-github", findServerFor("mcp-github", servers), l)?.state).toBe("connected");
    expect(mcpListStateFor("mcp-slack", undefined, l)?.name).toBe("claude.ai Slack");
    expect(mcpListStateFor("mcp-lucid", findServerFor("mcp-lucid", servers), l)).toBeUndefined();
  });
  it("local mcp config overrides the shared one", () => {
    const s = parseMcpConfigs([fx("architect.mcp.json"), JSON.stringify({ mcpServers: { atlassian: { type: "http", url: "https://mcp.atlassian.com/v2/mcp" } } })]);
    expect(findServerFor("mcp-atlassian", s)).toMatchObject({ url: "https://mcp.atlassian.com/v2/mcp", placeholder: false });
  });
  it("playwright browsers", () => {
    const b = requiredBrowsers(JSON.stringify({ browsers: [{ name: "chromium", revision: "1246", title: "Chrome for Testing" }, { name: "chromium-headless-shell", revision: "1246" }, { name: "firefox", revision: "1" }] }));
    expect(b.map((x) => browserDir(x.name, x.revision))).toEqual(["chromium-1246", "chromium_headless_shell-1246"]);
  });
});

describe("GitHub client", () => {
  const hdr = (h: Record<string, string> = {}) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
  it("helpful error messages", () => {
    expect(githubErrorMessage(401, "GET", "/user", '{"message":"Bad credentials"}', hdr())).toMatch(/connect GitHub again/);
    expect(githubErrorMessage(403, "GET", "/x", "{}", hdr({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" }))).toMatch(/rate limit/);
    expect(githubErrorMessage(404, "GET", "/repos/a/b", '{"message":"Not Found"}', hdr())).toMatch(/read:org/);
  });
  it("sends the token and user agent, never in the error", async () => {
    const calls: any[] = [];
    const f: FetchLike = async (url, init) => { calls.push({ url, init }); return { ok: false, status: 404, headers: hdr(), text: async () => '{"message":"Not Found"}' }; };
    const c = new GitHubClient(async () => "tok_SECRET", f);
    const err = await c.request("GET", "/repos/a/b").catch((e) => e);
    expect(calls[0].init.headers.Authorization).toBe("Bearer tok_SECRET");
    expect(calls[0].init.headers["User-Agent"]).toBe("delivery-circuit");
    expect(err.status).toBe(404);
    expect(err.message).not.toContain("tok_SECRET");
    await expect(c.request("GET", "https://evil.example.com")).rejects.toThrow(/Invalid/);
  });
  it("sets a secret with the repo public key", async () => {
    const sodium: any = await loadSodium();
    const kp = sodium.crypto_box_keypair();
    const calls: any[] = [];
    const f: FetchLike = async (url, init) => {
      calls.push({ url, init });
      const body = url.endsWith("/public-key") ? JSON.stringify({ key_id: "k1", key: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL) }) : "";
      return { ok: true, status: url.endsWith("/public-key") ? 200 : 201, headers: hdr(), text: async () => body };
    };
    await new GitHubClient(async () => "t", f).setSecret("o", "r", "MY_SECRET", "hello", "production");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/environments/production/secrets/public-key");
    expect(calls[1].init.method).toBe("PUT");
    expect(calls[1].url).toBe("https://api.github.com/repos/o/r/environments/production/secrets/MY_SECRET");
    const body = JSON.parse(calls[1].init.body);
    expect(body.key_id).toBe("k1");
    expect(body.encrypted_value).not.toContain("hello");
    await expect(new GitHubClient(async () => "t", f).setSecret("o", "r", "GITHUB_X", "v")).rejects.toThrow(/GITHUB_/);
  });
});

describe("identity", () => {
  const err = (status: number) => Object.assign(new Error("x"), { status });
  const teams = { architect: "architects", developer: "developers", tester: "testers" };
  it("org repo: personas from active team memberships; admin from org role", async () => {
    const get = async (p: string): Promise<any> => {
      if (p === "/repos/acme/app") return { owner: { type: "Organization" }, permissions: { admin: false } };
      if (p === "/user/memberships/orgs/acme") return { state: "active", role: "admin" };
      if (p.includes("/teams/developers/")) return { state: "active" };
      if (p.includes("/teams/testers/")) return { state: "pending" };
      throw err(404);
    };
    const r = await resolveIdentity({ login: "me", owner: "acme", repo: "app", teams, override: "tester", get });
    expect(r.identity).toEqual({ login: "me", personas: ["developer"], active: "developer", isAdmin: true, owner: "acme", repo: "app", orgOwned: true });
    expect(r.notice).toMatch(/personaOverride is ignored/);
  });
  it("personal repo uses the override, or none with a notice", async () => {
    const get = async (p: string): Promise<any> => { if (p === "/repos/me/app") return { owner: { type: "User" }, permissions: { admin: true } }; throw err(404); };
    const a = await resolveIdentity({ login: "me", owner: "me", repo: "app", teams, override: "tester", get });
    expect(a.identity).toMatchObject({ personas: ["tester"], active: "tester", isAdmin: true, orgOwned: false });
    const b = await resolveIdentity({ login: "me", owner: "me", repo: "app", teams, override: "", get });
    expect(b.identity.personas).toEqual([]);
    expect(b.identity.active).toBeNull();
    expect(b.notice).toMatch(/personaOverride/);
  });
  it("active persona choice", () => {
    expect(pickActive(["developer", "architect"], null)).toBe("architect");
    expect(pickActive(["developer", "architect"], "developer")).toBe("developer");
    expect(pickActive(["tester"], "architect")).toBe("tester");
    expect(pickActive([], "architect")).toBeNull();
  });
});

describe("panel state", () => {
  const id = (personas: Persona[], isAdmin: boolean) => ({ login: "x", personas, active: personas[0] ?? null, isAdmin, owner: "o", repo: "r", orgOwned: true });
  it("non-admin developer: project rows visible but read-only; hidden count", () => {
    const s = buildPanelState({ identity: id(["developer"], false), statuses: rows(), links: {} });
    const review = s.groups.find((g) => g.id === "review")!;
    expect(review.rows.every((r) => !r.actionable && r.reason)).toBe(true);
    expect(s.hiddenCount).toBeGreaterThan(0);
    expect(s.groups.map((g) => g.id)).toEqual(["personal", "mcp", "review"]);
  });
  it("admin architect sees all and can act", () => {
    const s = buildPanelState({ identity: id(["architect"], true), statuses: rows(), links: {} });
    expect(s.hiddenCount).toBe(0);
    expect(s.groups.flatMap((g) => g.rows).every((r) => r.actionable)).toBe(true);
  });
  it("rows being checked show checking, keep their labels, and refreshing is passed through", () => {
    const base = rows();
    const s = buildPanelState({ identity: id(["architect"], true), statuses: base, links: {}, checking: ["github"], refreshing: true });
    const gh = s.groups.flatMap((g) => g.rows).find((r) => r.id === "github")!;
    const before = buildPanelState({ identity: id(["architect"], true), statuses: base, links: {} }).groups.flatMap((g) => g.rows).find((r) => r.id === "github")!;
    expect(gh.state).toBe("checking");
    expect(gh.connectLabel).toBe(before.connectLabel);
    expect(gh.canDisconnect).toBe(before.canDisconnect);
    expect(s.refreshing).toBe(true);
    expect(s.groups.flatMap((g) => g.rows).filter((r) => r.state === "checking").map((r) => r.id))
      .toEqual(base.filter((r) => r.state === "checking" || r.id === "github").map((r) => r.id).filter((x) => s.groups.flatMap((g) => g.rows).some((r) => r.id === x)));
    expect(buildPanelState({ identity: id(["architect"], true), statuses: base, links: {} }).refreshing).toBe(false);
  });
  it("project info marks missing, env and expiring secrets", () => {
    const p = buildProjectInfo({ needed: ["CLAUDE_CODE_OAUTH_TOKEN", "SF_JWT_KEY_PROD", "SLACK_WEBHOOK_DEV", "JIRA_API_TOKEN"], envOf: { SF_JWT_KEY_PROD: "production" },
      environments: ["production"], repoSecrets: ["CLAUDE_CODE_OAUTH_TOKEN", "JIRA_API_TOKEN"], envSecrets: { production: ["SF_JWT_KEY_PROD"] },
      reminders: [{ label: "Jira PAT for Rule A", date: "2026-11-20" }], claudeTokenExpiresAt: "2027-06-01T00:00:00Z", now: new Date("2026-11-11T00:00:00Z") });
    expect(p.webhooks).toEqual([expect.objectContaining({ name: "SLACK_WEBHOOK_DEV", present: false })]);
    expect(p.secrets.find((x) => x.name === "SF_JWT_KEY_PROD")).toMatchObject({ present: true, env: "production" });
    expect(p.secrets.find((x) => x.name === "JIRA_API_TOKEN")).toMatchObject({ expiring: true });
    expect(p.secrets.find((x) => x.name === "CLAUDE_CODE_OAUTH_TOKEN")).toMatchObject({ expiring: false, expiryText: "expires 2027-06-01" });
    expect(p.reminders[0].state).toBe("expiring");
    const q = buildProjectInfo({ needed: ["JIRA_EMAIL", "JIRA_BASE_URL"], envOf: {}, environments: [], repoSecrets: ["JIRA_EMAIL", "JIRA_BASE_URL"], envSecrets: {},
      reminders: [{ label: "Jira PAT for Rule A", date: "2026-11-20" }], now: new Date("2026-11-11T00:00:00Z") });
    expect(q.secrets.every((x) => !x.expiring && !x.expiryText)).toBe(true);
  });
});
