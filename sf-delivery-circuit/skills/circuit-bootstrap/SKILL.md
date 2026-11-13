---
name: circuit-bootstrap
description: Set up the Delivery Circuit v4 in a client Salesforce DX repo, phase by phase (B0-B10) - install the files, create the branch ladder (main, uat, sit, dev, first sprint/<name>), GitHub teams, labels and auto-merge, one GitHub Environment per sandbox (qa, dev, sit, uat, production) whose SFDX_AUTH_URL secret the admin sets without Claude seeing it, CodeRabbit, rulesets, Jira/Confluence, workstations and a dry run, with a stop at every human checkpoint. Use when setting up the circuit for a new project or resuming a setup from build-state.md.
---

# Bootstrap the delivery circuit v4 (B0–B10)

You install the circuit into one repo and connect it to GitHub, Salesforce, CodeRabbit, Jira and Confluence.
**State lives in `build-state.md`** in the repo root: update it after every step; resume from it.
Contract: `docs/CIRCUIT-V4.md` in the plugin repo (sections 3 and 4 for branches, environments and CI). Where this
skill and the contract disagree, the contract wins.

## Rules for the whole bootstrap
- **One stored credential type, and Claude never touches it.** Each GitHub Environment holds one secret,
  `SFDX_AUTH_URL`. The admin creates it in their own terminal by piping `sf org display --verbose --json` into
  `gh secret set` (B5). You never run `sf org display --verbose`, never run `gh secret set`, never ask for, read,
  print or store an auth URL, and never put one in a file, a chat or `build.config.yml`. Everything else is a login
  (`gh`, `sf`, `claude`, MCP OAuth). Never create `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, a Salesforce JWT
  key, a Jira/Confluence API token or a Slack webhook.
- Before each phase, re-check every fact marked VERIFY (action majors, CLI flags, API fields, Setup labels) against
  official docs. Report differences **before** changing anything, and record them under "Facts re-checked".
- **Human checkpoints (HC-n):** stop, say exactly what the person must do, wait. Every browser sign-in and every
  secret is a human step.
- Never approve or merge a PR, never deploy to the production alias (`salesforce.prod_alias`) and never log in to it.
- Pushing: only the setup branch `circuit/setup`. A person merges its PR.
- End every phase by running its **Verify** steps and showing the results; mark DONE only when they pass.

Templates: `${CLAUDE_PLUGIN_ROOT}/templates/`. Installer: `${CLAUDE_PLUGIN_ROOT}/skills/circuit-bootstrap/scripts/install.mjs`.
Screens and commands for each system: `reference/connect.md` next to this file. Sample values are placeholders
(acme-org, acme-salesforce, ACME, demo.user@example.com). Below, `$ORG/$REPO` come from `build.config.yml` → `github`.

---

## B0 Preflight
1. Versions into `build-state.md`: `git gh node npm sf jq claude` and `sf plugins` (code-analyzer is optional on
   laptops; CI installs it). Install what is missing (`npm i -g @salesforce/cli`).
2. `gh auth status`: needs scopes `repo, admin:org, workflow` (`gh auth refresh -s admin:org,workflow`).
3. Repo: clone it, or create it **private**: `gh repo create $ORG/$REPO --private --clone`, then
   `sf project generate --name $REPO --manifest` (VERIFY flags) and move the files to the repo root.
4. Installer dry run: `node .../install.mjs --repo . --org $ORG --dry-run`. It refuses to run if a template workflow
   or CI script reads any secret other than `secrets.SFDX_AUTH_URL`, and lists v2/v3 leftovers as STALE.

Verify: every tool prints a version; `gh auth status` OK; the dry run prints no ERROR.

## B1 Project settings (HC-1)
The person fills `build.config.yml` (the installer adds it in B2; template: `templates/bootstrap/build.config.yml`):
`github`, `people` (architects, developers, testers, **leads**: GitHub login, Atlassian email, Slack handle),
`jira` (site, project key, `ready_status`, `test_issue_type`), `confluence.space_key`, `salesforce` (`dev_alias`,
`prod_alias`, `api_version`), `environments` (keep the default ladder unless the project has other sandboxes),
`slack` and `transcripts`. No secrets in it.

Verify: `node scripts/ci/env-for-branch.mjs sprint/2026-S1` prints `environment=qa`; `... main` prints
`environment=production`; every `people` list has at least one `gh` login.

## B2 Repo files
1. `git switch -c circuit/setup`; run the installer for real:
   `node .../install.mjs --repo . --org $ORG --project-name "<client>" [--prune]`. It adds CLAUDE.md, `.claude/`
   (hooks, personas, merged settings, sf-ai-tester-suites skill), CODEOWNERS, PR template, DoR/DoD,
   `scripts/ci/env-for-branch.mjs`, `.coderabbit.yaml`, `inputs/transcripts/README.md`, `build.config.yml`,
   `build-state.md` and the two workflows `pr-checks.yml` and `deploy.yml`. `--prune` deletes v2/v3 leftovers
   (`design-gate.yml`, `persona-gates.yml`, `fix-router.yml`, `deploy-prod.yml`, the old `scripts/ci/*` scripts,
   `.github/actionlint.yaml`).
2. If `actionlint` is installed: `actionlint .github/workflows/*.yml` must be clean.
3. Commit, push `circuit/setup`, open the PR into `main` (an empty repo: push the first commit to `main` instead,
   with the person's OK). The person merges.

Verify: the PR shows both workflows; its `scan` fails with "has no SFDX_AUTH_URL secret" until B5 (expected: no
ruleset requires it yet, so the person can still merge); in a
`CIRCUIT_PERSONA=developer` session the guard refuses `gh pr merge` without `--auto`.

## B3 Branch ladder
Branches are environments (contract section 3):
`feature/<KEY>-<slug> → sprint/<name> → dev → sit → uat → main`.
1. From the merged `main`: create `uat`, `sit`, `dev` and the first sprint branch (name agreed with the team, e.g.
   `sprint/2026-S1`), each from the `main` head:
   ```bash
   SHA=$(gh api repos/$ORG/$REPO/git/ref/heads/main --jq .object.sha)
   for b in uat sit dev sprint/2026-S1; do gh api -X POST repos/$ORG/$REPO/git/refs -f ref=refs/heads/$b -f sha=$SHA; done
   ```
   If the guard refuses (these are protected names), the admin runs the same commands.
2. Default branch stays `main`. Record the sprint branch in `build-state.md`; Developers branch features from it.

Verify: `gh api repos/$ORG/$REPO/branches --jq '.[].name'` lists all five.

## B4 GitHub teams, labels and settings
1. Teams `architects`, `developers`, `testers`, `leads` (`gh api -X POST orgs/$ORG/teams -f name=… -f privacy=closed`),
   members from `people` (`gh api -X PUT orgs/$ORG/teams/<t>/memberships/<user> -f role=member`), repo access
   `push` for each team (`gh api -X PUT orgs/$ORG/teams/<t>/repos/$ORG/$REPO -f permission=push`).
2. Labels (`gh label create <l> -R $ORG/$REPO --force`): `ai-generated`, `needs-fix` (the installer prints the list).
3. Repo settings: auto-merge on, squash merge allowed, head branches deleted after merge:
   `gh repo edit $ORG/$REPO --enable-auto-merge --enable-squash-merge --delete-branch-on-merge`.
4. Actions settings: Settings → Actions → General → Workflow permissions "Read repository contents and packages"
   (each job asks for more). Fork PR workflows: private repo, leave "Run workflows from fork pull requests" off;
   public repo, "Require approval for all external contributors". Fork PRs fail `scan` anyway and never get a secret.

Verify: `gh api repos/$ORG/$REPO --jq '{allow_auto_merge, allow_squash_merge, delete_branch_on_merge}'` all true;
teams and labels listed.

## B5 Environments and their SFDX_AUTH_URL (HC-2)
One GitHub Environment per row of `environments`: `qa`, `dev`, `sit`, `uat`, `production`.
1. Create them: `gh api -X PUT repos/$ORG/$REPO/environments/<env>` for the four sandboxes.
2. `production`: resolve the leads team id (`gh api orgs/$ORG/teams/leads --jq .id`), put it into a copy of
   `templates/github/environment-production.json` (replace `"LEADS_TEAM_ID"` with the number), then
   `gh api -X PUT repos/$ORG/$REPO/environments/production --input <copy>` and allow branch `main`:
   `gh api -X POST repos/$ORG/$REPO/environments/production/deployment-branch-policies -f name=main -f type=branch`.
   Required reviewers = `leads`, prevent self-review on.
   VERIFY on the first `uat → main` PR: its `scan` validates against `production` and needs the secret. If GitHub
   refuses the job because of the branch rule, also allow `uat` (the promotion PR's head) and note it in
   build-state.md; every such scan then waits for a lead's approval as well.
3. **HC-2, the admin, in their own terminal (never through Claude):** log in to each org with a dedicated CI user
   (`sf org login web --alias <alias>`), then for each environment:
   ```bash
   sf org display --verbose --json --target-org <alias> | jq -r .result.sfdxAuthUrl \
     | gh secret set SFDX_AUTH_URL --env <env> --repo $ORG/$REPO
   ```
   (`gh secret set` reads the value from stdin; nothing is echoed or saved.) Claude does not run this, does not see
   the output and does not ask for it. A sandbox refresh or the CI user's password policy can invalidate the URL:
   repeat this step for that environment.
4. Record in build-state.md which alias/user feeds which environment (names only).

Verify: `gh secret list --env <env> -R $ORG/$REPO` shows `SFDX_AUTH_URL` (name and date only) for all five;
`gh api repos/$ORG/$REPO/environments/production --jq '.protection_rules'` shows the reviewers.

## B6 CodeRabbit
1. **HC-3 (GitHub org owner):** install the CodeRabbit GitHub App on this repo with write access (its approval only
   counts on `sprint/*` when it can write: VERIFY on the first PR).
2. `.coderabbit.yaml` (installed in B2): `auto_review.enabled: false`, so CodeRabbit reviews only when the
   `coderabbit` job comments `@coderabbitai review` after `scan` passed; `request_changes_workflow: true`.
3. **HC-4 (Slack admin, optional):** add the CodeRabbit Slack agent to the workspace and the channel in
   `slack.channel`, so people can ask `@coderabbit` there and `/review-room` can post summaries.

Verify: CodeRabbit appears under Settings → GitHub Apps; on the dry-run PR (B10) it reviews only after `scan`.

## B7 Rulesets (HC-5)
1. Copy `templates/github/ruleset-promotion.json` and replace `"LEADS_TEAM_ID"` with the leads team id (number).
2. Show both rulesets to the person:
   - `ruleset-sprint.json` (`refs/heads/sprint/*`): PR only, 1 approval (CodeRabbit's counts when the app has write
     access; else a Developer lead approves), required check `scan`, no force-push, no deletion, no linear-history
     rule; auto-merge allowed.
   - `ruleset-promotion.json` (`dev`, `sit`, `uat`, `main`): PR only, 1 approval from the `leads` team, required
     check `scan`, no force-push, no deletion. VERIFY the `required_reviewers` field of the pull_request rule
     (team-scoped reviewers); if the API rejects it, drop that field and require code-owner review with
     `* @<org>/leads` in CODEOWNERS on those branches instead.
3. **HC-5:** the person confirms; then `gh api -X POST repos/$ORG/$REPO/rulesets --input <file>` for each.

Verify: `gh api repos/$ORG/$REPO/rulesets --jq '.[].name'` lists `circuit-sprint` and `circuit-promotion`; a direct
`git push` to `dev` is rejected.

## B8 Jira, Confluence, Atlassian MCP, Lucid (HC-6)
See `reference/connect.md` → Atlassian. Jira project with the `ready_status` ("Ready for Dev") in the story workflow
(people move stories there at refinement) and the `test_issue_type`; Confluence space `space_key` with **Approved**
as a page status (set by Architects only). Each person signs in to the Atlassian MCP with `/mcp`; Architects also
to Lucid (and Fireflies, optional). Install "GitHub for Atlassian" so `feature/<KEY>-…` branches link to stories.

Verify: from a Claude session the Atlassian MCP reads a Jira issue and lists the Confluence space.

## B9 Workstations
Each person: the Delivery Circuit VS Code extension and this plugin (`/plugin marketplace add <org>/<plugin-repo>`,
`/plugin install sf-delivery-circuit@<marketplace>`), `gh auth login`, `sf org login web --alias <dev_alias>` (their
own DEV org; nobody but the admin in B5 needs sandbox CI users), `claude` signed in, `/mcp` sign-ins. Nobody's laptop
needs the production alias for the circuit.

## B10 Dry run (HC-7)
One made-up change through the whole ladder, people acting at every step:
feature PR into `sprint/<name>` → `scan` green → `coderabbit` posts `@coderabbitai review` once (a second push gives
a new marker for the new SHA, a re-run does not post twice) → CodeRabbit approves → auto-merge → `deploy` to `qa`
with a job summary → promotion PRs `sprint → dev → sit → uat → main`, each needing a lead and deploying its sandbox
→ the `production` deploy waits for a lead's approval (approve it only if the change is safe, or reject it to end the
dry run). Also check: a fork PR (or a PR from a branch whose base has no environment entry) fails `scan`.
Tick each step in build-state.md; clean up the dry-run branches.

## Emergency stop
`gh workflow disable deploy -R $ORG/$REPO` stops all deployments; `gh workflow disable pr-checks` stops PR checks
(merges then block on the required `scan`). Rotating a leaked or stale auth URL: the admin logs the CI user out
(`sf org logout`), revokes its OAuth session in Salesforce Setup, and repeats B5.3 for that environment.
