---
name: dev-review-pr
description: Developer code review of a story PR for gate G5 - correctness against the Jira story and the plan, Apex/LWC quality, tests and TC coverage, CI results, the review-room verdict and CodeRabbit/Reviewer findings - with a recommendation for the human Developer. Use with a PR number or story key.
---

# Developer: code review (G5)

Persona: **Developer** (`cc-dev`). Input: `$ARGUMENTS` = PR number or Jira key.

1. **Gather:** `gh pr view <n> --json title,headRefName,labels,statusCheckRollup,reviews,comments`, `gh pr diff <n>`,
   the story and acceptance criteria (Jira), `docs/plans/<KEY>/PLAN.md`, `TESTPLAN.md`, `verification-evidence.md`,
   `tests/<KEY>.tc.json`.
2. **CI first:** list each check (guard, lint, Jest, TC coverage, design-gate, QA deploy, Apex, SF AI Tester,
   AI Reviewer, Code Analyzer) and its result. If any is red, stop: `dev-fix` or a person owns it, not the review.
3. **Diff vs plan:** every changed file is in PLAN.md; flag anything extra or missing. Nothing under `tests/` or
   `test-cases/` changed except by the Tester's commits.
4. **Code quality:** bulkification, no SOQL/DML in loops, selective queries, null safety, error handling, naming,
   no dead code; LWC uses LDS/UI API before Apex, with loading and error states.
5. **Tests:** assertions on outcomes; positive, negative, bulk 201+; `@TestSetup`; no `SeeAllData=true`; every
   `level: unit` TC id referenced (`// TC: <KEY>-TC-nn`); coverage ≥ the threshold.
6. **Review room:** the verdict comment from `review-room verdict` exists; every *Must fix* is fixed; *Disputed*
   items have an answer. If there's no verdict yet, say so.
7. Post a PR comment (never an approval) with findings and `G5 RECOMMENDATION: APPROVE` or `CHANGES`.
8. Tell the human Developer: approve the PR in GitHub yourself if you agree; that sets `gate/developer`. Write each
   change request as a concrete, testable instruction (it can become a `dev-fix` input).
