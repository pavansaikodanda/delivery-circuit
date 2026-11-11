import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async (importOriginal) => {
  const orig: any = await importOriginal();
  const watcher = { onDidCreate: () => ({ dispose() {} }), onDidChange: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} };
  return {
    ...orig,
    RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
    workspace: { ...orig.workspace, createFileSystemWatcher: () => watcher, getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }) },
  };
});

import type { Identity } from "../../src/core/contracts";
import { createProject } from "../../src/project";

const FIX = path.join(__dirname, "..", "fixtures", "project");
const resp = JSON.parse(require("fs").readFileSync(path.join(FIX, "github-prs.json"), "utf8"));
let root: string, storage: string;
const subs: { dispose(): void }[] = [];
const secrets = new Map<string, string>();
const graphqlCalls: any[] = [];

const identity: Identity = { login: "dev1", personas: ["developer"], active: "developer", isAdmin: false, owner: "acme", repo: "sales", orgOwned: true };

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "dc-proj-"));
  storage = await fsp.mkdtemp(path.join(os.tmpdir(), "dc-store-"));
  await fsp.cp(path.join(FIX, "repo"), root, { recursive: true });
});
afterAll(async () => {
  subs.forEach((s) => s.dispose());
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(storage, { recursive: true, force: true });
});

function make(opts: { graphqlFails?: boolean; jira?: boolean; graphql?: (q: string, v: any) => Promise<any>; state?: Map<string, unknown> } = {}) {
  const state = opts.state ?? new Map<string, unknown>();
  const ctx: any = {
    subscriptions: subs,
    workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } },
    globalStorageUri: { fsPath: storage },
    secrets: { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => { secrets.set(k, v); } },
  };
  const connections: any = {
    onDidChange: () => ({ dispose() {} }),
    githubGraphql: async (q: string, v: any) => {
      graphqlCalls.push(v);
      if (opts.graphqlFails) throw new Error("Not signed in to GitHub");
      return opts.graphql ? opts.graphql(q, v) : resp.data;
    },
    githubRequest: async () => ({ workflow_runs: [{ id: 5, status: "waiting", conclusion: null, html_url: "https://github.com/acme/sales/actions/runs/5", created_at: "2026-11-10T00:00:00Z", head_sha: "abc" }] }),
    jira: async () => (opts.jira ? { site: "acme.atlassian.net", email: "a@b.c", token: "t" } : undefined),
    firefliesKey: async () => undefined,
  };
  const logs: string[] = [];
  const svc = createProject({ ctx, root, pluginRoot: "", log: (m) => logs.push(m) }, {
    identity: { get: () => identity, refresh: async () => identity, setActive: async () => {}, onDidChange: () => ({ dispose() {} }) } as any,
    connections,
  });
  return { svc, logs };
}

describe("createProject", () => {
  it("serves features with gates from one GraphQL query", async () => {
    const { svc } = make();
    const features = await svc.features();
    expect(features.map((f) => f.slug)).toEqual(["001-case-escalation", "002-partner-onboarding"]);
    expect(features[0].gates.G8).toBe("waiting");
    expect(graphqlCalls.at(-1)).toEqual({ owner: "acme", name: "sales" });
    expect((await svc.feature("001-case-escalation"))!.id).toBe("001");
    const n = graphqlCalls.length;
    await svc.features();
    expect(graphqlCalls.length).toBe(n); // cached within refreshSeconds
  });
  it("lists only open PRs, linked to their stories", async () => {
    const { svc } = make();
    const prs = await svc.prs();
    expect(prs.map((p) => p.number)).toEqual([40, 42, 43, 44, 46]);
    expect(prs.find((p) => p.number === 43)!.featureId).toBe("001");
  });
  it("builds queues, including pending production approvals", async () => {
    const { svc } = make();
    const arch = await svc.queue(identity, "architect");
    expect(arch.some((i) => i.kind === "deploy-approval" && i.actions[0].args!.runId === 5)).toBe(true);
    expect((await svc.queue(identity, "developer")).map((i) => i.kind)).toEqual(["approve-plan", "needs-human"]);
  });
  it("shows a connect item and keeps repo data when GitHub fails", async () => {
    const { svc, logs } = make({ graphqlFails: true });
    const q = await svc.queue(identity, "architect");
    expect(q[0]).toMatchObject({ kind: "connect", detail: "Not signed in to GitHub" });
    expect(q.some((i) => i.kind === "sign-off")).toBe(true);
    expect(logs.filter((l) => l.includes("GitHub read failed"))).toHaveLength(1);
  });
  it("reads the Jira map and builds browse links from build.config.yml or the connection", async () => {
    await fsp.writeFile(path.join(root, "build.config.yml"), "github:\n  org: acme\njira:\n  site: https://acme.atlassian.net\n  project_key: ABC\n");
    const { svc } = make();
    expect((await svc.jiraMap("001")).epic).toBe("ABC-10");
    expect(await svc.jiraMap("999")).toEqual({});
    await new Promise((r) => setTimeout(r, 20));
    expect(svc.jiraBrowseUrl("ABC-1")).toBe("https://acme.atlassian.net/browse/ABC-1");
    expect(svc.jiraBrowseUrl("not a key")).toBeUndefined();
  });
  it("adds an encrypted upload, indexes metadata only and returns the text", async () => {
    const { svc } = make();
    let fired = 0;
    svc.onDidChange(() => fired++);
    const src = path.join(storage, "call.vtt");
    await fsp.writeFile(src, "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Anna>Partners need a portal.\n");
    const ref = await svc.addUpload({ fsPath: src } as any, "Partner call");
    expect(ref).toMatchObject({ kind: "upload", title: "Partner call" });
    expect(ref.id).toMatch(/^upload:[0-9a-f]{12}$/);
    expect(fired).toBe(1);
    const index = await fsp.readFile(path.join(root, ".circuit", "sources.json"), "utf8");
    expect(index).toContain(ref.id);
    expect(index).not.toContain("portal");
    expect(secrets.get("deliveryCircuit.sourcesKey")).toBeDefined();
    expect(await svc.transcript(ref.id)).toBe("Anna: Partners need a portal.");
    const sources = await svc.sources();
    expect(sources.find((s) => s.id === "upload:3f9a0c1b2d4e")!.usedBy).toEqual(["001"]);
    await expect(svc.transcript("upload:000000000000")).rejects.toThrow(/not stored/);
    await expect(svc.transcript("nope")).rejects.toThrow(/Unknown source id/);
    await expect(svc.transcript("fireflies:01ABC")).rejects.toThrow(/Fireflies is not connected/);
  });
  it("returns no Fireflies meetings when not connected and refuses to index", async () => {
    const { svc } = make();
    expect(await svc.firefliesRecent()).toEqual([]);
    await expect(svc.indexFireflies("01ABC")).rejects.toThrow(/not connected/);
    await expect(svc.indexFireflies("../x")).rejects.toThrow(/Invalid/);
  });
  it("finds story PRs that merged before the recent-merged window and keeps them", async () => {
    const clone = () => JSON.parse(JSON.stringify(resp.data));
    const node43 = resp.data.repository.open.nodes.find((n: any) => n.number === 43);
    const merged = (n: number, branch: string) => ({ ...node43, number: n, headRefName: branch, state: "MERGED", isDraft: false, mergedAt: "2026-01-02T00:00:00Z" });
    const searches: any[] = [];
    const graphql = async (q: string, v: any) => {
      if (q.includes("CircuitStoryPrs")) {
        searches.push(v);
        // head: is a prefix match, so the search also returns ABC-130's PR; only ABC-13's may be used.
        return { s0: { nodes: [merged(143, "feature/ABC-13-escalation-queue"), merged(1300, "feature/ABC-130-other")] } };
      }
      const d = clone();
      d.repository.open.nodes = d.repository.open.nodes.filter((n: any) => n.number !== 43);
      return d;
    };
    const state = new Map<string, unknown>();
    const { svc } = make({ graphql, state });
    const f = (await svc.feature("001"))!;
    expect(searches).toEqual([{ q0: "repo:acme/sales is:pr is:merged head:feature/ABC-13" }]);
    expect(f.stories.find((x) => x.jiraKey === "ABC-13")!.prNumber).toBe(143);
    // A new window (or session) reuses the stored merged PR instead of searching again.
    const again = make({ graphql, state });
    expect((await again.svc.feature("001"))!.stories.find((x) => x.jiraKey === "ABC-13")!.prNumber).toBe(143);
    expect(searches).toHaveLength(1);
  });
  it("a forced refresh does not reuse a GitHub read that started before it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const graphql = async () => {
      calls++;
      const d = JSON.parse(JSON.stringify(resp.data));
      if (calls === 1) { await gate; return d; } // the poll's read, started before the gate action
      d.repository.open.nodes = d.repository.open.nodes.filter((n: any) => n.number !== 46); // state after the action
      return d;
    };
    const { svc } = make({ graphql });
    const before = svc.prs();
    const refreshed = svc.refresh();
    release();
    await Promise.all([before, refreshed]);
    expect(calls).toBe(2);
    expect((await svc.prs()).map((p) => p.number)).not.toContain(46);
  });
  it("refresh re-reads and fires", async () => {
    const { svc } = make();
    let fired = 0;
    svc.onDidChange(() => fired++);
    const n = graphqlCalls.length;
    await svc.refresh();
    expect(graphqlCalls.length).toBe(n + 1);
    expect(fired).toBe(1);
  });
});
