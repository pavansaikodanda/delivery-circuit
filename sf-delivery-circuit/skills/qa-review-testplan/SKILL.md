---
name: qa-review-testplan
description: Tester reviews the story test plan (docs/plans/<KEY>/TESTPLAN.md) for gate G4 - every designed TC id is planned at the right level, nothing is dropped or weakened, test data and personas are covered - and tells the human Tester whether to add testplan-approved. Use with a PR number or Jira key.
---

# Tester: review the test plan (G4)

Persona: **Tester** (`cc-qa`). Input: `$ARGUMENTS` = PR number or Jira key.

1. Find the draft PR (`gh pr list --search "<KEY> in:title" --json number,headRefName,labels`), check out its branch
   read-only, and read `docs/plans/<KEY>/TESTPLAN.md`, `tests/<KEY>.tc.json`, `test-cases/<KEY>.sf-tests.yaml` and the
   Jira test cases linked to the story. If `tests/<KEY>.tc.json` is not on the branch yet, run `qa-add-tests` first.
2. Run `node scripts/ci/check-tc-coverage.mjs --key <KEY> --testplan` and report its output. It fails if a TC id is
   missing from TESTPLAN.md or appears there with a different level.
3. Check by reading:
   - each `unit` TC names the test class/method that will cover it;
   - each `ui` TC runs through SF AI Tester on `qa` from the committed suite (the plan must not rewrite the case);
   - each `manual` TC has an owner and timing (before G6);
   - test data: the records each case needs and how they are created (`@TestSetup`, data factory, AI-TEST records);
   - the plan cites the story's approved design version; nothing changes, skips or "adjusts" a designed case.
4. Post a PR comment with findings and a final line `G4 RECOMMENDATION: APPROVE` or `CHANGES`.
5. Tell the human Tester: if you agree, add the label `testplan-approved` yourself in GitHub (or the extension's gate
   action). The build starts when both `plan-approved` (Developer, G3) and `testplan-approved` are present.
