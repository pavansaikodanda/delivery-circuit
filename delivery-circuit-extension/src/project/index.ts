// Project context: Spec Kit features, PRs and gates, Jira, transcript sources. Logic lives in the vscode-free
// files next to this one (parse, github, gates, queue, sources, remote); this file wires caching, watching,
// SecretStorage and the connections service.
import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type {
  ConnectionsService, Feature, Identity, IdentityService, Persona, ProjectContextService, PrRef, QueueItem, SourceRef,
} from "../core/contracts";
import { gitRemote, type ModuleBase } from "../core/util";
import { enrichFeatures, linkPrs } from "./gates";
import { deployInfo, mapDeployRuns, mapPrsResponse, mapStoryPrsResponse, missingStoryKeys, PRS_QUERY, STORY_SEARCH_BATCH, storyPrsQuery } from "./github";
import type { DeployInfo, JiraLabels, ParsedFeature, PrInfo, RepoRef } from "./model";
import { loadFeatures } from "./parse";
import { buildQueue } from "./queue";
import { firefliesMeta, firefliesRecent, firefliesTranscript, jiraLabels, jiraSiteUrl, MEETING_ID_RE } from "./remote";
import {
  extractText, loadUpload, newKey, readIndex, SOURCE_REF_RE, storeUpload, uploadId, upsertSource, withUsage, writeIndex,
} from "./sources";

const KEY_SECRET = "deliveryCircuit.sourcesKey";
const JIRA_TTL = 5 * 60_000;
const FIREFLIES_TTL = 2 * 60_000;
/** Merged story PRs found outside the recent-PR window. Merged is final, so they are kept across sessions. */
const MERGED_STORY_KEY = "deliveryCircuit.mergedStoryPrs";
/** How long a story key with no merged PR is not searched again. */
const STORY_MISS_TTL = 15 * 60_000;

interface GhState { prs: PrInfo[]; deploy?: DeployInfo; at: number; error?: string }

export function createProject(base: ModuleBase, deps: { identity: IdentityService; connections: ConnectionsService }): ProjectContextService {
  const { ctx, root, log } = base;
  const { identity, connections } = deps;
  const changed = new vscode.EventEmitter<void>();
  ctx.subscriptions.push(changed);

  let parsed: Promise<ParsedFeature[]> | undefined;
  let gh: GhState | undefined;
  let ghInflight: Promise<GhState> | undefined;
  let ghNext: Promise<GhState> | undefined;
  const mergedStories = new Map<number, PrInfo>(
    Object.entries(ctx.workspaceState?.get<Record<string, PrInfo>>(MERGED_STORY_KEY) ?? {}).map(([n, pr]) => [Number(n), pr]));
  const storyMissAt = new Map<string, number>();
  let jira: { keys: string; labels: JiraLabels; at: number } | undefined;
  let ff: { limit: number; list: SourceRef[]; at: number } | undefined;
  let jiraSite: string | undefined;
  let configSite: string | undefined;
  let repoRef: RepoRef | undefined;
  let lastHash = "";
  const logged = new Set<string>();
  const logOnce = (m: string) => { if (!logged.has(m)) { logged.add(m); log(m); } };

  const refreshMs = () => Math.max(15, Number(vscode.workspace.getConfiguration("deliveryCircuit").get("refreshSeconds", 60)) || 60) * 1000;

  // Jira site from build.config.yml until the person connects Jira (browse links only, no secrets there)
  fs.readFile(path.join(root, "build.config.yml"), "utf8").then((y) => {
    const m = /^jira:\s*\n(?:[ \t]+.*\n)*?[ \t]+site:\s*([^\s#]+)/m.exec(y);
    configSite = m ? jiraSiteUrl(m[1]) : undefined;
  }).catch(() => {});

  async function repo(): Promise<RepoRef | undefined> {
    const id = identity.get();
    if (id?.owner && id.repo) return (repoRef = { owner: id.owner, repo: id.repo });
    if (!repoRef) repoRef = await gitRemote(root).catch(() => undefined);
    return repoRef;
  }

  const getParsed = () => (parsed ??= loadFeatures(root).catch((e) => { logOnce(`project: reading specs failed: ${e?.message ?? e}`); return []; }));

  /** Remembers merged story PRs (their state can no longer change). */
  function rememberMerged(prs: PrInfo[]): void {
    let added = false;
    for (const pr of prs) {
      if (pr.state !== "merged" || !pr.storyKey || mergedStories.has(pr.number)) continue;
      mergedStories.set(pr.number, pr);
      added = true;
    }
    if (added) void ctx.workspaceState?.update(MERGED_STORY_KEY, Object.fromEntries(mergedStories));
  }

  /** Merged PRs of stories the features reference that fell out of PRS_QUERY's recent-merged window. */
  async function olderStoryPrs(r: RepoRef, recent: PrInfo[]): Promise<PrInfo[]> {
    rememberMerged(recent);
    const keys = new Set((await getParsed()).flatMap((x) => x.feature.stories.map((st) => st.jiraKey).filter((k): k is string => !!k)));
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

  /**
   * GitHub state, cached for refreshSeconds. force = the caller needs data read after this moment (a gate action just
   * changed something): a request already in flight may have started before that change, so one fresh request is
   * queued behind it instead of reusing its answer.
   */
  async function loadGithub(force = false): Promise<GhState> {
    if (!force && gh && Date.now() - gh.at < refreshMs()) return gh;
    if (!ghInflight) return startFetch();
    if (!force) return ghInflight;
    ghNext ??= ghInflight.catch(() => undefined).then(() => { ghNext = undefined; return startFetch(); });
    return ghNext;
  }

  async function loadJira(p: ParsedFeature[]): Promise<JiraLabels> {
    const keys = [...new Set(p.flatMap((x) => x.feature.stories.map((s) => s.jiraKey).filter((k): k is string => !!k)))].sort();
    const sig = keys.join(",");
    if (jira && jira.keys === sig && Date.now() - jira.at < JIRA_TTL) return jira.labels;
    let creds;
    try { creds = await connections.jira(); } catch { creds = undefined; }
    if (!creds) { jira = { keys: sig, labels: undefined, at: Date.now() }; return undefined; }
    jiraSite = jiraSiteUrl(creds.site) ?? jiraSite;
    try {
      const labels = keys.length ? await jiraLabels(creds, keys) : {};
      jira = { keys: sig, labels, at: Date.now() };
      return labels;
    } catch (e: any) {
      logOnce(`project: Jira read failed: ${String(e?.message ?? e).slice(0, 200)}`);
      return jira?.labels;
    }
  }

  const jiraBrowseUrl = (key: string): string | undefined => {
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return undefined;
    const site = jiraSite ?? configSite;
    return site ? `${site}/browse/${key}` : undefined;
  };

  async function snapshot(): Promise<{ features: Feature[]; gh: GhState; jiraConnected: boolean; jiraLabels: JiraLabels; repo?: RepoRef }> {
    const [p, g] = await Promise.all([getParsed(), loadGithub()]);
    const labels = await loadJira(p);
    const r = await repo();
    const prs = g.prs.map((x) => ({ ...x }));
    const features = enrichFeatures(p, prs, labels, g.deploy, { repo: r, jiraBrowseUrl });
    return { features, gh: { ...g, prs }, jiraConnected: labels !== undefined, jiraLabels: labels, repo: r };
  }

  async function keyBuffer(): Promise<Buffer> {
    const s = await ctx.secrets.get(KEY_SECRET);
    if (s) return Buffer.from(s, "base64");
    const k = newKey();
    await ctx.secrets.store(KEY_SECRET, k.toString("base64"));
    return k;
  }

  async function sourcesWithUsage(): Promise<SourceRef[]> {
    const p = await getParsed();
    const citations = Object.fromEntries(p.map((x) => [x.feature.id, x.feature.sources]));
    return withUsage(await readIndex(root), citations);
  }

  async function addToIndex(ref: SourceRef): Promise<SourceRef> {
    const list = upsertSource(await readIndex(root), ref);
    await writeIndex(root, list);
    changed.fire();
    return (await sourcesWithUsage()).find((s) => s.id === ref.id) ?? ref;
  }

  // ---- change detection: file watcher, connections, periodic poll ----
  let debounce: NodeJS.Timeout | undefined;
  const onFiles = () => {
    parsed = undefined;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => changed.fire(), 300);
  };
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === root)?.uri ?? vscode.Uri.file(root);
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "{.specify/**,.circuit/**}"));
  watcher.onDidCreate(onFiles); watcher.onDidChange(onFiles); watcher.onDidDelete(onFiles);
  ctx.subscriptions.push(watcher);
  // Connections fire a change for every status row they re-check. Drop the remote caches only when a connection this
  // module reads through (GitHub, Jira, Fireflies) actually changed state or account.
  const REMOTE: ReadonlySet<string> = new Set(["github", "jira", "fireflies"]);
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

  const hashOf = (g: GhState) => JSON.stringify([g.error ?? "", g.prs.map((p) => [p.number, p.updatedAt, p.state, p.labels, p.checks]), g.deploy?.runs.map((r) => [r.id, r.status, r.conclusion])]);
  const poll = setInterval(async () => {
    const g = await loadGithub(true).catch(() => undefined);
    if (!g) return;
    const h = hashOf(g);
    if (lastHash && h !== lastHash) changed.fire();
    lastHash = h;
  }, refreshMs());
  ctx.subscriptions.push({ dispose: () => { clearInterval(poll); if (debounce) clearTimeout(debounce); } });

  const syntheticIdentity = (persona: Persona): Identity =>
    ({ login: "", personas: [persona], active: persona, isAdmin: false, owner: repoRef?.owner ?? "", repo: repoRef?.repo ?? "", orgOwned: true });

  return {
    async features() { return (await snapshot()).features; },
    async feature(id) { return (await snapshot()).features.find((f) => f.id === id || f.slug === id); },
    async prs(): Promise<PrRef[]> {
      const [p, g] = await Promise.all([getParsed(), loadGithub()]);
      const prs = linkPrs(p, g.prs.map((x) => ({ ...x })));
      return prs.filter((x) => x.state === "open");
    },
    async queue(id: Identity, persona: Persona): Promise<QueueItem[]> {
      const s = await snapshot();
      const who = id ?? syntheticIdentity(persona);
      return buildQueue(persona, {
        features: s.features, prs: s.gh.prs, deploy: s.gh.deploy,
        env: { login: who.login || undefined, repo: s.repo, jiraConnected: s.jiraConnected, jiraLabels: s.jiraLabels, jiraBrowseUrl, githubError: s.gh.error },
      });
    },
    async jiraMap(featureId) {
      const p = (await getParsed()).find((x) => x.feature.id === featureId || x.feature.slug === featureId);
      return { ...(p?.facts.jiraRefs ?? {}) };
    },
    jiraBrowseUrl,
    sources: sourcesWithUsage,
    async firefliesRecent(limit = 10) {
      if (ff && ff.limit >= limit && Date.now() - ff.at < FIREFLIES_TTL) return ff.list.slice(0, limit);
      const key = await connections.firefliesKey().catch(() => undefined);
      if (!key) return [];
      try {
        const list = await firefliesRecent(key, limit);
        ff = { limit, list, at: Date.now() };
        return list;
      } catch (e: any) {
        logOnce(`project: Fireflies read failed: ${String(e?.message ?? e).slice(0, 200)}`);
        return [];
      }
    },
    async indexFireflies(meetingId) {
      const id = meetingId.replace(/^fireflies:/, "");
      if (!MEETING_ID_RE.test(id)) throw new Error("Invalid Fireflies meeting id");
      const key = await connections.firefliesKey();
      if (!key) throw new Error("Fireflies is not connected. Connect it on the Connections page.");
      return addToIndex(await firefliesMeta(key, id));
    },
    async addUpload(fileUri, title) {
      const file = fileUri.fsPath;
      const stat = await fs.stat(file);
      if (stat.size > 20 * 1024 * 1024) throw new Error("Transcript file is larger than 20 MB");
      const text = extractText(file, await fs.readFile(file)).trim();
      if (!text) throw new Error("The transcript file has no text");
      const id = uploadId(text);
      await storeUpload(ctx.globalStorageUri.fsPath, id, text, await keyBuffer());
      const name = (title ?? path.basename(file, path.extname(file))).replace(/[\r\n]+/g, " ").trim().slice(0, 200) || id;
      return addToIndex({ id, kind: "upload", title: name, date: new Date().toISOString() });
    },
    async transcript(sourceId) {
      const m = SOURCE_REF_RE.exec(sourceId);
      if (!m) throw new Error(`Unknown source id: ${sourceId}`);
      if (m[1] === "upload") return loadUpload(ctx.globalStorageUri.fsPath, sourceId, await keyBuffer());
      const key = await connections.firefliesKey();
      if (!key) throw new Error("Fireflies is not connected. Connect it on the Connections page.");
      return firefliesTranscript(key, m[2]);
    },
    async refresh() {
      parsed = undefined; jira = undefined; ff = undefined;
      const g = await loadGithub(true);
      lastHash = hashOf(g);
      changed.fire();
    },
    onDidChange: changed.event,
  };
}
