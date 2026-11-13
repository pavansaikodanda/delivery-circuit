---
name: dev-start-story
description: Developer builds a Ready for Dev Jira story - branches feature/<KEY>-<slug> from the current sprint branch, plans from the story's change rows and acceptance criteria, builds, validates against the developer's own DEV org, pushes, opens the PR into the sprint branch with the plan in the PR body and turns on auto-merge. Use with a story key ("start ACME-12"); "<KEY> build" continues an existing branch.
---

# Developer: plan, build and open the PR

Persona: **Developer**. Input: `$ARGUMENTS` = `<KEY>` [`--sprint <name>`], or `<KEY> build` to continue work on an
existing branch/PR. Conventions: `circuit` skill. DEV alias: `build.config.yml` → `salesforce.dev_alias` (default
`dev`); written `<dev>` below. You deploy to `<dev>` only, never anywhere else.

## 1. Check
1. Logins: `gh auth status`, `sf org display --target-org <dev>`, Atlassian MCP. Missing → name it and stop.
2. Story (`getJiraIssue <KEY>`): status **Ready for Dev** (or In Progress when continuing). Otherwise stop: "The
   scrum team moves <KEY> to Ready for Dev in refinement." Not Story 00 and Story 00 not Done → stop.
3. Read the story's Design link (the page), its **Changes** rows and **Acceptance criteria**, the page's Decisions,
   and linked test cases. If they contradict each other, stop and list the questions.

## 2. Branch
- Sprint branch: `--sprint <name>` → `sprint/<name>`; else the newest remote one:
  `git fetch origin && git for-each-ref --sort=-committerdate --format='%(refname:lstrip=3)' 'refs/remotes/origin/sprint/*' | head -1`.
  None → stop: "No sprint branch; a lead creates sprint/<name>."
- `git switch -c feature/<KEY>-<slug> origin/sprint/<name>` (slug: 3-5 words of the summary, lowercase, hyphens).
  If the branch exists (or `build`), `git switch` to it and `git pull`.

## 3. Plan (goes in the PR body; no plan files)
Show the user, then wait for an OK:
- **Approach:** per change row (EXISTS reuse / EXTEND / CHANGE / REBUILD / NEW) what you will do; reuse first
  (search `force-app/` and `<dev>`).
- **Files:** each file under `force-app/` to add or change, with a reason.
- **Tests:** Apex test classes/methods and LWC Jest per acceptance criterion; bulk (201+) and negative cases; the
  QA suite `test-cases/<KEY>.sf-tests.yaml` if QA has added it.
- **Risks:** data, permissions, deletions, other stories touching the same files.

## 4. Build
1. Implement the plan. Follow `CLAUDE.md` (sharing, CRUD/FLS, bulk, trigger → handler → service → selector).
2. Prove it: `npm run lint` and `npx jest` if present;
   `sf project deploy validate --source-dir force-app --target-org <dev> --test-level RunSpecifiedTests --tests <classes>`.
   To click through it, `sf project deploy start --source-dir force-app --target-org <dev>` is allowed (DEV only).
3. Commit `<KEY> <what>`; `git push -u origin feature/<KEY>-<slug>`.

## 5. PR
1. Existing PR for the branch (`gh pr list --head feature/<KEY>-<slug> --json number,url`)? Update its body if the
   plan changed and stop here.
2. Write `.ai/pr-<KEY>.md`: Jira link, design page link, the plan (Approach, Files, Tests, Risks), validation result.
3. `gh pr create --base sprint/<name> --head feature/<KEY>-<slug> --title "<KEY> <summary>" --body-file .ai/pr-<KEY>.md`
4. `gh pr merge <n> --auto --squash` (merges only after `scan` passes and CodeRabbit or a lead approves).
5. **Report:** PR link. Next: `scan` runs, then CodeRabbit reviews. Failures or change requests → `dev-fix <n>`.
