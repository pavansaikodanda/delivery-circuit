---
name: qa-review-testplan
description: Tester reviews the AI test plan (docs/plans/<KEY>/TESTPLAN.md) for gate G4 - every designed TC id is planned at the right level, nothing is dropped or weakened, test data and personas are covered - and tells the human Tester whether to add testplan-approved. Use with a PR number or Jira key.
---

# Tester: review the AI test plan (G4)

Persona: **Tester** (`cc-qa`). Input: `$ARGUMENTS` = PR number or Jira key.

1. Find the draft PR and read `docs/plans/<KEY>/TESTPLAN.md`, the story's `tests/story_NN.tc.json`, its suite in
   `test-cases/` and `jira-map.json`.
2. Run `node scripts/ci/check-tc-coverage.mjs --testplan docs/plans/<KEY>/TESTPLAN.md .specify/specs/NNN-slug`
   and report its output. It fails if a TC id is missing from TESTPLAN.md or appears there with a different level.
3. Check by reading:
   - each `unit` TC names the test class/method that will cover it;
   - each `ui` TC says it runs through SF AI Tester on `qa` (the plan must not rewrite the case);
   - each `manual` TC has an owner and timing (before G6);
   - test data: the records each case needs and how they are created (`@TestSetup`, data factory, AI-TEST records);
   - nothing in the plan changes, skips or "adjusts" a designed case.
4. Post a PR comment with findings and a final line `G4 RECOMMENDATION: APPROVE` or `CHANGES`.
5. Tell the human Tester: if you agree, add the label `testplan-approved` yourself in GitHub. The build starts when
   both `plan-approved` (Developer, G3) and `testplan-approved` are present.
