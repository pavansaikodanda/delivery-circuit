import { describe, expect, it } from "vitest";
import { GATES, PERSONAS, type ActionRef, type Identity, type Persona } from "../../src/core/contracts";
import {
  approvableEnvironments, confirmText, denyReason, failureContext, fixPrompt, isAllowed, mergeMethods, parseAction, pinnedHead,
} from "../../src/actions/grammar";

const ident = (personas: Persona[], active: Persona | null, login = "pat"): Identity =>
  ({ login, personas, active, isAdmin: false, owner: "acme", repo: "crm", orgOwned: true });

const A = (id: string, persona: Persona, args?: Record<string, string | number>): ActionRef =>
  ({ id, label: id, persona, kind: id.split(":")[0] as ActionRef["kind"], args });

describe("action grammar", () => {
  it("parses AI actions into a prompt", () => {
    expect(parseAction(A("ai:/dev-review-plan", "developer", { command: "/dev-review-plan", arg: "42" }))).toEqual({ type: "ai", skill: "/dev-review-plan", prompt: "/dev-review-plan 42" });
    expect(parseAction(A("ai:qa-explore", "tester"))).toMatchObject({ prompt: "/qa-explore" });
    expect(parseAction(A("ai:arch-design", "architect", { arg: "001" }))).toMatchObject({ prompt: "/arch-design 001" });
  });
  it("parses gate actions in both id forms", () => {
    expect(parseAction(A("gate:label", "developer", { pr: 42, label: "plan-approved" }))).toEqual({ type: "label", pr: 42, label: "plan-approved", gate: "G3" });
    expect(parseAction(A("gate:label:testplan-approved", "tester", { pr: "7" }))).toMatchObject({ label: "testplan-approved", gate: "G4", pr: 7 });
    expect(parseAction(A("gate:label", "tester", { pr: 3, label: "ai-ready" }))).toMatchObject({ gate: "G2" });
    expect(parseAction(A("gate:review", "tester", { pr: 5, event: "request_changes" }))).toMatchObject({ event: "REQUEST_CHANGES", gate: "G6" });
    expect(parseAction(A("gate:review", "architect", { pr: 5, event: "APPROVE" }))).toMatchObject({ gate: "G7" });
    expect(parseAction(A("gate:merge", "architect", { pr: 9 }))).toMatchObject({ type: "merge", gate: "G8" });
    expect(parseAction(A("gate:deploy", "architect", { runId: 123 }))).toMatchObject({ type: "deploy", gate: "G9", runId: 123 });
    expect(parseAction(A("nav:feature", "developer", { featureId: "002" }))).toEqual({ type: "nav-feature", featureId: "002" });
    expect(parseAction(A("nav:testing", "tester"))).toEqual({ type: "nav-testing", suite: undefined });
  });
  it("rejects anything outside the grammar", () => {
    expect(() => parseAction(A("gate:label", "developer", { pr: 1, label: "needs-human" }))).toThrow(/Only the labels/);
    expect(() => parseAction(A("gate:label", "developer", { pr: "1; rm -rf", label: "plan-approved" }))).toThrow(/PR number/);
    expect(() => parseAction(A("gate:review", "developer", { pr: 1, event: "COMMENT" }))).toThrow(/APPROVE or REQUEST_CHANGES/);
    expect(() => parseAction(A("gate:nuke", "architect"))).toThrow(/Unknown gate/);
    expect(() => parseAction(A("ai:", "developer"))).toThrow();
    expect(() => parseAction({ id: "gate:merge", label: "x", persona: "architect", kind: "ai", args: { pr: 1 } })).toThrow(/does not match/);
    // v2 plan.md sign-off is gone: G1 is the Confluence page status (arch:approve-design opens the page)
    expect(() => parseAction(A("gate:signoff", "architect", { featureId: "001" }))).toThrow(/Unknown gate/);
  });
});

describe("allowed() matrix", () => {
  const actionsFor = (p: Persona): ActionRef[] => [
    A("ai:/x", p),
    A("gate:review", p, { pr: 1, event: "APPROVE" }),
  ];
  const gateActions: { a: ActionRef; owner: Persona }[] = [
    { a: A("gate:label", "developer", { pr: 1, label: "plan-approved" }), owner: "developer" },
    { a: A("gate:label", "tester", { pr: 1, label: "testplan-approved" }), owner: "tester" },
    { a: A("gate:label", "tester", { pr: 1, label: "ai-ready" }), owner: "tester" },
    { a: A("gate:merge", "architect", { pr: 1 }), owner: "architect" },
    { a: A("gate:deploy", "architect", { runId: 1 }), owner: "architect" },
  ];

  it("each persona acts only as itself, for every gate", () => {
    for (const who of PERSONAS) {
      const id = ident([who], who);
      for (const p of PERSONAS) for (const a of actionsFor(p)) expect(isAllowed(id, a), `${who} -> ${a.id} as ${p}`).toBe(p === who);
      for (const g of gateActions) expect(isAllowed(id, g.a), `${who} -> ${g.a.id}`).toBe(g.owner === who);
    }
  });
  it("the Architect sees everything but acts only as Architect", () => {
    const arch = ident(["architect"], "architect");
    expect(isAllowed(arch, A("nav:feature", "developer"))).toBe(true);
    expect(isAllowed(arch, A("nav:testing", "tester"))).toBe(true);
    expect(isAllowed(arch, A("gate:label", "developer", { pr: 1, label: "plan-approved" }))).toBe(false);
    expect(isAllowed(ident(["developer"], "developer"), A("nav:feature", "tester"))).toBe(false);
  });
  it("a gate claimed for the wrong persona is refused (owner check)", () => {
    const dev = ident(["developer"], "developer");
    expect(denyReason(dev, A("gate:merge", "developer", { pr: 1 }))).toMatch(/G8.*architect/);
    expect(denyReason(dev, A("gate:label", "developer", { pr: 1, label: "testplan-approved" }))).toMatch(/G4.*tester/);
    expect(denyReason(ident(["tester"], "tester"), { id: "arch:approve-design", label: "Approve design", persona: "tester", kind: "nav", args: { featureId: "ACME-10" } })).toMatch(/architect/);
  });
  it("needs an identity and the active persona", () => {
    expect(denyReason(null, A("ai:/x", "developer"))).toMatch(/Sign in/);
    expect(denyReason(ident(["developer", "tester"], "tester"), A("ai:/x", "developer"))).toMatch(/Switch to the developer/);
    expect(denyReason(ident([], null), A("ai:/x", "developer"))).toMatch(/Only the developer/);
  });
  it("every gate in GATES is reachable only by its owner", () => {
    const owners = new Set(Object.values(GATES).map((g) => g.owner));
    expect([...owners].sort()).toEqual(["architect", "developer", "tester"]);
  });
});

describe("confirmation text", () => {
  const c = { login: "pat", owner: "acme", repo: "crm" };
  it("states the exact effect", () => {
    expect(confirmText(parseAction(A("gate:label", "developer", { pr: 42, label: "plan-approved" })), c))
      .toBe("Add label plan-approved to PR #42 in acme/crm as pat (G3: AI plan approved).");
    expect(confirmText(parseAction(A("gate:review", "tester", { pr: 8, event: "APPROVE" })), c)).toBe("Approve PR #8 in acme/crm as pat (G6: QA on sandbox).");
    expect(confirmText(parseAction(A("gate:review", "tester", { pr: 8, event: "REQUEST_CHANGES" })), c)).toBe("Request changes on PR #8 in acme/crm as pat.");
    expect(confirmText(parseAction(A("gate:merge", "architect", { pr: 9 })), { ...c, mergeMethod: "squash" })).toBe("Merge PR #9 in acme/crm with the squash method as pat (G8).");
    expect(confirmText(parseAction(A("gate:deploy", "architect", { runId: 77 })), { ...c, environments: ["production"] }))
      .toBe("Approve the deployment of workflow run #77 in acme/crm to production as pat (G9).");
  });
});

describe("gate helpers", () => {
  it("merge methods follow the repository settings", () => {
    expect(mergeMethods({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false })).toEqual(["squash"]);
    expect(mergeMethods({ allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: true })).toEqual(["merge", "rebase"]);
    expect(mergeMethods({ allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: false })).toEqual([]);
  });
  it("only production environments are approvable, and only when GitHub says so", () => {
    const r = approvableEnvironments([
      { environment: { id: 1, name: "production" }, current_user_can_approve: true },
      { environment: { id: 2, name: "qa" }, current_user_can_approve: true },
      { environment: { id: 3, name: "production-dryrun" }, current_user_can_approve: false },
      { environment: { id: 4, name: "productionish" }, current_user_can_approve: true },
    ]);
    expect(r.approvable).toEqual([{ id: 1, name: "production" }]);
    expect(r.blocked).toEqual(["production-dryrun"]);
  });
});

describe("review and merge are pinned to the reviewed head commit", () => {
  const A1 = "a".repeat(40), B2 = "b".repeat(40);
  it("parses an optional 40-hex sha on review and merge", () => {
    expect(parseAction(A("gate:merge", "architect", { pr: 9, sha: A1.toUpperCase() }))).toEqual({ type: "merge", pr: 9, gate: "G8", sha: A1 });
    expect(parseAction(A("gate:review", "developer", { pr: 9, event: "APPROVE", sha: A1 }))).toMatchObject({ sha: A1 });
    expect(parseAction(A("gate:merge", "architect", { pr: 9 }))).not.toHaveProperty("sha");
    expect(() => parseAction(A("gate:merge", "architect", { pr: 9, sha: "main" }))).toThrow(/40 hex/);
  });
  it("refuses when the PR moved on since the person saw it", () => {
    expect(pinnedHead(9, A1, A1)).toBe(A1);
    expect(pinnedHead(9, undefined, B2.toUpperCase())).toBe(B2);
    expect(() => pinnedHead(9, A1, B2)).toThrow(/new commits since this view was loaded \(aaaaaaa -> bbbbbbb\)/);
    expect(() => pinnedHead(9, A1, undefined)).toThrow(/head commit/);
  });
  it("names the short sha in the confirmation", () => {
    const c = { login: "pat", owner: "acme", repo: "crm", headSha: A1 };
    expect(confirmText(parseAction(A("gate:merge", "architect", { pr: 9 })), { ...c, mergeMethod: "squash" })).toBe("Merge PR #9 at commit aaaaaaa in acme/crm with the squash method as pat (G8).");
    expect(confirmText(parseAction(A("gate:review", "tester", { pr: 8, event: "APPROVE" })), c)).toBe("Approve PR #8 at commit aaaaaaa in acme/crm as pat (G6: QA on sandbox).");
  });
});

describe("v3 named actions", () => {
  const V = (id: string, persona: Persona, kind: ActionRef["kind"], args?: Record<string, string | number>): ActionRef => ({ id, label: id, persona, kind, args });

  it("start story, add tests, review room and verdict run their skills", () => {
    expect(parseAction(V("dev:start-story", "developer", "ai", { command: "/dev-start-story", arg: "acme-12", storyKey: "ACME-12" })))
      .toEqual({ type: "ai", skill: "/dev-start-story", prompt: "/dev-start-story ACME-12", named: "dev:start-story" });
    expect(parseAction(V("dev:start-story", "developer", "ai", { key: "ACME-12", phase: "build" }))).toMatchObject({ prompt: "/dev-start-story ACME-12 build" });
    expect(parseAction(V("qa:add-tests", "tester", "ai", { arg: "ACME-12", pr: 42 }))).toMatchObject({ prompt: "/qa-add-tests ACME-12" });
    expect(parseAction(V("review:open-room", "developer", "ai", { arg: "open 42", pr: 42 }))).toMatchObject({ prompt: "/review-room open 42" });
    expect(parseAction(V("review:record-verdict", "developer", "ai", { pr: "42" }))).toMatchObject({ prompt: "/review-room verdict 42" });
  });

  it("dev:fix carries the failing checks and failure context, and stops at the attempt cap", () => {
    expect(parseAction(V("dev:fix", "developer", "ai", { pr: 42, checks: "qa,apex", attempt: 1 }))).toMatchObject({ prompt: "/dev-fix 42 qa,apex" });
    expect(parseAction(V("dev:fix", "developer", "ai", { pr: 42, attempt: 3, failure: "apex: 2 tests failed & \"x\"" })))
      .toMatchObject({ prompt: "/dev-fix 42 failure: apex: 2 tests failed x" });
    expect(() => parseAction(V("dev:fix", "developer", "ai", { pr: 42, attempt: 4 }))).toThrow(/needs-human/);
    expect(() => parseAction(V("dev:fix", "developer", "ai", { pr: "42; rm" }))).toThrow(/PR number/);
  });

  it("decision:record targets the feature and keeps the text on one safe line", () => {
    expect(parseAction(V("decision:record", "tester", "ai", { featureId: "acme-12", text: "Use Tier 2 queue\nfor escalations | now" })))
      .toMatchObject({ prompt: "/record-decision ACME-12 Use Tier 2 queue for escalations now" });
    expect(parseAction(V("decision:record", "architect", "ai", { arg: "001-case-escalation" }))).toMatchObject({ prompt: "/record-decision 001-case-escalation" });
    expect(() => parseAction(V("decision:record", "architect", "ai", { arg: "../x y" }))).toThrow(/epic key/);
  });

  it("arch:approve-design opens the page; it is the Architect's G1 and never an AI session", () => {
    expect(parseAction(V("arch:approve-design", "architect", "nav", { featureId: "ACME-10", pageId: "12345", url: "https://acme-demo.atlassian.net/wiki/x" })))
      .toEqual({ type: "approve-design", gate: "G1", key: "ACME-10", url: "https://acme-demo.atlassian.net/wiki/x" });
    expect(() => parseAction(V("arch:approve-design", "architect", "nav", { url: "http://insecure" }))).toThrow(/https/);
    expect(() => parseAction(V("arch:approve-design", "architect", "ai", { featureId: "ACME-10" }))).toThrow(/kind/);
    expect(() => parseAction(V("arch:approve-design", "architect", "nav", {}))).toThrow(/needs the feature/);
    expect(confirmText(parseAction(V("arch:approve-design", "architect", "nav", { featureId: "ACME-10" })), { login: "pat", owner: "acme", repo: "crm" })).toMatch(/AI never approves/);
  });

  it("each named action belongs to its persona; decision:record to whoever acts", () => {
    const dev = ident(["developer"], "developer");
    const arch = ident(["architect"], "architect");
    const qa = ident(["tester"], "tester");
    expect(isAllowed(dev, V("dev:start-story", "developer", "ai", { arg: "ACME-12" }))).toBe(true);
    expect(denyReason(arch, V("dev:start-story", "architect", "ai", { arg: "ACME-12" }))).toMatch(/developer action/);
    expect(isAllowed(arch, V("dev:start-story", "developer", "ai", { arg: "ACME-12" }))).toBe(false);
    expect(isAllowed(qa, V("qa:add-tests", "tester", "ai", { arg: "ACME-12" }))).toBe(true);
    expect(isAllowed(dev, V("qa:add-tests", "tester", "ai", { arg: "ACME-12" }))).toBe(false);
    expect(isAllowed(arch, V("arch:approve-design", "architect", "nav", { featureId: "ACME-10" }))).toBe(true);
    expect(isAllowed(dev, V("arch:approve-design", "developer", "nav", { featureId: "ACME-10" }))).toBe(false);
    for (const [who, id] of [["architect", arch], ["developer", dev], ["tester", qa]] as const) {
      expect(isAllowed(id, V("decision:record", who, "ai", { featureId: "ACME-10" }))).toBe(true);
    }
  });

  it("builds failure context and fix prompts from failed check runs", () => {
    expect(failureContext([
      { name: "guard", conclusion: "success" },
      { name: "apex", conclusion: "failure", output: { title: "2 of 40 tests failed" } },
      { name: "qa-deploy", conclusion: "timed_out", output: { summary: "\nDeploy timed out after 30m\nmore" } },
    ])).toBe("apex: 2 of 40 tests failed; qa-deploy: Deploy timed out after 30m");
    expect(fixPrompt(7, "apex, bad;name", "")).toBe("/dev-fix 7 apex");
  });
});
