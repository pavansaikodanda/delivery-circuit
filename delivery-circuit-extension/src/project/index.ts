// Project context v4: Jira stories (acli when installed, else the Atlassian MCP through a read-only `claude -p`),
// Confluence design pages (one read-only listing per space), GitHub PRs, deploy runs and repo setup (the person's VS
// Code GitHub sign-in), and the local transcript store for "New design from transcript". No API token anywhere.
// The logic lives in the vscode-free files next to this one (work.ts, github.ts, jira.ts); this file fetches and caches.
import { promises as fs, readFileSync, statSync } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { ConnectionsService, ProjectService, Role, SourceRef, StoryDetail, WorkSnapshot } from "../core/contracts";
import { resolveClaude } from "../core/claude";
import { gitRemote, run, type ModuleBase } from "../core/util";
import { AcliError, authSite, searchIssues, viewIssue, type AcliExec } from "./acli";
import {
  environmentNames, hasAuthSecret, mapDeployRuns, mapWorkResponse, rulesetCoverage, sampleBranch, workQuery,
} from "./github";
import { childrenJql, designPageOf, epicsJql, parseConfig, sprintJql, storiesOf, testCasesJql } from "./jira";
import { firefliesPointer, readDesignPages, readFirefliesRecent, readJiraBatch, readJiraIssues, type ClaudeExec } from "./mcpReader";
import type { CircuitConfig, DeployRun, DesignPage, Feature, JiraIssue, PrInfo, RepoRef, RepoSetup, WorkData } from "./model";
import { extractText, loadUpload, newKey, SOURCE_REF_RE, storeUpload, uploadId } from "./sources";
import { missingItems, nextSteps, sprintRows, storyDetail } from "./work";

const KEY_SECRET = "deliveryCircuit.sourcesKey";
const JIRA_TTL = 2 * 60_000;
const DESIGN_TTL = 10 * 60_000;
const SETUP_TTL = 10 * 60_000;
const FIREFLIES_TTL = 5 * 60_000;
const MAX_TEXT = 20 * 1024 * 1024;

interface JiraState { epics: JiraIssue[]; stories: JiraIssue[]; tests: JiraIssue[]; at: number; error?: string }
interface GhState { prs: PrInfo[]; sprints: string[]; branches: Record<string, boolean>; autoMerge?: boolean; deploys: DeployRun[]; sprintAhead?: number; at: number; error?: string }

export interface ProjectDeps {
  connections: ConnectionsService;
  /** owner/repo from the identity, when known */
  repo: () => RepoRef | undefined;
  /** for tests: replaces `acli` */
  acli?: AcliExec;
  /** for tests: replaces `claude -p` */
  claude?: ClaudeExec;
}

/** One line for the sidebar and the log. */
const short = (e: unknown) => String((e as any)?.message ?? e).split(/\r?\n/)[0].slice(0, 200);

export function createProject(base: ModuleBase, deps: ProjectDeps): ProjectService {
  const { ctx, root, log } = base;
  const { connections } = deps;
  const changed = new vscode.EventEmitter<void>();
  ctx.subscriptions.push(changed);
  const conf = () => vscode.workspace.getConfiguration("deliveryCircuit");

  // The CLI path is a machine setting only: a repository's .vscode/settings.json must not choose the program we run.
  const acliPath = () => {
    const v = (conf() as Partial<vscode.WorkspaceConfiguration>).inspect?.<string>("acliPath")?.globalValue;
    return typeof v === "string" && v.trim() ? v.trim() : "acli";
  };
  const acli: AcliExec = deps.acli ?? ((args) => run(acliPath(), args, { cwd: root, shell: false, timeoutMs: 90_000 }));
  const claude: ClaudeExec = deps.claude ?? ((args, prompt) => {
    const exe = resolveClaude(process.env.PATH ?? process.env.Path ?? "", process.platform, {
      exists: (p) => { try { return statSync(p).isFile(); } catch { return false; } },
      read: (p) => readFileSync(p, "utf8"),
    });
    return run(exe.shellPath, [...exe.prefixArgs, ...args], { cwd: root, input: prompt, shell: exe.viaCmdShim, timeoutMs: 240_000 });
  });
  const readerModel = () => String(conf().get("designReaderModel", "haiku") || "haiku");
  const readerOn = () => conf().get<string>("designReader", "claude") !== "off";
  const refreshMs = () => Math.max(15, Number(conf().get("refreshSeconds", 60)) || 60) * 1000;

  let cfg: CircuitConfig = parseConfig(undefined);
  let cfgLoaded: Promise<void> | undefined;
  const loadConfig = () => (cfgLoaded ??= fs.readFile(path.join(root, "build.config.yml"), "utf8")
    .then((y) => { cfg = parseConfig(y); }, () => { cfg = parseConfig(undefined); }));

  const logged = new Set<string>();
  const logOnce = (m: string) => { if (!logged.has(m)) { logged.add(m); log(m); } };
  let repoRef: RepoRef | undefined;
  async function repo(): Promise<RepoRef | undefined> {
    const r = deps.repo();
    if (r) return (repoRef = r);
    repoRef ??= await gitRemote(root).catch(() => undefined);
    return repoRef;
  }

  // ---------- Jira ----------
  let acliOff = false;
  let acliSite: string | undefined;
  async function search(jql: string): Promise<JiraIssue[]> {
    if (!acliOff) {
      try { return await searchIssues(acli, jql); } catch (e) {
        if (!(e instanceof AcliError) || e.kind === "failed") throw e;
        // acli is optional (section 7): without it, or logged out, Jira goes through the Atlassian MCP
        acliOff = true;
        logOnce(`project: ${e.message.split(".")[0]}; reading Jira through the Atlassian MCP`);
      }
    }
    throw new AcliUnavailable();
  }
  class AcliUnavailable extends Error { constructor() { super("acli is not available"); } }
  /** Claude reads (Jira, Confluence, Fireflies) cost a full `claude -p` run each: only start one when its MCP is connected. */
  const mcpReady = (id: "atlassian" | "fireflies") => connections.cached().find((c) => c.id === id)?.state === "connected";
  const NEED_ATLASSIAN = "Connect Atlassian on the Connections tab to read Jira";

  let jira: JiraState | undefined;
  let jiraInflight: Promise<JiraState> | undefined;
  /** Without acli: everything in ONE Claude run (it used to be four runs, each loading every MCP server). */
  async function fetchJiraViaClaude(pk: string): Promise<JiraState> {
    if (!readerOn()) throw new Error("Jira cannot be read: acli is not set up and deliveryCircuit.designReader is off");
    if (!mcpReady("atlassian")) throw new Error(NEED_ATLASSIAN);
    const b = await readJiraBatch(claude, pk, readerModel());
    return { epics: b.epics, stories: storiesOf(b.sprint.length ? b.sprint : b.children), tests: b.tests, at: Date.now() };
  }
  async function fetchJira(): Promise<JiraState> {
    await loadConfig();
    const pk = cfg.projectKey;
    if (!pk) return { epics: [], stories: [], tests: [], at: Date.now(), error: "Set jira.project_key in build.config.yml" };
    try {
      if (acliOff) return await fetchJiraViaClaude(pk);
      const epics = await search(epicsJql(pk));
      const jql = childrenJql(epics.filter((e) => e.statusCategory !== "done").map((e) => e.key));
      const [children, tests, sprint] = await Promise.all([
        jql ? search(jql) : Promise.resolve([]),
        search(testCasesJql(pk)),
        search(sprintJql(pk)).catch(() => undefined),
      ]);
      // the open sprint's stories when the project uses sprints, else the stories of the open epics
      const stories = storiesOf(sprint?.length ? sprint : children);
      if (!cfg.site && !acliSite && !acliOff) acliSite = (await authSite(acli).catch(() => undefined))?.site;
      return { epics, stories, tests, at: Date.now() };
    } catch (e) {
      if (e instanceof AcliUnavailable) {
        try { return await fetchJiraViaClaude(pk); } catch (e2) { e = e2; }
      }
      logOnce(`project: Jira read failed: ${short(e)}`);
      return { epics: jira?.epics ?? [], stories: jira?.stories ?? [], tests: jira?.tests ?? [], at: Date.now(), error: `Jira: ${short(e)}` };
    }
  }
  function loadJira(force = false): Promise<JiraState> {
    // through the MCP reader each read is a Claude call: read less often
    if (!force && jira && Date.now() - jira.at < (acliOff ? DESIGN_TTL : JIRA_TTL)) return Promise.resolve(jira);
    jiraInflight ??= fetchJira().then((s) => { jira = s; return s; }).finally(() => { jiraInflight = undefined; });
    return jiraInflight;
  }

  // ---------- Confluence design pages (background; the tabs render with what is cached) ----------
  let pages: { list: DesignPage[]; at: number; read: boolean } = { list: [], at: 0, read: false };
  let pagesInflight: Promise<void> | undefined;
  function refreshPages(force = false): void {
    if (!readerOn() || !cfg.spaceKey || pagesInflight || !mcpReady("atlassian")) return;
    if (!force && pages.at && Date.now() - pages.at < DESIGN_TTL) return;
    pagesInflight = readDesignPages(claude, cfg.spaceKey, readerModel())
      .then((list) => { pages = { list, at: Date.now(), read: true }; changed.fire(); },
        (e) => { logOnce(`project: reading design pages failed: ${short(e)}`); pages = { ...pages, at: Date.now() }; })
      .finally(() => { pagesInflight = undefined; });
  }

  // ---------- GitHub ----------
  let gh: GhState | undefined;
  let ghInflight: Promise<GhState> | undefined;
  const enc = encodeURIComponent;
  const fixedBranches = () => cfg.environments.map((e) => e.branch).filter((b) => !b.includes("*"));
  async function fetchGithub(): Promise<GhState> {
    await loadConfig();
    const r = await repo();
    if (!r) return { prs: [], sprints: [], branches: {}, deploys: [], at: Date.now(), error: "No GitHub remote \"origin\"" };
    const p = `/repos/${enc(r.owner)}/${enc(r.repo)}`;
    try {
      const w = mapWorkResponse(await connections.githubGraphql(workQuery(fixedBranches()), { owner: r.owner, name: r.repo }), fixedBranches());
      let deploys: DeployRun[] = [];
      try { deploys = mapDeployRuns(await connections.githubRequest("GET", `${p}/actions/workflows/deploy.yml/runs?per_page=30`)); } catch { /* not installed yet */ }
      let sprintAhead: number | undefined;
      const sprint = w.sprints[0];
      if (sprint && w.branches.dev) {
        try { sprintAhead = Number((await connections.githubRequest<any>("GET", `${p}/compare/dev...${sprint.split("/").map(enc).join("/")}`))?.ahead_by) || 0; }
        catch { /* compare failed: no promotion hint */ }
      }
      return { ...w, deploys, sprintAhead, at: Date.now() };
    } catch (e) {
      logOnce(`project: GitHub read failed: ${short(e)}`);
      return { prs: gh?.prs ?? [], sprints: gh?.sprints ?? [], branches: gh?.branches ?? {}, deploys: gh?.deploys ?? [], at: Date.now(), error: `GitHub: ${short(e)}` };
    }
  }
  function loadGithub(force = false): Promise<GhState> {
    if (!force && gh && Date.now() - gh.at < refreshMs()) return Promise.resolve(gh);
    ghInflight ??= fetchGithub().then((s) => { gh = s; return s; }).finally(() => { ghInflight = undefined; });
    return ghInflight;
  }

  // Repo setup (environments, SFDX_AUTH_URL by name, rulesets): slow-changing, read in the background.
  let setup: { value?: Omit<RepoSetup, "branches" | "sprintBranch" | "autoMerge">; at: number } = { at: 0 };
  let setupInflight: Promise<void> | undefined;
  function refreshSetup(force = false): void {
    if (setupInflight || (!force && setup.at && Date.now() - setup.at < SETUP_TTL)) return;
    setupInflight = (async () => {
      const r = await repo();
      if (!r) return;
      const p = `/repos/${enc(r.owner)}/${enc(r.repo)}`;
      const environments: RepoSetup["environments"] = {};
      try {
        const names = new Set(environmentNames(await connections.githubRequest("GET", `${p}/environments?per_page=100`)));
        for (const e of cfg.environments) {
          const exists = names.has(e.environment);
          let authUrl: boolean | undefined;
          if (exists) {
            // names only: the secrets API never returns values
            try { authUrl = hasAuthSecret(await connections.githubRequest("GET", `${p}/environments/${enc(e.environment)}/secrets?per_page=100`)); }
            catch { authUrl = undefined; /* needs repo admin: cannot tell */ }
          }
          environments[e.environment] = authUrl === undefined ? { exists } : { exists, authUrl };
        }
      } catch (e) { logOnce(`project: reading environments failed: ${short(e)}`); }
      let rulesets: Record<string, boolean> | undefined;
      try {
        const list = await connections.githubRequest<any[]>("GET", `${p}/rulesets?per_page=100`);
        const details = await Promise.all((Array.isArray(list) ? list : []).slice(0, 20).map((x) => connections.githubRequest("GET", `${p}/rulesets/${Number(x.id)}`).catch(() => x)));
        const sprint = gh?.sprints[0];
        rulesets = rulesetCoverage(details, cfg.environments.map((e) => sampleBranch(e.branch, sprint)), "main");
      } catch (e) { logOnce(`project: reading rulesets failed: ${short(e)}`); }
      setup = { value: { environments, ...(rulesets ? { rulesets } : {}) }, at: Date.now() };
      changed.fire();
    })().catch((e) => { logOnce(`project: repo setup read failed: ${short(e)}`); setup = { ...setup, at: Date.now() }; })
      .finally(() => { setupInflight = undefined; });
  }

  // ---------- snapshot ----------
  function features(j: JiraState): Feature[] {
    const out: Feature[] = [];
    const linked = new Set<string>();
    for (const epic of j.epics) {
      if (epic.statusCategory === "done") continue;
      const link = designPageOf(epic, cfg.fields);
      const slug = epic.labels.map((l) => /^feature-([a-z0-9-]+)$/.exec(l)?.[1]).find(Boolean);
      const page = pages.list.find((p) => p.id === link?.id || (slug && p.slug === slug));
      if (page) linked.add(page.id);
      out.push({ id: epic.key, title: epic.summary, epic, ...(page ? { page } : {}), ...(slug ?? page?.slug ? { slug: slug ?? page?.slug } : {}) });
    }
    for (const page of pages.list) {
      if (linked.has(page.id)) continue;
      out.push({ id: `page-${page.id}`, title: page.title.replace(/^Design:\s*/i, ""), page, ...(page.slug ? { slug: page.slug } : {}) });
    }
    return out;
  }

  async function snapshot(): Promise<WorkData> {
    await loadConfig();
    const [j, g] = await Promise.all([loadJira(), loadGithub()]);
    refreshPages();
    refreshSetup();
    const r = await repo();
    const data: WorkData = {
      readyStatus: cfg.readyStatus, features: features(j), stories: j.stories, tests: j.tests, prs: g.prs, deploys: g.deploys,
      fields: cfg.fields, designsRead: pages.read, errors: [j.error, g.error].filter((x): x is string => !!x),
    };
    if (r) data.repo = r;
    const site = cfg.site ?? acliSite;
    if (site) data.site = site;
    if (g.sprints[0]) data.sprint = g.sprints[0];
    if (g.sprintAhead !== undefined) data.sprintAhead = g.sprintAhead;
    if (!g.error && r) {
      data.setup = { branches: g.branches, environments: setup.value?.environments ?? {}, ...(g.sprints[0] ? { sprintBranch: g.sprints[0] } : {}) };
      if (setup.value?.rulesets) data.setup.rulesets = setup.value.rulesets;
      if (g.autoMerge !== undefined) data.setup.autoMerge = g.autoMerge;
    }
    return data;
  }

  // ---------- transcripts ----------
  async function keyBuffer(): Promise<Buffer> {
    const s = await ctx.secrets.get(KEY_SECRET);
    if (s) return Buffer.from(s, "base64");
    const k = newKey();
    await ctx.secrets.store(KEY_SECRET, k.toString("base64"));
    return k;
  }
  const oneLine = (s: string, fallback: string) => String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200) || fallback;
  async function store(text: string, title: string, origin: "paste" | "file"): Promise<SourceRef> {
    const body = String(text ?? "").trim();
    if (!body) throw new Error("There is no text in it");
    if (Buffer.byteLength(body, "utf8") > MAX_TEXT) throw new Error("The transcript is larger than 20 MB");
    const id = uploadId(body);
    // encrypted straight into the extension's storage: no temp file, nothing in the repo
    await storeUpload(ctx.globalStorageUri.fsPath, id, body, await keyBuffer());
    return { id, kind: "upload", title: oneLine(title, id), date: new Date().toISOString(), origin };
  }
  let ff: { list: SourceRef[]; at: number } | undefined;

  // ---------- change detection ----------
  let lastHash = "";
  const hashOf = () => JSON.stringify([gh?.prs.map((p) => [p.number, p.updatedAt, p.state, p.scan, p.coderabbit, p.approvedBy]),
    gh?.deploys.map((d) => [d.id, d.status, d.conclusion]), gh?.sprints, jira?.stories.map((s) => [s.key, s.status, s.updated]), jira?.error, gh?.error]);
  const poll = setInterval(async () => {
    await Promise.all([loadGithub(true).catch(() => undefined), loadJira().catch(() => undefined)]);
    const h = hashOf();
    if (lastHash && h !== lastHash) changed.fire();
    lastHash = h;
  }, refreshMs());
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === root)?.uri ?? vscode.Uri.file(root);
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "build.config.yml"));
  const onConfig = () => { cfgLoaded = undefined; jira = undefined; changed.fire(); };
  watcher.onDidCreate(onConfig); watcher.onDidChange(onConfig); watcher.onDidDelete(onConfig);
  ctx.subscriptions.push(watcher, { dispose: () => clearInterval(poll) });

  return {
    async work(role: Role, login, conns): Promise<WorkSnapshot> {
      const data = await snapshot();
      lastHash ||= hashOf();
      return {
        next: nextSteps(role, data, login),
        sprint: { ...(data.sprint ? { name: data.sprint } : {}), stories: sprintRows(data) },
        missing: missingItems(role, data, conns, cfg.environments),
        errors: data.errors,
        updatedAt: new Date().toISOString(),
      };
    },
    async story(key): Promise<StoryDetail | undefined> {
      if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) return undefined;
      const data = await snapshot();
      let issue = data.stories.find((s) => s.key === key);
      if (!issue) {
        try {
          issue = !acliOff ? await viewIssue(acli, key)
            : mcpReady("atlassian") ? (await readJiraIssues(claude, `key = ${key}`, readerModel()))[0] : undefined;
        }
        catch (e) { logOnce(`project: reading ${key} failed: ${short(e)}`); }
      }
      if (!issue) return undefined;
      // Release: the story's merge commit is on main (compare main...<sha> is "behind" or "identical")
      let inMain: boolean | undefined;
      const pr = data.prs.find((p) => p.storyKey === key && p.state === "merged" && p.mergeSha);
      const r = data.repo;
      if (pr && r) {
        try {
          const c = await connections.githubRequest<any>("GET", `/repos/${enc(r.owner)}/${enc(r.repo)}/compare/main...${pr.mergeSha}`);
          inMain = c?.status === "behind" || c?.status === "identical";
        } catch { inMain = undefined; }
      }
      return storyDetail(issue, data, { inMain });
    },
    async addText(text, opts) { return store(text, opts.title, opts.origin === "file" ? "file" : "paste"); },
    async addFile(file) {
      const stat = await fs.stat(file);
      if (stat.size > MAX_TEXT) throw new Error("The file is larger than 20 MB");
      const text = extractText(file, await fs.readFile(file));
      return store(text, path.basename(file, path.extname(file)), "file");
    },
    async firefliesRecent(limit = 10) {
      if (ff && Date.now() - ff.at < FIREFLIES_TTL) return ff.list.slice(0, limit);
      if (!readerOn()) return [];
      try {
        const list = await readFirefliesRecent(claude, limit, readerModel());
        ff = { list, at: Date.now() };
        return list;
      } catch (e) {
        logOnce(`project: Fireflies read failed: ${short(e)}`);
        return [];
      }
    },
    async transcript(sourceId) {
      const m = SOURCE_REF_RE.exec(sourceId);
      if (!m) throw new Error(`Unknown source id: ${sourceId}`);
      if (m[1] === "upload") return loadUpload(ctx.globalStorageUri.fsPath, sourceId, await keyBuffer());
      return firefliesPointer(m[2]);
    },
    async refresh() {
      cfgLoaded = undefined; ff = undefined;
      await loadConfig();
      await Promise.all([loadGithub(true), loadJira(true)]);
      refreshPages(true);
      refreshSetup(true);
      lastHash = hashOf();
      changed.fire();
    },
    onDidChange: changed.event,
  };
}

