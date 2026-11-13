// createProject wiring: Jira through acli (or the Atlassian MCP when acli is missing), the design-page listing in the
// background, one GitHub GraphQL query plus REST for deploys, environments (secret names only) and rulesets, and the
// encrypted transcript store.
import { promises as fsp } from "fs";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async (importOriginal) => {
  const orig: any = await importOriginal();
  const watcher = { onDidCreate: () => ({ dispose() {} }), onDidChange: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} };
  return { ...orig, workspace: { ...orig.workspace, createFileSystemWatcher: () => watcher, getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }) } };
});

import { baseStatus } from "../../src/connections/catalog";
import { createProject } from "../../src/project";
import type { AcliExec } from "../../src/project/acli";
import type { ClaudeExec } from "../../src/project/mcpReader";

const FIX = path.join(__dirname, "..", "fixtures", "project");
const raw = (p: string) => fs.readFileSync(path.join(FIX, p), "utf8");
let root: string, storage: string;
const subs: { dispose(): void }[] = [];
const secrets = new Map<string, string>();

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

function fakeAcli(opts: { missing?: boolean } = {}): AcliExec & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (args: string[]) => {
    const line = args.join(" ");
    calls.push(line);
    if (opts.missing) return { code: 1, stdout: "", stderr: "'acli' is not recognized as an internal or external command" };
    if (line.includes("issuetype = Epic")) return { code: 0, stdout: raw("acli/epics.json"), stderr: "" };
    if (line.includes("openSprints")) return { code: 1, stdout: "", stderr: "Error: the field 'sprint' does not exist" };
    if (line.includes("parent in (")) return { code: 0, stdout: raw("acli/children.json"), stderr: "" };
    if (line.includes("circuit-test")) return { code: 0, stdout: raw("acli/tests.json"), stderr: "" };
    if (line === "jira auth status") return { code: 0, stdout: "Site: acme.atlassian.net", stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected: ${line}` };
  }) as any;
  f.calls = calls;
  return f;
}

function fakeClaude(): ClaudeExec & { prompts: string[]; pending(): Promise<void> } {
  const prompts: string[] = [];
  const inflight: Promise<unknown>[] = [];
  const f = ((_args: string[], prompt: string) => {
    prompts.push(prompt);
    const p = (async () => {
      await new Promise((r) => setTimeout(r, 1));
      if (prompt.includes("circuit-design")) return { code: 0, stdout: raw("confluence/listing.json"), stderr: "" };
      if (prompt.includes("searchJiraIssuesUsingJql")) {
        const json = prompt.includes("issuetype = Epic") ? raw("acli/epics.json") : prompt.includes("parent in") ? raw("acli/children.json") : prompt.includes("circuit-test") ? raw("acli/tests.json") : "[]";
        const parsed = JSON.parse(json);
        return { code: 0, stdout: JSON.stringify({ type: "result", result: JSON.stringify(Array.isArray(parsed) ? { issues: parsed } : parsed) }), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected prompt" };
    })();
    inflight.push(p);
    return p;
  }) as any;
  f.prompts = prompts;
  f.pending = async () => { let n = -1; while (n !== inflight.length) { n = inflight.length; await Promise.all(inflight); await new Promise((r) => setTimeout(r, 5)); } };
  return f;
}

function make(opts: { acli?: ReturnType<typeof fakeAcli>; graphqlFails?: boolean } = {}) {
  const requests: string[] = [];
  const ctx: any = {
    subscriptions: subs, workspaceState: { get: () => undefined, update: async () => {} },
    globalStorageUri: { fsPath: storage },
    secrets: { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => { secrets.set(k, v); } },
  };
  const connections: any = {
    onDidChange: () => ({ dispose() {} }),
    githubGraphql: async () => { if (opts.graphqlFails) throw new Error("Not signed in to GitHub."); return JSON.parse(raw("github-work.json")).data; },
    githubRequest: async (_m: string, p: string) => {
      requests.push(p);
      if (p.includes("/actions/workflows/deploy.yml/runs")) return JSON.parse(raw("deploy-runs.json"));
      if (p.includes("/compare/dev...")) return { ahead_by: 3 };
      if (p.includes("/compare/main...")) return { status: "ahead" };
      if (/\/environments\?/.test(p)) return { environments: [{ name: "qa" }, { name: "dev" }, { name: "sit" }, { name: "production" }] };
      if (p.includes("/environments/sit/secrets")) return { secrets: [] };
      if (p.includes("/environments/production/secrets")) throw Object.assign(new Error("403"), { status: 403 });
      if (p.includes("/secrets")) return { secrets: [{ name: "SFDX_AUTH_URL" }] };
      if (/\/rulesets\?/.test(p)) return [{ id: 1 }];
      if (p.includes("/rulesets/1")) return { enforcement: "active", conditions: { ref_name: { include: ["refs/heads/sprint/*", "refs/heads/dev", "refs/heads/sit", "refs/heads/uat", "refs/heads/main"], exclude: [] } } };
      throw new Error(`unexpected ${p}`);
    },
  };
  const acli = opts.acli ?? fakeAcli();
  const claude = fakeClaude();
  const svc = createProject({ ctx, root, log: () => {} }, { connections, repo: () => ({ owner: "acme-org", repo: "acme-salesforce" }), acli, claude });
  return { svc, acli, claude, requests };
}

/** First call starts the background reads (design pages, repo setup); the second sees them. */
async function settled(m: ReturnType<typeof make>, role: Parameters<ReturnType<typeof make>["svc"]["work"]>[0] = "developer") {
  await m.svc.work(role, "dev1", []);
  await m.claude.pending();
  await new Promise((r) => setTimeout(r, 20));
  return m.svc.work(role, "dev1", []);
}

describe("createProject", () => {
  it("serves the Work and Missing tabs from Jira (acli), the design listing and GitHub", async () => {
    const m = make();
    const w = await settled(m);
    expect(w.errors).toEqual([]);
    expect(w.sprint.name).toBe("sprint/2026-11");
    // no open sprint in Jira: the stories of the open epics
    expect(w.sprint.stories.map((s) => [s.key, s.status])).toEqual([["ABC-11", "qa"], ["ABC-21", "design"], ["ABC-12", "in-pr"], ["ABC-13", "in-pr"], ["ABC-14", "ready"], ["ABC-15", "design"]]);
    expect(w.next.map((r) => r.id)).toEqual(["fix:41", "review:43", "review:44", "build:ABC-14"]);
    const repo = w.missing.filter((x) => x.group === "repo").map((x) => x.id);
    expect(repo).toEqual(["repo:bootstrap", "repo:branch:uat", "repo:secret:sit", "repo:env:uat", "repo:automerge"]);
    // secret values are never requested: only the list endpoints (names)
    expect(m.requests.filter((p) => p.includes("secrets")).every((p) => /\/environments\/[a-z]+\/secrets\?per_page=100$/.test(p))).toBe(true);
    const a = await m.svc.work("architect", "arch1", []);
    expect(a.next.map((r) => r.title)).toEqual(["New design from transcript", "Finish design Partner onboarding", "Create stories for Returns portal"]);
    const lead = await m.svc.work("lead", "lead1", [{ ...baseStatus("github"), state: "disconnected" }]);
    expect(lead.next.map((r) => r.id)).toEqual(["prod:901", "promote:sprint/2026-11", "promote:dev"]);
    expect(lead.missing[0]).toMatchObject({ id: "conn:github", button: "Connect" });
  });
  it("story panel: release is checked against main", async () => {
    const m = make();
    await settled(m);
    const s = (await m.svc.story("ABC-11"))!;
    expect(s.steps.find((x) => x.id === "release")!.state).toBe("todo");
    expect(s.links.map((l) => l.label)).toEqual(["Jira", "Design page", "Diagram", "PR #42"]);
    expect(m.requests).toContain("/repos/acme-org/acme-salesforce/compare/main...b0b0b0b0");
    expect(await m.svc.story("not a key")).toBeUndefined();
  });
  it("reads Jira through the Atlassian MCP when acli is not installed", async () => {
    const m = make({ acli: fakeAcli({ missing: true }) });
    const w = await settled(m);
    expect(w.errors).toEqual([]);
    expect(w.sprint.stories.map((s) => s.key)).toContain("ABC-14");
    expect(m.claude.prompts.some((p) => p.includes("searchJiraIssuesUsingJql"))).toBe(true);
  });
  it("keeps Jira data and reports GitHub when it fails", async () => {
    const w = await make({ graphqlFails: true }).svc.work("developer", "dev1", []);
    expect(w.errors).toEqual(["GitHub: Not signed in to GitHub."]);
    expect(w.sprint.stories.length).toBeGreaterThan(0);
    expect(w.missing.some((x) => x.group === "repo")).toBe(false);
  });
  it("stores pasted text and files encrypted outside the repo and serves them back", async () => {
    const { svc } = make();
    const ref = await svc.addText("Client: we need Case escalation.", { title: "Kickoff\ncall", origin: "paste" });
    expect(ref).toMatchObject({ id: expect.stringMatching(/^upload:[0-9a-f]{12}$/), kind: "upload", title: "Kickoff call", origin: "paste" });
    expect(await svc.transcript(ref.id)).toBe("Client: we need Case escalation.");
    const file = path.join(storage, "call.vtt");
    await fsp.writeFile(file, "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Anna>Escalate it.</v>\n");
    const f = await svc.addFile(file);
    expect(f).toMatchObject({ title: "call", origin: "file" });
    expect(await svc.transcript(f.id)).toBe("Anna: Escalate it.");
    // nothing was written into the repository
    expect(fs.readdirSync(root).sort()).toEqual(["build.config.yml"]);
    await expect(svc.addText("  ", { title: "x", origin: "paste" })).rejects.toThrow(/no text/);
    expect(await svc.transcript("fireflies:01ABC")).toContain("fireflies_get_transcript");
  });
});
