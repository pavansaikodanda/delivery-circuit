---
name: dev-review-pr
description: Read-only second look at a feature PR before asking for review - diff against the story's change rows and acceptance criteria, Apex/LWC quality, tests, scan results and open CodeRabbit comments. Posts findings as a PR comment; never approves. Use with a PR number or story key.
---

# Developer: second look at the PR

Persona: **Developer**. Input: `$ARGUMENTS` = PR number or `<KEY>`. Read-only: never approve, merge or push.

1. **Gather:** `gh pr view <n> --json title,body,headRefName,baseRefName,statusCheckRollup,reviewDecision`,
   `gh pr diff <n>`, the story (Changes rows, acceptance criteria), CodeRabbit comments.
2. **Scan first:** if `scan` is red, stop and point to `dev-fix <n>`.
3. **Diff vs plan:** every changed file is in the plan; flag extra or missing ones; nothing deleted without saying so.
4. **Quality:** bulkified, no SOQL/DML in loops, `with sharing`, CRUD/FLS, no hard-coded IDs, error handling;
   LWC uses LDS/UI API first, with loading and error states.
5. **Tests:** outcome assertions; positive, negative, bulk 201+; `@TestSetup`; no `SeeAllData=true`; each acceptance
   criterion covered.
6. **CodeRabbit:** list unresolved comments and whether each is valid.
7. Post one PR comment with findings and a last line `SECOND LOOK: READY` or `SECOND LOOK: CHANGES`.
