// v3 connection logic: acli login status, the self-hosted runner, GitHub apps on the org, rulesets / environments and
// the "no stored credentials" scan of workflows.
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { CONNECTIONS } from "../../src/connections/catalog";
import {
  acliInstallHelp, APP_SLUGS, findInstallation, mcpListStateFor, parseAcliAuthStatus, parseEnvironments, parseMcpList, parseRulesets, parseRunners,
  RUNNER_CONNECT_MESSAGE, RUNNER_REGISTER_HINT, summarizeRunners,
} from "../../src/connections/parse";
import { bannedSecretRefs, isBannedSecret } from "../../src/connections/secrets";

const FX = path.join(__dirname, "..", "fixtures", "connections");
const fx = (f: string) => fs.readFileSync(path.join(FX, f), "utf8");
const r = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr });

describe("v3 catalogue", () => {
  it("has no token rows and the v3 rows", () => {
    const ids = CONNECTIONS.map((c) => c.id);
    for (const gone of ["jira", "confluence", "fireflies"]) expect(ids).not.toContain(gone);
    expect(ids).toEqual(expect.arrayContaining(["github", "claude", "sf-dev", "sf-qa", "acli", "mcp-atlassian", "mcp-fireflies", "mcp-slack", "runner", "github-jira", "coderabbit"]));
    expect(CONNECTIONS.filter((c) => c.group === "project").map((c) => c.id)).toEqual(["runner", "github-jira", "coderabbit"]);
  });
});

describe("acli jira auth status", () => {
  it("missing program", () => {
    expect(parseAcliAuthStatus(r(1, "", "'acli' is not recognized as an internal or external command")).state).toBe("missing");
    expect(parseAcliAuthStatus(r(127, "", "")).state).toBe("missing");
    expect(parseAcliAuthStatus(r(-1, "", "spawn acli ENOENT")).state).toBe("missing");
  });
  it("logged in: site and email are read", () => {
    const a = parseAcliAuthStatus(r(0, "✓ Authenticated\n  Site: acme.atlassian.net\n  Email: demo.user@example.com\n"));
    expect(a).toEqual({ state: "logged-in", site: "acme.atlassian.net", email: "demo.user@example.com" });
    expect(parseAcliAuthStatus(r(0, "Logged in to ACME.atlassian.net")).site).toBe("acme.atlassian.net");
  });
  it("logged out, in the several ways a CLI says it", () => {
    for (const out of ["You are not logged in. Run acli jira auth login.", "Error: unauthorized", "Authenticated: false", "Session expired, please log in"]) {
      expect(parseAcliAuthStatus(r(0, out)).state).toBe("logged-out");
    }
    expect(parseAcliAuthStatus(r(1, "something went wrong")).state).toBe("logged-out");
    expect(parseAcliAuthStatus(r(1, "something went wrong")).note).toBe("something went wrong");
  });
  it("a clean exit that says nothing useful is unknown", () => {
    expect(parseAcliAuthStatus(r(0, "ok")).state).toBe("unknown");
  });
  it("install help per platform (no API token anywhere)", () => {
    const mac = acliInstallHelp("darwin");
    expect(mac.commands).toEqual([["brew", "tap", "atlassian/homebrew-acli"], ["brew", "install", "acli"]]);
    const win = acliInstallHelp("win32", "arm64");
    expect(win.text).toMatch(/acli_windows_arm64\/acli\.exe/);
    expect(acliInstallHelp("win32").text).toMatch(/acli_windows_amd64/);
    expect(acliInstallHelp("linux").guide).toMatch(/install-linux/);
    for (const p of ["darwin", "win32", "linux"] as const) expect(JSON.stringify(acliInstallHelp(p))).not.toMatch(/token/i);
  });
});

describe("self-hosted runners", () => {
  const api = {
    total_count: 3,
    runners: [
      { id: 1, name: "mac-mini", os: "macOS", status: "online", busy: true, labels: [{ name: "self-hosted", type: "read-only" }, { name: "macOS" }, { name: "Circuit", type: "custom" }, { name: "circuit-release" }] },
      { id: 2, name: "win-box", os: "Windows", status: "offline", busy: false, labels: [{ name: "self-hosted" }, { name: "circuit" }] },
      { id: 3, name: "other", os: "Linux", status: "online", busy: false, labels: [{ name: "self-hosted" }, { name: "gpu" }] },
    ],
  };
  it("parses runners, lower-casing labels", () => {
    const list = parseRunners(api);
    expect(list).toHaveLength(3);
    expect(list[0]).toEqual({ id: 1, name: "mac-mini", os: "macOS", status: "online", busy: true, labels: ["self-hosted", "macos", "circuit", "circuit-release"] });
    expect(parseRunners({})).toEqual([]);
    expect(parseRunners(null)).toEqual([]);
  });
  it("online for every label = connected, with busy and offline counts", () => {
    const s = summarizeRunners(parseRunners(api));
    expect(s.state).toBe("connected");
    expect(s.perLabel).toEqual([
      { label: "circuit", total: 2, online: 1, busy: 1, names: ["mac-mini", "win-box"] },
      { label: "circuit-release", total: 1, online: 1, busy: 1, names: ["mac-mini"] },
    ]);
    expect(s.detail).toBe("circuit: 1 online (1 busy), 1 offline · circuit-release: 1 online (1 busy)");
  });
  it("all offline = error; a label with no runner = disconnected", () => {
    const off = parseRunners({ runners: [{ id: 2, name: "win-box", status: "offline", labels: [{ name: "self-hosted" }, { name: "circuit" }, { name: "circuit-release" }] }] });
    expect(summarizeRunners(off).state).toBe("error");
    expect(summarizeRunners(off).detail).toBe("circuit: 1 offline · circuit-release: 1 offline");
    const half = parseRunners({ runners: [{ id: 1, name: "a", status: "online", busy: false, labels: [{ name: "self-hosted" }, { name: "circuit" }] }] });
    expect(summarizeRunners(half).state).toBe("disconnected");
    expect(summarizeRunners(half).detail).toBe("circuit: 1 online (idle) · circuit-release: none registered");
    expect(summarizeRunners([]).state).toBe("disconnected");
  });
  it("a runner without the self-hosted label does not count", () => {
    const x = parseRunners({ runners: [{ id: 1, name: "a", status: "online", labels: [{ name: "circuit" }, { name: "circuit-release" }] }] });
    expect(summarizeRunners(x).state).toBe("disconnected");
  });
});

describe("GitHub apps, rulesets, environments", () => {
  const inst = { total_count: 2, installations: [
    { id: 11, app_slug: "jira", repository_selection: "selected", html_url: "https://github.com/organizations/acme-org/settings/installations/11", suspended_at: null },
    { id: 12, app_slug: "coderabbitai", repository_selection: "all", html_url: "https://github.com/organizations/acme-org/settings/installations/12", suspended_at: "2026-10-01T00:00:00Z" },
  ] };
  it("finds the GitHub for Jira and CodeRabbit installations", () => {
    expect(findInstallation(inst, APP_SLUGS.githubForJira)).toEqual({ id: 11, slug: "jira", selection: "selected", url: inst.installations[0].html_url, suspended: false });
    expect(findInstallation(inst, APP_SLUGS.coderabbit)).toMatchObject({ selection: "all", suspended: true });
    expect(findInstallation({ installations: [] }, APP_SLUGS.coderabbit)).toBeUndefined();
    expect(findInstallation(undefined, APP_SLUGS.coderabbit)).toBeUndefined();
  });
  it("rulesets", () => {
    expect(parseRulesets([{ id: 1, name: "main", target: "branch", enforcement: "active" }, { id: 2 }])).toEqual([{ id: 1, name: "main", target: "branch", enforcement: "active" }]);
    expect(parseRulesets({ message: "Not Found" })).toEqual([]);
  });
  it("environments: reviewers (teams and users) and wait timer", () => {
    const e = parseEnvironments({ environments: [{ name: "production", deployment_branch_policy: { protected_branches: true }, protection_rules: [
      { type: "wait_timer", wait_timer: 10 },
      { type: "required_reviewers", reviewers: [{ type: "Team", reviewer: { slug: "architects" } }, { type: "User", reviewer: { login: "demo-architect" } }] },
    ] }, { name: "qa" }] });
    expect(e).toEqual([
      { name: "production", reviewers: ["team architects", "demo-architect"], waitMinutes: 10, branchPolicy: true },
      { name: "qa", reviewers: [], waitMinutes: undefined, branchPolicy: false },
    ]);
  });
});

describe("no stored credentials", () => {
  it("names the circuit refuses", () => {
    for (const n of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "SF_JWT_KEY_PROD", "SF_CLIENT_ID_QA", "JIRA_API_TOKEN", "ATLASSIAN_API_TOKEN", "FIREFLIES_API_KEY"]) {
      expect(isBannedSecret(n)).toBe(true);
    }
    for (const n of ["SLACK_WEBHOOK_DEV", "GITHUB_TOKEN", "JIRA_BASE_URL"]) expect(isBannedSecret(n)).toBe(false);
  });
  it("flags v2 workflows that read them; a v3 workflow is clean", () => {
    const refs = bannedSecretRefs([{ file: ".github/workflows/pr-checks.yml", text: fx("pr-checks.yml") }, { file: ".github/workflows/deploy-prod.yml", text: fx("deploy-prod.yml") }]);
    expect(refs).toEqual([
      { file: ".github/workflows/pr-checks.yml", names: ["CLAUDE_CODE_OAUTH_TOKEN", "SF_CLIENT_ID_QA", "SF_JWT_KEY_QA"] },
      { file: ".github/workflows/deploy-prod.yml", names: ["SF_CLIENT_ID_PROD", "SF_JWT_KEY_PROD"] },
    ]);
    const v3 = "jobs:\n  review:\n    runs-on: [self-hosted, circuit]\n    steps:\n      - run: claude -p \"review\"\n        env:\n          HOOK: ${{ secrets.SLACK_WEBHOOK_DEV }}\n";
    expect(bannedSecretRefs([{ file: "a.yml", text: v3 }])).toEqual([]);
  });
});

describe("MCP rows from claude mcp list", () => {
  it("claude.ai connectors count by name; the best state wins", () => {
    const list = parseMcpList([
      "claude.ai Fireflies: https://api.fireflies.ai/mcp - ✓ Connected",
      "fireflies: https://api.fireflies.ai/mcp (HTTP) - ! Needs authentication",
      "claude.ai Slack: claude.ai - ✗ Failed to connect — timeout",
      "atlassian: https://mcp.atlassian.com/v2/mcp (HTTP) - ! Needs authentication",
    ].join("\n"));
    expect(mcpListStateFor("mcp-fireflies", undefined, list, true)).toMatchObject({ name: "claude.ai Fireflies", state: "connected" });
    expect(mcpListStateFor("mcp-slack", undefined, list, true)).toMatchObject({ state: "failed", reason: "timeout" });
    expect(mcpListStateFor("mcp-slack", undefined, list, false)).toBeUndefined();
    expect(mcpListStateFor("mcp-atlassian", undefined, list, true)).toMatchObject({ state: "needs-auth" });
  });
});

describe("runner registration help", () => {
  // The PR runner runs PR-branch code; it must never hold the production login of the release runner.
  const BOTH = /circuit\s*,\s*circuit-release|circuit-release\s*,\s*circuit\b/;
  it("the Connections page tells admins to register two runners, one label each", () => {
    for (const msg of [RUNNER_REGISTER_HINT, RUNNER_CONNECT_MESSAGE]) {
      expect(msg).not.toMatch(BOTH);
      expect(msg).toMatch(/--labels circuit(?![-\w])/);
      expect(msg).toMatch(/--labels circuit-release/);
      expect(msg).toMatch(/two runners/);
    }
  });
  it("no user-facing string in the extension or plugin suggests one runner with both labels", () => {
    const roots = [path.join(__dirname, "..", "..", "src"), path.join(__dirname, "..", "..", "media"),
      path.join(__dirname, "..", "..", "..", "sf-delivery-circuit")];
    const hits: string[] = [];
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "codicons") continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.(ts|js|mjs|md|yml|yaml|sh|json|html)$/.test(e.name) && BOTH.test(fs.readFileSync(f, "utf8"))) hits.push(f);
      }
    };
    roots.forEach(walk);
    expect(hits).toEqual([]);
  });
});
