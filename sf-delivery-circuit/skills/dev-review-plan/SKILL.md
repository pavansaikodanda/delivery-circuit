---
name: dev-review-plan
description: Developer reviews the AI build plan (docs/plans/<KEY>/PLAN.md) on a draft PR for gate G3 - reuse, layering, files to touch, test approach, risk - and tells the human Developer whether to add the plan-approved label. Use with a PR number or Jira key.
---

# Developer: review the AI plan (G3)

Persona: **Developer** (`cc-dev`). Input: `$ARGUMENTS` = PR number or Jira key.

1. Find the PR (`gh pr list --search "<KEY> in:title" --json number,headRefName,labels,isDraft`) and check out
   its branch read-only (`gh pr checkout <n>`).
2. Read `docs/plans/<KEY>/PLAN.md`, the story file, its `tests/story_NN.tc.json`, `plan.md`, `data-model.md`.
3. Check:
   - **Scope:** the plan covers every acceptance criterion and nothing outside the story.
   - **Reuse:** it extends existing classes/flows/LWCs where the story allows; each "new" file has a reason.
   - **Layering (constitution):** trigger → handler → service → selector; one trigger per object; no logic in triggers.
   - **Security:** `with sharing`, `WITH USER_MODE` / `stripInaccessible`, no hard-coded IDs.
   - **Tests:** each `level: unit` TC id is mapped to a planned test method; bulk (201+) and negative cases exist.
   - **Deploy safety:** the plan uses check-only validation on `dev`; no destructive change unless the story says so.
4. Post a PR comment with findings and a final line `G3 RECOMMENDATION: APPROVE` or `G3 RECOMMENDATION: CHANGES`.
5. Tell the human Developer: if you agree, add the label `plan-approved` yourself in GitHub. The AI can't add it:
   the guard blocks it and `persona-gates` removes gate labels added by anyone outside the `developers` team.
   The build starts when both `plan-approved` and `testplan-approved` (Tester, G4) are present.
