// ConnectionsService: checks, connect / disconnect flows, GitHub API access and Actions secrets.
// Secrets live only in SecretStorage or go straight to GitHub (sealed). Nothing secret is logged or rendered.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { ConnectionId, ConnectionStatus, ConnectionsService, DeepLink, Identity, JiraCredentials, Persona, SfOrgGuard } from "../core/contracts";
import { PERSONAS } from "../core/contracts";
import { run, type ModuleBase } from "../core/util";
import { baseStatus, CONNECTIONS, def } from "./catalog";
import { EMPTY_CONFIG, normalizeSite, parseBuildConfig, parseReminders, slackWorkspaceUrl, type CircuitConfig, type Reminder } from "./config";
import { applyExpiry, claudeTokenExpiry } from "./expiry";
import { GitHubClient } from "./github";
import { GITHUB_SCOPES } from "./identity";
import {
  browserDir, findCodeAnalyzer, findServerFor, isSubscriptionAuth, MCP_KNOWN, mcpListStateFor, parseClaudeAuth, parseMcpConfigs,
  parseMcpList, parseSfOrgDisplay, parseSfPlugins, requiredBrowsers, type McpListEntry, type McpRowId, type McpServerEntry,
} from "./parse";
import { checkLoginUrl, safeRelPath, sfOrgDecision, terminalCommand } from "./safety";
import { isFileSecret, scanWorkflows } from "./secrets";
import { buildProjectInfo, type ProjectInfo } from "./panelState";

const K = {
  jira: "deliveryCircuit.jira",
  fireflies: "deliveryCircuit.fireflies",
  claudeTokenSetAt: "deliveryCircuit.claudeTokenSetAt",
  confirmed: (id: string) => `deliveryCircuit.confirmed.${id}`,
};
const SF_MCP_EOL = "2026-11-02";
const UA = "delivery-circuit";

export interface ConnectionsInternals extends ConnectionsService {
  links(): Partial<Record<ConnectionId, DeepLink[]>>;
  cached(): ConnectionStatus[];
  config(): CircuitConfig;
  projectInfo(): Promise<ProjectInfo>;
  setProjectSecret(name: string, env?: string): Promise<void>;
  checkAll(): Promise<ConnectionStatus[]>;
}

export function createConnections(base: ModuleBase, getIdentity: () => Identity | null): { service: ConnectionsInternals; gh: GitHubClient } {
  const { ctx, root, log } = base;
  const ev = new vscode.EventEmitter<void>();
  ctx.subscriptions.push(ev);
  const statuses = new Map<ConnectionId, ConnectionStatus>();
  const links: Partial<Record<ConnectionId, DeepLink[]>> = {};
  let lastFull = 0;
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
  function reminders(): Reminder[] {
    try { return parseReminders(fs.readFileSync(path.join(root, "build-state.md"), "utf8")); } catch { return []; }
  }
  const exists = (rel: string) => fs.existsSync(path.join(root, rel));

  // ---------- GitHub ----------
  async function githubToken(): Promise<string> {
    const s = await vscode.authentication.getSession("github", GITHUB_SCOPES, { createIfNone: false });
    if (!s) throw new Error("Not signed in to GitHub. Open Delivery Circuit: Connections and connect GitHub.");
    return s.accessToken;
  }
  const gh = new GitHubClient(githubToken);
  function repoRef(): { owner: string; repo: string } {
    const id = getIdentity();
    if (id?.owner && id.repo) return { owner: id.owner, repo: id.repo };
    const c = config();
    if (c.githubOrg && c.githubRepo) return { owner: c.githubOrg, repo: c.githubRepo };
    throw new Error("No GitHub repository known for this workspace (git remote origin or build.config.yml github.org/repo).");
  }

  // ---------- secrets (VS Code SecretStorage) ----------
  async function jira(): Promise<JiraCredentials | undefined> {
    const raw = await ctx.secrets.get(K.jira);
    if (!raw) return undefined;
    try { const j = JSON.parse(raw); return j.site && j.email && j.token ? j : undefined; } catch { return undefined; }
  }
  const firefliesKey = async () => (await ctx.secrets.get(K.fireflies)) || undefined;

  // ---------- helpers ----------
  const now = () => new Date();
  function put(s: ConnectionStatus, l?: DeepLink[]): ConnectionStatus {
    s.state = applyExpiry(s.state, s.expiresAt, now());
    const prev = statuses.get(s.id);
    statuses.set(s.id, s);
    if (l) links[s.id] = l;
    if (JSON.stringify(prev) !== JSON.stringify(s)) ev.fire();
    return s;
  }
  const st = (id: ConnectionId, patch: Partial<ConnectionStatus>, extra: Persona[] = []): ConnectionStatus => ({ ...baseStatus(id, extra), ...patch });
  function terminal(name: string, cwd = root): vscode.Terminal {
    const t = vscode.window.terminals.find((x) => x.name === name) ?? vscode.window.createTerminal({ name, cwd });
    t.show();
    return t;
  }
  async function fetchText(url: string, init: { method?: string; headers: Record<string, string>; body?: string }, timeoutMs = 20_000) {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ac.signal, headers: { "User-Agent": UA, ...init.headers } });
      return { status: r.status, ok: r.ok, text: await r.text() };
    } finally { clearTimeout(tm); }
  }
  const errMsg = (e: unknown) => (e as any)?.name === "AbortError" ? "timed out" : String((e as any)?.message ?? e);
  function pollUntilConnected(id: ConnectionId, totalMs = 180_000, everyMs = 15_000) {
    const started = Date.now();
    const tick = async () => {
      const s = await check(id).catch(() => undefined);
      if (s && (s.state === "connected" || s.state === "expiring")) return;
      if (Date.now() - started < totalMs) setTimeout(tick, everyMs);
    };
    setTimeout(tick, everyMs);
  }
  async function confirm(message: string, detail: string | undefined, yes: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, yes)) === yes;
  }

  // ---------- checks ----------
  async function checkGithub(): Promise<ConnectionStatus> {
    const s = await vscode.authentication.getSession("github", GITHUB_SCOPES, { createIfNone: false });
    if (!s) return put(st("github", { state: "disconnected", detail: "Sign in with GitHub (scopes repo, read:org, workflow)." }));
    const id = getIdentity();
    const repo = id?.owner ? `${id.owner}/${id.repo}` : undefined;
    return put(st("github", { state: "connected", account: s.account.label, detail: repo ? `Signed in · ${repo}${id?.isAdmin ? " · admin" : ""}` : "Signed in" }),
      repo ? [{ kind: "github", label: "Repo", target: `https://github.com/${repo}` }, { kind: "github", label: "Account", target: "https://github.com/settings/applications" }] : undefined);
  }

  async function checkClaude(): Promise<ConnectionStatus> {
    if (process.env.ANTHROPIC_API_KEY) {
      return put(st("claude", { state: "error", detail: "ANTHROPIC_API_KEY is set in VS Code's environment. The circuit uses your Claude subscription only; remove that variable and restart VS Code." }));
    }
    const r = await run("claude", ["auth", "status", "--json"], { cwd: root, timeoutMs: 30_000 });
    const a = parseClaudeAuth(r.stdout);
    const docs: DeepLink[] = [{ kind: "url", label: "Docs", target: "https://code.claude.com/docs/en/authentication" }];
    if (!a) {
      const missing = /not recognized|not found|ENOENT/i.test(r.stderr) || r.code === 127 || r.code === 9009;
      return put(st("claude", { state: missing ? "disconnected" : "error",
        detail: missing ? "Claude Code is not installed (npm i -g @anthropic-ai/claude-code)." : "Could not read Claude's login status." }), docs);
    }
    if (!a.loggedIn) return put(st("claude", { state: "disconnected", detail: "Not signed in. Connect signs in with your Claude subscription." }), docs);
    if (!isSubscriptionAuth(a)) {
      return put(st("claude", { state: "error", account: a.email, detail: `Signed in with ${a.authMethod ?? "another method"} (${a.apiProvider ?? "?"}). The circuit needs a claude.ai subscription login.` }), docs);
    }
    const plan = a.subscriptionType ? `${cap(a.subscriptionType)} plan` : "Subscription";
    return put(st("claude", { state: "connected", account: a.email, expiresAt: a.loginExpiresAt, detail: [plan, a.orgName].filter(Boolean).join(" · ") }),
      [{ kind: "url", label: "Account", target: "https://claude.ai/settings/account" }, { kind: "url", label: "Connectors", target: "https://claude.ai/customize/connectors" }]);
  }

  function sfAlias(role: "dev" | "qa"): string { return role === "dev" ? config().sf.devAlias : config().sf.qaAlias; }

  async function checkSf(id: "sf-dev" | "sf-qa"): Promise<ConnectionStatus> {
    const role = id === "sf-dev" ? "dev" : "qa";
    const alias = sfAlias(role);
    const c = config();
    const url = role === "dev" ? c.sf.devUrl : c.sf.qaUrl;
    const r = await run("sf", ["org", "display", "--target-org", alias, "--json"], { cwd: root, timeoutMs: 90_000 });
    const p = parseSfOrgDisplay(r.stdout);
    if (!p.ok || !p.org) {
      const noCli = !r.stdout.trim() && /not recognized|not found|ENOENT/i.test(r.stderr);
      const noOrg = /NoOrgFound|No authorization|not found|NamedOrgNotFound/i.test(p.error ?? "");
      return put(st(id, { state: noCli ? "disconnected" : noOrg ? "disconnected" : "error",
        detail: noCli ? "Salesforce CLI (sf) not found. Install it from developer.salesforce.com/tools/salesforcecli."
          : noOrg ? `No org with alias "${alias}". Connect logs in to ${url ?? "https://login.salesforce.com"}.` : `${alias}: ${p.error}` }),
        url ? [{ kind: "salesforce", label: "Login page", target: url }] : undefined);
    }
    // Any connected org is fine: SDO / demo orgs are production-edition orgs, so the org type is not checked.
    const inst = p.org.instanceUrl;
    const host = inst ? new URL(inst).hostname : "";
    return put(st(id, { state: "connected", account: p.org.username, expiresAt: p.org.expirationDate,
      detail: `alias ${alias} · ${host}` }),
      inst ? [{ kind: "salesforce", label: "Org", target: inst }, { kind: "salesforce", label: "Setup", target: `${inst.replace(/\/+$/, "")}/lightning/setup/SetupOneHome/home` }] : undefined);
  }

  /** Fresh sf org display for the role's alias: allowed when it resolves to a connected org (any org type). Never cached. */
  async function sfOrgGuard(role: "dev" | "qa"): Promise<SfOrgGuard> {
    const alias = sfAlias(role);
    if (!alias || !/^[\w.@+-]+$/.test(alias)) return { alias, allowed: false, reason: `No usable sf CLI alias for the ${role} org (got "${alias}").` };
    const c = config();
    const r = await run("sf", ["org", "display", "--target-org", alias, "--json"], { cwd: root, timeoutMs: 90_000 });
    const p = parseSfOrgDisplay(r.stdout);
    const instanceUrl = p.ok ? p.org?.instanceUrl : undefined;
    return { alias, instanceUrl, ...sfOrgDecision(alias, instanceUrl, role === "dev" ? c.sf.devIsTrial : c.sf.qaIsTrial) };
  }

  async function atlassianGet(creds: JiraCredentials, apiPath: string) {
    const auth = Buffer.from(`${creds.email}:${creds.token}`).toString("base64");
    return fetchText(`${creds.site}${apiPath}`, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
  }

  async function verifyJira(creds: JiraCredentials): Promise<{ ok: boolean; account?: string; detail: string }> {
    try {
      const r = await atlassianGet(creds, "/rest/api/3/myself");
      if (r.status === 401 || r.status === 403) return { ok: false, detail: "Atlassian rejected the email or API token (401/403). Create a new token and connect again." };
      if (!r.ok) return { ok: false, detail: `Jira answered ${r.status} for /rest/api/3/myself. Check the site URL.` };
      const j = JSON.parse(r.text);
      return { ok: true, account: j.emailAddress || creds.email, detail: `${j.displayName ?? creds.email} · ${new URL(creds.site).hostname}` };
    } catch (e) { return { ok: false, detail: `Could not reach ${creds.site}: ${errMsg(e)}` }; }
  }

  async function checkJira(): Promise<ConnectionStatus> {
    const c = config(); const creds = await jira();
    const site = creds?.site ?? c.jiraSite;
    const l: DeepLink[] = site ? [{ kind: "jira", label: c.jiraProjectKey ? `Jira ${c.jiraProjectKey}` : "Jira", target: c.jiraProjectKey ? `${site}/browse/${c.jiraProjectKey}` : `${site}/jira` }] : [];
    l.push({ kind: "url", label: "API tokens", target: "https://id.atlassian.com/manage-profile/security/api-tokens" });
    if (!creds) return put(st("jira", { state: "disconnected", detail: "Add your Atlassian site, email and API token." }), l);
    const v = await verifyJira(creds);
    return put(st("jira", { state: v.ok ? "connected" : "error", account: v.account, detail: v.detail }), l);
  }

  async function checkConfluence(): Promise<ConnectionStatus> {
    const c = config(); const creds = await jira();
    const site = creds?.site ?? c.jiraSite;
    const l: DeepLink[] = site ? [{ kind: "confluence", label: c.confluenceSpace ? `Space ${c.confluenceSpace}` : "Confluence", target: c.confluenceSpace ? `${site}/wiki/spaces/${c.confluenceSpace}` : `${site}/wiki` }] : [];
    if (!creds) return put(st("confluence", { state: "disconnected", detail: "Uses your Atlassian (Jira) credentials. Connect Jira or connect here." }), l);
    try {
      const r = await atlassianGet(creds, "/wiki/rest/api/space?limit=1");
      if (r.status === 401 || r.status === 403) return put(st("confluence", { state: "error", account: creds.email, detail: "Atlassian rejected the token for Confluence, or you have no Confluence access on this site." }), l);
      if (r.status === 404) return put(st("confluence", { state: "error", account: creds.email, detail: `Confluence is not enabled on ${new URL(creds.site).hostname}.` }), l);
      if (!r.ok) return put(st("confluence", { state: "error", account: creds.email, detail: `Confluence answered ${r.status}.` }), l);
      return put(st("confluence", { state: "connected", account: creds.email, detail: `${new URL(creds.site).hostname}${c.confluenceSpace ? ` · space ${c.confluenceSpace}` : ""}` }), l);
    } catch (e) { return put(st("confluence", { state: "error", detail: `Could not reach Confluence: ${errMsg(e)}` }), l); }
  }

  async function verifyFireflies(key: string): Promise<{ ok: boolean; account?: string; detail: string }> {
    try {
      const r = await fetchText("https://api.fireflies.ai/graphql", { method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: "query { user { email name } }" }) });
      if (r.status === 401 || r.status === 403) return { ok: false, detail: "Fireflies rejected the API key." };
      const j = JSON.parse(r.text);
      if (j.errors?.length) return { ok: false, detail: `Fireflies: ${String(j.errors[0]?.message ?? "error")}` };
      if (!r.ok || !j.data?.user) return { ok: false, detail: `Fireflies answered ${r.status}.` };
      return { ok: true, account: j.data.user.email, detail: j.data.user.name ?? j.data.user.email };
    } catch (e) { return { ok: false, detail: `Could not reach Fireflies: ${errMsg(e)}` }; }
  }

  async function checkFireflies(): Promise<ConnectionStatus> {
    const key = await firefliesKey();
    const src = config().transcriptsSource;
    const l: DeepLink[] = [{ kind: "fireflies", label: "Fireflies", target: "https://app.fireflies.ai/" }, { kind: "fireflies", label: "API key", target: "https://app.fireflies.ai/integrations/custom/fireflies" }];
    if (!key) return put(st("fireflies", { state: "disconnected", detail: src === "file" ? "Optional: transcripts come from files in this repo (build.config.yml). Add a key to index meetings." : "Add your Fireflies API key." }), l);
    const v = await verifyFireflies(key);
    return put(st("fireflies", { state: v.ok ? "connected" : "error", account: v.account, detail: v.detail }), l);
  }

  function checkConfirmed(id: "slack" | "lucid"): ConnectionStatus {
    const c = config();
    const at = ctx.globalState.get<string>(K.confirmed(id));
    if (id === "slack") {
      const ws = slackWorkspaceUrl(c.slackWorkspace);
      const ch = Object.values(c.slackChannels);
      const l: DeepLink[] = ws ? [{ kind: "slack", label: "Workspace", target: ws }, ...ch.map((n) => ({ kind: "slack" as const, label: `#${n}`, target: `${ws}/app_redirect?channel=${encodeURIComponent(n)}` }))] : [];
      if (!ws) return put(st("slack", { state: "unknown", detail: "Slack workspace is not set in build.config.yml (slack.workspace)." }), l);
      const chText = ch.length ? ` · #${ch.join(" #")}` : "";
      return put(st("slack", at ? { state: "connected", detail: `Member of ${new URL(ws).hostname}${chText} (confirmed ${at.slice(0, 10)})` }
        : { state: "disconnected", detail: `Join ${new URL(ws).hostname}${chText}, then confirm.` }), l);
    }
    const l: DeepLink[] = [{ kind: "lucid", label: "Lucid", target: "https://lucid.app/documents" }];
    return put(st("lucid", at ? { state: "connected", detail: `Signed in to Lucid (confirmed ${at.slice(0, 10)})` }
      : { state: "disconnected", detail: "Sign in to Lucid (diagrams for solution designs), then confirm." }), l);
  }

  function playwrightPaths(): { browsersJson?: string; cli?: string; cacheDir: string } {
    const ext = ctx.extensionPath;
    // playwright may carry its own nested playwright-core (different browser revision than a top-level one)
    const bj = [path.join(ext, "node_modules", "playwright", "node_modules", "playwright-core", "browsers.json"),
      path.join(ext, "node_modules", "playwright-core", "browsers.json")].find((f) => fs.existsSync(f)) ?? "";
    const cli = path.join(ext, "node_modules", "playwright", "cli.js");
    const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const cacheDir = env && env !== "0" ? env
      : process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "ms-playwright")
      : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
      : path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "ms-playwright");
    return { browsersJson: fs.existsSync(bj) ? bj : undefined, cli: fs.existsSync(cli) ? cli : undefined, cacheDir };
  }

  function checkBrowsers(): ConnectionStatus {
    const p = playwrightPaths();
    const l: DeepLink[] = [{ kind: "url", label: "Playwright browsers", target: "https://playwright.dev/docs/browsers" }];
    if (!p.browsersJson) return put(st("testing-browsers", { state: "unknown", detail: "Playwright is not bundled with this build of the extension." }), l);
    const need = requiredBrowsers(fs.readFileSync(p.browsersJson, "utf8"));
    const missing = need.filter((b) => !fs.existsSync(path.join(p.cacheDir, browserDir(b.name, b.revision), "INSTALLATION_COMPLETE")));
    if (!need.length) return put(st("testing-browsers", { state: "unknown", detail: "Could not read Playwright's browser list." }), l);
    if (missing.length) return put(st("testing-browsers", { state: "disconnected", detail: `Missing ${missing.map((b) => `${b.title ?? b.name} r${b.revision}`).join(", ")}. Install downloads them (about 200 MB).` }), l);
    return put(st("testing-browsers", { state: "connected", detail: `${need.map((b) => `${b.title ?? b.name} r${b.revision}`).join(" + ")} in ${p.cacheDir}` }), l);
  }

  async function checkCodeAnalyzer(): Promise<ConnectionStatus> {
    const r = await run("sf", ["plugins", "--json"], { cwd: root, timeoutMs: 60_000 });
    const plugin = findCodeAnalyzer(parseSfPlugins(r.stdout));
    const inCi = workflowTexts().some((t) => /run-code-analyzer|code-analyzer run/.test(t));
    const ci = inCi ? " · runs in CI (pr-checks)" : " · not in CI workflows yet";
    const l: DeepLink[] = [{ kind: "url", label: "Docs", target: def("code-analyzer").manageUrl! }];
    if (exists(".github/workflows/pr-checks.yml")) l.push({ kind: "file", label: "pr-checks.yml", target: ".github/workflows/pr-checks.yml" });
    if (!plugin) return put(st("code-analyzer", { state: "disconnected", detail: `sf plugin @salesforce/plugin-code-analyzer is not installed locally${ci}.` }), l);
    return put(st("code-analyzer", { state: "connected", detail: `${plugin.name.replace("@salesforce/", "")} ${plugin.version ?? ""} locally${ci}` }), l);
  }

  async function checkCodeRabbit(): Promise<ConnectionStatus> {
    const hasCfg = exists(".coderabbit.yaml") || exists(".coderabbit.yml");
    const l: DeepLink[] = [{ kind: "coderabbit", label: "CodeRabbit", target: "https://app.coderabbit.ai/" }, { kind: "github", label: "GitHub App", target: "https://github.com/apps/coderabbitai" }];
    if (hasCfg) l.push({ kind: "file", label: ".coderabbit.yaml", target: exists(".coderabbit.yaml") ? ".coderabbit.yaml" : ".coderabbit.yml" });
    let seen: { pr: number; url: string; at: string } | undefined;
    let apiNote = "";
    try {
      const { owner, repo } = repoRef();
      const prs = await gh.request<any[]>("GET", `/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=8`);
      for (const pr of prs.slice(0, 8)) {
        const reviews = await gh.request<any[]>("GET", `/repos/${owner}/${repo}/pulls/${pr.number}/reviews?per_page=50`);
        const r = reviews.reverse().find((x) => x?.user?.login === "coderabbitai[bot]");
        if (r) { seen = { pr: pr.number, url: r.html_url ?? pr.html_url, at: r.submitted_at }; break; }
        const comments = await gh.request<any[]>("GET", `/repos/${owner}/${repo}/issues/${pr.number}/comments?per_page=50`);
        const c = comments.reverse().find((x) => x?.user?.login === "coderabbitai[bot]");
        if (c) { seen = { pr: pr.number, url: c.html_url ?? pr.html_url, at: c.created_at }; break; }
      }
      if (!prs.length) apiNote = " · no pull requests yet";
    } catch (e) { apiNote = ` · could not read PRs (${errMsg(e)})`; }
    if (seen) l.push({ kind: "github", label: `PR #${seen.pr}`, target: seen.url });
    if (!hasCfg) return put(st("coderabbit", { state: "disconnected", detail: `.coderabbit.yaml is missing from the repo${seen ? `; last review on PR #${seen.pr}` : ""}.` }), l);
    if (seen) return put(st("coderabbit", { state: "connected", account: "coderabbitai[bot]", detail: `Config present · last review on PR #${seen.pr}${seen.at ? ` (${seen.at.slice(0, 10)})` : ""}` }), l);
    return put(st("coderabbit", { state: "unknown", detail: `Config present · no CodeRabbit review seen yet${apiNote}. Install the app on the repo if it is not.` }), l);
  }

  async function repoSecretNames(): Promise<string[]> { const { owner, repo } = repoRef(); return gh.secretNames(owner, repo); }

  async function checkAiReviewer(): Promise<ConnectionStatus> {
    const hasAgent = exists(".claude/agents/reviewer.md");
    let repoUrl: string | undefined; let secret: boolean | undefined; let note = "";
    try {
      const { owner, repo } = repoRef(); repoUrl = `https://github.com/${owner}/${repo}`;
      secret = (await repoSecretNames()).includes("CLAUDE_CODE_OAUTH_TOKEN");
    } catch (e) {
      const s = (e as any)?.status;
      note = s === 403 || s === 404 ? "Only repo admins can see Actions secrets." : `Could not list secrets (${errMsg(e)}).`;
    }
    const l: DeepLink[] = [];
    if (hasAgent) l.push({ kind: "file", label: "reviewer.md", target: ".claude/agents/reviewer.md" });
    if (repoUrl) l.push({ kind: "github", label: "Secrets", target: `${repoUrl}/settings/secrets/actions` });
    const setAt = ctx.globalState.get<string>(K.claudeTokenSetAt);
    const reminder = reminders().find((r) => /claude/i.test(r.label))?.date;
    const expiresAt = setAt ? claudeTokenExpiry(setAt) : reminder;
    const manageUrl = repoUrl ? `${repoUrl}/settings/secrets/actions` : undefined;
    if (!hasAgent) return put(st("ai-reviewer", { state: "disconnected", manageUrl, detail: ".claude/agents/reviewer.md is missing (the circuit's bootstrap adds it)." }), l);
    if (secret === undefined) return put(st("ai-reviewer", { state: "unknown", manageUrl, expiresAt, detail: `reviewer.md present · ${note}` }), l);
    if (!secret) return put(st("ai-reviewer", { state: "disconnected", manageUrl, detail: "reviewer.md present · repo secret CLAUDE_CODE_OAUTH_TOKEN is missing." }), l);
    return put(st("ai-reviewer", { state: "connected", manageUrl, expiresAt, detail: `reviewer.md + CLAUDE_CODE_OAUTH_TOKEN${expiresAt ? "" : " (expiry unknown: set it from here to track it)"}` }), l);
  }

  // ---------- MCP ----------
  function personaConfigFiles(p: Persona): string[] {
    return [`.claude/personas/${p}.mcp.json`, `.claude/personas/${p}.local.mcp.json`].filter(exists);
  }
  function personaServers(p: Persona): McpServerEntry[] {
    return parseMcpConfigs(personaConfigFiles(p).map((f) => { try { return fs.readFileSync(path.join(root, f), "utf8"); } catch { return ""; } }));
  }
  async function mcpList(force = false): Promise<McpListEntry[]> {
    if (!force && mcpListCache && Date.now() - mcpListCache.at < 120_000) return mcpListCache.entries;
    const r = await run("claude", ["mcp", "list"], { cwd: root, timeoutMs: 90_000 });
    mcpListCache = { at: Date.now(), entries: parseMcpList(r.stdout) };
    return mcpListCache.entries;
  }

  async function checkMcp(id: McpRowId, force = false): Promise<ConnectionStatus> {
    const active = getIdentity()?.active ?? null;
    const holders = PERSONAS.filter((p) => findServerFor(id, personaServers(p)));
    const persona = active && holders.includes(active) ? active : holders[0];
    const l: DeepLink[] = [{ kind: def(id).linkKind, label: "Docs", target: def(id).manageUrl! }];
    if (!persona) return put(st(id, { state: "disconnected", detail: "Not in any persona's MCP config (.claude/personas/<persona>.mcp.json)." }), l);
    const file = personaConfigFiles(persona)[0];
    l.push({ kind: "file", label: `${persona}.mcp.json`, target: file });
    const entry = findServerFor(id, personaServers(persona))!;
    const who = holders.length > 1 ? ` (${holders.join(", ")})` : "";
    if (entry.placeholder) {
      const known = MCP_KNOWN[id].url;
      return put(st(id, { state: "error", detail: `URL in ${file} is a placeholder${known ? `; documented URL is ${known}` : ""}. Connect can fix it.` }, holders), l);
    }
    if (entry.type === "stdio") {
      const orgs = (entry.args ?? [])[(entry.args ?? []).indexOf("--orgs") + 1];
      const eol = id === "mcp-salesforce" && new Date() >= new Date(SF_MCP_EOL);
      return put(st(id, { state: eol ? "expiring" : "connected",
        detail: `Local server (${entry.command} ${MCP_KNOWN[id].stdioPackage ?? ""}${orgs ? ` --orgs ${orgs}` : ""})${who}${eol ? `. @salesforce/mcp reached end of life on ${SF_MCP_EOL}; plan the move to forcedotcom/sf-skills.` : ""}` }, holders), l);
    }
    let listed: McpListEntry | undefined;
    try { listed = mcpListStateFor(id, entry, await mcpList(force)); } catch { listed = undefined; }
    const slackNote = id === "mcp-slack" ? " Slack's server has no dynamic client registration; if /mcp sign-in fails, ask an admin to add the claude.ai Slack connector." : "";
    if (listed?.state === "connected") return put(st(id, { state: "connected", account: listed.name, detail: `Signed in (Claude reports "${listed.name}" connected)${who}` }, holders), l);
    if (listed?.state === "needs-auth") return put(st(id, { state: "disconnected", detail: `Configured${who}; sign in once in Claude with /mcp.${slackNote}` }, holders), l);
    if (listed?.state === "failed") return put(st(id, { state: "error", detail: `Claude could not connect: ${listed.reason ?? "failed"}.${slackNote}` }, holders), l);
    return put(st(id, { state: "unknown", detail: `Configured${who} (${new URL(entry.url!).hostname}); sign-in state shows in Claude's /mcp.${slackNote}` }, holders), l);
  }

  // ---------- dispatch ----------
  async function check(id: ConnectionId): Promise<ConnectionStatus> {
    try {
      switch (id) {
        case "github": return await checkGithub();
        case "claude": return await checkClaude();
        case "sf-dev": case "sf-qa": return await checkSf(id);
        case "jira": return await checkJira();
        case "confluence": return await checkConfluence();
        case "slack": case "lucid": return checkConfirmed(id);
        case "fireflies": return await checkFireflies();
        case "testing-browsers": return checkBrowsers();
        case "code-analyzer": return await checkCodeAnalyzer();
        case "coderabbit": return await checkCodeRabbit();
        case "ai-reviewer": return await checkAiReviewer();
        default: return await checkMcp(id as McpRowId, true);
      }
    } catch (e) {
      log(`connections: check ${id} failed: ${errMsg(e)}`);
      return put(st(id, { state: "error", detail: errMsg(e) }));
    }
  }

  // One full check at a time: views call list() on every change event, and checkAll() itself fires change events.
  let checkAllInflight: Promise<ConnectionStatus[]> | undefined;
  function checkAll(): Promise<ConnectionStatus[]> {
    checkAllInflight ??= doCheckAll().finally(() => { checkAllInflight = undefined; });
    return checkAllInflight;
  }

  async function doCheckAll(): Promise<ConnectionStatus[]> {
    mcpListCache = undefined;
    const ids = CONNECTIONS.map((c) => c.id);
    for (const id of ids) if (!statuses.has(id)) statuses.set(id, st(id, { state: "checking", detail: "Checking…" }));
    ev.fire();
    await Promise.all(ids.map((id) => (id.startsWith("mcp-") ? checkMcp(id as McpRowId).catch(() => check(id)) : check(id))));
    lastFull = Date.now();
    return ids.map((id) => statuses.get(id)!);
  }

  // ---------- connect flows ----------
  async function promptAtlassian(): Promise<JiraCredentials | undefined> {
    const prev = await jira(); const c = config();
    const siteIn = await vscode.window.showInputBox({ title: "Atlassian site (1/3)", prompt: "Your Jira / Confluence site", value: prev?.site ?? c.jiraSite ?? "https://", ignoreFocusOut: true,
      validateInput: (v) => (normalizeSite(v) ? undefined : "Enter an https URL such as https://acme.atlassian.net") });
    const site = normalizeSite(siteIn); if (!site) return undefined;
    const email = await vscode.window.showInputBox({ title: "Atlassian email (2/3)", value: prev?.email ?? "", ignoreFocusOut: true,
      validateInput: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? undefined : "Enter your Atlassian account email") });
    if (!email) return undefined;
    void vscode.env.openExternal(vscode.Uri.parse("https://id.atlassian.com/manage-profile/security/api-tokens"));
    const token = await vscode.window.showInputBox({ title: "Atlassian API token (3/3)", prompt: "Create one at id.atlassian.com (opened in your browser) and paste it here. It is kept in VS Code's secret storage.", password: true, ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length >= 10 ? undefined : "Paste the API token") });
    if (!token) return undefined;
    return { site, email: email.trim(), token: token.trim() };
  }

  async function connectAtlassian(id: "jira" | "confluence"): Promise<ConnectionStatus> {
    const creds = await promptAtlassian();
    if (!creds) return statuses.get(id) ?? st(id, {});
    const v = await verifyJira(creds);
    if (!v.ok) { void vscode.window.showErrorMessage(`Atlassian: ${v.detail}`); return put(st(id, { state: "error", detail: v.detail })); }
    await ctx.secrets.store(K.jira, JSON.stringify(creds));
    log(`connections: Atlassian credentials saved for ${new URL(creds.site).hostname}`);
    await checkConfluence();
    return checkJira();
  }

  async function connectFireflies(): Promise<ConnectionStatus> {
    void vscode.env.openExternal(vscode.Uri.parse("https://app.fireflies.ai/integrations/custom/fireflies"));
    const key = await vscode.window.showInputBox({ title: "Fireflies API key", prompt: "Copy it from Fireflies > Integrations > Fireflies API (opened in your browser). Stored in VS Code's secret storage.",
      password: true, ignoreFocusOut: true, validateInput: (v) => (v.trim().length >= 10 ? undefined : "Paste the API key") });
    if (!key) return statuses.get("fireflies") ?? st("fireflies", {});
    const v = await verifyFireflies(key.trim());
    if (!v.ok) { void vscode.window.showErrorMessage(v.detail); return put(st("fireflies", { state: "error", detail: v.detail })); }
    await ctx.secrets.store(K.fireflies, key.trim());
    return checkFireflies();
  }

  async function connectSf(id: "sf-dev" | "sf-qa"): Promise<ConnectionStatus> {
    const role = id === "sf-dev" ? "dev" : "qa"; const c = config();
    const alias = sfAlias(role);
    const decision = checkLoginUrl(role === "dev" ? c.sf.devUrl : c.sf.qaUrl, role === "dev" ? c.sf.devIsTrial : c.sf.qaIsTrial);
    if (!decision.allowed) {
      void vscode.window.showWarningMessage(`Login refused: ${decision.warning}`, { modal: true });
      return put(st(id, { state: "error", detail: decision.warning }));
    }
    if (decision.warning && !(await confirm(`Log in to ${decision.url} as "${alias}"?`, decision.warning, "Log in"))) return statuses.get(id) ?? st(id, {});
    terminal("Delivery Circuit: Salesforce").sendText(terminalCommand("sf", ["org", "login", "web", "--alias", alias, "--instance-url", decision.url]));
    void vscode.window.showInformationMessage(`Finish the Salesforce login in your browser. The "${alias}" row updates by itself.`);
    pollUntilConnected(id);
    return put(st(id, { state: "checking", detail: `Waiting for the browser login to ${new URL(decision.url).hostname}…` }));
  }

  async function connectConfirmed(id: "slack" | "lucid"): Promise<ConnectionStatus> {
    const ws = slackWorkspaceUrl(config().slackWorkspace);
    const url = id === "slack" ? ws : "https://lucid.app/documents";
    if (!url) { void vscode.window.showWarningMessage("Set slack.workspace in build.config.yml first."); return checkConfirmed(id); }
    await vscode.env.openExternal(vscode.Uri.parse(url));
    const ch = Object.values(config().slackChannels);
    const ask = id === "slack"
      ? `Opened ${new URL(url).hostname}. Confirm once you are signed in${ch.length ? ` and have joined #${ch.join(", #")}` : ""}.`
      : "Opened Lucid. Confirm once you are signed in with your work account.";
    if (await confirm(ask, undefined, "Done")) await ctx.globalState.update(K.confirmed(id), new Date().toISOString());
    return checkConfirmed(id);
  }

  async function connectBrowsers(): Promise<ConnectionStatus> {
    const p = playwrightPaths();
    if (!p.cli) { void vscode.window.showErrorMessage("Playwright is not bundled with this build of the extension."); return checkBrowsers(); }
    const t = vscode.window.createTerminal({ name: "Delivery Circuit: browsers", shellPath: process.execPath, shellArgs: [p.cli, "install", "chromium"],
      env: { ELECTRON_RUN_AS_NODE: "1" }, cwd: ctx.extensionPath });
    t.show();
    pollUntilConnected("testing-browsers", 600_000, 20_000);
    return put(st("testing-browsers", { state: "checking", detail: "Installing Chrome for Testing…" }));
  }

  async function connectMcp(id: McpRowId): Promise<ConnectionStatus> {
    const active = getIdentity()?.active ?? null;
    const holders = PERSONAS.filter((p) => findServerFor(id, personaServers(p)));
    const persona = active && holders.includes(active) ? active : holders[0];
    if (!persona) {
      void vscode.window.showWarningMessage(`No persona MCP config declares ${def(id).label}. The Circuit MCP module writes .claude/personas/<persona>.local.mcp.json; vendor servers are in <persona>.mcp.json.`);
      return check(id);
    }
    const entry = findServerFor(id, personaServers(persona))!;
    if (entry.placeholder && MCP_KNOWN[id].url) {
      const fixed = await fixPlaceholder(id, MCP_KNOWN[id].url!);
      if (!fixed) return check(id);
    }
    const files = personaConfigFiles(persona).map(safeRelPath).filter((f): f is string => !!f);
    if (!files.length) throw new Error("Persona MCP config path contains characters that are not safe for a terminal command.");
    terminal(`Claude (${persona}) MCP`).sendText(terminalCommand("claude", ["--mcp-config", ...files]));
    void vscode.window.showInformationMessage(`In Claude, type /mcp, pick "${entry.name}" and sign in. Press Check here when done.`);
    mcpListCache = undefined;
    return put(st(id, { state: "checking", detail: `Waiting for /mcp sign-in to "${entry.name}"…` }, holders));
  }

  async function fixPlaceholder(id: McpRowId, url: string): Promise<boolean> {
    const changed: string[] = [];
    if (!(await confirm(`Fill in the documented ${def(id).label} URL?`, `Writes ${url} into each .claude/personas/<persona>.mcp.json that has a placeholder for it.`, "Write URL"))) return false;
    for (const p of PERSONAS) {
      const rel = `.claude/personas/${p}.mcp.json`; const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) continue;
      const j = JSON.parse(fs.readFileSync(abs, "utf8"));
      const e = findServerFor(id, parseMcpConfigs([JSON.stringify(j)]));
      if (!e?.placeholder || !j.mcpServers?.[e.name]) continue;
      j.mcpServers[e.name] = { ...j.mcpServers[e.name], type: "http", url };
      fs.writeFileSync(abs, JSON.stringify(j, null, 2) + "\n", "utf8");
      changed.push(rel);
    }
    if (changed.length) void vscode.window.showInformationMessage(`Updated ${changed.join(", ")}. Commit it so the whole team gets it.`);
    return true;
  }

  async function connectAiReviewer(): Promise<ConnectionStatus> {
    const go = await confirm("Create the CI token for the AI Reviewer?",
      "A terminal runs \"claude setup-token\" (your subscription; valid 1 year). Copy the token it prints, then paste it into the box that opens. It goes straight to the repo's Actions secret CLAUDE_CODE_OAUTH_TOKEN, encrypted.", "Start");
    if (!go) return check("ai-reviewer");
    terminal("Delivery Circuit: Claude token").sendText(terminalCommand("claude", ["setup-token"]));
    const token = await vscode.window.showInputBox({ title: "CLAUDE_CODE_OAUTH_TOKEN", prompt: "Paste the token from \"claude setup-token\"", password: true, ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length >= 20 ? undefined : "Paste the whole token") });
    if (!token) return check("ai-reviewer");
    await setRepoSecretTracked("CLAUDE_CODE_OAUTH_TOKEN", token.trim());
    return check("ai-reviewer");
  }

  async function connectCodeRabbit(): Promise<ConnectionStatus> {
    const tpl = path.join(base.pluginRoot, "templates", "repo", ".coderabbit.yaml");
    if (!exists(".coderabbit.yaml") && fs.existsSync(tpl) && await confirm("Add the circuit's .coderabbit.yaml to this repo?", "Copied from the bundled circuit templates. Commit it with your next change.", "Add file")) {
      fs.copyFileSync(tpl, path.join(root, ".coderabbit.yaml"));
    }
    await vscode.env.openExternal(vscode.Uri.parse("https://github.com/apps/coderabbitai/installations/new"));
    void vscode.window.showInformationMessage("Install the CodeRabbit GitHub App on this repository. The row turns green after its first review on a PR.");
    return check("coderabbit");
  }

  async function connect(id: ConnectionId): Promise<ConnectionStatus> {
    const d = def(id); const identity = getIdentity();
    if (d.scope === "project" && !identity?.isAdmin) {
      void vscode.window.showWarningMessage(`${d.label} is a project connection; a repo or org admin sets it up.`);
      return check(id);
    }
    switch (id) {
      case "github": {
        await vscode.authentication.getSession("github", GITHUB_SCOPES, { createIfNone: true });
        return check("github");
      }
      case "claude": {
        terminal("Delivery Circuit: Claude login").sendText(terminalCommand("claude", ["auth", "login"]));
        void vscode.window.showInformationMessage("Sign in with your Claude subscription in the browser window.");
        pollUntilConnected("claude");
        return put(st("claude", { state: "checking", detail: "Waiting for Claude sign-in…" }));
      }
      case "sf-dev": case "sf-qa": return connectSf(id);
      case "jira": case "confluence": return connectAtlassian(id);
      case "fireflies": return connectFireflies();
      case "slack": case "lucid": return connectConfirmed(id);
      case "testing-browsers": return connectBrowsers();
      case "code-analyzer": {
        terminal("Delivery Circuit: Code Analyzer").sendText(terminalCommand("sf", ["plugins", "install", "@salesforce/plugin-code-analyzer"]));
        pollUntilConnected("code-analyzer", 300_000);
        return put(st("code-analyzer", { state: "checking", detail: "Installing the sf plugin…" }));
      }
      case "coderabbit": return connectCodeRabbit();
      case "ai-reviewer": return connectAiReviewer();
      default: return connectMcp(id as McpRowId);
    }
  }

  async function disconnect(id: ConnectionId): Promise<void> {
    const label = def(id).label;
    switch (id) {
      case "jira": case "confluence":
        if (!(await confirm(`Remove your Atlassian credentials?`, "Jira and Confluence both use them.", "Remove"))) return;
        await ctx.secrets.delete(K.jira); await checkJira(); await checkConfluence(); return;
      case "fireflies":
        if (!(await confirm("Remove your Fireflies API key?", undefined, "Remove"))) return;
        await ctx.secrets.delete(K.fireflies); await checkFireflies(); return;
      case "slack": case "lucid":
        await ctx.globalState.update(K.confirmed(id), undefined); checkConfirmed(id); return;
      case "sf-dev": case "sf-qa": {
        const alias = sfAlias(id === "sf-dev" ? "dev" : "qa");
        if (!(await confirm(`Log out of the Salesforce org "${alias}"?`, "Runs sf org logout for this alias only.", "Log out"))) return;
        const r = await run("sf", ["org", "logout", "--target-org", alias, "--no-prompt"], { cwd: root, timeoutMs: 60_000 });
        if (r.code !== 0) void vscode.window.showErrorMessage(`sf org logout failed for "${alias}".`);
        await check(id); return;
      }
      case "claude":
        if (!(await confirm("Sign out of Claude Code on this machine?", "This affects every Claude Code session, not only the circuit.", "Sign out"))) return;
        await run("claude", ["auth", "logout"], { cwd: root, timeoutMs: 30_000 }); await check(id); return;
      case "github":
        void vscode.window.showInformationMessage("Sign out of GitHub from VS Code's Accounts menu (bottom left)."); return;
      default:
        void vscode.window.showInformationMessage(`${label} is managed outside the extension. Use Manage to open its page.`);
    }
  }

  // ---------- project secrets ----------
  function workflowTexts(): string[] {
    const dir = path.join(root, ".github", "workflows");
    try { return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), "utf8")); } catch { return []; }
  }

  async function projectInfo(): Promise<ProjectInfo> {
    const needs = scanWorkflows(workflowTexts());
    const rems = reminders();
    const setAt = ctx.globalState.get<string>(K.claudeTokenSetAt);
    let repoSecrets: string[] = []; const envSecrets: Record<string, string[]> = {}; let error: string | undefined; let repoUrl: string | undefined;
    try {
      const { owner, repo } = repoRef(); repoUrl = `https://github.com/${owner}/${repo}`;
      repoSecrets = await gh.secretNames(owner, repo);
      for (const env of needs.environments) {
        try { envSecrets[env] = await gh.secretNames(owner, repo, env); } catch (e) { if ((e as any)?.status !== 404) throw e; envSecrets[env] = []; }
      }
    } catch (e) {
      const s = (e as any)?.status;
      error = s === 403 || s === 404 ? "Only repo admins can see which Actions secrets exist." : errMsg(e);
    }
    return buildProjectInfo({ needed: needs.secrets, envOf: needs.envOf, environments: needs.environments, repoSecrets, envSecrets,
      reminders: rems, claudeTokenExpiresAt: setAt ? claudeTokenExpiry(setAt) : undefined, repoUrl, error });
  }

  async function setRepoSecretTracked(name: string, value: string, env?: string): Promise<void> {
    const { owner, repo } = repoRef();
    await gh.setSecret(owner, repo, name, value, env);
    if (name === "CLAUDE_CODE_OAUTH_TOKEN" && !env) await ctx.globalState.update(K.claudeTokenSetAt, new Date().toISOString());
    log(`connections: set Actions secret ${name}${env ? ` (environment ${env})` : ""} on ${owner}/${repo}`);
    ev.fire();
  }

  async function setProjectSecret(name: string, env?: string): Promise<void> {
    if (!getIdentity()?.isAdmin) throw new Error("Only repo or org admins can set project secrets.");
    const fileLike = isFileSecret(name);
    let value: string | undefined;
    if (fileLike) {
      const pick = await vscode.window.showOpenDialog({ title: `Choose the file for ${name}`, canSelectMany: false, openLabel: "Use this file" });
      if (!pick?.[0]) return;
      value = fs.readFileSync(pick[0].fsPath, "utf8");
    } else {
      value = await vscode.window.showInputBox({ title: `${name}${env ? ` (environment ${env})` : ""}`, prompt: "Value goes straight to GitHub, encrypted. It is not stored locally.",
        password: !/^(JIRA_BASE_URL|JIRA_EMAIL|APP_ID|SF_USERNAME_\w+|SF_CLIENT_ID_\w+)$/.test(name), ignoreFocusOut: true });
    }
    if (!value) return;
    await setRepoSecretTracked(name, value.replace(/\r?\n$/, ""), env);
    void vscode.window.showInformationMessage(`Saved ${name}${env ? ` in environment ${env}` : ""}.`);
  }

  const service: ConnectionsInternals = {
    async list() {
      // While a full check runs, answer with what is known so far (rows show "Checking…") instead of waiting.
      if (checkAllInflight) return CONNECTIONS.map((c) => statuses.get(c.id) ?? st(c.id, {}));
      if (!lastFull || Date.now() - lastFull > 5 * 60_000) return checkAll();
      return CONNECTIONS.map((c) => statuses.get(c.id) ?? st(c.id, {}));
    },
    check,
    connect: async (id) => { try { return await connect(id); } catch (e) { void vscode.window.showErrorMessage(`${def(id).label}: ${errMsg(e)}`); return check(id); } },
    disconnect,
    onDidChange: ev.event,
    githubToken,
    jira,
    firefliesKey,
    sfAlias,
    sfOrgGuard,
    githubRequest: (method, p, body) => gh.request(method, p, body),
    githubGraphql: (q, v) => gh.graphql(q, v),
    repoSecretNames,
    async setRepoSecret(name, value, env) { await setRepoSecretTracked(name, value, env); },
    links: () => links,
    cached: () => CONNECTIONS.map((c) => statuses.get(c.id) ?? st(c.id, {})),
    config,
    projectInfo,
    async projectSecrets() {
      const info = await projectInfo();
      return [...info.secrets, ...info.webhooks].map((r) => ({
        name: r.name, kind: r.kind, env: r.env, expiring: r.expiring, present: r.unknown ? undefined : r.present,
      }));
    },
    setProjectSecret,
    checkAll,
  };
  return { service, gh };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
