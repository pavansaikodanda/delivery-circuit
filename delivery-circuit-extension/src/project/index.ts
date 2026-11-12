// Project context v3: features from Jira epics (Atlassian CLI, the person's `acli jira auth login --web`) and their
// Confluence design pages (read-only `claude -p` call through the person's Atlassian MCP login), PRs and gates from
// GitHub (the person's VS Code sign-in), transcript sources. No API token is read or stored anywhere.
// Logic lives in the vscode-free files next to this one; this file wires caching, watching and the processes.
import { promises as fs, readFileSync, statSync } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type {
  ConnectionsService, Identity, IdentityService, Persona, ProjectContextService, PrRef, QueueItem, SourceRef,
} from "../core/contracts";
import { resolveClaude } from "../core/claude";
import { gitRemote, run, type ModuleBase } from "../core/util";
import { AcliError, authSite, searchIssues, viewIssue, type AcliExec } from "./acli";
import { withPageOnlyFeatures } from "./design";
import { decisionsDetail, designDetail, orgSnapshotDetail, storyDetail } from "./details";
import { buildFeatures, linkPrs } from "./gates";
import { deployInfo, mapDeployRuns, mapPrsResponse, mapStoryPrsResponse, missingStoryKeys, PRS_QUERY, STORY_SEARCH_BATCH, storyPrsQuery } from "./github";
import { childrenJql, epicsJql, groupFeatures, parseConfig, testCasesJql } from "./jira";
import {
  firefliesPointer, MEETING_ID_RE, readDesignPage, readDesignPages, readFirefliesMeta, readFirefliesRecent, type ClaudeExec,
} from "./mcpReader";
import type { CircuitConfig, DeployInfo, DesignPage, DesignPageListing, FeatureInfo, FeatureSource, JiraIssue, PrInfo, RepoRef } from "./model";
import { buildQueue } from "./queue";
import {
  extractText, isSourceOrigin, loadUpload, newKey, readIndex, SOURCE_REF_RE, storeUpload, uploadId, upsertSource, withUsage, writeIndex,
} from "./sources";

/** One-line title for the sources index (no newlines, at most 200 characters). */
const cleanTitle = (t: string, fallback: string) => String(t ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200) || fallback;

const KEY_SECRET = "deliveryCircuit.sourcesKey";
const JIRA_TTL = 2 * 60_000;
const DESIGN_TTL = 10 * 60_000;
const FIREFLIES_TTL = 5 * 60_000;
/** Merged story PRs found outside the recent-PR window. Merged is final, so they are kept across sessions. */
const MERGED_STORY_KEY = "deliveryCircuit.mergedStoryPrs";
/** Design pages read last (metadata, decisions, org snapshot lists): shown at once in a new window, refreshed behind. */
const DESIGN_CACHE_KEY = "deliveryCircuit.designPages";
/** How long a story key with no merged PR is not searched again. */
const STORY_MISS_TTL = 15 * 60_000;

interface GhState { prs: PrInfo[]; deploy?: DeployInfo; at: number; error?: string }
interface JiraState { epics: JiraIssue[]; children: JiraIssue[]; tests: JiraIssue[]; at: number; error?: string }
interface Cached<T> { value: T; at: number }

/** The Circuit MCP detail reads (design_get, decisions_get, org_snapshot_get, story_get); now part of the contract. */
export type ProjectDetails = Pick<ProjectContextService, "design" | "decisions" | "orgSnapshot" | "story">;

export interface ProjectDeps {
  identity: IdentityService;
  connections: ConnectionsService;
  /** for tests: replaces `acli` */
  acli?: AcliExec;
  /** for tests: replaces `claude -p` */
  claude?: ClaudeExec;
}

export function createProject(base: ModuleBase, deps: ProjectDeps): ProjectContextService & ProjectDetails {
  const { ctx, root, log } = base;
  const { identity, connections } = deps;
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

  let cfg: CircuitConfig = parseConfig(undefined);
  let cfgLoaded: Promise<void> | undefined;
  const loadConfig = () => (cfgLoaded ??= fs.readFile(path.join(root, "build.config.yml"), "utf8")
    .then((y) => { cfg = parseConfig(y); }, () => { cfg = parseConfig(undefined); }));

  let gh: GhState | undefined;
  let ghInflight: Promise<GhState> | undefined;
  let ghNext: Promise<GhState> | undefined;
  let jira: JiraState | undefined;
  let jiraInflight: Promise<JiraState> | undefined;
  let acliSite: string | undefined;
  const mergedStories = new Map<number, PrInfo>(
    Object.entries(ctx.workspaceState?.get<Record<string, PrInfo>>(MERGED_STORY_KEY) ?? {}).map(([n, pr]) => [Number(n), pr]));
  const pages = new Map<string, Cached<DesignPage>>(
    Object.entries(ctx.workspaceState?.get<Record<string, Cached<DesignPage>>>(DESIGN_CACHE_KEY) ?? {}));
  const pageReads = new Map<string, Promise<void>>();
  let listing: Cached<DesignPageListing[]> | undefined;
  let listingRead: Promise<void> | undefined;
  let ff: { limit: number; list: SourceRef[]; at: number } | undefined;
  const storyMissAt = new Map<string, number>();
  let repoRef: RepoRef | undefined;
  let lastHash = "";
  const logged = new Set<string>();
  const logOnce = (m: string) => { if (!logged.has(m)) { logged.add(m); log(m); } };

  const refreshMs = () => Math.max(15, Number(conf().get("refreshSeconds", 60)) || 60) * 1000;

  async function repo(): Promise<RepoRef | undefined> {
    const id = identity.get();
    if (id?.owner && id.repo) return (repoRef = { owner: id.owner, repo: id.repo });
    if (!repoRef) repoRef = await gitRemote(root).catch(() => undefined);
    return repoRef;
  }

  // ---------- Jira (acli) ----------
  async function fetchJira(): Promise<JiraState> {
    await loadConfig();
    const pk = cfg.projectKey;
    if (!pk) return { epics: [], children: [], tests: [], at: Date.now(), error: "Set jira.project_key in build.config.yml to read epics and stories" };
    try {
      const epics = await searchIssues(acli, epicsJql(pk));
      const jql = childrenJql(epics.map((e) => e.key));
      const [children, tests] = await Promise.all([jql ? searchIssues(acli, jql) : Promise.resolve([]), searchIssues(acli, testCasesJql(pk))]);
      if (!cfg.site && !acliSite) {
        const a = await authSite(acli).catch(() => undefined);
        if (a?.site) acliSite = a.site;
      }
      return { epics, children, tests, at: Date.now() };
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      logOnce(`project: Jira read failed: ${msg}`);
      const keep = e instanceof AcliError && e.kind === "failed" ? jira : undefined;
      return { epics: keep?.epics ?? [], children: keep?.children ?? [], tests: keep?.tests ?? [], at: Date.now(), error: msg };
    }
  }
  async function loadJira(force = false): Promise<JiraState> {
    if (!force && jira && Date.now() - jira.at < JIRA_TTL) return jira;
    jiraInflight ??= fetchJira().then((s) => { jira = s; return s; }).finally(() => { jiraInflight = undefined; });
    return jiraInflight;
  }

  const jiraBrowseUrl = (key: string): string | undefined => {
    if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) return undefined;
    const site = cfg.site ?? acliSite;
    return site ? `${site}/browse/${key}` : undefined;
  };

  // ---------- Confluence (read-only Claude call, background) ----------
  function persistPages(): void {
    void ctx.workspaceState?.update(DESIGN_CACHE_KEY, Object.fromEntries(pages));
  }
  function readPage(pageId: string): Promise<void> {
    let p = pageReads.get(pageId);
    if (p) return p;
    p = (async () => {
      try {
        const page = await readDesignPage(claude, pageId, readerModel());
        if (page.error) logOnce(`project: design page ${pageId}: ${page.error}`);
        pages.set(pageId, { value: page, at: Date.now() });
      } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 200);
        logOnce(`project: reading design page ${pageId} failed: ${msg}`);
        const prev = pages.get(pageId)?.value;
        pages.set(pageId, { value: prev ? { ...prev, error: msg } : { id: pageId, versions: [], sections: [], openQuestions: 0, decisions: [], sources: [], readAt: new Date().toISOString(), error: msg }, at: Date.now() });
      }
      persistPages();
      changed.fire();
    })().finally(() => pageReads.delete(pageId));
    pageReads.set(pageId, p);
    return p;
  }
  /** Starts reads for stale pages (2 at a time) and returns at once with what is cached. */
  function refreshPages(ids: string[], force = false): void {
    if (!readerOn()) return;
    const stale = [...new Set(ids)].filter((id) => force || !pages.has(id) || Date.now() - pages.get(id)!.at >= DESIGN_TTL).filter((id) => !pageReads.has(id));
    let i = 0;
    const next = (): Promise<void> | undefined => (i < stale.length ? readPage(stale[i++]).then(() => next()) : undefined);
    next(); next();
  }
  function refreshListing(force = false): void {
    if (!readerOn() || !cfg.spaceKey || listingRead) return;
    if (!force && listing && Date.now() - listing.at < DESIGN_TTL) return;
    listingRead = readDesignPages(claude, cfg.spaceKey, readerModel())
      .then((l) => { listing = { value: l, at: Date.now() }; changed.fire(); },
        (e: any) => { logOnce(`project: listing design pages failed: ${String(e?.message ?? e).slice(0, 200)}`); listing = { value: listing?.value ?? [], at: Date.now() }; })
      .finally(() => { listingRead = undefined; });
  }

  // ---------- GitHub ----------
  function rememberMerged(prs: PrInfo[]): void {
    let added = false;
    for (const pr of prs) {
      if (pr.state !== "merged" || !pr.storyKey || mergedStories.has(pr.number)) continue;
      mergedStories.set(pr.number, pr);
      added = true;
    }
    if (added) void ctx.workspaceState?.update(MERGED_STORY_KEY, Object.fromEntries(mergedStories));
  }
  const storyKeys = (j: JiraState | undefined) => new Set((j?.children ?? []).map((c) => c.key));

  /** Merged PRs of Jira stories that fell out of PRS_QUERY's recent-merged window. */
  async function olderStoryPrs(r: RepoRef, recent: PrInfo[]): Promise<PrInfo[]> {
    rememberMerged(recent);
    const keys = storyKeys(await loadJira().catch(() => undefined));
    const now = Date.now();
    const todo = missingStoryKeys(keys, [...recent, ...mergedStories.values()])
      .filter((k) => now - (storyMissAt.get(k) ?? 0) >= STORY_MISS_TTL).slice(0, 2 * STORY_SEARCH_BATCH);
    for (let i = 0; i < todo.length; i += STORY_SEARCH_BATCH) {
      const batch = todo.slice(i, i + STORY_SEARCH_BATCH);
      try {
        const q = storyPrsQuery(r.owner, r.repo, batch);
        const found = mapStoryPrsResponse(await connections.githubGraphql(q.query, q.variables), batch);
        rememberMerged(found);
        for (const k of batch) if (!found.some((p) => p.storyKey === k)) storyMissAt.set(k, now);
      } catch (e: any) {
        logOnce(`project: looking up older story PRs failed: ${String(e?.message ?? e).slice(0, 200)}`);
        break;
      }
    }
    const seen = new Set(recent.map((p) => p.number));
    return [...mergedStories.values()].filter((p) => !seen.has(p.number) && keys.has(p.storyKey!)).map((p) => ({ ...p }));
  }

  async function fetchGithub(): Promise<GhState> {
    const r = await repo();
    if (!r) return { prs: [], at: Date.now(), error: "No GitHub remote \"origin\" in this workspace" };
    try {
      const resp = await connections.githubGraphql(PRS_QUERY, { owner: r.owner, name: r.repo });
      const mapped = mapPrsResponse(resp);
      const older = await olderStoryPrs(r, mapped.prs);
      let runs: ReturnType<typeof mapDeployRuns> = [];
      try {
        runs = mapDeployRuns(await connections.githubRequest("GET",
          `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/actions/workflows/deploy-prod.yml/runs?per_page=10`));
      } catch { /* workflow not installed yet */ }
      return { prs: [...mapped.prs, ...older], deploy: deployInfo(runs, mapped.prodDeployedAt, mapped.prodDeployedSha), at: Date.now() };
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 200);
      logOnce(`project: GitHub read failed: ${msg}`);
      return { prs: gh?.prs ?? [], deploy: gh?.deploy, at: Date.now(), error: msg };
    }
  }
  function startFetch(): Promise<GhState> {
    const p: Promise<GhState> = fetchGithub()
      .then((state) => { gh = state; return state; })
      .finally(() => { if (ghInflight === p) ghInflight = undefined; });
    ghInflight = p;
    return p;
  }
  /** GitHub state, cached for refreshSeconds. force = queue one fresh read behind a read already in flight. */
  async function loadGithub(force = false): Promise<GhState> {
    if (!force && gh && Date.now() - gh.at < refreshMs()) return gh;
    if (!ghInflight) return startFetch();
    if (!force) return ghInflight;
    ghNext ??= ghInflight.catch(() => undefined).then(() => { ghNext = undefined; return startFetch(); });
    return ghNext;
  }

  // ---------- snapshot ----------
  function sourcesOf(j: JiraState): FeatureSource[] {
    const grouped = groupFeatures(j.epics, j.children, j.tests, cfg.fields);
    const all = withPageOnlyFeatures(grouped, listing?.value ?? []);
    refreshPages(all.map((s) => s.pageId).filter((x): x is string => !!x));
    refreshListing();
    return all.map((s) => (s.pageId && pages.has(s.pageId) ? { ...s, page: pages.get(s.pageId)!.value } : s));
  }

  async function snapshot(): Promise<{ features: FeatureInfo[]; gh: GhState; jira: JiraState; repo?: RepoRef }> {
    await loadConfig();
    const [j, g] = await Promise.all([loadJira(), loadGithub()]);
    const r = await repo();
    const prs = g.prs.map((x) => ({ ...x }));
    const features = buildFeatures(sourcesOf(j), prs, g.deploy, cfg, { repo: r, jiraBrowseUrl });
    return { features, gh: { ...g, prs }, jira: j, repo: r };
  }
  const findFeature = (list: FeatureInfo[], id: string) => list.find((f) => f.id === id || f.slug === id || f.design?.pageId === id);
  const pageOf = (f: FeatureInfo | undefined) => (f?.design ? pages.get(f.design.pageId)?.value : undefined);

  // ---------- sources ----------
  async function keyBuffer(): Promise<Buffer> {
    const s = await ctx.secrets.get(KEY_SECRET);
    if (s) return Buffer.from(s, "base64");
    const k = newKey();
    await ctx.secrets.store(KEY_SECRET, k.toString("base64"));
    return k;
  }
  async function sourcesWithUsage(): Promise<SourceRef[]> {
    const index = await readIndex(root);
    let citations: Record<string, string[]> = {};
    try { citations = Object.fromEntries((await snapshot()).features.map((f) => [f.id, f.sources])); } catch { /* index only */ }
    // usedBy recorded in the index (the epic an intake used) stays; design-page citations are added to it.
    const recorded = new Map(index.map((s) => [s.id, s.usedBy ?? []]));
    return withUsage(index, citations).map((s) => {
      const by = [...new Set([...(s.usedBy ?? []), ...(recorded.get(s.id) ?? [])])].sort();
      const o = { ...s };
      if (by.length) o.usedBy = by; else delete o.usedBy;
      return o;
    });
  }
  async function addToIndex(ref: SourceRef): Promise<SourceRef> {
    const list = upsertSource(await readIndex(root), ref);
    await writeIndex(root, list);
    changed.fire();
    return (await sourcesWithUsage()).find((s) => s.id === ref.id) ?? ref;
  }

  // ---------- change detection: file watcher, connections, periodic poll ----------
  let debounce: NodeJS.Timeout | undefined;
  const onFiles = () => {
    cfgLoaded = undefined;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => changed.fire(), 300);
  };
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === root)?.uri ?? vscode.Uri.file(root);
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "{.circuit/**,build.config.yml}"));
  watcher.onDidCreate(onFiles); watcher.onDidChange(onFiles); watcher.onDidDelete(onFiles);
  ctx.subscriptions.push(watcher);
  // Drop the remote caches only when a connection this module reads through actually changed state or account.
  const REMOTE: ReadonlySet<string> = new Set(["github", "jira", "confluence", "mcp-atlassian", "fireflies", "mcp-fireflies"]);
  let connSig: string | undefined;
  let connTimer: NodeJS.Timeout | undefined;
  ctx.subscriptions.push(connections.onDidChange(() => {
    if (connTimer) clearTimeout(connTimer);
    connTimer = setTimeout(async () => {
      let sig: string;
      try {
        const list = await connections.list();
        sig = JSON.stringify(list.filter((c) => REMOTE.has(c.id) && c.state !== "checking").map((c) => [c.id, c.state, c.account ?? ""]));
      } catch { sig = `error:${Date.now()}`; }
      if (sig === connSig) return;
      connSig = sig;
      gh = undefined; jira = undefined; ff = undefined;
      changed.fire();
    }, 500);
  }));
  ctx.subscriptions.push({ dispose: () => { if (connTimer) clearTimeout(connTimer); } });

  const hashOf = (g: GhState, j?: JiraState) => JSON.stringify([g.error ?? "", g.prs.map((p) => [p.number, p.updatedAt, p.state, p.labels, p.checks]),
    g.deploy?.runs.map((r) => [r.id, r.status, r.conclusion]), j?.error ?? "", [...(j?.epics ?? []), ...(j?.children ?? []), ...(j?.tests ?? [])].map((i) => [i.key, i.updated ?? i.status, i.labels])]);
  const poll = setInterval(async () => {
    const [g, j] = await Promise.all([loadGithub(true).catch(() => undefined), loadJira().catch(() => undefined)]);
    if (!g) return;
    const h = hashOf(g, j);
    if (lastHash && h !== lastHash) changed.fire();
    lastHash = h;
  }, refreshMs());
  ctx.subscriptions.push({ dispose: () => { clearInterval(poll); if (debounce) clearTimeout(debounce); } });

  const syntheticIdentity = (persona: Persona): Identity =>
    ({ login: "", personas: [persona], active: persona, isAdmin: false, owner: repoRef?.owner ?? "", repo: repoRef?.repo ?? "", orgOwned: true });

  return {
    async features() { return (await snapshot()).features; },
    async feature(id) { return findFeature((await snapshot()).features, id); },
    async prs(): Promise<PrRef[]> {
      const s = await snapshot();
      return linkPrs(s.features, s.gh.prs).filter((x) => x.state === "open");
    },
    async queue(id: Identity, persona: Persona): Promise<QueueItem[]> {
      const s = await snapshot();
      const who = id ?? syntheticIdentity(persona);
      return buildQueue(persona, {
        features: s.features, prs: s.gh.prs, deploy: s.gh.deploy,
        env: { login: who.login || undefined, repo: s.repo, jiraBrowseUrl, githubError: s.gh.error, jiraError: s.jira.error, maxAttempts: cfg.maxAttempts },
      });
    },
    jiraBrowseUrl,
    sources: sourcesWithUsage,
    async firefliesRecent(limit = 10) {
      if (ff && ff.limit >= limit && Date.now() - ff.at < FIREFLIES_TTL) return ff.list.slice(0, limit);
      if (!readerOn()) return [];
      try {
        const list = await readFirefliesRecent(claude, limit, readerModel());
        ff = { limit, list, at: Date.now() };
        return list;
      } catch (e: any) {
        logOnce(`project: Fireflies read failed: ${String(e?.message ?? e).slice(0, 200)}`);
        return [];
      }
    },
    async indexFireflies(meetingId, meta) {
      const id = meetingId.replace(/^fireflies:/, "");
      if (!MEETING_ID_RE.test(id)) throw new Error("Invalid Fireflies meeting id");
      // The Sources page already listed the meeting: its title and date avoid a second Fireflies read.
      const given = meta && typeof meta.title === "string" && meta.title.trim()
        ? { id: `fireflies:${id}`, kind: "fireflies" as const, title: cleanTitle(meta.title, id), date: String(meta.date ?? "") } : undefined;
      const known = given ?? ff?.list.find((m) => m.id === `fireflies:${id}`);
      return addToIndex({ ...(known ?? await readFirefliesMeta(claude, id, readerModel())), origin: "fireflies" });
    },
    async addUpload(fileUri, title) {
      const file = fileUri.fsPath;
      const stat = await fs.stat(file);
      if (stat.size > 20 * 1024 * 1024) throw new Error("Transcript file is larger than 20 MB");
      const text = extractText(file, await fs.readFile(file)).trim();
      if (!text) throw new Error("The transcript file has no text");
      const id = uploadId(text);
      await storeUpload(ctx.globalStorageUri.fsPath, id, text, await keyBuffer());
      const name = cleanTitle(title ?? path.basename(file, path.extname(file)), id);
      return addToIndex({ id, kind: "upload", title: name, date: new Date().toISOString(), origin: "file" });
    },
    async addText(text, opts) {
      const body = String(text ?? "").trim();
      if (!body) throw new Error("There is no text to add");
      if (Buffer.byteLength(body, "utf8") > 20 * 1024 * 1024) throw new Error("The text is larger than 20 MB");
      const origin = isSourceOrigin(opts?.origin) ? opts.origin : "paste";
      const id = uploadId(body);
      // Encrypted straight into the extension's storage: no temp file, nothing in the repo but the index entry.
      await storeUpload(ctx.globalStorageUri.fsPath, id, body, await keyBuffer());
      const date = opts?.date && !Number.isNaN(Date.parse(opts.date)) ? new Date(opts.date).toISOString() : new Date().toISOString();
      return addToIndex({ id, kind: "upload", title: cleanTitle(opts?.title ?? "", id), date, origin });
    },
    async transcript(sourceId) {
      const m = SOURCE_REF_RE.exec(sourceId);
      if (!m) throw new Error(`Unknown source id: ${sourceId}`);
      if (m[1] === "upload") return loadUpload(ctx.globalStorageUri.fsPath, sourceId, await keyBuffer());
      return firefliesPointer(m[2]);
    },
    async refresh() {
      cfgLoaded = undefined; jira = undefined; ff = undefined;
      await loadConfig();
      const [g, j] = await Promise.all([loadGithub(true), loadJira(true)]);
      refreshPages([...pages.keys(), ...groupFeatures(j.epics, j.children, j.tests, cfg.fields).map((s) => s.pageId).filter((x): x is string => !!x)], true);
      refreshListing(true);
      lastHash = hashOf(g, j);
      changed.fire();
    },
    onDidChange: changed.event,

    // ---- v3 detail reads (Circuit MCP) ----
    async design(featureId) {
      const f = findFeature((await snapshot()).features, featureId);
      if (!f) throw new Error(`No feature ${featureId} (an epic key, a feature slug or a design page id)`);
      return designDetail(f, pageOf(f));
    },
    async decisions(featureId) {
      const f = findFeature((await snapshot()).features, featureId);
      if (!f) throw new Error(`No feature ${featureId}`);
      return decisionsDetail(f, pageOf(f));
    },
    async orgSnapshot(featureId) {
      const f = findFeature((await snapshot()).features, featureId);
      if (!f) throw new Error(`No feature ${featureId}`);
      return orgSnapshotDetail(f, pageOf(f));
    },
    async story(key) {
      if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) throw new Error(`Not a Jira key: ${key}`);
      const s = await snapshot();
      for (const f of s.features) {
        const st = f.stories.find((x) => x.jiraKey === key);
        if (st) return storyDetail(f, st, s.gh.prs);
      }
      // Not a story of a feature epic: read it directly.
      const issue = await viewIssue(acli, key);
      if (!issue) throw new Error(`Jira issue ${key} not found`);
      return { key: issue.key, summary: issue.summary, issueType: issue.issueType, status: issue.status, labels: issue.labels, parent: issue.parentKey ?? null,
        description: issue.description ?? null, url: jiraBrowseUrl(issue.key) ?? null, note: "Not a story under a feature epic." };
    },
  };
}
