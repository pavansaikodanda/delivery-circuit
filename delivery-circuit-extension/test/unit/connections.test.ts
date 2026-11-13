import { describe, expect, it } from "vitest";
import { ROLES, roleChoices, type ConnectionStatus, type Identity, type Role } from "../../src/core/contracts";
import { baseStatus, buttonFor, CONNECTIONS, rowsFor } from "../../src/connections/catalog";
import { isPlaceholder, normalizeSite, parseBuildConfig } from "../../src/connections/config";
import { GitHubClient, githubErrorMessage, type FetchLike } from "../../src/connections/github";
import { pickActive, resolveIdentity } from "../../src/connections/identityCore";
import {
  findInstallation, findServerFor, isSubscriptionAuth, mcpListStateFor, parseAcliAuthStatus, parseClaudeAuth, parseMcpConfigs, parseMcpList,
  parseSfOrgDisplay,
} from "../../src/connections/parse";
import { checkLoginUrl, classifySfUrl, isNamedProduction, namedProdAliases, terminalCommand } from "../../src/connections/safety";

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("Connections tab rows per role", () => {
  it("about seven logins, no token, secret, webhook, runner, Claude Tag or AI Reviewer rows", () => {
    expect(ids(CONNECTIONS)).toEqual(["github", "claude", "sf-dev", "sf-qa", "atlassian", "lucid", "coderabbit", "fireflies"]);
    expect(JSON.stringify(CONNECTIONS)).not.toMatch(/token|secret|webhook|runner|tag|reviewer|slack|acli/i);
  });
  it("hides rows the role does not need", () => {
    const rows = CONNECTIONS.map((c) => baseStatus(c.id));
    const of = (r: Role) => ids(rowsFor(rows, r));
    expect(of("architect")).toEqual(["github", "claude", "sf-dev", "atlassian", "lucid", "fireflies"]);
    expect(of("developer")).toEqual(["github", "claude", "sf-dev", "atlassian", "coderabbit"]);
    expect(of("tester")).toEqual(["github", "claude", "sf-qa", "atlassian"]);
    expect(of("lead")).toEqual(["github", "atlassian", "coderabbit"]);
    expect(rowsFor(rows, null)).toHaveLength(CONNECTIONS.length);
    for (const r of ROLES) expect(of(r).length).toBeLessThanOrEqual(7);
  });
  it("Fireflies is optional; one button per state", () => {
    expect(baseStatus("fireflies").optional).toBe(true);
    expect(baseStatus("github").optional).toBeUndefined();
    const b = (state: ConnectionStatus["state"]) => buttonFor({ state });
    expect([b("connected"), b("checking"), b("error"), b("disconnected"), b("unknown")]).toEqual(["Check", "Check", "Fix", "Connect", "Connect"]);
  });
});

describe("roles", () => {
  const err = (status: number) => Object.assign(new Error("x"), { status });
  const teams = { architect: "architects", developer: "developers", tester: "testers", lead: "leads" };
  it("org repo: roles from active memberships of architects, developers, testers and leads", async () => {
    const get = async (p: string): Promise<any> => {
      if (p === "/repos/acme-org/app") return { owner: { type: "Organization" }, permissions: { admin: false } };
      if (p === "/user/memberships/orgs/acme-org") return { state: "active", role: "member" };
      if (p.includes("/teams/developers/") || p.includes("/teams/leads/")) return { state: "active" };
      if (p.includes("/teams/testers/")) return { state: "pending" };
      throw err(404);
    };
    const r = await resolveIdentity({ login: "demo-user", owner: "acme-org", repo: "app", teams, get });
    expect(r.identity).toEqual({ login: "demo-user", roles: ["developer", "lead"], active: "developer", isAdmin: false, owner: "acme-org", repo: "app", orgOwned: true });
    expect(r.notice).toBeUndefined();
  });
  it("no team (or a personal repo): every role is offered, with a notice in an org", async () => {
    const org = async (p: string): Promise<any> => { if (p === "/repos/acme-org/app") return { owner: { type: "Organization" }, permissions: { admin: true } }; throw err(404); };
    const a = await resolveIdentity({ login: "demo-user", owner: "acme-org", repo: "app", teams, previousActive: "lead", get: org });
    expect(a.identity).toMatchObject({ roles: [], active: "lead", isAdmin: true });
    expect(a.notice).toMatch(/not in a circuit team/);
    expect(roleChoices(a.identity)).toEqual(ROLES);
    const personal = async (p: string): Promise<any> => { if (p === "/repos/demo-user/app") return { owner: { type: "User" }, permissions: { admin: true } }; throw err(404); };
    const b = await resolveIdentity({ login: "demo-user", owner: "demo-user", repo: "app", teams, get: personal });
    expect(b.identity).toMatchObject({ roles: [], active: "developer", orgOwned: false });
    expect(b.notice).toBeUndefined();
  });
  it("a team that cannot be read is named", async () => {
    const get = async (p: string): Promise<any> => {
      if (p === "/repos/acme-org/app") return { owner: { type: "Organization" } };
      if (p.includes("/teams/architects/")) throw err(403);
      if (p.includes("/teams/developers/")) return { state: "active" };
      throw err(404);
    };
    const r = await resolveIdentity({ login: "demo-user", owner: "acme-org", repo: "app", teams, get });
    expect(r.notice).toMatch(/architects/);
  });
  it("active role: keeps a valid previous choice, else the first team role", () => {
    expect(pickActive(["developer", "lead"], "lead")).toBe("lead");
    expect(pickActive(["developer", "lead"], "architect")).toBe("developer");
    expect(pickActive([], "tester")).toBe("tester");
    expect(pickActive([], null)).toBe("developer");
    const id: Identity = { login: "x", roles: ["tester"], active: "tester", isAdmin: false, owner: "o", repo: "r", orgOwned: true };
    expect(roleChoices(id)).toEqual(["tester"]);
    expect(roleChoices(null)).toEqual([]);
  });
});

describe("Salesforce safety", () => {
  it("classifies hosts and allows only Salesforce https login URLs", () => {
    expect(classifySfUrl("https://acme--uat.sandbox.my.salesforce.com")).toBe("sandbox");
    expect(classifySfUrl("https://test.salesforce.com")).toBe("test-login");
    expect(classifySfUrl("https://salesforce.com.evil.io")).toBe("invalid");
    expect(checkLoginUrl("https://acme.my.salesforce.com/")).toEqual({ allowed: true, url: "https://acme.my.salesforce.com" });
    expect(checkLoginUrl(undefined)).toEqual({ allowed: true, url: "https://login.salesforce.com" });
    expect(checkLoginUrl("http://acme.my.salesforce.com").allowed).toBe(false);
  });
  it("the production alias is never used for the DEV or QA row", () => {
    const prod = namedProdAliases(["client-live"], "");
    for (const a of ["prod", "production", "client-live", "acme-prod"]) expect(isNamedProduction(a, prod), a).toBe(true);
    for (const a of ["dev", "qa", "salesOrgSDO"]) expect(isNamedProduction(a, prod), a).toBe(false);
  });
  it("terminal commands only accept safe arguments", () => {
    expect(terminalCommand("sf", ["org", "login", "web", "--alias", "dev"])).toBe("sf org login web --alias dev");
    expect(() => terminalCommand("sf", ["--alias", "dev; rm -rf /"])).toThrow();
    expect(() => terminalCommand("sf", ["$(whoami)"])).toThrow();
  });
});

describe("build.config.yml", () => {
  it("reads aliases and placeholders", () => {
    const c = parseBuildConfig("github:\n  org: acme-org\n  repo: acme-salesforce\njira:\n  site: https://<site>.atlassian.net\n  project_key: ACME\nsalesforce:\n  dev_alias: mydev\n  qa_alias: 'bad alias'\n  prod_alias: prod\n");
    expect(c).toMatchObject({ githubOrg: "acme-org", githubRepo: "acme-salesforce", jiraProjectKey: "ACME", sf: { devAlias: "mydev", qaAlias: "qa", prodAlias: "prod" } });
    expect(c.jiraSite).toBeUndefined();
    expect(parseBuildConfig(": : :\n  - [").sf.devAlias).toBe("dev");
    expect(isPlaceholder("VERIFY: x")).toBe(true);
    expect(normalizeSite("acme.atlassian.net/")).toBe("https://acme.atlassian.net");
    expect(normalizeSite("https://user:pw@acme.atlassian.net")).toBeUndefined();
  });
});

describe("CLI parsers", () => {
  it("claude auth status", () => {
    const j = parseClaudeAuth(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "demo.user@example.com", subscriptionType: "max" }))!;
    expect(isSubscriptionAuth(j)).toBe(true);
    expect(isSubscriptionAuth({ loggedIn: true, authMethod: "api_key" })).toBe(false);
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: false }))!.loggedIn).toBe(false);
  });
  it("sf org display drops the access token", () => {
    const r = parseSfOrgDisplay(JSON.stringify({ status: 0, result: { id: "00D", accessToken: "00D!SECRET", instanceUrl: "https://acme-demo.my.salesforce.com", username: "demo.user@example.com", connectedStatus: "Connected" } }));
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(parseSfOrgDisplay(JSON.stringify({ status: 1, name: "NoOrgFound" })).ok).toBe(false);
  });
  it("MCP rows from claude mcp list and the persona configs", () => {
    const l = parseMcpList([
      "claude.ai Atlassian: https://mcp.atlassian.com/v2/mcp - √ Connected",
      "lucid: https://mcp.lucid.app/mcp (HTTP) - ! Needs authentication",
      "fireflies: https://api.fireflies.ai/mcp (HTTP) - ✘ Failed to connect — timeout",
    ].join("\n"));
    expect(mcpListStateFor("atlassian", undefined, l, true)?.state).toBe("connected");
    expect(mcpListStateFor("lucid", undefined, l, true)?.state).toBe("needs-auth");
    expect(mcpListStateFor("fireflies", undefined, l, true)).toMatchObject({ state: "failed", reason: "timeout" });
    const servers = parseMcpConfigs([JSON.stringify({ mcpServers: { atlassian: { type: "http", url: "https://mcp.atlassian.com/v2/mcp" } } })]);
    expect(findServerFor("atlassian", servers)).toMatchObject({ placeholder: false });
    expect(findServerFor("lucid", servers)).toBeUndefined();
  });
  it("acli is optional: missing, logged out, logged in", () => {
    expect(parseAcliAuthStatus({ code: 9009, stdout: "", stderr: "'acli' is not recognized" }).state).toBe("missing");
    expect(parseAcliAuthStatus({ code: 1, stdout: "", stderr: "not logged in" }).state).toBe("logged-out");
    expect(parseAcliAuthStatus({ code: 0, stdout: "Site: acme.atlassian.net\nEmail: demo.user@example.com", stderr: "" })).toMatchObject({ state: "logged-in", site: "acme.atlassian.net" });
  });
  it("finds the CodeRabbit installation", () => {
    const inst = { installations: [{ id: 7, app_slug: "coderabbitai", repository_selection: "all", html_url: "https://github.com/organizations/acme-org/settings/installations/7" }] };
    expect(findInstallation(inst, ["coderabbitai"])).toMatchObject({ selection: "all", suspended: false });
    expect(findInstallation({ installations: [] }, ["coderabbitai"])).toBeUndefined();
  });
});

describe("GitHub client", () => {
  const hdr = (h: Record<string, string> = {}) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
  it("helpful errors that never include the token", async () => {
    expect(githubErrorMessage(401, "GET", "/user", '{"message":"Bad credentials"}', hdr())).toMatch(/connect GitHub again/);
    const f: FetchLike = async () => ({ ok: false, status: 404, headers: hdr(), text: async () => '{"message":"Not Found"}' });
    const err = await new GitHubClient(async () => "tok_SECRET", f).request("GET", "/repos/a/b").catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.message).not.toContain("tok_SECRET");
    await expect(new GitHubClient(async () => "t", f).request("GET", "https://evil.example.com")).rejects.toThrow(/Invalid/);
  });
});
