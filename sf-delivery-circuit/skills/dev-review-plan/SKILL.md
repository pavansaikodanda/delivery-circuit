---
name: dev-review-plan
description: Developer reviews the story plan (docs/plans/<KEY>/PLAN.md) on the draft PR for gate G3 - scope against the acceptance criteria and the approved design version, reuse, layering, files to touch, test approach, risk - and tells the human Developer whether to add the plan-approved label. Use with a PR number or Jira key.
---

# Developer: review the plan (G3)

Persona: **Developer** (`cc-dev`). Input: `$ARGUMENTS` = PR number or Jira key.

1. Find the PR (`gh pr list --search "<KEY> in:title" --json number,headRefName,labels,isDraft`) and read its branch
   (`gh pr checkout <n>`; read only).
2. Read `docs/plans/<KEY>/PLAN.md`, `TESTPLAN.md`, `tests/<KEY>.tc.json` (if the Tester added it), the story and its
   acceptance criteria (Jira), and the design page at the story's *Approved design version* (`design_get`).
3. Check:
   - **Design version (C5):** PLAN.md cites the same version the story carries, and the epic's version is not newer.
   - **Scope:** every acceptance criterion is covered and nothing outside the story or the design.
   - **Reuse:** extends existing classes/flows/LWCs where possible; each "new" file has a reason.
   - **Layering (constitution):** trigger → handler → service → selector; one trigger per object.
   - **Security:** `with sharing`, `WITH USER_MODE` / `stripInaccessible`, no hard-coded IDs.
   - **Tests:** each `unit` TC id maps to a planned test method; bulk (201+) and negative cases exist.
   - **Deploy safety:** only check-only validation on `dev`; no destructive change unless the story says so.
4. Post a PR comment (`gh pr comment <n> --body-file <file>`) with findings and a final line
   `G3 RECOMMENDATION: APPROVE` or `G3 RECOMMENDATION: CHANGES`.
5. Tell the human Developer: if you agree, add the label `plan-approved` yourself in GitHub (or the extension's gate
   action). The AI can't: the guard blocks it and `persona-gates` removes gate labels added by anyone outside
   `developers`. The build starts with `dev-start-story <KEY> build` when `testplan-approved` (G4) is also there.
