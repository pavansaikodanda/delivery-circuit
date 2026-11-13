// ConnectionsService (docs/CIRCUIT-V4.md section 7): every row is a login the person already has. GitHub (VS Code
// sign-in), Claude (the logged-in claude CLI), Salesforce (sf CLI), Atlassian, Lucid and Fireflies (their MCP servers'
// OAuth inside Claude; acli only when installed), CodeRabbit (the GitHub App on the repo). Nothing here asks for,
// stores or forwards a token or a secret.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { ConnectionId, ConnectionStatus, ConnectionsService, Identity } from "../core/contracts";
import { run, type ModuleBase } from "../core/util";
import { baseStatus, CONNECTIONS, def } from "./catalog";
import { EMPTY_CONFIG, parseBuildConfig, type CircuitConfig } from "./config";
import { GitHubClient } from "./github";
import { GITHUB_SCOPES } from "./identity";
import {
  CODERABBIT_SLUGS, findInstallation, findServerFor, isSubscriptionAuth, MCP_KNOWN, mcpListStateFor, parseAcliAuthStatus,
  parseClaudeAuth, parseMcpConfigs, parseMcpList, parseSfOrgDisplay, type McpListEntry, type McpRowId,
} from "./parse";
import { checkLoginUrl, isNamedProduction, namedProdAliases, terminalCommand } from "./safety";

/** How long list() waits for slow CLI checks before answering with "Checking" rows. */
export const LIST_WAIT_MS = 4000;

export interface ConnectionsInternals extends ConnectionsService {
  config(): CircuitConfig;
  checkAll(): Promise<ConnectionStatus[]>;
}

const MCP_ROW: Partial<Record<ConnectionId, McpRowId>> = { atlassian: "atlassian", lucid: "lucid", fireflies: "fireflies" };

export function createConnections(base: ModuleBase, getIdentity: () => Identity | null): { service: ConnectionsInternals; gh: GitHubClient } {
  const { ctx, root, log } = base;
  const ev = new vscode.EventEmitter<void>();
  ctx.subscriptions.push(ev);
  const statuses = new Map<ConnectionId, ConnectionStatus>();
  let lastFull = 0;
  let checkAllInflight: Promise<ConnectionStatus[]> | undefined;
  let mcpListCache: { at: number; entries: McpListEntry[] } | undefined;

  // ---------- config ----------
  let cfgCache: { mtime: number; cfg: CircuitConfig } | undefined;
  function config(): CircuitConfig {
    const f = path.join(root, "build.config.yml");
    try {
      const st = fs.statSync(f);
      if (cfgCache?.mtime !== st.mtimeMs) cfgCache = { mtime: st.mtimeMs, cfg: parseBuildConfig(fs.readFileSync(f, "utf8")) };
      return cfgCache.cfg;
    } catch { return EMPTY_CONFIG; }
  }
  const sfAlias = (org: "dev" | "qa") => (org === "dev" ? config().sf.devAlias : config().sf.qaAlias);

  // ---------- GitHub ----------
  async function githubToken(): Promise<string> {
    const s = await vscode.authentication.getSession("github", GITHUB_SCOPES, { createIfNone: false });
    if (!s) throw Object.assign(new Error("Not signed in to GitHub."), { status: 401 });
    return s.accessToken;
  }
  const gh = new GitHubClient(githubToken);
  function repoRef(): { owner: string; repo: string } | undefined {
    const id = getIdentity();
    if (id?.owner && id.repo) return { owner: id.owner, repo: id.repo };
    const c = config();
    return c.githubOrg && c.githubRepo ? { owner: c.githubOrg, repo: c.githubRepo } : undefined;
  }
  const enc = encodeURIComponent;

  // ---------- helpers ----------
  function put(s: ConnectionStatus): ConnectionStatus {
    const prev = statuses.get(s.id);
    statuses.set(s.id, s);
    if (JSON.stringify(prev) !== JSON.stringify(s)) ev.fire();
    return s;
  }
  const st = (id: ConnectionId, patch: Partial<ConnectionStatus>): ConnectionStatus => ({ ...baseStatus(id), ...patch });
  function terminal(name: string): vscode.Terminal {
    const t = vscode.window.terminals.find((x) => x.name === name) ?? vscode.window.createTerminal({ name, cwd: root });
    t.show();
    return t;
  }
  const missingCli = (r: { code: number; stdout: string; stderr: string }) =>
    !r.stdout.trim() && (r.code === 127 || r.code === 9009 || /not recognized|not found|ENOENT/i.test(r.stderr));
  function pollUntilConnected(id: ConnectionId, totalMs = 180_000, everyMs = 15_000) {
    const started = Date.now();
    const tick = async () => {
      const s = await check(id).catch(() => undefined);
      if (s?.state === "connected") return;
      if (Date.now() - started < totalMs) setTimeout(tick, everyMs);
    };
    setTimeout(tick, everyMs);
  }

  // ---------- checks ----------
  async function checkGithub(): Promise<ConnectionStatus> {
    const s = await vscode.authentication.getSession("github", GITHUB_SCOPES, { createIfNone: false });
    if (!s) return put(st("github", { state: "disconnected", detail: "Sign in with GitHub in VS Code." }));
    const r = repoRef();
    return put(st("github", { state: "connected", account: s.account.label, detail: r ? `${r.owner}/${r.repo}` : "Signed in" }));
  }

  async function checkClaude(): Promise<ConnectionStatus> {
    if (process.env.ANTHROPIC_API_KEY) {
      return put(st("claude", { state: "error", detail: "ANTHROPIC_API_KEY is set for VS Code. Remove it: the circuit uses your Claude login." }));
    }
    const r = await run("claude", ["auth", "status", "--json"], { cwd: root, timeoutMs: 30_000 });
    const a = parseClaudeAuth(r.stdout);
    if (!a) return put(st("claude", { state: missingCli(r) ? "disconnected" : "error", detail: missingCli(r) ? "Claude Code is not installed." : "Could not read the Claude login." }));
    if (!a.loggedIn) return put(st("claude", { state: "disconnected", detail: "Not signed in." }));
    if (!isSubscriptionAuth(a)) return put(st("claude", { state: "error", account: a.email, detail: "Signed in without a Claude subscription." }));
    return put(st("claude", { state: "connected", account: a.email, detail: a.subscriptionType ? `${cap(a.subscriptionType)} plan` : undefined }));
  }

  async function checkSf(id: "sf-dev" | "sf-qa"): Promise<ConnectionStatus> {
    const alias = sfAlias(id === "sf-dev" ? "dev" : "qa");
    if (isNamedProduction(alias, namedProdAliases([config().sf.prodAlias]))) {
      return put(st(id, { state: "error", detail: `Alias "${alias}" is the production org. Use a sandbox alias in build.config.yml.` }));
    }
    const r = await run("sf", ["org", "display", "--target-org", alias, "--json"], { cwd: root, timeoutMs: 90_000 });
    const p = parseSfOrgDisplay(r.stdout);
    if (!p.ok || !p.org) {
      if (missingCli(r)) return put(st(id, { state: "disconnected", detail: "Salesforce CLI (sf) is not installed." }));
      const noOrg = /NoOrgFound|No authorization|not found|NamedOrgNotFound/i.test(p.error ?? "");
      return put(st(id, { state: noOrg ? "disconnected" : "error", detail: noOrg ? `No org with alias "${alias}".` : `${alias}: ${p.error}` }));
    }
    const host = p.org.instanceUrl ? new URL(p.org.instanceUrl).hostname : "";
    return put(st(id, { state: "connected", account: p.org.username, detail: `alias ${alias}${host ? ` · ${host}` : ""}` }));
  }

  async function mcpList(force = false): Promise<McpListEntry[]> {
    if (!force && mcpListCache && Date.now() - mcpListCache.at < 30 * 60_000) return mcpListCache.entries;
    const r = await run("claude", ["mcp", "list"], { cwd: root, timeoutMs: 90_000 });
    mcpListCache = { at: Date.now(), entries: parseMcpList(r.stdout) };
    return mcpListCache.entries;
  }
  /** Servers the repo's persona configs (.claude/personas/*.mcp.json) give Claude sessions. */
  function personaServers() {
    const dir = path.join(root, ".claude", "personas");
    let texts: string[] = [];
    try { texts = fs.readdirSync(dir).filter((f) => f.endsWith(".mcp.json")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")); } catch { /* none */ }
    return parseMcpConfigs(texts);
  }

  async function checkMcp(id: ConnectionId): Promise<ConnectionStatus> {
    const row = MCP_ROW[id]!;
    const entry = findServerFor(row, personaServers());
    let listed: McpListEntry | undefined;
    try { listed = mcpListStateFor(row, entry, await mcpList(), true); } catch { listed = undefined; }
    let acliNote = "";
    if (id === "atlassian") {
      const a = parseAcliAuthStatus(await run("acli", ["jira", "auth", "status"], { cwd: root, timeoutMs: 45_000 }));
      if (a.state === "logged-in") acliNote = ` · acli${a.site ? ` ${a.site}` : ""}`;
    }
    const what = id === "atlassian" ? "Jira + Confluence" : def(id).label;
    if (listed?.state === "connected") return put(st(id, { state: "connected", account: listed.name, detail: `${what} through Claude${acliNote}` }));
    if (listed?.state === "needs-auth") return put(st(id, { state: "disconnected", detail: `Sign in with /mcp in Claude${acliNote}` }));
    if (listed?.state === "failed") return put(st(id, { state: "error", detail: `Claude could not connect: ${listed.reason ?? "failed"}${acliNote}` }));
    if (entry) return put(st(id, { state: "unknown", detail: `Set up for Claude sessions; sign in with /mcp${acliNote}` }));
    return put(st(id, { state: "disconnected", detail: `Not added to Claude yet${acliNote}` }));
  }

  async function checkCodeRabbit(): Promise<ConnectionStatus> {
    const r = repoRef();
    if (!r) return put(st("coderabbit", { state: "unknown", detail: "No GitHub repository known." }));
    let seen: number | undefined;
    try {
      const prs = await gh.request<any[]>("GET", `/repos/${enc(r.owner)}/${enc(r.repo)}/pulls?state=all&sort=updated&direction=desc&per_page=5`);
      for (const pr of prs) {
        const reviews = await gh.request<any[]>("GET", `/repos/${enc(r.owner)}/${enc(r.repo)}/pulls/${pr.number}/reviews?per_page=50`);
        if (reviews.some((x) => /^coderabbitai(\[bot\])?$/.test(x?.user?.login ?? ""))) { seen = pr.number; break; }
      }
    } catch { /* fall back to the installation */ }
    if (seen) return put(st("coderabbit", { state: "connected", account: "coderabbitai", detail: `Reviewed PR #${seen}` }));
    let inst: unknown;
    if (getIdentity()?.orgOwned !== false) {
      try { inst = await gh.request("GET", `/orgs/${enc(r.owner)}/installations?per_page=100`); } catch { inst = undefined; }
    }
    const app = inst !== undefined ? findInstallation(inst, CODERABBIT_SLUGS) : undefined;
    if (app?.suspended) return put(st("coderabbit", { state: "error", detail: "The app is suspended on this org." }));
    if (app) return put(st("coderabbit", { state: "connected", account: "coderabbitai", detail: app.selection === "all" ? "Installed on all repos" : "Installed; no review yet" }));
    if (inst !== undefined) return put(st("coderabbit", { state: "disconnected", detail: "The GitHub App is not installed." }));
    return put(st("coderabbit", { state: "unknown", detail: "No review seen yet." }));
  }

  async function check(id: ConnectionId): Promise<ConnectionStatus> {
    try {
      switch (id) {
        case "github": return await checkGithub();
        case "claude": return await checkClaude();
        case "sf-dev": case "sf-qa": return await checkSf(id);
        case "coderabbit": return await checkCodeRabbit();
        default: return await checkMcp(id);
      }
    } catch (e: any) {
      return put(st(id, { state: "error", detail: String(e?.message ?? e).slice(0, 200) }));
    }
  }

  function checkAll(): Promise<ConnectionStatus[]> {
    checkAllInflight ??= (async () => {
      mcpListCache = undefined;
      for (const c of CONNECTIONS) if (!statuses.has(c.id)) statuses.set(c.id, st(c.id, { state: "checking" }));
      ev.fire();
      await Promise.all(CONNECTIONS.map((c) => check(c.id)));
      lastFull = Date.now();
      return listNow();
    })().finally(() => { checkAllInflight = undefined; });
    return checkAllInflight;
  }

  // ---------- connect / fix ----------
  async function connectMcp(id: ConnectionId): Promise<ConnectionStatus> {
    const row = MCP_ROW[id]!;
    const k = MCP_KNOWN[row];
    let listed: McpListEntry | undefined;
    try { listed = mcpListStateFor(row, findServerFor(row, personaServers()), await mcpList(true), true); } catch { listed = undefined; }
    if (!listed) {
      const yes = "Add";
      const pick = await vscode.window.showInformationMessage(`Add ${def(id).label} to Claude?`,
        { modal: true, detail: `Runs: claude mcp add --transport http --scope user ${k.names[0]} ${k.url}\nYou then sign in with /mcp. No token is stored.` }, yes);
      if (pick !== yes) return check(id);
      const r = await run("claude", ["mcp", "add", "--transport", "http", "--scope", "user", k.names[0], k.url], { cwd: root, timeoutMs: 60_000 });
      if (r.code !== 0) throw new Error(`claude mcp add failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? `exit ${r.code}`}`);
      log(`connections: added MCP server ${k.names[0]} to Claude (user scope)`);
    }
    terminal("Claude: sign in").sendText(terminalCommand("claude", []));
    void vscode.window.showInformationMessage(`In Claude, type /mcp, pick ${listed?.name ?? k.names[0]} and sign in. Then press Check.`);
    mcpListCache = undefined;
    return put(st(id, { state: "checking", detail: "Waiting for the /mcp sign-in" }));
  }

  async function connect(id: ConnectionId): Promise<ConnectionStatus> {
    switch (id) {
      case "github":
        await vscode.authentication.getSession("github", GITHUB_SCOPES, { createIfNone: true });
        return check("github");
      case "claude":
        terminal("Claude: sign in").sendText(terminalCommand("claude", ["auth", "login"]));
        pollUntilConnected("claude");
        return put(st("claude", { state: "checking", detail: "Waiting for the browser sign-in" }));
      case "sf-dev": case "sf-qa": {
        const org = id === "sf-dev" ? "dev" : "qa";
        const alias = sfAlias(org);
        const decision = checkLoginUrl(org === "dev" ? config().sf.devUrl : config().sf.qaUrl);
        if (!decision.allowed) return put(st(id, { state: "error", detail: decision.warning }));
        terminal("Salesforce: log in").sendText(terminalCommand("sf", ["org", "login", "web", "--alias", alias, "--instance-url", decision.url]));
        pollUntilConnected(id);
        return put(st(id, { state: "checking", detail: `Waiting for the browser login (${alias})` }));
      }
      case "coderabbit": {
        const r = repoRef();
        let app;
        try { app = r ? findInstallation(await gh.request("GET", `/orgs/${enc(r.owner)}/installations?per_page=100`), CODERABBIT_SLUGS) : undefined; } catch { app = undefined; }
        await vscode.env.openExternal(vscode.Uri.parse(app?.url ?? "https://github.com/apps/coderabbitai/installations/new"));
        return check("coderabbit");
      }
      default:
        return connectMcp(id);
    }
  }

  const listNow = () => CONNECTIONS.map((c) => statuses.get(c.id) ?? st(c.id, {}));

  const service: ConnectionsInternals = {
    async list() {
      if (checkAllInflight) return listNow();
      if (!lastFull || Date.now() - lastFull > 5 * 60_000) {
        const all = checkAll();
        let timer: NodeJS.Timeout | undefined;
        const early = await Promise.race([all, new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), LIST_WAIT_MS); })])
          .finally(() => clearTimeout(timer));
        return early ?? listNow();
      }
      return listNow();
    },
    cached: listNow,
    check,
    async connect(id) {
      try { return await connect(id); } catch (e: any) {
        void vscode.window.showErrorMessage(`${def(id).label}: ${e?.message ?? e}`);
        return check(id);
      }
    },
    onDidChange: ev.event,
    sfAlias,
    githubRequest: (method, p, body) => gh.request(method, p, body),
    githubGraphql: (q, v) => gh.graphql(q, v),
    config,
    checkAll,
  };
  return { service, gh };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
