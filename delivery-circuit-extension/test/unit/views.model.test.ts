import { describe, expect, it } from "vitest";
import type { ActionRef, Identity, PrRef, QueueItem } from "../../src/core/contracts";
import * as M from "../../src/views/model";
import {
  ARCHITECT, CONNECTIONS, DEVELOPER, FEATURES, NOW, OWNER, PRS, QUEUE, REPO, SOURCES, TEAMS, TESTER, allowedFor, jiraUrl,
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
    expect(s.queue.map((q) => q.id)).toEqual(["d-start-ACME-15", "d-g3-43", "d-g5-42", "d-human-44", "d-fix-45"]);
    expect(s.queue.flatMap((q) => q.actions).every((a) => !a.allowed && a.reason === "Only a Developer can run this")).toBe(true);
    expect(s.aiActions.map((a) => a.label)).toEqual(["Review stories", "Start story", "Review plan", "Review PR", "Fix with AI",
      "Open review room", "Record verdict", "Take over", "Record decision"]);
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
      jiraUrl, allowed: allowedFor(TESTER), now: NOW });
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
      jiraUrl, allowed: () => true, now: NOW });
    expect(s.found).toBe(false);
  });
});

describe("navigation", () => {
  it("architect sees all views, testing, connections and setup", () => {
    expect(home(ARCHITECT).nav.map((n) => n.target)).toEqual(["persona:architect", "persona:developer", "persona:tester", "testing", "sources", "connections", "setup"]);
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
    // Sources: the Architect's intake inputs only
    expect(M.navAllowed(ARCHITECT, "sources")).toBe(true);
    expect(M.navAllowed(DEVELOPER, "sources")).toBe(false);
    expect(M.navAllowed(TESTER, "sources")).toBe(false);
    expect(M.navItems(ARCHITECT, 0).map((n) => n.target)).toContain("sources");
    expect(M.navItems(DEVELOPER, 0).map((n) => n.target)).not.toContain("sources");
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
  it("sorts check badges guard, static, design-gate, qa, gate/*", () => {
    expect(M.checkBadges(PRS[1]).map((c) => c.name)).toEqual(["guard", "static", "design-gate", "qa", "gate/architect", "gate/developer", "gate/tester"]);
    expect(M.checkBadges(PRS[3]).find((c) => c.name === "static")?.cls).toBe("err");
  });
  it("persona gates on a build PR", () => {
    expect(M.prGates(PRS[2], "developer").map((g) => `${g.id}:${g.state}`)).toEqual(["G3:waiting", "G5:not-started"]);
    expect(M.prGates(PRS[1], "tester").map((g) => `${g.id}:${g.state}`)).toEqual(["G4:done", "G6:waiting"]);
    expect(M.prGates(PRS[1], "architect").map((g) => `${g.id}:${g.state}`)).toEqual(["G7:waiting", "G8:not-started"]);
    expect(M.prGates(PRS[0], "architect").map((g) => `${g.id}:${g.state}`)).toEqual(["G7:done", "G8:done"]); // merged
    // a v2 spec/ PR (no longer created in v3) still shows G1 from spec-gate to the Architect only
    const spec: PrRef = { ...PRS[0], branch: "spec/001-x", state: "open", checks: { "spec-gate": "success" } };
    expect(M.prGates(spec, "architect").map((g) => `${g.id}:${g.state}`)).toEqual(["G1:done"]);
    expect(M.prGates(spec, "developer")).toEqual([]);
  });
  it("relevant PRs per persona, waiting-on-you first", () => {
    const intake: PrRef = { ...PRS[0], number: 40, branch: "intake/acme-sla", updatedAt: "2026-11-11T14:00:00Z" };
    const all = [...PRS, intake];
    expect(M.prsForPersona(all, "architect").map((p) => p.number)).toContain(40);
    expect(M.prsForPersona(all, "developer").map((p) => p.number)).not.toContain(40);
    expect(M.prsForPersona(all, "developer").slice(0, 2).map((p) => p.number)).toEqual([45, 44]); // failing checks, needs-human
    // #44 is needs-human: the Tester queue does not ask for G6 there, so it is not "waiting on you" for the Tester.
    expect(M.prsForPersona(all, "tester").map((p) => p.number)).toEqual([45, 42, 43, 44, 41]);
  });
  it("PR gates and needs-you follow the queue rules", () => {
    // Non-draft, human-authored story PR without ai-generated / plan-approved labels.
    const human: PrRef = { ...PRS[1], number: 50, author: "sam-dev", labels: [], checks: { guard: "success", "gate/developer": "missing", "gate/tester": "missing", "gate/architect": "missing" } };
    const states = (pr: PrRef, p: "developer" | "tester" | "architect") => M.prGates(pr, p).map((g) => `${g.id}:${g.state}`);
    expect(states(human, "developer")).toEqual(["G5:waiting"]);
    expect(states(human, "tester")).toEqual(["G6:waiting"]);
    expect(M.prNeedsPersona(human, "developer", "ravi-dev")).toBe(true);
    expect(M.prNeedsPersona(human, "developer", "sam-dev")).toBe(false); // own PR: not offered for own review
    expect(M.prNeedsPersona(human, "tester", "tess-qa")).toBe(true);
    // G5 follows gate/developer whatever the labels say.
    expect(states({ ...human, checks: { ...human.checks, "gate/developer": "success" } }, "developer")).toEqual(["G5:done"]);
    // needs-human: the Architect queue leaves it out, so neither G7 nor G6 needs you.
    const stuck: PrRef = { ...human, labels: ["needs-human"] };
    expect(M.prNeedsPersona(stuck, "architect")).toBe(false);
    expect(M.prNeedsPersona(stuck, "tester", "tess-qa")).toBe(false);
    expect(M.prNeedsPersona(stuck, "developer", "ravi-dev")).toBe(true);
    // Draft AI PR: G3 / G4 wait, and nobody is asked for G5-G7 yet.
    expect(M.prNeedsPersona(PRS[2], "developer", "ravi-dev")).toBe(true);
    expect(M.prNeedsPersona(PRS[2], "architect")).toBe(false);
    // Merge (G8) only when every gate and check is green.
    const green: PrRef = { ...human, checks: { guard: "success", "gate/developer": "success", "gate/tester": "success", "gate/architect": "success" } };
    expect(states(green, "architect")).toEqual(["G7:done", "G8:waiting"]);
    expect(M.prNeedsPersona({ ...green, checks: { ...green.checks, static: "failure" } }, "architect")).toBe(false);
  });
});

describe("AI actions and argument picking", () => {
  it("builds ActionRefs with command and argKind", () => {
    const a = M.aiActions("architect");
    expect(a.map((x) => x.id)).toEqual(["ai:/circuit-intake", "ai:/arch-design", "ai:/arch-jira-push", "ai:/arch-review-pr", "decision:record"]);
    expect(a[1].args).toEqual({ command: "/arch-design", argKind: "feature" });
    expect(M.aiActions("tester").map((x) => x.id)).toEqual(["ai:/qa-design-tests", "ai:/qa-push-tests", "qa:add-tests", "ai:/qa-review-testplan", "ai:/qa-explore", "decision:record"]);
    expect(M.aiActions("developer").map((x) => x.id)).toEqual(["ai:/dev-review-stories", "dev:start-story", "ai:/dev-review-plan", "ai:/dev-review-pr",
      "dev:fix", "review:open-room", "review:record-verdict", "ai:/dev-review-pr", "decision:record"]);
    expect(M.aiActions("developer", { feature: "ACME-10" })[0].args?.arg).toBe("ACME-10");
    expect(M.aiActions("developer", { story: "ACME-15" })[1].args).toEqual({ command: "/dev-start-story", argKind: "story", arg: "ACME-15" });
  });
  it("needsArg / withArg", () => {
    const a = M.aiActions("developer")[1];
    expect(M.needsArg(a)).toBe(true);
    expect(M.needsArg(M.withArg(a, 43))).toBe(false);
    expect(M.needsArg({ id: "gate:x", label: "x", persona: "developer", kind: "gate" })).toBe(false);
  });
  it("puts the best PRs first for each command", () => {
    const data = { features: FEATURES, prs: PRS, sources: SOURCES };
    const dev = (label: string) => M.aiActions("developer").find((a) => a.label === label)!;
    const qa = (label: string) => M.aiActions("tester").find((a) => a.label === label)!;
    expect(M.argPickItems(dev("Review plan"), data)[0].value).toBe(43); // draft without plan-approved
    expect(M.argPickItems(dev("Take over"), data)[0].value).toBe(44); // needs-human
    expect(M.argPickItems(dev("Fix with AI"), data)[0].value).toBe(45); // failing checks, attempts left
    expect(M.argPickItems(dev("Open review room"), data)[0].value).toBe(42); // green, room not open yet
    expect(M.argPickItems(dev("Start story"), data)[0].value).toBe("ACME-15"); // ai-ready, no PR, design approved
    expect(M.argPickItems(qa("Add tests"), data)[0].value).toBe("ACME-13"); // PR without tests yet
    expect(M.argPickItems(qa("Explore on QA"), data)[0].value).toBe(45); // non-draft build PR, newest
    expect(M.argPickItems(qa("Design tests"), data).map((x) => x.value)).toEqual(["ACME-10", "ACME-20", "ACME-30"]);
  });
  it("lists sources newest first without duplicates", () => {
    const items = M.argPickItems(M.aiActions("architect")[0], { features: [], prs: [], sources: [...SOURCES, SOURCES[0]] });
    expect(items.map((x) => x.value)).toEqual(["fireflies:01JDC4M9ZP", "upload:3f9a1c2b7d4e", "fireflies:01JD8Q2KX7"]);
  });
});

describe("feature panel", () => {
  const build = (id: Identity) => M.buildFeature({ feature: FEATURES[0], featureId: "001", identity: id, sources: SOURCES, prs: PRS,
    owner: OWNER, repo: REPO, jiraUrl, allowed: allowedFor(id), now: NOW });
  it("shows sources to the Architect only", () => {
    expect(build(ARCHITECT).sources?.map((s) => s.title)).toEqual(["Acme Shipping support: escalation workshop", "Tier 2 routing notes (call recording transcript)"]);
    expect(build(ARCHITECT).sources?.[0].links[0].target).toBe("https://app.fireflies.ai/view/01JD8Q2KX7");
    expect(build(DEVELOPER).sources).toBeNull();
    expect(build(TESTER).sources).toBeNull();
  });
  it("counts test cases by level and links Jira and PRs", () => {
    const s = build(DEVELOPER).stories.find((x) => x.num === "03")!;
    expect(s.counts).toEqual({ ui: 1, unit: 2, manual: 1 });
    expect(s.links.map((l) => l.kind)).toEqual(["jira", "github"]); // no spec-file links in v3
  });
  it("feature links never point at spec files", () => {
    const withFile = { ...FEATURES[0], links: [...FEATURES[0].links, { kind: "file" as const, label: "spec.md", target: ".specify/specs/001/spec.md" }] };
    const s = M.buildFeature({ feature: withFile, featureId: "ACME-10", identity: TESTER, sources: SOURCES, prs: PRS, owner: OWNER, repo: REPO,
      jiraUrl, allowed: allowedFor(TESTER), now: NOW });
    expect(s.feature!.links.map((l) => l.kind)).toEqual(["jira", "confluence", "confluence", "lucid"]);
  });
  it("Spec Kit actions: only personas the viewer can see; enabled only for own persona", () => {
    const dev = build(DEVELOPER).actions;
    expect(dev.map((a) => a.id)).toEqual(["ai:/dev-review-stories", "decision:record"]);
    expect(dev.every((a) => a.allowed && a.persona === "developer")).toBe(true);
    const arch = build(ARCHITECT).actions;
    expect(arch.map((a) => a.persona)).toEqual(["architect", "architect", "architect", "architect", "developer", "tester", "tester"]);
    // design approved: Design leads, Approve design follows it
    expect(arch.filter((a) => a.allowed).map((a) => a.id)).toEqual(["ai:/arch-design", "arch:approve-design", "ai:/arch-jira-push", "decision:record"]);
    expect(build(ARCHITECT).designActions.map((a) => a.id)).toEqual(["ai:/arch-design", "arch:approve-design", "decision:record"]);
  });
});

describe("connect notices are not waiting work", () => {
  it("keeps kind connect out of the waiting list and count, with its link and action intact", () => {
    const notice: QueueItem = { id: "developer:connect:github", persona: "developer", kind: "connect", title: "Connect GitHub to see pull requests and gates",
      detail: "Bad credentials", links: [{ kind: "github", label: "acme/crm", target: "https://github.com/acme/crm/pulls" }],
      actions: [{ id: "nav:connections", label: "Open Connections", persona: "developer", kind: "nav" }] };
    const s = M.buildHome({ hasRemote: true, identity: DEVELOPER, githubConnected: true, circuitInstalled: true, connections: CONNECTIONS,
      queue: [notice], allowed: allowedFor(DEVELOPER), teams: TEAMS, now: NOW });
    expect(s.waitingTotal).toBe(0);
    expect(s.waiting).toEqual([]);
    expect(s.notices.map((n) => [n.kind, n.links.length, n.actions[0].id, n.actions[0].allowed])).toEqual([["connect", 1, "nav:connections", true]]);
    expect(M.statusText(DEVELOPER, s.waitingTotal).text).toContain("0 waiting");
  });
});

describe("design v2 view-model additions", () => {
  const pr = (n: number) => PRS.find((p) => p.number === n)!;
  const cmds = (as: ActionRef[]) => as.map((a) => `${a.args?.command}${a.args?.intent ? "#" + a.args.intent : ""}:${a.args?.arg}`);

  it("PR actions: the persona's most relevant AI action first, PR number preset", () => {
    expect(cmds(M.prActions(pr(44), "developer"))).toEqual(["/dev-review-pr#takeover:44", "/dev-review-pr:44"]);
    expect(cmds(M.prActions(pr(43), "developer"))).toEqual(["/dev-review-plan:43"]);
    expect(cmds(M.prActions(pr(42), "developer"))).toEqual(["/dev-review-pr:42", "/review-room:42"]);
    expect(M.prActions(pr(42), "developer")[1].id).toBe("review:open-room");
    expect(M.prActions({ ...pr(42), labels: [...pr(42).labels, "review-room"] }, "developer").map((a) => a.id)).toEqual(["ai:/dev-review-pr", "review:record-verdict"]);
    expect(M.prActions({ ...pr(42), labels: [...pr(42).labels, "review-room", "review-verdict"] }, "developer").map((a) => a.id)).toEqual(["ai:/dev-review-pr"]);
    const fix = M.prActions(pr(45), "developer")[0];
    expect([fix.id, fix.args?.arg, fix.args?.attempt, fix.args?.checks]).toEqual(["dev:fix", 45, 2, "static"]);
    expect(M.prActions({ ...pr(45), aiAttempt: 3 }, "developer").map((a) => a.id)).not.toContain("dev:fix");
    expect(cmds(M.prActions(pr(43), "tester"))).toEqual(["/qa-add-tests:ACME-13", "/qa-review-testplan:43"]);
    expect(M.prActions({ ...pr(43), files: ["tests/ACME-13.tc.json", "test-cases/ACME-13.sf-tests.yaml"] } as PrRef, "tester").map((a) => a.id)).toEqual(["ai:/qa-review-testplan"]);
    expect(cmds(M.prActions(pr(42), "tester"))).toEqual(["/qa-explore:42"]);
    expect(cmds(M.prActions(pr(41), "tester"))).toEqual([]);
    expect(cmds(M.prActions(pr(43), "architect"))).toEqual([]);
    expect(cmds(M.prActions(pr(42), "architect"))).toEqual(["/arch-review-pr:42"]);
  });

  it("persona state carries the identity's personas, the repo and per-PR actions; view-only actions explain why", () => {
    const dev = persona(DEVELOPER);
    expect(dev.personas).toEqual(["developer"]);
    expect(dev.repo).toBe(`${OWNER}/${REPO}`);
    expect(dev.prs.find((p) => p.number === 44)!.actions.map((a) => [a.label, a.allowed])).toEqual([["Take over", true], ["Review PR", true]]);
    const arch = persona(ARCHITECT, "developer");
    expect(arch.canAct).toBe(false);
    const a = arch.prs.find((p) => p.number === 44)!.actions[0];
    expect(a.allowed).toBe(false);
    expect(a.reason).toBe("Only a Developer can run this");
    expect(persona(ARCHITECT, "architect").prs.every((p) => p.actions.every((x) => x.persona === "architect" && x.allowed))).toBe(true);
  });

  it("gate rows: waitsOnViewer only for the viewer's open gates; actions follow the owner", () => {
    const build = (id: Identity, f = FEATURES[0]) => M.buildFeature({ feature: f, featureId: f.id, identity: id, sources: SOURCES, prs: PRS,
      owner: OWNER, repo: REPO, jiraUrl, allowed: allowedFor(id), now: NOW });
    const dev = build(DEVELOPER);
    expect(dev.gates.filter((g) => g.waitsOnViewer).map((g) => g.id)).toEqual(["G3", "G5"]);
    // G3 is moved on the draft PR (/dev-review-plan), not by a feature-level command.
    expect(dev.gates.find((g) => g.id === "G3")!.actions).toEqual([]);
    // a Developer never sees the Architect's or Tester's Spec Kit actions
    expect(dev.gates.flatMap((g) => g.actions).every((a) => a.persona === "developer")).toBe(true);
    const arch = build(ARCHITECT);
    const g2 = arch.gates.find((g) => g.id === "G2")!;
    expect(g2.waitsOnViewer).toBe(false);
    expect(g2.actions.map((a) => [a.id, a.allowed, a.reason])).toEqual([
      ["ai:/qa-design-tests", false, "Only a Tester can run this"], ["ai:/qa-push-tests", false, "Only a Tester can run this"]]);
    // G1 waits on the Architect while it is the next open gate, even before anyone marks it waiting
    const early = build(ARCHITECT, { ...FEATURES[1], gates: {} });
    expect(early.gates.filter((g) => g.waitsOnViewer).map((g) => g.id)).toEqual(["G1"]);
    expect(arch.personas).toEqual(["architect"]);
    expect(arch.login).toBe("maya-arch");
  });

  it("story PR state comes from the PR list", () => {
    expect(M.storyPrState(undefined)).toBeUndefined();
    expect(M.storyPrState({ ...pr(43) })).toBe("draft");
    expect(M.storyPrState({ ...pr(42) })).toBe("open");
    expect(M.storyPrState({ ...pr(42), state: "merged" })).toBe("merged");
    const s = M.buildFeature({ feature: FEATURES[0], featureId: "001", identity: DEVELOPER, sources: [], prs: PRS, owner: OWNER, repo: REPO,
      jiraUrl, allowed: allowedFor(DEVELOPER), now: NOW });
    expect(s.stories.map((x) => x.prState)).toEqual(["merged", "open", "draft", "open", undefined, undefined, "open"]);
  });

  it("gateOfCommand maps feature commands to their gate", () => {
    expect(M.gateOfCommand("/arch-design")).toBe("G1");
    expect(M.gateOfCommand("/qa-push-tests")).toBe("G2");
    expect(M.gateOfCommand("/dev-review-stories")).toBeUndefined();
    expect(M.gateOfCommand("/arch-review-pr")).toBeUndefined();
  });
});

describe("v3 design page and stories (project module shapes)", () => {
  const feat = (design: M.DesignInfo | undefined, stories: M.StoryV3[] = []): M.FeatureV3 =>
    ({ ...FEATURES[0], epicKey: "ACME-50", id: "ACME-50", design, stories, links: [] });
  const st = (over: Partial<M.StoryV3>): M.StoryV3 => ({ num: "01", title: "S", jiraKey: "ACME-51", testCases: [], labels: [], designSync: "unknown", blockedBy: [], ...over });

  it("reads G1 from the project's approval: approved, changed, unverified, draft, unknown, missing", () => {
    const page = { pageId: "9", url: "https://acme.atlassian.net/wiki/x", status: "Approved", version: 5 };
    expect(M.designView(feat({ ...page, approval: { state: "approved", approvedVersion: 5, approverIsArchitect: true } }))).toMatchObject({ state: "approved", text: "Approved v5" });
    expect(M.designView(feat({ ...page, version: 7, approval: { state: "changed", approvedVersion: 5, changedSinceApproval: true } }))).toMatchObject({ state: "changed", text: "Changed since approved v5 (now v7)" });
    expect(M.designView(feat({ ...page, approval: { state: "unverified-approver", approvedVersion: 5, approvedBy: "dev@example.com", approverIsArchitect: false } })).state).toBe("unverified");
    expect(M.designView(feat({ ...page, status: "Ready for review", approval: { state: "draft", approvedVersion: 3 } }))).toMatchObject({ state: "draft", text: "Ready for review · v5", approvedVersion: undefined });
    expect(M.designView(feat({ pageId: "9", approval: { state: "unknown", detail: "Design page not read yet (sign in to the Atlassian MCP in Claude Code: /mcp)" } })))
      .toMatchObject({ state: "unknown", tone: "muted", text: expect.stringMatching(/not read yet/) });
    expect(M.designView(feat(undefined)).state).toBe("missing");
    expect(M.designView(feat({ approval: { state: "missing" } })).state).toBe("missing");
  });

  it("normalises StoryInfo: approved design version, G2 from labels + testability, tests on the PR from its files", () => {
    const pr = { ...PRS[2], storyKey: "ACME-51", files: ["tests/ACME-51.tc.json"] } as PrRef & { files: string[] };
    const s = M.storyOf(st({ approvedDesignVersion: 4, labels: ["ai-ready"], testabilityConfirmed: true }), pr);
    expect([s.designVersion, s.aiReady, s.testsOnPr, s.prNumber]).toEqual([4, true, true, 43]);
    expect(M.storyOf(st({ labels: ["ai-ready"], testabilityConfirmed: false })).aiReady).toBe(false);
    expect(M.storyOf(st({ labels: [] })).aiReady).toBe(false);
    expect(M.storyOf(st({ aiReady: true, designVersion: 8 })).designVersion).toBe(8);
  });

  it("Start story waits for G1, C5, G2 and the stories that block it (Story 00 first)", () => {
    const approved = { pageId: "9", url: "https://acme.atlassian.net/wiki/x", status: "Approved", version: 5, approval: { state: "approved" as const, approvedVersion: 5 } };
    const ready = { labels: ["ai-ready"], testabilityConfirmed: true, approvedDesignVersion: 5, designSync: "ok" as const };
    const f = feat(approved, [
      st({ num: "00", jiraKey: "ACME-51", status: "In Progress", statusCategory: "indeterminate", ...ready }),
      st({ num: "01", jiraKey: "ACME-52", blockedBy: ["ACME-51"], ...ready }),
      st({ num: "02", jiraKey: "ACME-53", ...ready, approvedDesignVersion: 4, designSync: "changed" }),
      st({ num: "03", jiraKey: "ACME-54", ...ready, approvedDesignVersion: undefined, designSync: "missing" }),
    ]);
    const s = M.buildFeature({ feature: f, featureId: "ACME-50", identity: DEVELOPER, sources: [], prs: [], owner: OWNER, repo: REPO, jiraUrl, allowed: allowedFor(DEVELOPER), now: NOW });
    const why = (k: string) => s.stories.find((x) => x.jiraKey === k)!.actions.map((a) => [a.id, a.allowed, a.reason]);
    expect(why("ACME-51")).toEqual([["dev:start-story", true, undefined]]);
    expect(why("ACME-52")).toEqual([["dev:start-story", false, "Waits for ACME-51 (blocks this story)"]]);
    expect(why("ACME-53")[0][2]).toMatch(/Design changed since this story was planned/);
    expect(s.stories.find((x) => x.jiraKey === "ACME-53")!.designChanged).toBe(true);
    expect(why("ACME-54")[0][2]).toMatch(/no Approved design version/);
    // the blocker is done: the story may start
    const done = M.buildFeature({ feature: { ...f, stories: f.stories.map((x) => x.jiraKey === "ACME-51" ? { ...x, statusCategory: "done" } as M.StoryV3 : x) },
      featureId: "ACME-50", identity: DEVELOPER, sources: [], prs: [], owner: OWNER, repo: REPO, jiraUrl, allowed: allowedFor(DEVELOPER), now: NOW });
    expect(done.stories.find((x) => x.jiraKey === "ACME-52")!.actions[0].allowed).toBe(true);
    // design not readable: nothing starts, and the reason says how to fix it
    const unknown = M.buildFeature({ feature: { ...f, design: { pageId: "9", approval: { state: "unknown" } } } as M.FeatureV3,
      featureId: "ACME-50", identity: DEVELOPER, sources: [], prs: [], owner: OWNER, repo: REPO, jiraUrl, allowed: allowedFor(DEVELOPER), now: NOW });
    expect(unknown.stories[0].actions[0].reason).toMatch(/Atlassian MCP/);
  });

  it("Approve design names the feature and page, and is disabled until a page exists", () => {
    expect(M.approveDesignAction(FEATURES[1])).toMatchObject({ id: "arch:approve-design", persona: "architect",
      args: { featureId: "ACME-20", key: "ACME-20", pageId: "2240011", url: "https://acme.atlassian.net/wiki/spaces/ACME/pages/2240011/Entitlement+SLA" } });
    const s = M.buildFeature({ feature: feat(undefined), featureId: "ACME-50", identity: ARCHITECT, sources: [], prs: [], owner: OWNER, repo: REPO,
      jiraUrl, allowed: allowedFor(ARCHITECT), now: NOW });
    expect(s.designActions.find((a) => a.id === "arch:approve-design")).toMatchObject({ allowed: false, reason: "Run Design first: there is no design page yet" });
  });
});
