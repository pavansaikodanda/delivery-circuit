---
name: dev-review-plan
description: Read-only second look at the plan in a feature PR body before review - covers every change row and acceptance criterion of the Jira story, reuses before building new, layering, security, tests, risks. Posts findings as a PR comment. Use with a PR number or story key.
---

# Developer: second look at the plan

Persona: **Developer**. Input: `$ARGUMENTS` = PR number or `<KEY>`. Read-only: no code changes, no approvals.

1. `gh pr view <n> --json number,title,body,headRefName,baseRefName`; the story (`getJiraIssue <KEY>`): Changes rows,
   acceptance criteria, design link.
2. Check the plan in the PR body:
   - every change row has a matching approach, with the right tag (no NEW where something EXISTS);
   - every acceptance criterion has a test;
   - layering trigger → handler → service → selector; `with sharing`, CRUD/FLS; bulk (201+);
   - files listed match the scope; risks named (deletions, permissions, shared files);
   - base branch is the current `sprint/*`.
3. Post one PR comment (`gh pr comment <n> --body-file <file>`): findings and a last line
   `PLAN: OK` or `PLAN: CHANGES`. If changes are needed, the Developer updates the PR body (`dev-start-story <KEY> build`).
