---
name: dev-start-story
description: Developer starts a Jira story - reads the story, acceptance criteria, design page at the approved version and the test cases, writes docs/plans/<KEY>/PLAN.md and TESTPLAN.md, creates branch feature/<KEY>-<slug> and opens a DRAFT PR titled "<KEY> ..."; later, after plan-approved and testplan-approved, builds the story with a check-only deploy. Use with a story key ("start ACME-12") or "build ACME-12".
---

# Developer: start a story (plan, branch, draft PR) and build it

Persona: **Developer** (`cc-dev`, or "Start story" in the extension). Input: `$ARGUMENTS` = `<KEY>` (plan phase)
or `<KEY> build` (build phase). Conventions: `circuit` skill. The human Developer owns the PR.

## Preconditions (both phases)
1. Logins: `gh auth status`, `sf org display --target-org dev`, Atlassian MCP or `acli jira auth status`.
2. Story (`story_get` / `getJiraIssue` / `acli jira workitem view <KEY> --json --fields '*all'`): label `ai-ready`
   and *Testability confirmed* (G2). Not Story 00? Story 00 must be Done (its "blocks" link). Stop otherwise.
3. **C5:** the story's *Approved design version* equals its epic's. If not: "Design changed since this story was
   planned: re-plan or re-approve" and stop.
4. Read the design page **at that version** (`design_get`, or `getConfluenceContentVersion`), its Decisions and the
   Org snapshot, and the story's test cases (Jira, linked to the story; `tests/<KEY>.tc.json` if already on the PR).

## Plan phase (`<KEY>`)
1. **Branch:** from an up-to-date `main`: `git switch -c feature/<KEY>-<slug>` (slug: 3–5 words of the summary,
   lowercase, hyphens). If it exists, check it out and continue from what is there.
2. **PLAN.md** at `docs/plans/<KEY>/PLAN.md`: story and design links (with version N), acceptance criteria → approach,
   files to add/change under `force-app/` with a reason for each "new" (reuse first: search `force-app/` and `dev`),
   layering (trigger → handler → service → selector), security (sharing, CRUD/FLS), bulk behaviour, deploy proof
   (`sf project deploy validate --target-org dev --test-level RunSpecifiedTests --tests …`), risks, open points.
3. **TESTPLAN.md** at `docs/plans/<KEY>/TESTPLAN.md`: a row per test case id (`<KEY>-TC-nn`) with its level and how
   it is covered: `unit` → test class and method; `ui` → "SF AI Tester on qa (suite test-cases/<KEY>.sf-tests.yaml)";
   `manual` → owner and timing (before G6); plus test data. Never drop or reword a designed case.
4. **Commit and push:** `git add docs/plans/<KEY>` → `git commit -m "<KEY> plan: <summary>"` →
   `git push -u origin feature/<KEY>-<slug>`.
5. **Draft PR** (the only kind you may open):
   `gh pr create --draft --base main --head feature/<KEY>-<slug> --title "<KEY> <summary>" --body-file .ai/pr-<KEY>.md`
   Body: Jira link, design page link + version N, plan/testplan paths, the gate checklist (G3 `plan-approved`
   Developer, G4 `testplan-approved` Tester, G5–G7 reviews, G8 merge), and "Tests: the Tester adds
   tests/<KEY>.tc.json and test-cases/<KEY>.sf-tests.yaml to this PR". The Jira key in the branch and title links the
   PR to the story through GitHub for Jira; no other linking is needed.
6. **Report:** PR link. Next: Tester runs `qa-add-tests <KEY>`; human Developer reviews the plan (`dev-review-plan`)
   and adds `plan-approved` (G3); Tester adds `testplan-approved` (G4).

## Build phase (`<KEY> build`)
1. The PR has both `plan-approved` and `testplan-approved` and `tests/<KEY>.tc.json` is on the branch. Stop otherwise.
2. `git pull` the branch. Implement exactly PLAN.md (`/speckit-sf-implement` may help; its deploy step is disabled).
   Every `level: unit` case gets a test naming it: `// TC: <KEY>-TC-nn`. Never edit `tests/`, `test-cases/`,
   `.github/`, `.claude/` or the constitution.
3. Prove it: `npm run lint`, `npx jest` (LWC), `node scripts/ci/check-tc-coverage.mjs --key <KEY> --code`, and
   `sf project deploy validate --source-dir force-app --target-org dev --test-level RunSpecifiedTests --tests <classes>`.
   Record results in `docs/plans/<KEY>/verification-evidence.md`.
4. Commit (`<KEY> build: …`), push the branch. If the story, design and tests disagree, stop and say so.
5. Next: checks run on the PR; failures come back as "Fix with AI" (`dev-fix`). When green, the human Developer marks
   the PR ready and opens the review room (`review-room open <KEY>`).
