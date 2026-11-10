---
name: dev-review-stories
description: Developer reviews spec-kit-sf generated stories before they go to Jira - buildability, Story 00 completeness, dependencies, estimates, reuse and test hooks - and records findings in the spec PR. Use with a spec folder name.
---

# Developer: review stories before Jira

Persona: **Developer** (`cc-dev`). Input: `$ARGUMENTS` = `NNN-slug`. Read-only on the spec: write findings, don't
edit the stories (the guard blocks story edits for the Developer; the Architect applies agreed changes).

For each `task_story_NN.md`, check and record:
1. **Buildable:** every acceptance criterion maps to concrete metadata or code in the story's implementation
   layers. Flag vague criteria ("works correctly", "is fast").
2. **Story 00:** contains every object, field, permission set, trigger shell, test data factory and shared
   selector that later stories use. Anything a later story needs but 00 lacks is a BLOCKER (it breaks parallel
   work).
3. **Dependencies:** the "Blocks / Blocked by" graph has no cycles, and two stories don't edit the same class or
   flow in parallel without saying so (merge-conflict risk).
4. **Reuse:** check `force-app/` and `dev` (`sf data query`, `sf sobject describe`) for existing classes, flows
   and fields that the story re-creates.
5. **Size:** a story bigger than about 2 days or 8 points should be split. Give a points estimate.
6. **Testability hooks:** unit-testable seams exist (handler/service/selector layers), and the story's test
   data needs are stated.

Output: a table `story | verdict (OK / CHANGES / BLOCKER) | findings | estimate`, saved to
`.specify/specs/NNN-slug/reviews/dev-review-stories.md` (the only file you write), plus a PR comment with the same
table (`gh pr comment <spec PR> --body-file ...`). Next owner: Architect (apply changes), then Tester
(`qa-design-tests`).
