// ConnectionsService (v3, docs/CIRCUIT-V3.md): every connection is a login the person already has. GitHub (VS Code
// sign-in), Claude (the logged-in claude CLI), Salesforce (sf CLI), Atlassian (acli web login for the extension and the
// runner; Atlassian MCP OAuth for Claude), Fireflies and Slack (their MCP servers' OAuth). Nothing here asks for, stores
// or forwards an API token. Project rows read the repo through the person's GitHub login: the self-hosted runner, the
// GitHub for Jira and CodeRabbit apps, rulesets and the production environment.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { ConnectionId, ConnectionsService, DeepLink, Identity, Persona, SfOrgGuard } from "../core/contracts";
import { PERSONAS } from "../core/contracts";
import { run, type ModuleBase } from "../core/util";
import { asContract, baseStatus, CONNECTIONS, def, type RowId, type RowStatus } from "./catalog";
import { EMPTY_CONFIG, parseBuildConfig, parseReminders, slackWorkspaceUrl, type CircuitConfig, type Reminder } from "./config";
import { applyExpiry } from "./expiry";
import { GitHubClient } from "./github";
import { GITHUB_SCOPES } from "./identity";
import {
  acliInstallHelp, APP_SLUGS, browserDir, findCodeAnalyzer, findInstallation, findServerFor, isSubscriptionAuth, MCP_KNOWN, mcpListStateFor,
  parseAcliAuthStatus, parseClaudeAuth, parseEnvironments, parseMcpConfigs, parseMcpList, parseRulesets, parseRunners, parseSfOrgDisplay,
  parseSfPlugins, requiredBrowsers, RUNNER_CONNECT_MESSAGE, RUNNER_REGISTER_HINT, summarizeRunners, type AcliAuth, type McpListEntry, type McpRowId, type McpServerEntry, type RunnerInfo,
} from "./parse";
import { checkLoginUrl, isNamedProduction, namedProdAliases, safeRelPath, sfConfigProdAlias, sfOrgDecision, terminalCommand } from "./safety";
import { bannedSecretRefs, isBannedSecret } from "./secrets";
import { buildProjectInfo, type ProjectInfo } from "./panelState";

/** How long the first list() waits for a full check before answering with what is known so far. */
export const LIST_WAIT_MS = 4000;

const K = {
  confirmed: (id: string) => `deliveryCircuit.confirmed.${id}`,
  // v2 kept these; v3 stores no credentials, so they are removed on start
  legacySecrets: ["deliveryCircuit.jira", "deliveryCircuit.fireflies"],
  legacyState: ["deliveryCircuit.claudeTokenSetAt"],
};
const SF_MCP_EOL = "2026-11-02";

export interface ConnectionsInternals extends ConnectionsService {
  links(): Partial<Record<RowId, DeepLink[]>>;
  cached(): RowStatus[];
  config(): CircuitConfig;
  projectInfo(): Promise<ProjectInfo>;
  checkAll(): Promise<RowStatus[]>;
  /** check/connect/disconnect for any row id this module knows (the contract methods take ConnectionId only). */
  checkRow(id: RowId): Promise<RowStatus>;
  connectRow(id: RowId): Promise<RowStatus>;
  disconnectRow(id: RowId): Promise<void>;
  /** Atlassian site the acli login uses (from `acli jira auth status`), else build.config.yml jira.site. */
  atlassianSite(): string | undefined;
}

export function createConnections(base: ModuleBase, getIdentity: () => Identity | null): { service: ConnectionsInternals; gh: GitHubClient } {
  const { ctx, root, log } = base;
  const ev = new vscode.EventEmitter<void>();
  ctx.subscriptions.push(ev);
  const statuses = new Map<RowId, RowStatus>();
  const links: Partial<Record<RowId, DeepLink[]>> = {};
  let lastFull = 0;
  let mcpListCache: { at: number; entries: McpListEntry[] } | undefined;
  let acliAuth: AcliAuth | undefined;

  // v3: remove what v2 stored (Atlassian / Fireflies API tokens, the CI token date). Never read, never logged.
  void (async () => {
    let removed = 0;
    for (const k of K.legacySecrets) { try { if (await ctx.secrets.get(k)) { await ctx.secrets.delete(k); removed++; } } catch { /* ignore */ } }
    for (const k of K.legacyState) if (ctx.globalState.get(k) !== undefined) await ctx.globalState.update(k, undefined);
    if (removed) log(`connections: removed ${removed} stored API token${removed === 1 ? "" : "s"} left by an older version (v3 uses logins only)`);
  })();

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
  const atlassianSite = () => (acliAuth?.site ? `https://${acliAuth.site}` : config().jiraSite);

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
  const repoUrlOrUndefined = () => { try { const { owner, repo } = repoRef(); return `https://github.com/${owner}/${repo}`; } catch { return undefined; } };
  const enc = encodeURIComponent;

  // Short caches so one "Check all" asks GitHub once for things two rows need.
  const memo = new Map<string, { at: number; p: Promise<any> }>();
  function cached<T>(key: string, f: () => Promise<T>, ttl = 60_000): Promise<T> {
    const m = memo.get(key);
    if (m && Date.now() - m.at < ttl) return m.p;
    const p = f(); memo.set(key, { at: Date.now(), p });
    p.catch(() => memo.delete(key));
    return p;
  }
  const repoInfo = () => { const { owner, repo } = repoRef(); return cached(`repo:${owner}/${repo}`, () => gh.request<any>("GET", `/repos/${enc(owner)}/${enc(repo)}`)); };
  /** Org app installations; undefined when the repo is personal or the person may not list them (org owners only). */
  async function orgInstallations(): Promise<unknown | undefined> {
    const id = getIdentity();
    const { owner } = repoRef();
    if (id && !id.orgOwned) return undefined;
    try { return await cached(`inst:${owner}`, () => gh.request<any>("GET", `/orgs/${enc(owner)}/installations?per_page=100`)); }
    catch { return undefined; }
  }

  // ---------- helpers ----------
  const now = () => new Date();
  function put(s: RowStatus, l?: DeepLink[]): RowStatus {
    s.state = applyExpiry(s.state, s.expiresAt, now());
    const prev = statuses.get(s.id);
    statuses.set(s.id, s);
    if (l) links[s.id] = l;
    if (JSON.stringify(prev) !== JSON.stringify(s)) ev.fire();
    return s;
  }
  const st = (id: RowId, patch: Partial<RowStatus>, extra: Persona[] = []): RowStatus => ({ ...baseStatus(id, extra), ...patch });
  function terminal(name: string, cwd = root): vscode.Terminal {
    const t = vscode.window.terminals.find((x) => x.name === name) ?? vscode.window.createTerminal({ name, cwd });
    t.show();
    return t;
  }
  const errMsg = (e: unknown) => (e as any)?.name === "AbortError" ? "timed out" : String((e as any)?.message ?? e);
  const httpStatus = (e: unknown): number | undefined => (e as any)?.status;
  function pollUntilConnected(id: RowId, totalMs = 180_000, everyMs = 15_000) {
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
  function workflowFiles(): { file: string; text: string }[] {
    const dir = path.join(root, ".github", "workflows");
    try {
      return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
        .map((f) => ({ file: `.github/workflows/${f}`, text: fs.readFileSync(path.join(dir, f), "utf8") }));
    } catch { return []; }
  }

  // ---------- personal ----------
  async function checkGithub(): Promise<RowStatus> {
    const s = await vscode.authentication.getSession("github", GITHUB_SCOPES, { createIfNone: false });
    if (!s) return put(st("github", { state: "disconnected", detail: "Sign in with GitHub (scopes repo, read:org, workflow)." }));
    const id = getIdentity();
    const repo = id?.owner ? `${id.owner}/${id.repo}` : undefined;
    return put(st("github", { state: "connected", account: s.account.label, detail: repo ? `Signed in · ${repo}${id?.isAdmin ? " · admin" : ""}` : "Signed in" }),
      repo ? [{ kind: "github", label: "Repo", target: `https://github.com/${repo}` }, { kind: "github", label: "Account", target: "https://github.com/settings/applications" }] : undefined);
  }

  async function checkClaude(): Promise<RowStatus> {
    if (process.env.ANTHROPIC_API_KEY) {
      return put(st("claude", { state: "error", detail: "ANTHROPIC_API_KEY is set in VS Code's environment. The circuit uses your logged-in Claude only; remove that variable and restart VS Code." }));
    }
    const r = await run("claude", ["auth", "status", "--json"], { cwd: root, timeoutMs: 30_000 });
    const a = parseClaudeAuth(r.stdout);
    const docs: DeepLink[] = [{ kind: "url", label: "Docs", target: "https://code.claude.com/docs/en/authentication" }];
    if (!a) {
      const missing = /not recognized|not found|ENOENT/i.test(r.stderr) || r.code === 127 || r.code === 9009;
      return put(st("claude", { state: missing ? "disconnected" : "error",
        detail: missing ? "Claude Code is not installed (npm i -g @anthropic-ai/claude-code)." : "Could not read Claude's login status." }), docs);
    }
    if (!a.loggedIn) return put(st("claude", { state: "disconnected", detail: "Not signed in. Connect runs claude auth login with your Claude subscription." }), docs);
    if (!isSubscriptionAuth(a)) {
      return put(st("claude", { state: "error", account: a.email, detail: `Signed in with ${a.authMethod ?? "another method"} (${a.apiProvider ?? "?"}). The circuit needs a claude.ai subscription login.` }), docs);
    }
    const plan = a.subscriptionType ? `${cap(a.subscriptionType)} plan` : "Subscription";
    return put(st("claude", { state: "connected", account: a.email, expiresAt: a.loginExpiresAt, detail: [plan, a.orgName].filter(Boolean).join(" · ") }),
      [{ kind: "url", label: "Account", target: "https://claude.ai/settings/account" }, { kind: "url", label: "Connectors", target: "https://claude.ai/customize/connectors" }]);
  }

  function sfAlias(role: "dev" | "qa"): string { return role === "dev" ? config().sf.devAlias : config().sf.qaAlias; }

  async function checkSf(id: "sf-dev" | "sf-qa"): Promise<RowStatus> {
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
    return put(st(id, { state: "connected", account: p.org.username, expiresAt: p.org.expirationDate, detail: `alias ${alias} · ${host}` }),
      inst ? [{ kind: "salesforce", label: "Org", target: inst }, { kind: "salesforce", label: "Setup", target: `${inst.replace(/\/+$/, "")}/lightning/setup/SetupOneHome/home` }] : undefined);
  }

  /** Fresh sf org display for the role's alias: allowed when it resolves to a connected org (any org type). Never cached. */
  async function sfOrgGuard(role: "dev" | "qa"): Promise<SfOrgGuard> {
    const alias = sfAlias(role);
    if (!alias || !/^[\w.@+-]+$/.test(alias)) return { alias, allowed: false, reason: `No usable sf CLI alias for the ${role} org (got "${alias}").` };
    let sfConfig: string | undefined;
    try { sfConfig = fs.readFileSync(path.join(root, ".specify", "extensions", "sf", "sf-config.yml"), "utf8"); } catch { sfConfig = undefined; }
    const prod = namedProdAliases([config().sf.prodAlias, sfConfigProdAlias(sfConfig)]);
    if (isNamedProduction(alias, prod)) return { alias, ...sfOrgDecision(alias, undefined, prod) };
    const r = await run("sf", ["org", "display", "--target-org", alias, "--json"], { cwd: root, timeoutMs: 90_000 });
    const p = parseSfOrgDisplay(r.stdout);
    const instanceUrl = p.ok ? p.org?.instanceUrl : undefined;
    return { alias, instanceUrl, ...sfOrgDecision(alias, instanceUrl, prod) };
  }

  async function checkAcli(): Promise<RowStatus> {
    const r = await run("acli", ["jira", "auth", "status"], { cwd: root, timeoutMs: 45_000 });
    const a = parseAcliAuthStatus(r);
    acliAuth = a;
    const c = config();
    const site = atlassianSite();
    const l: DeepLink[] = [];
    if (site) l.push({ kind: "jira", label: c.jiraProjectKey ? `Jira ${c.jiraProjectKey}` : "Jira", target: c.jiraProjectKey ? `${site}/browse/${c.jiraProjectKey}` : `${site}/jira` });
    if (site && c.confluenceSpace) l.push({ kind: "confluence", label: `Space ${c.confluenceSpace}`, target: `${site}/wiki/spaces/${c.confluenceSpace}` });
    l.push({ kind: "url", label: "acli guide", target: def("acli").manageUrl! });
    if (a.state === "missing") {
      return put(st("acli", { state: "disconnected", detail: `The Atlassian CLI (acli) is not installed. ${acliInstallHelp(process.platform, process.arch).text}` }), l);
    }
    if (a.state === "logged-out") {
      return put(st("acli", { state: "disconnected", detail: `Not logged in${a.note ? ` (${a.note})` : ""}. Connect runs acli jira auth login --web in a terminal.` }), l);
    }
    const wrongSite = a.site && c.jiraSite && new URL(c.jiraSite).hostname !== a.site;
    if (a.state === "unknown") return put(st("acli", { state: "unknown", detail: `acli answered without a site: ${a.note ?? "no output"}.` }), l);
    return put(st("acli", {
      state: wrongSite ? "error" : "connected", account: a.email ?? a.site,
      detail: wrongSite ? `Logged in to ${a.site}, but build.config.yml names ${new URL(c.jiraSite!).hostname}. Switch with acli jira auth switch.`
        : `Jira via acli${a.site ? ` · ${a.site}` : ""}. Confluence goes through the Atlassian MCP. Keep acli updated: each version is supported for 6 months.`,
    }), l);
  }

  function checkConfirmed(id: "slack" | "lucid"): RowStatus {
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

  function checkBrowsers(): RowStatus {
    const p = playwrightPaths();
    const l: DeepLink[] = [{ kind: "url", label: "Playwright browsers", target: "https://playwright.dev/docs/browsers" }];
    if (!p.browsersJson) return put(st("testing-browsers", { state: "unknown", detail: "Playwright is not bundled with this build of the extension." }), l);
    const need = requiredBrowsers(fs.readFileSync(p.browsersJson, "utf8"));
    const missing = need.filter((b) => !fs.existsSync(path.join(p.cacheDir, browserDir(b.name, b.revision), "INSTALLATION_COMPLETE")));
    if (!need.length) return put(st("testing-browsers", { state: "unknown", detail: "Could not read Playwright's browser list." }), l);
    if (missing.length) return put(st("testing-browsers", { state: "disconnected", detail: `Missing ${missing.map((b) => `${b.title ?? b.name} r${b.revision}`).join(", ")}. Install downloads them (about 200 MB).` }), l);
    return put(st("testing-browsers", { state: "connected", detail: `${need.map((b) => `${b.title ?? b.name} r${b.revision}`).join(" + ")} in ${p.cacheDir}` }), l);
  }

  // ---------- review tools ----------
  async function checkCodeAnalyzer(): Promise<RowStatus> {
    const r = await run("sf", ["plugins", "--json"], { cwd: root, timeoutMs: 60_000 });
    const plugin = findCodeAnalyzer(parseSfPlugins(r.stdout));
    const inCi = workflowFiles().some((w) => /run-code-analyzer|code-analyzer run/.test(w.text));
    const ci = inCi ? " · runs in CI on the self-hosted runner" : " · not in CI workflows yet";
    const l: DeepLink[] = [{ kind: "url", label: "Docs", target: def("code-analyzer").manageUrl! }];
    if (exists(".github/workflows/pr-checks.yml")) l.push({ kind: "file", label: "pr-checks.yml", target: ".github/workflows/pr-checks.yml" });
    if (!plugin) return put(st("code-analyzer", { state: "disconnected", detail: `sf plugin @salesforce/plugin-code-analyzer is not installed locally${ci}.` }), l);
    return put(st("code-analyzer", { state: "connected", detail: `${plugin.name.replace("@salesforce/", "")} ${plugin.version ?? ""} locally${ci}` }), l);
  }

  /** v3: the AI Reviewer runs in pr-checks on [self-hosted, circuit] with the runner's own claude login (no token). */
  async function checkAiReviewer(): Promise<RowStatus> {
    const hasAgent = exists(".claude/agents/reviewer.md");
    const files = workflowFiles();
    const reviewerFiles = files.filter((w) => /reviewer/i.test(w.text));
    const onRunner = reviewerFiles.some((w) => /runs-on:\s*\[\s*self-hosted\s*,\s*circuit\s*\]/i.test(w.text));
    const banned = bannedSecretRefs(reviewerFiles);
    const l: DeepLink[] = [];
    if (hasAgent) l.push({ kind: "file", label: "reviewer.md", target: ".claude/agents/reviewer.md" });
    for (const w of reviewerFiles.slice(0, 2)) l.push({ kind: "file", label: path.basename(w.file), target: w.file });
    const repoUrl = repoUrlOrUndefined();
    if (repoUrl) l.push({ kind: "github", label: "Runners", target: `${repoUrl}/settings/actions/runners` });
    if (!hasAgent) return put(st("ai-reviewer", { state: "disconnected", detail: ".claude/agents/reviewer.md is missing (the circuit's bootstrap adds it)." }), l);
    if (banned.length) {
      return put(st("ai-reviewer", { state: "error", detail: `${banned.map((b) => `${b.file} reads ${b.names.join(", ")}`).join("; ")}. v3 runs the reviewer on the self-hosted runner with its claude login; update the workflow.` }), l);
    }
    if (!onRunner) return put(st("ai-reviewer", { state: "disconnected", detail: "No workflow runs the AI Reviewer on runs-on: [self-hosted, circuit] yet." }), l);
    const runner = statuses.get("runner") ?? await checkRunner();
    if (runner.state === "connected") return put(st("ai-reviewer", { state: "connected", detail: "reviewer.md · runs in pr-checks on the self-hosted runner (its claude login)" }), l);
    return put(st("ai-reviewer", { state: runner.state === "error" ? "error" : "unknown",
      detail: `reviewer.md · runs on the self-hosted runner, which is ${runner.state === "error" ? "offline" : "not confirmed online"} (${runner.detail ?? "see the runner row"}).` }), l);
  }

  // ---------- project ----------
  async function checkRunner(): Promise<RowStatus> {
    let owner: string, repo: string;
    try { ({ owner, repo } = repoRef()); } catch (e) { return put(st("runner", { state: "unknown", detail: errMsg(e) })); }
    const repoUrl = `https://github.com/${owner}/${repo}`;
    const l: DeepLink[] = [{ kind: "github", label: "Runners", target: `${repoUrl}/settings/actions/runners` }, { kind: "url", label: "Docs", target: def("runner").manageUrl! },
      { kind: "github", label: "Actions", target: `${repoUrl}/actions` }];
    let list: RunnerInfo[] = [];
    let repoErr: number | undefined;
    try { list = parseRunners(await gh.request("GET", `/repos/${enc(owner)}/${enc(repo)}/actions/runners?per_page=100`)); }
    catch (e) { repoErr = httpStatus(e) ?? 0; }
    // org runners shared with the repo are not in the repo list; org admins can read them
    if (getIdentity()?.orgOwned !== false) {
      try { list = [...list, ...parseRunners(await gh.request("GET", `/orgs/${enc(owner)}/actions/runners?per_page=100`))]; } catch { /* not an org admin */ }
    }
    if (repoErr !== undefined && !list.length) {
      return put(st("runner", { state: "unknown", detail: repoErr === 403 || repoErr === 404
        ? "Only repo admins can list runners. The labels the workflows need are circuit and circuit-release."
        : `Could not list runners (HTTP ${repoErr}).` }), l);
    }
    const sum = summarizeRunners(list);
    let pub = "";
    try { if ((await repoInfo())?.private === false) pub = " · public repo: GitHub advises against self-hosted runners here; require approval for all outside contributors' workflows"; } catch { /* ignore */ }
    const howTo = sum.state === "disconnected" ? RUNNER_REGISTER_HINT : "";
    return put(st("runner", { state: sum.state, detail: `${sum.detail}${howTo}${pub}` }), l);
  }

  async function checkGithubJira(): Promise<RowStatus> {
    const site = atlassianSite();
    const l: DeepLink[] = [{ kind: "url", label: "Setup guide", target: def("github-jira").manageUrl! }];
    if (site) l.push({ kind: "jira", label: "Jira", target: `${site}/jira` });
    let inst: unknown;
    try { inst = await orgInstallations(); } catch { inst = undefined; }
    if (inst !== undefined) {
      const app = findInstallation(inst, APP_SLUGS.githubForJira);
      if (app?.url) l.unshift({ kind: "github", label: "Installation", target: app.url });
      if (!app) return put(st("github-jira", { state: "disconnected", detail: "Not installed on this GitHub org. A Jira site admin installs GitHub for Atlassian from Jira (Apps > Explore more apps) and a GitHub org owner approves it." }), l);
      if (app.suspended) return put(st("github-jira", { state: "error", detail: "Installed but suspended on this GitHub org." }), l);
      return put(st("github-jira", { state: "connected", detail: `Installed (${app.selection === "all" ? "all repositories" : "selected repositories: make sure this one is included"}). Branch feature/<KEY>-…, PR title "<KEY> …" link work to Jira.` }), l);
    }
    const at = ctx.globalState.get<string>(K.confirmed("github-jira"));
    if (at) return put(st("github-jira", { state: "connected", detail: `Confirmed installed by you on ${at.slice(0, 10)} (only org owners can list installed apps).` }), l);
    return put(st("github-jira", { state: "unknown", detail: "Only GitHub org owners can see installed apps. If a PR shows in a Jira work item's Development panel, it is installed." }), l);
  }

  async function checkCodeRabbit(): Promise<RowStatus> {
    const hasCfg = exists(".coderabbit.yaml") || exists(".coderabbit.yml");
    const l: DeepLink[] = [{ kind: "coderabbit", label: "CodeRabbit", target: "https://app.coderabbit.ai/" }, { kind: "github", label: "GitHub App", target: "https://github.com/apps/coderabbitai" }];
    if (hasCfg) l.push({ kind: "file", label: ".coderabbit.yaml", target: exists(".coderabbit.yaml") ? ".coderabbit.yaml" : ".coderabbit.yml" });
    const cfgNote = hasCfg ? "" : " · no .coderabbit.yaml (CodeRabbit defaults apply)";
    let seen: { pr: number; url: string; at: string } | undefined;
    let repoName = "this repo";
    try {
      const { owner, repo } = repoRef(); repoName = repo;
      const prs = await gh.request<any[]>("GET", `/repos/${enc(owner)}/${enc(repo)}/pulls?state=all&sort=updated&direction=desc&per_page=6`);
      for (const pr of prs.slice(0, 6)) {
        const reviews = await gh.request<any[]>("GET", `/repos/${enc(owner)}/${enc(repo)}/pulls/${pr.number}/reviews?per_page=50`);
        const r = reviews.reverse().find((x) => x?.user?.login === "coderabbitai[bot]");
        if (r) { seen = { pr: pr.number, url: r.html_url ?? pr.html_url, at: r.submitted_at }; break; }
        const comments = await gh.request<any[]>("GET", `/repos/${enc(owner)}/${enc(repo)}/issues/${pr.number}/comments?per_page=50`);
        const c = comments.reverse().find((x) => x?.user?.login === "coderabbitai[bot]");
        if (c) { seen = { pr: pr.number, url: c.html_url ?? pr.html_url, at: c.created_at }; break; }
      }
    } catch { /* PR read failed: rely on the installation */ }
    if (seen) l.push({ kind: "github", label: `PR #${seen.pr}`, target: seen.url });
    const seenText = seen ? ` · last review on PR #${seen.pr}${seen.at ? ` (${seen.at.slice(0, 10)})` : ""}` : "";
    let inst: unknown;
    try { inst = await orgInstallations(); } catch { inst = undefined; }
    const app = inst !== undefined ? findInstallation(inst, APP_SLUGS.coderabbit) : undefined;
    if (app?.url) l.unshift({ kind: "github", label: "Repository access", target: app.url });
    if (inst !== undefined && !app && !seen) return put(st("coderabbit", { state: "disconnected", detail: `The CodeRabbit app is not installed on this GitHub org${cfgNote}.` }), l);
    if (app?.suspended) return put(st("coderabbit", { state: "error", detail: `Installed but suspended on this GitHub org${cfgNote}.` }), l);
    if (seen) return put(st("coderabbit", { state: "connected", account: "coderabbitai[bot]", detail: `Has access to ${repoName}${seenText}${cfgNote}` }), l);
    if (app?.selection === "all") return put(st("coderabbit", { state: "connected", detail: `Installed for all repositories of the org${cfgNote}; no review seen yet.` }), l);
    if (app) return put(st("coderabbit", { state: "unknown", detail: `Installed for selected repositories; add ${repoName} under Repository access if it is not listed${cfgNote}.` }), l);
    return put(st("coderabbit", { state: "unknown", detail: `No CodeRabbit review seen on recent PRs${cfgNote}. Only org owners can see installed apps; give the app access to ${repoName}.` }), l);
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

  async function checkMcp(id: McpRowId, force = false): Promise<RowStatus> {
    const active = getIdentity()?.active ?? null;
    const holders = PERSONAS.filter((p) => findServerFor(id, personaServers(p)));
    const persona = active && holders.includes(active) ? active : holders[0];
    const l: DeepLink[] = [{ kind: def(id).linkKind, label: "Docs", target: def(id).manageUrl! }];
    const entry = persona ? findServerFor(id, personaServers(persona)) : undefined;
    if (persona) l.push({ kind: "file", label: `${persona}.mcp.json`, target: personaConfigFiles(persona)[0] });
    const who = holders.length > 1 ? ` (${holders.join(", ")})` : "";
    if (entry?.placeholder) {
      const known = MCP_KNOWN[id].url;
      return put(st(id, { state: "error", detail: `URL in ${personaConfigFiles(persona!)[0]} is a placeholder${known ? `; documented URL is ${known}` : ""}. Connect can fix it.` }, holders), l);
    }
    if (entry?.type === "stdio") {
      const orgs = (entry.args ?? [])[(entry.args ?? []).indexOf("--orgs") + 1];
      const eol = id === "mcp-salesforce" && new Date() >= new Date(SF_MCP_EOL);
      return put(st(id, { state: eol ? "expiring" : "connected",
        detail: `Local server (${entry.command} ${MCP_KNOWN[id].stdioPackage ?? ""}${orgs ? ` --orgs ${orgs}` : ""})${who}${eol ? `. @salesforce/mcp reached end of life on ${SF_MCP_EOL}; plan the move to forcedotcom/sf-skills.` : ""}` }, holders), l);
    }
    let listed: McpListEntry | undefined;
    try { listed = mcpListStateFor(id, entry, await mcpList(force), true); } catch { listed = undefined; }
    const slackNote = id === "mcp-slack" ? " Slack's server has no dynamic client registration: use the claude.ai Slack connector (a workspace admin approves it)." : "";
    const where = listed ? ` as "${listed.name}"` : "";
    if (listed?.state === "connected") return put(st(id, { state: "connected", account: listed.name, detail: `Signed in (Claude reports${where} connected)${who}` }, holders), l);
    if (listed?.state === "needs-auth") return put(st(id, { state: "disconnected", detail: `Configured${where}${who}; sign in once in Claude with /mcp.${slackNote}` }, holders), l);
    if (listed?.state === "failed") return put(st(id, { state: "error", detail: `Claude could not connect${where}: ${listed.reason ?? "failed"}.${slackNote}` }, holders), l);
    if (!entry && !listed) {
      const how = id === "mcp-slack" ? "Add the Slack connector in claude.ai (Settings > Connectors); it then shows up in Claude Code."
        : MCP_KNOWN[id].url ? `Connect adds ${MCP_KNOWN[id].url} to Claude Code for your user, then you sign in with /mcp (or add the claude.ai connector).`
          : "Not in Claude's MCP list or any persona's MCP config.";
      return put(st(id, { state: "disconnected", detail: how }, holders), l);
    }
    return put(st(id, { state: "unknown", detail: `Configured${who}${entry?.url ? ` (${new URL(entry.url).hostname})` : where}; sign-in state shows in Claude's /mcp.${slackNote}` }, holders), l);
  }

  // ---------- dispatch ----------
  async function check(id: RowId): Promise<RowStatus> {
    try {
      switch (id) {
        case "github": return await checkGithub();
        case "claude": return await checkClaude();
        case "sf-dev": case "sf-qa": return await checkSf(id);
        case "acli": return await checkAcli();
        case "slack": case "lucid": return checkConfirmed(id);
        case "testing-browsers": return checkBrowsers();
        case "code-analyzer": return await checkCodeAnalyzer();
        case "coderabbit": return await checkCodeRabbit();
        case "ai-reviewer": return await checkAiReviewer();
        case "runner": return await checkRunner();
        case "github-jira": return await checkGithubJira();
        default: return await checkMcp(id as McpRowId, true);
      }
    } catch (e) {
      log(`connections: check ${id} failed: ${errMsg(e)}`);
      return put(st(id, { state: "error", detail: errMsg(e) }));
    }
  }

  // One full check at a time: views call list() on every change event, and checkAll() itself fires change events.
  let checkAllInflight: Promise<RowStatus[]> | undefined;
  function checkAll(): Promise<RowStatus[]> {
    checkAllInflight ??= doCheckAll().finally(() => { checkAllInflight = undefined; });
    return checkAllInflight;
  }
  async function doCheckAll(): Promise<RowStatus[]> {
    mcpListCache = undefined; memo.clear();
    const ids = CONNECTIONS.map((c) => c.id);
    for (const id of ids) if (!statuses.has(id)) statuses.set(id, st(id, { state: "checking", detail: "Checking…" }));
    ev.fire();
    // the runner first: the AI Reviewer row reads its result
    await check("runner");
    await Promise.all(ids.filter((id) => id !== "runner").map((id) => (id.startsWith("mcp-") ? checkMcp(id as McpRowId).catch(() => check(id)) : check(id))));
    lastFull = Date.now();
    return ids.map((id) => statuses.get(id)!);
  }

  // ---------- connect flows ----------
  async function connectSf(id: "sf-dev" | "sf-qa"): Promise<RowStatus> {
    const role = id === "sf-dev" ? "dev" : "qa"; const c = config();
    const alias = sfAlias(role);
    const decision = checkLoginUrl(role === "dev" ? c.sf.devUrl : c.sf.qaUrl);
    if (!decision.allowed) {
      void vscode.window.showWarningMessage(`Login refused: ${decision.warning}`, { modal: true });
      return put(st(id, { state: "error", detail: decision.warning }));
    }
    terminal("Delivery Circuit: Salesforce").sendText(terminalCommand("sf", ["org", "login", "web", "--alias", alias, "--instance-url", decision.url]));
    void vscode.window.showInformationMessage(`Finish the Salesforce login in your browser. The "${alias}" row updates by itself.`);
    pollUntilConnected(id);
    return put(st(id, { state: "checking", detail: `Waiting for the browser login to ${new URL(decision.url).hostname}…` }));
  }

  async function connectAcli(): Promise<RowStatus> {
    const s = await checkAcli();
    if (acliAuth?.state === "missing") {
      const help = acliInstallHelp(process.platform, process.arch);
      const choice = await vscode.window.showInformationMessage("Install the Atlassian CLI (acli)", { modal: true, detail: `${help.text}\nThen press Connect again to log in with your browser (no API token).` },
        ...(help.commands.length ? ["Install in terminal"] : []), "Open install guide");
      if (choice === "Install in terminal") {
        const t = terminal("Delivery Circuit: Atlassian CLI");
        for (const c of help.commands) t.sendText(terminalCommand(c[0], c.slice(1)));
      } else if (choice === "Open install guide") await vscode.env.openExternal(vscode.Uri.parse(help.guide));
      return s;
    }
    terminal("Delivery Circuit: Atlassian CLI").sendText(terminalCommand("acli", ["jira", "auth", "login", "--web"]));
    void vscode.window.showInformationMessage("Accept the Atlassian login in your browser, then choose the same site in the terminal. The row updates by itself.");
    pollUntilConnected("acli");
    return put(st("acli", { state: "checking", detail: "Waiting for the Atlassian browser login…" }));
  }

  async function connectConfirmed(id: "slack" | "lucid" | "github-jira"): Promise<RowStatus> {
    const ws = slackWorkspaceUrl(config().slackWorkspace);
    const url = id === "slack" ? ws : id === "lucid" ? "https://lucid.app/documents" : def("github-jira").manageUrl!;
    if (!url) { void vscode.window.showWarningMessage("Set slack.workspace in build.config.yml first."); return checkConfirmed("slack"); }
    await vscode.env.openExternal(vscode.Uri.parse(url));
    const ch = Object.values(config().slackChannels);
    const ask = id === "slack"
      ? `Opened ${new URL(url).hostname}. Confirm once you are signed in${ch.length ? ` and have joined #${ch.join(", #")}` : ""}.`
      : id === "lucid" ? "Opened Lucid. Confirm once you are signed in with your work account."
        : "Opened the GitHub for Atlassian guide. Confirm once a Jira site admin has installed the app and connected this GitHub org.";
    if (await confirm(ask, undefined, "Done")) await ctx.globalState.update(K.confirmed(id), new Date().toISOString());
    return id === "github-jira" ? checkGithubJira() : checkConfirmed(id);
  }

  async function connectBrowsers(): Promise<RowStatus> {
    const p = playwrightPaths();
    if (!p.cli) { void vscode.window.showErrorMessage("Playwright is not bundled with this build of the extension."); return checkBrowsers(); }
    const t = vscode.window.createTerminal({ name: "Delivery Circuit: browsers", shellPath: process.execPath, shellArgs: [p.cli, "install", "chromium"],
      env: { ELECTRON_RUN_AS_NODE: "1" }, cwd: ctx.extensionPath });
    t.show();
    pollUntilConnected("testing-browsers", 600_000, 20_000);
    return put(st("testing-browsers", { state: "checking", detail: "Installing Chrome for Testing…" }));
  }

  async function connectMcp(id: McpRowId): Promise<RowStatus> {
    const active = getIdentity()?.active ?? null;
    const holders = PERSONAS.filter((p) => findServerFor(id, personaServers(p)));
    const persona = active && holders.includes(active) ? active : holders[0];
    if (persona) {
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
    let listed: McpListEntry | undefined;
    try { listed = mcpListStateFor(id, undefined, await mcpList(true), true); } catch { listed = undefined; }
    if (!listed && id === "mcp-slack") {
      await vscode.env.openExternal(vscode.Uri.parse("https://claude.ai/customize/connectors"));
      void vscode.window.showInformationMessage("Add the Slack connector in claude.ai and sign in. It shows up in Claude Code automatically; press Check here when done.");
      return check(id);
    }
    const url = MCP_KNOWN[id].url;
    if (!listed) {
      if (!url) { await vscode.env.openExternal(vscode.Uri.parse(def(id).manageUrl!)); return check(id); }
      const name = MCP_KNOWN[id].names[0];
      if (!(await confirm(`Add the ${def(id).label} to Claude Code?`, `Runs: claude mcp add --transport http --scope user ${name} ${url}\nSign-in is OAuth in Claude's /mcp; no token is stored by the circuit.`, "Add"))) return check(id);
      const r = await run("claude", ["mcp", "add", "--transport", "http", "--scope", "user", name, url], { cwd: root, timeoutMs: 60_000 });
      if (r.code !== 0) throw new Error(`claude mcp add failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? `exit ${r.code}`}`);
      log(`connections: added MCP server ${name} (${url}) to Claude Code (user scope)`);
    }
    terminal("Claude MCP sign-in").sendText(terminalCommand("claude", []));
    void vscode.window.showInformationMessage(`In Claude, type /mcp, pick "${listed?.name ?? MCP_KNOWN[id].names[0]}" and sign in. Press Check here when done.`);
    mcpListCache = undefined;
    return put(st(id, { state: "checking", detail: "Waiting for /mcp sign-in…" }, holders));
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

  async function connectCodeRabbit(): Promise<RowStatus> {
    const tpl = path.join(base.pluginRoot, "templates", "repo", ".coderabbit.yaml");
    if (!exists(".coderabbit.yaml") && fs.existsSync(tpl) && await confirm("Add the circuit's .coderabbit.yaml to this repo?", "Copied from the bundled circuit templates. Commit it with your next change.", "Add file")) {
      fs.copyFileSync(tpl, path.join(root, ".coderabbit.yaml"));
    }
    let inst: unknown;
    try { inst = await orgInstallations(); } catch { inst = undefined; }
    const app = inst !== undefined ? findInstallation(inst, APP_SLUGS.coderabbit) : undefined;
    await vscode.env.openExternal(vscode.Uri.parse(app?.url ?? "https://github.com/apps/coderabbitai/installations/new"));
    void vscode.window.showInformationMessage(app ? "Give CodeRabbit access to this repository under Repository access." : "Install the CodeRabbit GitHub App and give it access to this repository.");
    return check("coderabbit");
  }

  async function connectRunner(): Promise<RowStatus> {
    const { owner, repo } = repoRef();
    await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${owner}/${repo}/settings/actions/runners/new`));
    void vscode.window.showInformationMessage(RUNNER_CONNECT_MESSAGE,
      { modal: true });
    pollUntilConnected("runner", 900_000, 30_000);
    return check("runner");
  }

  async function connect(id: RowId): Promise<RowStatus> {
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
      case "acli": return connectAcli();
      case "slack": case "lucid": case "github-jira": return connectConfirmed(id);
      case "testing-browsers": return connectBrowsers();
      case "code-analyzer": {
        terminal("Delivery Circuit: Code Analyzer").sendText(terminalCommand("sf", ["plugins", "install", "@salesforce/plugin-code-analyzer"]));
        pollUntilConnected("code-analyzer", 300_000);
        return put(st("code-analyzer", { state: "checking", detail: "Installing the sf plugin…" }));
      }
      case "coderabbit": return connectCodeRabbit();
      case "runner": return connectRunner();
      case "ai-reviewer": return check("ai-reviewer");
      default: return connectMcp(id as McpRowId);
    }
  }

  async function disconnect(id: RowId): Promise<void> {
    const label = def(id).label;
    switch (id) {
      case "acli": {
        if (!(await confirm("Log out of the Atlassian CLI?", "Runs acli jira auth logout. Jira rows in the extension stop updating until you log in again.", "Log out"))) return;
        const r = await run("acli", ["jira", "auth", "logout"], { cwd: root, timeoutMs: 60_000 });
        if (r.code !== 0) void vscode.window.showErrorMessage("acli jira auth logout failed.");
        await check(id); return;
      }
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

  // ---------- project settings ----------
  async function projectInfo(): Promise<ProjectInfo> {
    const files = workflowFiles();
    const bannedRefs = bannedSecretRefs(files);
    let repoUrl: string | undefined; let defaultBranch: string | undefined; let error: string | undefined;
    let rulesets: ReturnType<typeof parseRulesets> | undefined; let environments: ReturnType<typeof parseEnvironments> | undefined;
    try {
      const { owner, repo } = repoRef(); repoUrl = `https://github.com/${owner}/${repo}`;
      defaultBranch = (await repoInfo().catch(() => undefined))?.default_branch;
      try { rulesets = parseRulesets(await gh.request("GET", `/repos/${enc(owner)}/${enc(repo)}/rulesets?per_page=100`)); } catch { rulesets = undefined; }
      try { environments = parseEnvironments(await gh.request("GET", `/repos/${enc(owner)}/${enc(repo)}/environments?per_page=100`)); } catch { environments = undefined; }
    } catch (e) { error = errMsg(e); }
    return buildProjectInfo({ repoUrl, defaultBranch, rulesets, environments, bannedRefs, workflowCount: files.length, reminders: reminders(), error });
  }

  const listNow = () => CONNECTIONS.map((c) => statuses.get(c.id) ?? st(c.id, {}));
  const service: ConnectionsInternals = {
    async list() {
      // While a full check runs, answer with what is known so far (rows show "Checking…") instead of waiting.
      if (checkAllInflight) return listNow().map(asContract);
      if (!lastFull || Date.now() - lastFull > 5 * 60_000) {
        // Wait a little for the quick rows (GitHub, Claude); slow CLI checks (sf org display, claude mcp list: up to
        // 90 s each) keep showing "Checking…" and fire onDidChange as they finish, so the sidebar paints at once.
        const all = checkAll();
        let timer: NodeJS.Timeout | undefined;
        const early = await Promise.race([
          all.then((rows) => rows),
          new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), LIST_WAIT_MS); }),
        ]).finally(() => clearTimeout(timer));
        return (early ?? listNow()).map(asContract);
      }
      return listNow().map(asContract);
    },
    check: async (id) => asContract(await check(id)),
    connect: async (id) => asContract(await service.connectRow(id)),
    disconnect: (id) => disconnect(id),
    checkRow: check,
    async connectRow(id) { try { return await connect(id); } catch (e) { void vscode.window.showErrorMessage(`${def(id).label}: ${errMsg(e)}`); return check(id); } },
    disconnectRow: disconnect,
    onDidChange: ev.event,
    githubToken,
    sfAlias,
    sfOrgGuard,
    githubRequest: (method, p, body) => gh.request(method, p, body),
    githubGraphql: (q, v) => gh.graphql(q, v),
    async repoSecretNames() { const { owner, repo } = repoRef(); return gh.secretNames(owner, repo); },
    links: () => links,
    cached: listNow,
    config,
    projectInfo,
    checkAll,
    atlassianSite,
  };
  return { service, gh };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
