import { describe, expect, it } from "vitest";
import type { ActionRef, Identity, PrRef, QueueItem } from "../../src/core/contracts";
import * as M from "../../src/views/model";
import {
  ARCHITECT, CONNECTIONS, DEVELOPER, EXISTING_FILES, FEATURES, NOW, OWNER, PRS, QUEUE, REPO, SOURCES, TEAMS, TESTER, allowedFor, jiraUrl,
} from "../fixtures/views/sample";

const persona = (id: Identity, requested?: Identity["active"]) => M.buildPersona({
  identity: id, requested, queue: QUEUE, features: FEATURES, prs: PRS, allowed: allowedFor(id), jiraUrl, now: NOW,
});
const home = (id: Identity | null, over: Partial<M.HomeInput> = {}) => M.buildHome({
  hasRemote: true, identity: id, githubConnected: !!id, circuitInstalled: true, connections: CONNECTIONS,
  queue: id?.active ? QUEUE.filter((q) => q.persona === id.active) : [], allowed: allowedFor(id), teams: TEAMS, now: NOW, ...over,
});

describe("tab visibility", () => {
  it("architect sees three tabs, developer and tester one each", () => {
    expect(M.personaTabs(ARCHITECT).tabs.map((t) => t.id)).toEqual(["architect", "developer", "tester"]);
    expect(M.personaTabs(DEVELOPER).tabs.map((t) => t.id)).toEqual(["developer"]);
    expect(M.personaTabs(TESTER).tabs.map((t) => t.id)).toEqual(["tester"]);
    expect(M.personaTabs(null).tabs).toEqual([]);
  });
  it("a requested tab the identity can't view falls back to the active persona", () => {
    expect(M.personaTabs(DEVELOPER, "tester").selected).toBe("developer");
    expect(M.personaTabs(ARCHITECT, "tester").selected).toBe("tester");
    expect(M.personaTabs(ARCHITECT).selected).toBe("architect");
  });
  it("shows the view-only notice only where the identity can't act", () => {
    expect(M.viewOnlyNotice(ARCHITECT, "developer")).toBe("View only — you act as Architect");
    expect(M.viewOnlyNotice(ARCHITECT, "architect")).toBeUndefined();
    expect(M.viewOnlyNotice(DEVELOPER, "developer")).toBeUndefined();
    expect(M.viewOnlyNotice({ ...ARCHITECT, active: null }, "tester")).toMatch(/choose a persona/);
  });
  it("persona panel for the architect viewing the developer tab is view only with disabled actions", () => {
    const s = persona(ARCHITECT, "developer");
    expect(s.selected).toBe("developer");
    expect(s.canAct).toBe(false);
    expect(s.notice).toBe("View only — you act as Architect");
    expect(s.queue.map((q) => q.id)).toEqual(["d-g3-43", "d-g5-42", "d-human-44"]);
    expect(s.queue.flatMap((q) => q.actions).every((a) => !a.allowed && a.reason === "Only a Developer can run this")).toBe(true);
    expect(s.aiActions.map((a) => a.label)).toEqual(["Review stories", "Review plan", "Review PR", "Take over"]);
  });
});

describe("disabled-action reasons", () => {
  const a: ActionRef = { id: "ai:/dev-review-pr", label: "Review PR", persona: "developer", kind: "ai" };
  it("explains each case", () => {
    expect(M.disabledReason(null, a, false)).toBe("Sign in to GitHub first");
    expect(M.disabledReason(ARCHITECT, a, false)).toBe("Only a Developer can run this");
    expect(M.disabledReason({ ...DEVELOPER, personas: ["developer", "tester"], active: "tester" }, a, false)).toBe("Switch to Developer to run this");
    expect(M.disabledReason(DEVELOPER, a, false)).toBe("Not available right now");
    expect(M.disabledReason(DEVELOPER, { ...a, kind: "gate" }, false)).toBe("This gate is not ready yet");
    expect(M.disabledReason(DEVELOPER, a, true)).toBeUndefined();
  });
  it("treats a throwing allowed() as not allowed", () => {
    const v = M.toActionView(DEVELOPER, a, () => { throw new Error("boom"); });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("Not available right now");
  });
  it("never allows anything without an identity", () => {
    expect(M.toActionView(null, a, () => true).allowed).toBe(false);
  });
});

describe("gate highlighting", () => {
  const f = FEATURES[0];
  it("flags the persona's own gates", () => {
    const own = (p: Identity["active"]) => M.gateStrip(f, p).filter((g) => g.own).map((g) => g.id);
    expect(own("architect")).toEqual(["G1", "G7", "G8", "G9"]);
    expect(own("developer")).toEqual(["G3", "G5"]);
    expect(own("tester")).toEqual(["G2", "G4", "G6"]);
  });
  it("fills missing gates as not-started and finds the next gate", () => {
    const g = M.gateStrip(FEATURES[1], "architect");
    expect(g).toHaveLength(9);
    expect(g[1].state).toBe("not-started");
    expect(M.nextGate(FEATURES[0])?.id).toBe("G3");
    expect(M.nextGate(FEATURES[1])).toMatchObject({ id: "G1", ownerLabel: "Architect" });
  });
  it("stage strip covers intake..release", () => {
    expect(M.stageStrip(f).map((s) => s.id)).toEqual(["intake", "clarify", "plan", "signoff", "stories", "tests", "jira", "build", "qa", "release"]);
  });
  it("feature panel marks the viewer's gate rows", () => {
    const s = M.buildFeature({ feature: f, featureId: "001", identity: TESTER, sources: SOURCES, prs: PRS, owner: OWNER, repo: REPO,
      jiraUrl, existingFiles: EXISTING_FILES, allowed: allowedFor(TESTER), now: NOW });
    expect(s.gates.filter((g) => g.own).map((g) => g.id)).toEqual(["G2", "G4", "G6"]);
  });
});

describe("queue sorting", () => {
  const q = (id: string, since?: string, gate?: QueueItem["gate"]): QueueItem =>
    ({ id, persona: "developer", kind: "review-pr", title: id, since, gate, links: [], actions: [] });
  it("puts the oldest first, undated last, then gate order", () => {
    const sorted = M.sortQueue([q("new", "2026-11-10T00:00:00Z"), q("none"), q("old", "2026-11-01T00:00:00Z"),
      q("g5", "2026-11-05T00:00:00Z", "G5"), q("g3", "2026-11-05T00:00:00Z", "G3")]);
    expect(sorted.map((x) => x.id)).toEqual(["old", "g3", "g5", "new", "none"]);
  });
  it("limits the sidebar to 8 and counts the rest", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ ...QUEUE[3], id: `x${i}`, since: new Date(NOW - i * 3600_000).toISOString() }));
    const s = home(DEVELOPER, { queue: many });
    expect(s.waiting).toHaveLength(8);
    expect(s.waitingTotal).toBe(11);
    expect(s.waiting[0].id).toBe("x10");
  });
  it("labels age", () => {
    expect(M.ageLabel(undefined, NOW)).toBe("");
    expect(M.ageLabel(new Date(NOW - 30_000).toISOString(), NOW)).toBe("just now");
    expect(M.ageLabel(new Date(NOW - 20 * 60_000).toISOString(), NOW)).toBe("20 min");
    expect(M.ageLabel(new Date(NOW - 5 * 3600_000).toISOString(), NOW)).toBe("5 h");
    expect(M.ageLabel(new Date(NOW - 110 * 3600_000).toISOString(), NOW)).toBe("5 d");
  });
});

describe("empty and onboarding states", () => {
  it("no remote", () => { expect(home(null, { hasRemote: false }).mode).toBe("no-remote"); });
  it("not signed in", () => {
    const s = home(null, { githubConnected: false });
    expect(s.mode).toBe("signin");
    expect(s.waiting).toEqual([]);
  });
  it("signed in but identity still loading", () => { expect(home(null, { githubConnected: true }).mode).toBe("loading"); });
  it("no persona keeps Connections reachable", () => {
    const s = home({ ...DEVELOPER, personas: [], active: null });
    expect(s.mode).toBe("no-persona");
    expect(s.nav.map((n) => n.target)).toEqual(["connections"]);
  });
  it("repo not set up suggests Project setup", () => {
    expect(home(ARCHITECT, { circuitInstalled: false }).setupNeeded).toBe(true);
    expect(home(ARCHITECT).setupNeeded).toBe(false);
  });
  it("nothing waiting", () => {
    const s = home(TESTER, { queue: [] });
    expect(s.mode).toBe("ready");
    expect(s.waiting).toEqual([]);
  });
  it("persona panel without identity shows a notice", () => {
    const s = M.buildPersona({ identity: null, queue: [], features: [], prs: [], allowed: () => false, jiraUrl, now: NOW });
    expect(s.selected).toBeNull();
    expect(s.notice).toMatch(/Sign in/);
  });
  it("feature panel for a missing feature", () => {
    const s = M.buildFeature({ feature: undefined, featureId: "009", identity: ARCHITECT, sources: [], prs: [], owner: OWNER, repo: REPO,
      jiraUrl, existingFiles: [], allowed: () => true, now: NOW });
    expect(s.found).toBe(false);
  });
});

describe("navigation", () => {
  it("architect sees all views, testing, connections and setup", () => {
    expect(home(ARCHITECT).nav.map((n) => n.target)).toEqual(["persona:architect", "persona:developer", "persona:tester", "testing", "connections", "setup"]);
  });
  it("developer sees own view and connections only", () => {
    expect(home(DEVELOPER).nav.map((n) => n.target)).toEqual(["persona:developer", "connections"]);
  });
  it("tester sees own view, testing and connections", () => {
    expect(home(TESTER).nav.map((n) => n.target)).toEqual(["persona:tester", "testing", "connections"]);
  });
  it("counts connections needing attention for the person (review tools included)", () => {
    expect(M.connectionsAttention(CONNECTIONS, DEVELOPER)).toBe(1); // code-analyzer
    expect(M.connectionsAttention(CONNECTIONS, TESTER)).toBe(1); // sf-qa expiring
    expect(M.connectionsAttention(CONNECTIONS, ARCHITECT)).toBe(2); // atlassian + fireflies MCP
    expect(home(DEVELOPER).nav.find((n) => n.target === "connections")).toMatchObject({ count: 1, detail: "1 needs attention" });
  });
  it("validates nav targets", () => {
    expect(M.navAllowed(DEVELOPER, "persona:tester")).toBe(false);
    expect(M.navAllowed(DEVELOPER, "setup")).toBe(false);
    expect(M.navAllowed(DEVELOPER, "testing")).toBe(false);
    expect(M.navAllowed(ARCHITECT, "setup")).toBe(true);
    expect(M.navAllowed(null, "connections")).toBe(true);
    expect(M.navAllowed(ARCHITECT, "persona:admin")).toBe(false);
  });
  it("status bar text", () => {
    expect(M.statusText(ARCHITECT, 3).text).toContain("Circuit: Architect · 3 waiting");
    expect(M.statusText(null, 0).text).toContain("sign in");
    expect(M.statusText({ ...TESTER, active: null }, 0).text).toContain("no persona");
  });
});

describe("pull requests", () => {
  it("orders the review signal groups and keeps the latest per author", () => {
    const { groups, missing } = M.groupSignals(PRS[1].reviews);
    expect(groups.map((g) => g.label)).toEqual(["CodeRabbit", "AI Reviewer", "Code Analyzer", "SF AI Tester"]);
    expect(groups[0].signals).toHaveLength(1);
    expect(groups[0].signals[0].state).toBe("commented");
    expect(groups[0].signals[0].links[0].kind).toBe("coderabbit");
    expect(missing).toEqual([]);
    expect(M.groupSignals([]).missing).toEqual(["CodeRabbit", "AI Reviewer", "Code Analyzer", "SF AI Tester"]);
  });
  it("drops non-https signal links", () => {
    const { groups } = M.groupSignals([{ source: "human", author: "x", state: "approved", summary: "", url: "javascript:alert(1)", at: "2026-01-01" }]);
    expect(groups[0].signals[0].links).toEqual([]);
  });
  it("sorts check badges guard, static, qa, spec-gate, gate/*", () => {
    expect(M.checkBadges(PRS[1]).map((c) => c.name)).toEqual(["guard", "static", "qa", "spec-gate", "gate/architect", "gate/developer", "gate/tester"]);
    expect(M.checkBadges(PRS[3]).find((c) => c.name === "static")?.cls).toBe("err");
  });
  it("persona gates on a build PR", () => {
    expect(M.prGates(PRS[2], "developer").map((g) => `${g.id}:${g.state}`)).toEqual(["G3:waiting", "G5:not-started"]);
    expect(M.prGates(PRS[1], "tester").map((g) => `${g.id}:${g.state}`)).toEqual(["G4:done", "G6:waiting"]);
    expect(M.prGates(PRS[1], "architect").map((g) => `${g.id}:${g.state}`)).toEqual(["G7:waiting", "G8:not-started"]);
    expect(M.prGates(PRS[0], "architect").map((g) => `${g.id}:${g.state}`)).toEqual(["G1:done"]);
    expect(M.prGates(PRS[0], "developer")).toEqual([]);
  });
  it("relevant PRs per persona, waiting-on-you first", () => {
    const intake: PrRef = { ...PRS[0], number: 40, branch: "intake/acme-sla", updatedAt: "2026-11-11T14:00:00Z" };
    const all = [...PRS, intake];
    expect(M.prsForPersona(all, "architect").map((p) => p.number)).toContain(40);
    expect(M.prsForPersona(all, "developer").map((p) => p.number)).not.toContain(40);
    expect(M.prsForPersona(all, "developer")[0].number).toBe(44); // needs-human, newest
    expect(M.prsForPersona(all, "tester").map((p) => p.number)).toEqual([44, 42, 43, 41]);
  });
});

describe("AI actions and argument picking", () => {
  it("builds ActionRefs with command and argKind", () => {
    const a = M.aiActions("architect");
    expect(a.map((x) => x.id)).toEqual(["ai:/circuit-intake", "ai:/arch-design", "ai:/arch-jira-push", "ai:/arch-review-pr"]);
    expect(a[1].args).toEqual({ command: "/arch-design", argKind: "feature" });
    expect(M.aiActions("tester").map((x) => x.id)).toEqual(["ai:/qa-design-tests", "ai:/qa-push-tests", "ai:/qa-review-testplan", "ai:/qa-explore"]);
    expect(M.aiActions("developer", { feature: "001-case-escalation" })[0].args?.arg).toBe("001-case-escalation");
  });
  it("needsArg / withArg", () => {
    const a = M.aiActions("developer")[1];
    expect(M.needsArg(a)).toBe(true);
    expect(M.needsArg(M.withArg(a, 43))).toBe(false);
    expect(M.needsArg({ id: "gate:x", label: "x", persona: "developer", kind: "gate" })).toBe(false);
  });
  it("puts the best PRs first for each command", () => {
    const data = { features: FEATURES, prs: PRS, sources: SOURCES };
    const [plan, , , take] = M.aiActions("developer");
    void plan;
    expect(M.argPickItems(M.aiActions("developer")[1], data)[0].value).toBe(43); // draft without plan-approved
    expect(M.argPickItems(take, data)[0].value).toBe(44); // needs-human
    expect(M.argPickItems(M.aiActions("tester")[3], data)[0].value).toBe(44); // non-draft build PR, newest
    expect(M.argPickItems(M.aiActions("tester")[0], data).map((x) => x.value)).toEqual(["001-case-escalation", "002-entitlement-sla"]);
  });
  it("lists sources newest first without duplicates", () => {
    const items = M.argPickItems(M.aiActions("architect")[0], { features: [], prs: [], sources: [...SOURCES, SOURCES[0]] });
    expect(items.map((x) => x.value)).toEqual(["fireflies:01JDC4M9ZP", "upload:3f9a1c2b7d4e", "fireflies:01JD8Q2KX7"]);
  });
});

describe("feature panel", () => {
  const build = (id: Identity) => M.buildFeature({ feature: FEATURES[0], featureId: "001", identity: id, sources: SOURCES, prs: PRS,
    owner: OWNER, repo: REPO, jiraUrl, existingFiles: EXISTING_FILES, allowed: allowedFor(id), now: NOW });
  it("shows sources to the Architect only", () => {
    expect(build(ARCHITECT).sources?.map((s) => s.title)).toEqual(["Acme support: escalation workshop", "Tier 2 routing notes (Teams recording)"]);
    expect(build(ARCHITECT).sources?.[0].links[0].target).toBe("https://app.fireflies.ai/view/01JD8Q2KX7");
    expect(build(DEVELOPER).sources).toBeNull();
    expect(build(TESTER).sources).toBeNull();
  });
  it("counts test cases by level and links Jira and PRs", () => {
    const s = build(DEVELOPER).stories.find((x) => x.num === "03")!;
    expect(s.counts).toEqual({ ui: 1, unit: 2, manual: 1 });
    expect(s.links.map((l) => l.kind)).toEqual(["file", "jira", "github"]);
  });
  it("links existing spec files only", () => {
    expect(build(TESTER).files.map((f) => f.label)).toEqual(["spec.md", "plan.md", "data-model.md", "jira-map.json"]);
  });
  it("Spec Kit actions: only personas the viewer can see; enabled only for own persona", () => {
    const dev = build(DEVELOPER).actions;
    expect(dev.map((a) => a.id)).toEqual(["ai:/dev-review-stories"]);
    expect(dev[0].allowed).toBe(true);
    const arch = build(ARCHITECT).actions;
    expect(arch.map((a) => a.persona)).toEqual(["architect", "architect", "developer", "tester", "tester"]);
    expect(arch.filter((a) => a.allowed).map((a) => a.id)).toEqual(["ai:/arch-design", "ai:/arch-jira-push"]);
  });
});
