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
import type { AcliExec } from "../../src/project/acli";
import type { ClaudeExec } from "../../src/project/mcpReader";

const FIX = path.join(__dirname, "..", "fixtures", "project");
const raw = (p: string) => require("fs").readFileSync(path.join(FIX, p), "utf8") as string;
const resp = JSON.parse(raw("github-prs.json"));
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

/** Recorded acli outputs by command line. */
function fakeAcli(opts: { fail?: string } = {}): AcliExec & { calls: string[][] } {
  const calls: string[][] = [];
  const f = (async (args: string[]) => {
    calls.push(args);
    if (opts.fail) return { code: 1, stdout: "", stderr: opts.fail };
    const line = args.join(" ");
    if (line.includes("issuetype = Epic")) return { code: 0, stdout: raw("acli/epics.json"), stderr: "" };
    if (line.includes("parent in (")) return { code: 0, stdout: raw("acli/children.json"), stderr: "" };
    if (line.includes("test-case")) return { code: 0, stdout: raw("acli/tests.json"), stderr: "" };
    if (line.startsWith("jira workitem view ABC-99")) return { code: 0, stdout: raw("acli/view-ABC-99.json"), stderr: "" };
    if (line === "jira auth status") return { code: 0, stdout: "Site: acme.atlassian.net", stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected: ${line}` };
  }) as any;
  f.calls = calls;
  return f;
}

/** Recorded `claude -p` reader outputs by prompt. pending() resolves when every started read has answered. */
function fakeClaude(opts: { fireflies?: boolean } = {}): ClaudeExec & { calls: string[]; pending(): Promise<void> } {
  const calls: string[] = [];
  const inflight: Promise<unknown>[] = [];
  const f = ((args: string[], prompt: string) => {
    calls.push(prompt);
    const p = (async () => {
      await new Promise((r) => setTimeout(r, 1));
      const id = /Confluence design page id: (\d+)/.exec(prompt)?.[1];
      if (id) {
        try { return { code: 0, stdout: raw(`confluence/page-${id}.json`), stderr: "" }; } catch { return { code: 0, stdout: JSON.stringify({ type: "result", result: "{\"error\":\"not found\"}" }), stderr: "" }; }
      }
      if (prompt.includes("labelled circuit-design")) return { code: 0, stdout: raw("confluence/listing.json"), stderr: "" };
      if (prompt.includes("Fireflies")) {
        if (!opts.fireflies) return { code: 0, stdout: JSON.stringify({ type: "result", result: "{\"meetings\":[],\"error\":\"Fireflies MCP is not connected\"}" }), stderr: "" };
        if (prompt.includes("most recent")) return { code: 0, stdout: raw("confluence/fireflies-recent.json"), stderr: "" };
        return { code: 0, stdout: JSON.stringify({ type: "result", result: JSON.stringify({ meetings: [{ id: "01NEW1", title: "New call", date: "2026-11-11T09:00:00Z" }] }) }), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected prompt" };
    })();
    inflight.push(p);
    return p;
  }) as any;
  f.calls = calls;
  f.pending = async () => { let n = -1; while (n !== inflight.length) { n = inflight.length; await Promise.all(inflight); await new Promise((r) => setTimeout(r, 5)); } };
  return f;
}

function make(opts: { graphqlFails?: boolean; graphql?: (q: string, v: any) => Promise<any>; state?: Map<string, unknown>; acli?: ReturnType<typeof fakeAcli>; claude?: ReturnType<typeof fakeClaude> } = {}) {
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
  };
  const logs: string[] = [];
  const acli = opts.acli ?? fakeAcli();
  const claude = opts.claude ?? fakeClaude();
  const svc = createProject({ ctx, root, pluginRoot: "", log: (m) => logs.push(m) }, {
    identity: { get: () => identity, refresh: async () => identity, setActive: async () => {}, onDidChange: () => ({ dispose() {} }) } as any,
    connections, acli, claude,
  });
  return { svc, logs, acli, claude, state };
}

/** Reads start the design-page reads in the background; settled() waits until they are all in. */
async function settled(m: ReturnType<typeof make>) {
  // pass 1 lists the pages; pass 2 reads the page-only designs the listing found
  for (let i = 0; i < 2; i++) { await m.svc.features(); await m.claude.pending(); }
  return m.svc.features();
}

describe("createProject (v3: Jira via acli, Confluence via the read-only reader, GitHub)", () => {
  it("serves features from Jira epics and their design pages, with gates from one GraphQL query", async () => {
    const m = make();
    const first = await m.svc.features();
    expect(first[0].gates.G1).toBe("waiting"); // design page not read yet
    const features = await settled(m);
    expect(features.map((f) => f.id)).toEqual(["ABC-10", "ABC-20", "page-333333"]);
    expect(features[0].gates).toMatchObject({ G1: "done", G8: "waiting" });
    expect(graphqlCalls).toContainEqual({ owner: "acme", name: "sales" });
    expect((await m.svc.feature("ABC-10-case-escalation"))!.id).toBe("ABC-10");
    expect((await m.svc.feature("123456"))!.id).toBe("ABC-10");
    // acli calls are argument arrays with --json; no token anywhere
    expect(m.acli.calls.every((a) => Array.isArray(a) && a[0] === "jira")).toBe(true);
    expect(JSON.stringify(m.acli.calls)).not.toMatch(/token|password/i);
    // cached: no new GitHub, Jira or page reads within the TTLs
    const g = graphqlCalls.length, a = m.acli.calls.length, c = m.claude.calls.length;
    await m.svc.features();
    expect([graphqlCalls.length, m.acli.calls.length, m.claude.calls.length]).toEqual([g, a, c]);
  });
  it("keeps read design pages for the next window", async () => {
    const first = make();
    await settled(first);
    const again = make({ state: first.state });
    expect((await again.svc.features())[0].gates.G1).toBe("done");
  });
  it("lists only open PRs, linked to their stories", async () => {
    const { svc } = make();
    const prs = await svc.prs();
    expect(prs.map((p) => p.number)).toEqual([40, 42, 43, 44, 46]);
    expect(prs.find((p) => p.number === 43)!.featureId).toBe("ABC-10");
  });
  it("builds queues, including pending production approvals", async () => {
    const m = make();
    await settled(m);
    const arch = await m.svc.queue(identity, "architect");
    expect(arch.some((i) => i.kind === "deploy-approval" && i.actions[0].args!.runId === 5)).toBe(true);
    expect(arch.some((i) => i.kind === "sign-off" && i.actions[0].id === "arch:approve-design")).toBe(true);
    expect((await m.svc.queue(identity, "developer")).map((i) => i.kind)).toEqual(["approve-plan", "design-changed", "needs-human"]);
  });
  it("shows a connect item and keeps Jira data when GitHub fails", async () => {
    const m = make({ graphqlFails: true });
    await settled(m);
    const q = await m.svc.queue(identity, "architect");
    expect(q[0]).toMatchObject({ kind: "connect", detail: "Not signed in to GitHub" });
    expect(q.some((i) => i.kind === "sign-off")).toBe(true);
    expect(m.logs.filter((l) => l.includes("GitHub read failed"))).toHaveLength(1);
  });
  it("shows a Jira connect item when acli is not logged in", async () => {
    const { svc } = make({ acli: fakeAcli({ fail: "Error: unauthorized" }) });
    const q = await svc.queue(identity, "developer");
    expect(q.find((i) => i.id === "developer:connect:jira")).toMatchObject({ detail: "Atlassian CLI is not logged in. Run: acli jira auth login --web" });
    expect(await svc.features()).toEqual(expect.arrayContaining([]));
  });
  it("has no jira-map.json reader (keys come from Jira) and builds browse links from build.config.yml", async () => {
    const { svc } = make();
    expect((svc as any).jiraMap).toBeUndefined();
    await svc.features(); // loads build.config.yml (the Jira site)
    expect(svc.jiraBrowseUrl("ABC-1")).toBe("https://acme.atlassian.net/browse/ABC-1");
    expect(svc.jiraBrowseUrl("not a key")).toBeUndefined();
  });
  it("serves the Circuit MCP detail reads", async () => {
    const m = make();
    await settled(m);
    expect(await m.svc.design("ABC-10")).toMatchObject({ approvedVersion: 3, state: "approved" });
    expect(((await m.svc.decisions("ABC-10")) as any).decisions).toHaveLength(2);
    expect(((await m.svc.orgSnapshot("ABC-10")) as any).snapshot.objects).toEqual(["Case"]);
    expect(await m.svc.story("ABC-12")).toMatchObject({ key: "ABC-12", design: { c5: "ok" }, pr: { number: 42 } });
    expect(await m.svc.story("ABC-99")).toMatchObject({ key: "ABC-99", note: "Not a story under a feature epic." });
    await expect(m.svc.story("abc")).rejects.toThrow(/Not a Jira key/);
    await expect(m.svc.design("NOPE-1")).rejects.toThrow(/No feature/);
  });
  it("adds an encrypted upload, indexes metadata only and returns the text", async () => {
    const m = make();
    await settled(m);
    let fired = 0;
    m.svc.onDidChange(() => fired++);
    const src = path.join(storage, "call.vtt");
    await fsp.writeFile(src, "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Anna>Partners need a portal.\n");
    const ref = await m.svc.addUpload({ fsPath: src } as any, "Partner call");
    expect(ref).toMatchObject({ kind: "upload", title: "Partner call" });
    expect(ref.id).toMatch(/^upload:[0-9a-f]{12}$/);
    expect(fired).toBe(1);
    const index = await fsp.readFile(path.join(root, ".circuit", "sources.json"), "utf8");
    expect(index).toContain(ref.id);
    expect(index).not.toContain("portal");
    expect(secrets.get("deliveryCircuit.sourcesKey")).toBeDefined();
    expect(await m.svc.transcript(ref.id)).toBe("Anna: Partners need a portal.");
    const sources = await m.svc.sources();
    expect(sources.find((s) => s.id === "upload:3f9a0c1b2d4e")!.usedBy).toEqual(["ABC-10"]);
    await expect(m.svc.transcript("upload:000000000000")).rejects.toThrow(/not stored/);
    await expect(m.svc.transcript("nope")).rejects.toThrow(/Unknown source id/);
    expect(await m.svc.transcript("fireflies:01ABC")).toContain("fireflies_get_transcript");
  });
  it("Fireflies meetings come from the person's Fireflies MCP; none when it is not connected", async () => {
    const off = make();
    expect(await off.svc.firefliesRecent()).toEqual([]);
    expect(off.logs.some((l) => l.includes("Fireflies MCP is not connected"))).toBe(true);
    await expect(off.svc.indexFireflies("../x")).rejects.toThrow(/Invalid/);
    const on = make({ claude: fakeClaude({ fireflies: true }) });
    expect((await on.svc.firefliesRecent(5)).map((s) => s.id)).toEqual(["fireflies:01JD7K2M9Q"]);
    expect(await on.svc.indexFireflies("01NEW1")).toMatchObject({ id: "fireflies:01NEW1", title: "New call", origin: "fireflies" });
  });
  it("indexes a Fireflies meeting from the title and date the Sources page passes, with no second Fireflies read", async () => {
    const claude = fakeClaude({ fireflies: true });
    const m = make({ claude });
    const before = claude.calls.filter((c) => c.includes("Fireflies")).length;
    const ref = await m.svc.indexFireflies("01META1", { title: "Kick-off\nwith Acme Shipping", date: "2026-11-10T10:00:00Z" });
    expect(ref).toMatchObject({ id: "fireflies:01META1", kind: "fireflies", title: "Kick-off with Acme Shipping", date: "2026-11-10T10:00:00Z", origin: "fireflies" });
    expect(claude.calls.filter((c) => c.includes("Fireflies")).length).toBe(before);
  });
  it("adds pasted or dictated text encrypted with no temp file, keeping its origin in the index", async () => {
    const m = make();
    const ref = await m.svc.addText("  Ops lead: rates must show on the Order.  ", { title: "Dictated note", origin: "wispr-flow", date: "2026-11-09T08:00:00Z" });
    expect(ref).toMatchObject({ kind: "upload", title: "Dictated note", origin: "wispr-flow", date: "2026-11-09T08:00:00.000Z" });
    expect(ref.id).toMatch(/^upload:[0-9a-f]{12}$/);
    expect(await m.svc.transcript(ref.id)).toBe("Ops lead: rates must show on the Order.");
    const index = await fsp.readFile(path.join(root, ".circuit", "sources.json"), "utf8");
    expect(index).toContain('"origin": "wispr-flow"');
    expect(index).not.toContain("rates must show");
    const stored = await fsp.readdir(path.join(storage, "sources"));
    expect(stored).toContain(`${ref.id.slice("upload:".length)}.enc`);
    await expect(m.svc.addText("   ", { title: "x", origin: "paste" })).rejects.toThrow(/no text/);
    expect((await m.svc.addText("Another note", { title: "", origin: "bogus" as any })).origin).toBe("paste");
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
        const i = Object.values(v).indexOf("repo:acme/sales is:pr is:merged head:feature/ABC-13");
        return i < 0 ? {} : { [`s${i}`]: { nodes: [merged(143, "feature/ABC-13-escalation-queue"), merged(1300, "feature/ABC-130-other")] } };
      }
      const d = clone();
      d.repository.open.nodes = d.repository.open.nodes.filter((n: any) => n.number !== 43);
      return d;
    };
    const state = new Map<string, unknown>();
    const { svc } = make({ graphql, state });
    const f = (await svc.feature("ABC-10"))!;
    expect(searches).toHaveLength(1);
    expect(Object.values(searches[0])).toContain("repo:acme/sales is:pr is:merged head:feature/ABC-13");
    expect(f.stories.find((x) => x.jiraKey === "ABC-13")!.prNumber).toBe(143);
    // A new window (or session) reuses the stored merged PR instead of searching for it again.
    const again = make({ graphql, state });
    expect((await again.svc.feature("ABC-10"))!.stories.find((x) => x.jiraKey === "ABC-13")!.prNumber).toBe(143);
  });
  it("a forced refresh does not reuse a GitHub read that started before it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    let started!: () => void;
    const pollStarted = new Promise<void>((r) => (started = r));
    const graphql = async () => {
      calls++;
      if (calls === 1) started();
      const d = JSON.parse(JSON.stringify(resp.data));
      if (calls === 1) { await gate; return d; } // the poll's read, started before the gate action
      d.repository.open.nodes = d.repository.open.nodes.filter((n: any) => n.number !== 46); // state after the action
      return d;
    };
    const { svc } = make({ graphql });
    const before = svc.prs();
    await pollStarted; // the refresh is requested only once the poll's read is in flight
    const refreshed = svc.refresh();
    release();
    await Promise.all([before, refreshed]);
    expect((await svc.prs()).map((p) => p.number)).not.toContain(46);
  });
  it("refresh re-reads GitHub, Jira and the design pages, and fires", async () => {
    const m = make();
    await settled(m);
    let fired = 0;
    m.svc.onDidChange(() => fired++);
    const g = graphqlCalls.length, a = m.acli.calls.length, c = m.claude.calls.length;
    await m.svc.refresh();
    await m.claude.pending();
    expect(graphqlCalls.length).toBe(g + 1);
    expect(m.acli.calls.length).toBeGreaterThan(a);
    expect(m.claude.calls.length).toBeGreaterThan(c);
    expect(fired).toBeGreaterThanOrEqual(1);
  });
});
