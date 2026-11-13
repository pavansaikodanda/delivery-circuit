// View models (sidebar tabs, story panel), webview message checks, and the preview fixtures: preview/fixtures/views.*.json
// are generated from these builders. Regenerate with DC_WRITE_FIXTURES=1 npx vitest run test/unit/views.test.ts
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { type ConnectionStatus, type Identity, type Role, type WorkSnapshot } from "../../src/core/contracts";
import { baseStatus } from "../../src/connections/catalog";
import { missingItems, nextSteps, sprintRows, storyDetail } from "../../src/project/work";
import { parseHomeMessage, parseStoryMessage } from "../../src/views/messages";
import { buildHome, buildStory, since } from "../../src/views/model";
import { ENVIRONMENTS, NOW, workData } from "./workFixture";

const PREVIEW = path.join(__dirname, "..", "..", "preview", "fixtures");
const id = (active: Role, roles: Role[] = ["developer", "lead"]): Identity => ({ login: "demo-user", roles, active, isAdmin: false, owner: "acme-org", repo: "acme-salesforce", orgOwned: true });
const c = (cid: ConnectionStatus["id"], p: Partial<ConnectionStatus>): ConnectionStatus => ({ ...baseStatus(cid), ...p });
const CONNS: ConnectionStatus[] = [
  c("github", { state: "connected", account: "demo-user", detail: "acme-org/acme-salesforce" }),
  c("claude", { state: "connected", account: "demo.user@example.com", detail: "Max plan" }),
  c("sf-dev", { state: "connected", account: "demo.user@example.com", detail: "alias dev · acme-demo.my.salesforce.com" }),
  c("sf-qa", { state: "disconnected", detail: "No org with alias \"qa\"." }),
  c("atlassian", { state: "connected", account: "claude.ai Atlassian", detail: "Jira + Confluence through Claude" }),
  c("lucid", { state: "disconnected", detail: "Sign in with /mcp in Claude" }),
  c("coderabbit", { state: "error", detail: "The app is suspended on this org." }),
  c("fireflies", { state: "unknown", detail: "Set up for Claude sessions; sign in with /mcp" }),
];
function snapshot(role: Role, login = "dev1"): WorkSnapshot {
  const d = workData();
  return { next: nextSteps(role, d, login), sprint: { name: d.sprint, stories: sprintRows(d) }, missing: missingItems(role, d, CONNS, ENVIRONMENTS, NOW), errors: [], updatedAt: "2026-11-13T11:58:00.000Z" };
}

describe("sidebar model", () => {
  it("header, tabs data and the missing count", () => {
    const s = buildHome(id("developer"), CONNS, snapshot("developer"));
    expect(s.mode).toBe("ready");
    expect(s.user).toEqual({ login: "demo-user", role: "developer", roleLabel: "Developer", roles: [{ id: "developer", label: "Developer" }, { id: "lead", label: "Lead" }] });
    expect(s.repo).toBe("acme-org/acme-salesforce");
    expect(s.work!.next.map((r) => r.button)).toEqual(["Fix", "Open", "Open", "Build"]);
    expect(s.work!.sprint.stories.map((x) => x.statusLabel)).toEqual(["QA", "In PR", "In PR", "Ready", "Design"]);
    expect(s.connections.map((x) => [x.id, x.button])).toEqual([["github", "Check"], ["claude", "Check"], ["sf-dev", "Check"], ["atlassian", "Check"], ["coderabbit", "Fix"]]);
    expect(s.missingCount).toBe(s.missing!.length);
    // the webview never sees what a row runs
    expect(JSON.stringify(s)).not.toMatch(/"run"|\/dev-fix|"kind":"skill"/);
  });
  it("QA sees the QA org; no role chip menu with one role; signed out and no remote", () => {
    const q = buildHome(id("tester", ["tester"]), CONNS, undefined);
    expect(q.connections.map((x) => x.id)).toEqual(["github", "claude", "sf-qa", "atlassian"]);
    expect(q.user!.roles).toHaveLength(1);
    expect(q.work).toBeUndefined();
    expect(q.missing).toBeUndefined();
    expect(buildHome(null, CONNS, undefined)).toEqual({ mode: "signin", connections: [], missingCount: 0 });
    expect(buildHome({ ...id("developer"), owner: "", repo: "" }, CONNS, undefined).mode).toBe("no-remote");
    expect(buildHome({ ...id("lead", []), notice: "You are not in a circuit team" }, CONNS, undefined).user!.roles.map((r) => r.label)).toEqual(["Architect", "Developer", "QA", "Lead"]);
  });
  it("no jargon: no gates, personas, tokens or secrets in the sidebar", () => {
    for (const r of ["architect", "developer", "tester", "lead"] as const) {
      const text = JSON.stringify(buildHome(id(r, ["architect", "developer", "tester", "lead"]), CONNS, snapshot(r)));
      expect(text).not.toMatch(/\bG[1-9]\b|gate|persona|token|webhook|runner/i);
    }
  });
});

describe("story panel model", () => {
  it("labels the PR state", () => {
    const d = workData();
    const s = buildStory(storyDetail(d.stories.find((x) => x.key === "ABC-12")!, d), NOW);
    expect(s.story!.statusLabel).toBe("In PR");
    expect(s.story!.pr).toMatchObject({ scanText: "failed", coderabbitText: "changes requested", approvalText: "waiting 3 d" });
    expect(buildStory(undefined)).toEqual({ error: "Story not found" });
    expect(since("2026-11-13T11:30:00Z", NOW)).toBe("under 1 h");
    expect(since("2026-11-13T02:00:00Z", NOW)).toBe("10 h");
  });
});

describe("webview messages", () => {
  it("accepts only known shapes", () => {
    expect(parseHomeMessage({ type: "run", id: "build:ABC-14" })).toEqual({ type: "run", id: "build:ABC-14" });
    expect(parseHomeMessage({ type: "run", id: "promote:sprint/2026-11" })).toEqual({ type: "run", id: "promote:sprint/2026-11" });
    expect(parseHomeMessage({ type: "run", id: "x; rm -rf /" })).toBeUndefined();
    expect(parseHomeMessage({ type: "switchRole", role: "lead" })).toEqual({ type: "switchRole", role: "lead" });
    expect(parseHomeMessage({ type: "switchRole", role: "admin" })).toBeUndefined();
    expect(parseHomeMessage({ type: "connect", id: "runner" })).toBeUndefined();
    expect(parseHomeMessage({ type: "openStory", key: "ABC-12" })).toEqual({ type: "openStory", key: "ABC-12" });
    expect(parseHomeMessage({ type: "openStory", key: "abc" })).toBeUndefined();
    expect(parseHomeMessage({ type: "action", action: {} })).toBeUndefined();
    expect(parseStoryMessage({ type: "openLink", target: "https://acme.atlassian.net/browse/ABC-12" })).toBeDefined();
    expect(parseStoryMessage({ type: "openLink", target: "file:///etc/passwd" })).toBeUndefined();
  });
});

describe("preview fixtures", () => {
  const d = workData();
  const fixtures: Record<string, unknown> = {
    "views.home.developer": buildHome(id("developer"), CONNS, snapshot("developer")),
    "views.home.architect": buildHome(id("architect", ["architect", "developer"]), CONNS, snapshot("architect")),
    "views.home.tester": buildHome(id("tester", ["tester"]), CONNS, snapshot("tester")),
    "views.home.lead": buildHome(id("lead", ["developer", "lead"]), CONNS, snapshot("lead")),
    "views.home.loading": buildHome(id("developer"), CONNS.map((x) => ({ ...x, state: "checking" as const, account: undefined, detail: undefined })), undefined),
    "views.home.nothing": buildHome(id("lead", ["lead"]), CONNS, { next: [], sprint: { stories: [] }, missing: [], errors: [], updatedAt: "2026-11-13T11:58:00.000Z" }),
    "views.home.signin": buildHome(null, [], undefined),
    "views.story.default": buildStory(storyDetail(d.stories.find((x) => x.key === "ABC-12")!, d), NOW),
    "views.story.merged": buildStory(storyDetail(d.stories.find((x) => x.key === "ABC-11")!, d, { inMain: false }), NOW),
  };
  it("match the builders (DC_WRITE_FIXTURES=1 regenerates them)", () => {
    for (const [name, data] of Object.entries(fixtures)) {
      const file = path.join(PREVIEW, `${name}.json`);
      const text = JSON.stringify(data, null, 2) + "\n";
      if (process.env.DC_WRITE_FIXTURES) { fs.mkdirSync(PREVIEW, { recursive: true }); fs.writeFileSync(file, text); }
      expect(fs.readFileSync(file, "utf8"), name).toBe(text);
    }
    expect(fs.readdirSync(PREVIEW).sort()).toEqual(Object.keys(fixtures).map((n) => `${n}.json`).sort());
  });
  it("hold placeholders only", () => {
    const text = fs.readdirSync(PREVIEW).map((f) => fs.readFileSync(path.join(PREVIEW, f), "utf8")).join("\n");
    for (const m of text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) expect(m).toBe("demo.user@example.com");
    for (const h of text.match(/https:\/\/[^/"\s]+/g) ?? []) expect(h).toMatch(/^https:\/\/(acme\.atlassian\.net|github\.com|lucid\.app)$/);
  });
});
