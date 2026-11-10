---
name: dev-review-pr
description: Developer code review of an AI-built Salesforce PR for gate G5 - correctness against the story, Apex/LWC quality, tests and TC coverage, CI results, Reviewer/CodeRabbit findings - with a recommendation for the human Developer. Use with a PR number.
---

# Developer: code review (G5)

Persona: **Developer** (`cc-dev`). Input: `$ARGUMENTS` = PR number.

1. Gather: `gh pr view $ARGUMENTS --json title,headRefName,labels,statusCheckRollup,reviews,comments`,
   `gh pr diff $ARGUMENTS`, the story file, `docs/plans/<KEY>/PLAN.md`, `TESTPLAN.md` and `verification-evidence.md`.
2. **CI first:** list each check (guard, static, reviewer, qa, spec-gate) and its result. If any is red, stop:
   the fix loop or a human owns it, not the review.
3. **Diff vs plan:** every changed file is in PLAN.md; flag anything extra or missing.
4. **Code quality:** bulkification, no SOQL/DML in loops, selective queries, null safety, error handling and
   logging, naming, no dead code, LWC uses LDS/UI API before Apex, loading and error states.
5. **Tests:** assertions on outcomes (not just coverage); positive, negative, bulk 201+; `@TestSetup`; no
   `SeeAllData=true`; every `level: unit` TC id is referenced (`// TC: Sxx-TC-yy`); coverage ≥ the threshold.
6. **Reviewer and CodeRabbit:** each finding is fixed or answered.
7. Post a PR comment (never an approval) with findings and `G5 RECOMMENDATION: APPROVE` or `CHANGES`.
8. Tell the human Developer: approve the PR in GitHub yourself if you agree; that sets `gate/developer`.
   Requesting changes on an `ai-generated` PR starts another AI attempt (up to 3), so write each change request
   as a concrete, testable instruction.
