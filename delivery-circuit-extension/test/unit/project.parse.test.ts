import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  citedSources, clarificationOpenItems, loadFeatures, parseJiraMap, parseScore, parseTcIndex, planSignedOff, specOpenQuestions,
  specTitle, storyJiraKey, storyTitle, suitePath,
} from "../../src/project/parse";

const ROOT = path.join(__dirname, "..", "fixtures", "project", "repo");

describe("spec-kit-sf markdown parsers", () => {
  it("counts NEEDS CLARIFICATION markers outside HTML comments", () => {
    const md = "<!-- [NEEDS CLARIFICATION: sample] -->\n- FR-1 [NEEDS CLARIFICATION: a]\n- FR-2 [NEEDS CLARIFICATION: b]";
    expect(specOpenQuestions(md)).toBe(2);
  });
  it("counts pending rows in the Clarification Status table", () => {
    const md = "## Clarification Status\n\n| # | Question | Status | Answer |\n|---|---|---|---|\n| 1 | q | ⏳ Pending | — |\n| 2 | q | ✅ Answered | x |\n\n## Change Log\n| 1 | Pending | Pending | x |";
    expect(specOpenQuestions(md)).toBe(1);
  });
  it("counts OPEN lines in a clarification report, ignoring comments", () => {
    expect(clarificationOpenItems("**Final Decision**: OPEN\n<!-- OPEN -->\nOPENING\n- OPEN: y")).toBe(2);
  });
  it("detects the Architect Sign-Off like spec-gate does", () => {
    expect(planSignedOff("**Overall Sign-Off**: [x] APPROVED / [ ] CHANGES REQUIRED")).toBe(true);
    expect(planSignedOff("**Overall Sign-Off**: [X]  APPROVED")).toBe(true);
    expect(planSignedOff("**Overall Sign-Off**: [ ] APPROVED / [x] CHANGES REQUIRED")).toBe(false);
    expect(planSignedOff("<!-- tick [x] APPROVED -->\n**Overall Sign-Off**: [ ] APPROVED")).toBe(false);
  });
  it("reads titles", () => {
    expect(specTitle("# Feature Specification: Case Escalation\n", "001-x")).toBe("Case Escalation");
    expect(specTitle("# Feature Specification: $FEATURE_NAME", "001-case-escalation")).toBe("Case Escalation");
    expect(specTitle(undefined, "002-partner-onboarding")).toBe("Partner Onboarding");
    expect(storyTitle("# STORY-01 — Agent escalates a Case\n", "01")).toBe("Agent escalates a Case");
    expect(storyTitle("no heading", "03")).toBe("Story 03");
  });
  it("reads a story's Jira key only when real", () => {
    expect(storyJiraKey("- **Jira**: ABC-12")).toBe("ABC-12");
    expect(storyJiraKey("- **Jira**: [PROJ-NNN]")).toBeUndefined();
  });
  it("parses jira-map refs and drops non-keys", () => {
    expect(parseJiraMap('{"refs":{"epic":"ABC-1","00":"ABC-2","x":"nope"}}')).toEqual({ epic: "ABC-1", "00": "ABC-2" });
    expect(parseJiraMap("not json")).toEqual({});
    expect(parseJiraMap(undefined)).toEqual({});
  });
  it("parses a tc index with levels and Jira keys", () => {
    const tcs = parseTcIndex('{"cases":[{"id":"S01-TC-01","level":"ui","ac":"AC-1"},{"id":"S01-TC-02","level":"weird"},{"nope":1}]}', { "S01-TC-01": "ABC-9" });
    expect(tcs).toEqual([{ id: "S01-TC-01", level: "ui", ac: "AC-1", jiraKey: "ABC-9" }, { id: "S01-TC-02", level: "manual" }]);
  });
  it("parses the feature score and source citations", () => {
    expect(parseScore("### Overall Feature Score: 488/555")).toBe(488);
    expect(parseScore("**Overall Feature Score**: 501 / 555")).toBe(501);
    expect(parseScore("XXX/555")).toBeUndefined();
    expect(citedSources("source: fireflies:01ABC and upload:3f9a0c1b2d4e", "<!-- fireflies:HIDDEN1 -->", "fireflies:01ABC")).toEqual(["fireflies:01ABC", "upload:3f9a0c1b2d4e"]);
  });
  it("names suites by convention", () => {
    expect(suitePath("001-case-escalation", "02")).toBe("test-cases/001-case-escalation-story-02.sf-tests.yaml");
  });
});

describe("loadFeatures on the fixture repo", () => {
  it("reads both features in id order and skips non-feature folders", async () => {
    const fs = await loadFeatures(ROOT);
    expect(fs.map((f) => f.feature.slug)).toEqual(["001-case-escalation", "002-partner-onboarding"]);
  });

  it("parses feature 001 fully", async () => {
    const [{ feature: f, facts }] = await loadFeatures(ROOT);
    expect(f.id).toBe("001");
    expect(f.title).toBe("Case Escalation");
    expect(f.dir).toBe(".specify/specs/001-case-escalation");
    expect(f.openQuestions).toBe(0);
    expect(f.signedOff).toBe(true);
    expect(f.score).toBe(488);
    expect(f.sources).toEqual(["fireflies:01JD7K2M9Q", "upload:3f9a0c1b2d4e"]);
    expect(f.stories.map((s) => [s.num, s.title, s.jiraKey])).toEqual([
      ["00", "Foundation: Case escalation fields and permission set", "ABC-11"],
      ["01", "Agent escalates a Case", "ABC-12"],
      ["02", "Escalation team queue", "ABC-13"],
    ]);
    expect(f.stories[0].file).toBe(".specify/specs/001-case-escalation/task_story_00.md");
    const s1 = f.stories[1].testCases;
    expect(s1.map((t) => [t.id, t.level, t.jiraKey])).toEqual([["S01-TC-01", "ui", "ABC-32"], ["S01-TC-02", "ui", "ABC-33"], ["S01-TC-03", "unit", undefined]]);
    expect(f.stories[2].testCases.map((t) => t.level)).toEqual(["ui", "unit", "manual"]);
    expect(facts).toMatchObject({ hasSpec: true, hasPlan: true, hasDataModel: true, hasClarification: true, hasReview: true, tcStories: ["00", "01", "02"] });
    expect(facts.jiraRefs.epic).toBe("ABC-10");
    expect(facts.jiraRefs.bad).toBeUndefined();
    expect(f.links.map((l) => l.label)).toEqual(["spec.md", "clarification-report-case-escalation.md", "plan.md", "data-model.md"]);
    expect(f.links.every((l) => l.kind === "file")).toBe(true);
  });

  it("parses feature 002 with open questions and an unsigned plan", async () => {
    const [, { feature: f, facts }] = await loadFeatures(ROOT);
    expect(f.openQuestions).toBe(2);
    expect(f.signedOff).toBe(false);
    expect(facts.hasPlan).toBe(true);
    expect(f.stories).toEqual([]);
    expect(f.sources).toEqual(["upload:aa11bb22cc33"]);
  });

  it("returns nothing for a repo without specs", async () => {
    expect(await loadFeatures(path.join(ROOT, "test-cases"))).toEqual([]);
  });
});
