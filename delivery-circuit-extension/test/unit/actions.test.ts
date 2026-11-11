import { describe, expect, it } from "vitest";
import { GATES, PERSONAS, type ActionRef, type Identity, type Persona } from "../../src/core/contracts";
import {
  approvableEnvironments, confirmText, denyReason, isAllowed, isProtectedBranch, mergeMethods, parseAction, pinnedHead, signoffMessage,
} from "../../src/actions/grammar";
import { applySignOff, isSignedOff, signOffItems } from "../../src/actions/signoff";

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
    expect(parseAction(A("gate:signoff", "architect", { featureId: "001" }))).toMatchObject({ type: "signoff", gate: "G1" });
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
    expect(() => parseAction(A("gate:signoff", "architect", { featureId: "../etc" }))).toThrow();
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
    { a: A("gate:signoff", "architect", { featureId: "001" }), owner: "architect" },
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
    expect(denyReason(ident(["tester"], "tester"), A("gate:signoff", "tester", { featureId: "001" }))).toMatch(/G1/);
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
    expect(confirmText(parseAction(A("gate:signoff", "architect", { featureId: "001" })), { ...c, planPath: ".specify/specs/001-x/plan.md", branch: "spec/001-x", gitName: "Pat Lee", gitEmail: "pat@acme.io" }))
      .toBe(`Tick the Architect Sign-Off in .specify/specs/001-x/plan.md, commit "Architect sign-off for 001" as Pat Lee <pat@acme.io> on branch spec/001-x and push it (G1).`);
    expect(signoffMessage("001-x")).toBe("Architect sign-off for 001-x");
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
  it("never signs off on main", () => {
    for (const b of ["main", "master", "HEAD", "", "trunk"]) expect(isProtectedBranch(b, "trunk")).toBe(true);
    expect(isProtectedBranch("spec/001-x")).toBe(false);
  });
});

const PLAN = [
  "# Plan", "", "## Architect Sign-Off", "", "<!-- gate -->", "", "### Data Model Review",
  "- [ ] Object relationships are correct", "- [ ] Field types are appropriate", "- **Reviewed by**: [Architect Name]", "",
  "### Security Review", "- [ ] OWD settings are correct", "- **Reviewed by**: [Architect Name]", "",
  "**Overall Sign-Off**: [ ] APPROVED / [ ] CHANGES REQUIRED", "**Date**: [Date]", "", "---", "", "## Estimation Summary", "- [ ] not part of sign-off",
].join("\n");

describe("plan.md sign-off", () => {
  it("lists only the items of the sign-off section", () => {
    const items = signOffItems(PLAN);
    expect(items.map((i) => i.text)).toEqual(["Object relationships are correct", "Field types are appropriate", "OWD settings are correct", "Overall Sign-Off: APPROVED"]);
    expect(items[0].section).toBe("Data Model Review");
    expect(items.at(-1)!.overall).toBe(true);
  });
  it("ticks the chosen lines, fills name and date, never ticks CHANGES REQUIRED", () => {
    const items = signOffItems(PLAN);
    const out = applySignOff(PLAN, [items[0].line, items[2].line, items[3].line], "Pat Lee", "2026-11-11T10:00:00Z");
    expect(out).toContain("- [x] Object relationships are correct");
    expect(out).toContain("- [ ] Field types are appropriate");
    expect(out).toContain("**Overall Sign-Off**: [x] APPROVED / [ ] CHANGES REQUIRED");
    expect(out).toContain("**Date**: 2026-11-11");
    expect(out.match(/Reviewed by\*\*: Pat Lee/g)).toHaveLength(2);
    expect(out).toContain("- [ ] not part of sign-off");
    expect(isSignedOff(out)).toBe(true);
    expect(isSignedOff(PLAN)).toBe(false);
  });
  it("requires the Overall APPROVED box and keeps CRLF", () => {
    expect(() => applySignOff(PLAN, [signOffItems(PLAN)[0].line], "x", "2026-01-01")).toThrow(/Overall/);
    const crlf = PLAN.replace(/\n/g, "\r\n");
    const lines = signOffItems(crlf).map((i) => i.line);
    expect(applySignOff(crlf, lines, "x", "2026-01-01")).toContain("\r\n");
    expect(() => applySignOff("# no section", [], "x", "2026-01-01")).toThrow(/no Architect Sign-Off/);
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
