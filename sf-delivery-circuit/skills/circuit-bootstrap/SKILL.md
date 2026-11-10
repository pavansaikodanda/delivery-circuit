---
name: circuit-bootstrap
description: Install and connect the AI + Human Salesforce delivery circuit in a client Salesforce DX repo, phase by phase (B0-B12) - tools, GitHub teams/App/secrets, Salesforce JWT access, repo files, Spec Kit + spec-kit-sf, Jira, Confluence/Lucid, Slack, workflows, rulesets, persona workstations, dry run - stopping at every human checkpoint. Use when setting up the circuit for a new project or resuming a setup from build-state.md.
---

# Bootstrap the delivery circuit (B0–B12)

You install the circuit into one repo and connect it to GitHub, Salesforce, Jira, Confluence and Slack.
**State lives in `build-state.md`** in the repo root: update it after every step; resume from it.

## Rules for the whole bootstrap
- Before each phase, re-check every fact marked VERIFY (action majors, CLI flags, MCP URLs, Setup labels) against
  official docs. Report differences **before** changing anything, and record them under "Facts re-checked".
- **Human checkpoints (HC-n):** stop, say exactly what the person must do, wait. Never do these yourself.
- **Secrets:** never print, paste or echo one. A person runs `gh secret set NAME` in **their own terminal** (the
  prompt is interactive; Claude's shell can't type into it), or Claude runs `gh secret set NAME < file` and then
  deletes the file. The guard blocks reading key files.
- **Claude authentication:** subscription only. CI uses `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` on a
  dedicated seat. Never create or set `ANTHROPIC_API_KEY`; never use `--bare` in CI.
- Never approve, merge, or deploy to production, and never log in to production. Production steps are HC-5.
- Pushing: only non-`main` branches (`pipeline/*`). A person merges each pipeline PR.
- End every phase by running its **Verify** steps and showing the results; mark DONE only when they pass.

Templates: `${CLAUDE_PLUGIN_ROOT}/templates/`. Installer: `${CLAUDE_PLUGIN_ROOT}/skills/circuit-bootstrap/scripts/install.mjs`.
Details for the Jira, Salesforce and Slack screens: `reference/connect.md` next to this file.

---

## B0 Preflight
1. Versions into `build-state.md`: `git gh node npm python uv sf claude openssl jq actionlint` and
   `sf plugins` (code-analyzer). Install what's missing (`npm i -g @salesforce/cli`,
   `sf plugins install @salesforce/plugin-code-analyzer`, `uv tool install specify-cli` (VERIFY), `jq`, `actionlint`).
2. `gh auth status`: needs scopes `repo, admin:org, workflow` (`gh auth refresh -s admin:org,workflow`).
3. Repo: clone it, or create it: `gh repo create <org>/<repo> --private --clone`, then
   `sf project generate --name <repo> --manifest` (VERIFY flags) and move the files to the repo root.
4. Run the installer in **dry-run** mode to show what will be added:
   `node .../install.mjs --repo . --org <org> --dry-run`. It also creates `build.config.yml` and `build-state.md`.
5. **HC-1:** the person fills `build.config.yml` (no secrets in it) and signs in to GitHub, Atlassian, the DEV and QA
   sandboxes and Slack in the browser.

Verify: every tool prints a version; `gh auth status` OK; config filled.

## B1 GitHub teams, labels, App, secrets
1. Teams `architects`, `developers`, `testers` (`gh api -X POST orgs/$ORG/teams -f name=… -f privacy=closed`), add
   members from config (`gh api -X PUT orgs/$ORG/teams/<t>/memberships/<user> -f role=member`), give each team
   `push` on the repo (`gh api -X PUT orgs/$ORG/teams/<t>/repos/$ORG/$REPO -f permission=push`).
   **Check the teams are disjoint**: one person in two persona teams would satisfy two gates with one approval.
2. Labels: `sdd needs-clarification plan-review plan-approved testplan-approved ai-generated ai-attempt-1 ai-attempt-2 ai-attempt-3 needs-human needs-qa`
   (`gh label create <l> -R $ORG/$REPO --force`).
3. **GitHub App** (browser, HC-2): org settings → Developer settings → GitHub Apps → New. No webhook. Repository
   permissions: Contents RW, Pull requests RW, Issues RW, Actions Read, **Commit statuses RW**, Metadata R;
   Organization: Members Read; **Workflows: none**. Generate a private key; install on this repo only.
4. Secrets/variables (person's terminal for interactive ones):
   ```bash
   gh secret set APP_ID -R $ORG/$REPO --body "<app id>"
   gh secret set APP_PRIVATE_KEY -R $ORG/$REPO < ~/Downloads/<app>.*.private-key.pem   # then delete the .pem
   claude setup-token                                   # HC-3: dedicated seat; prints a 1-year token
   gh secret set CLAUDE_CODE_OAUTH_TOKEN -R $ORG/$REPO  # HC-3: paste in the person's terminal, never in chat
   gh variable set MAX_AI_ATTEMPTS -R $ORG/$REPO --body 3
   gh variable set SF_INSTANCE_URL_SANDBOX -R $ORG/$REPO --body https://test.salesforce.com
   gh variable set SF_INSTANCE_URL_PROD -R $ORG/$REPO --body https://login.salesforce.com
   gh variable set SF_AI_TESTER_IN_CI -R $ORG/$REPO --body false      # true after one green qa job with it
   gh variable set SF_AI_TESTER_REF -R $ORG/$REPO --body <sha>        # commit of github.com/pavansaikodanda/sf-ai-tester
   gh variable set SF_AI_TESTER_MODE -R $ORG/$REPO --body manual
   gh api -X PUT repos/$ORG/$REPO/environments/production
   ```

Verify: teams and members listed; `gh secret list` shows APP_ID, APP_PRIVATE_KEY, CLAUDE_CODE_OAUTH_TOKEN and **no**
ANTHROPIC_API_KEY; a throwaway workflow (`workflow_dispatch`) gets an App token and runs `claude -p "say ok"` with
`CLAUDE_CODE_OAUTH_TOKEN`; delete it afterwards.

## B2 Salesforce access (DEV and QA here; production by the person)
1. Keys (one pair per org) in `~/.sfkeys`: `openssl req -x509 -newkey rsa:2048 -nodes -keyout dev.key -out dev.crt -days 730 -subj "/CN=delivery-dev"` (same for qa).
2. Browser, per sandbox (`reference/connect.md` → Salesforce): integration user (`ai-dev`: API, read, run tests,
   **check-only deploys allowed** so the AI can compile and test before a PR, nothing else; `ai-qa`: deploy, run tests,
   test-data DML), External Client App with JWT and the `.crt`, pre-authorised for the user's permission set. **HC-4**
   for licence and MFA prompts.
3. Test: `sf org login jwt --client-id <key> --username <user> --jwt-key-file ~/.sfkeys/dev.key --instance-url https://test.salesforce.com --alias ci-dev-test`,
   then `sf org display --target-org ci-dev-test` (no `--verbose`). Store
   `SF_CLIENT_ID_DEV`, `SF_USERNAME_DEV` (`--body`), `SF_JWT_KEY_DEV` (`< ~/.sfkeys/dev.key`). Same for QA.
   After both work, delete the `.key` files (keep the `.crt`).
4. **HC-5 production:** write `docs/prod-access-steps.md` (same steps, user `release`, deploy rights only); the person
   does them and runs `gh secret set SF_CLIENT_ID_PROD|SF_USERNAME_PROD|SF_JWT_KEY_PROD --env production`.

Verify: JWT login works for DEV and QA; `ai-dev` can `sf project deploy validate` but a real
`sf project deploy start` as `ai-dev` fails; `gh secret list --env production` shows the three PROD secrets and
`gh secret list` (repo) shows none of them.

## B3 Repo foundation
1. `git switch -c pipeline/foundation`; run the installer for real: `node .../install.mjs --repo . --org <org> --project-name "<client>"`.
   It adds CLAUDE.md, `.claude/` (agents, personas, hooks, merged settings, sf-ai-tester-suites skill), CODEOWNERS,
   PR template, DoR/DoD, `scripts/ci/*`, `scripts/setup-persona.sh`, `inputs/transcripts/README.md`,
   `.coderabbit.yaml`, `.specify/extensions/sf/sf-config.yml` and the workflows (the workflows are committed in B8).
2. Fill the MCP URLs in `.claude/personas/*.mcp.json` from official docs (VERIFY placeholders).
3. Commit everything **except** `.github/workflows/` (B8 adds those), push, open the PR. The person merges.

Verify: `claude` in the repo lists the agents; inside a `CIRCUIT_PERSONA=developer` session,
`sf project deploy start --target-org dev …` is denied by circuit-guard; CODEOWNERS shows no errors on the PR.

## B4 Spec Kit + spec-kit-sf
1. `git switch -c pipeline/speckit`:
   ```bash
   specify init --here --integration claude --integration-options="--no-model-invocation"   # VERIFY with specify init --help
   specify extension add sf --from https://github.com/Evernorth/spec-kit-sf/archive/refs/tags/v2.0.1.zip
   ```
   Then re-run the installer (it merges `.claude/settings.json` again, keeping Spec Kit's entries).
2. Read every installed `speckit-sf-*` skill; list anything that deploys, pushes or opens PRs (expected: deploy,
   hotfix, pr, regression). The guard blocks `speckit-sf-deploy|hotfix|pr`; delete those three skill folders as well.
   `regression` deploys to `qa` only, which the guard allows for the Tester.
3. Confirm `.specify/extensions/sf/sf-config.yml` has `prod: "none"`.
4. Constitution: run `/speckit-sf-constitution` against `dev`; append the house rules from CLAUDE.md as Article X.
5. Commit `.specify/` and `.claude/skills/`, open the PR; the **Architect** reviews and merges.

Verify: `specify extension list` shows sf 2.0.1; `.specify/memory/constitution.md` exists; invoking a deploy skill is
denied.

## B5 Jira (browser + REST checks) — see `reference/connect.md` → Jira
1. Service account `delivery-bot@…` with project access. **HC-6:** its API token → person runs
   `gh secret set JIRA_API_TOKEN`; Claude sets `JIRA_BASE_URL`, `JIRA_EMAIL` with `--body`.
2. Groups `architects`, `developers`, `testers`; project (company-managed); issue types Epic, Story, Test (Xray/Zephyr)
   or sub-task "Test Case"; custom fields: Spec file, Feature, Story type, Schema change, Persona, Test level, AC id,
   Testability confirmed, Acceptance criteria.
3. Workflow: Backlog → Design Review → Design Approved → Ready for Dev → Plan Review → In Build → Code Review → QA →
   Ready to Merge → Done. Design Review → Design Approved: `architects` only. Design Approved → Ready for Dev:
   `testers` only and "Testability confirmed" set (G2).
4. Automation: Rule A (dispatch, **key only** in the body), Rule B (status sync on the bot's comment texts and on PR
   merged). **HC-7:** the fine-grained PAT goes into Rule A's header, typed by the person.
5. GitHub for Jira app connected to the org.
6. `node ${CLAUDE_PLUGIN_ROOT}/skills/arch-jira-push/scripts/jira-sync.mjs discover --project <KEY> --out .specify/extensions/jira/jira-config.json`; commit via PR.

Verify (REST with the bot token): statuses and fields exist; moving a test issue to Ready for Dev as a non-tester is
refused; Rule A's audit log shows 204 from GitHub (temporary echo workflow on `repository_dispatch`, deleted after).

## B6 Confluence, Lucid, Fireflies
Space from config (only `architects` can set pages to Approved); Lucid for Confluence installed; the Architect signs
in to the Lucid and Fireflies MCPs (`/mcp` in `cc-arch`). Verify: the Architect alias lists spaces, creates a Lucid
doc and (if enabled) lists Fireflies transcripts.

## B7 Slack
Channels `#arch-gate`, `#dev-gate`, `#qa-gate`; one Slack app "Delivery Gates" with one incoming webhook per channel;
the person runs `gh secret set SLACK_WEBHOOK_ARCH|SLACK_WEBHOOK_DEV|SLACK_WEBHOOK_QA` and pastes each URL there.
Verify: a throwaway workflow posts to all three.

## B8 Workflows and CodeRabbit
1. `git switch -c pipeline/workflows`; add `.github/workflows/*` from the installer (8 files). Pin action majors to
   current versions (VERIFY each; list them in build-state.md).
2. `actionlint .github/workflows/*.yml` must be clean.
3. Install the CodeRabbit GitHub App on this repo only (browser).
4. Open the PR; the Architect merges (CODEOWNERS covers `.github/`).

Verify: actionlint clean; all workflows visible in Actions; CodeRabbit comments on the PR.

## B9 Protect main and production (HC-8)
1. Resolve the team id: `gh api orgs/$ORG/teams/architects --jq .id`; put it in a copy of
   `templates/github/ruleset-merge-architects.json`.
2. Show both rulesets (`ruleset-main.json`: PRs, code owners, stale-approval dismissal, required checks `guard static qa
   spec-gate gate/developer gate/tester gate/architect`, no force push or deletion, no bypass; and the merge ruleset:
   only `architects` may update `main`, through a PR). **HC-8:** the person confirms; then
   `gh api -X POST repos/$ORG/$REPO/rulesets --input <file>` for each.
3. Environment `production`: required reviewers = team `architects`, prevent self-review, branches `main` only.
4. Tag ruleset for `prod-deployed` with the App as the only bypass actor on that ruleset.

Verify: a developer cannot merge; the App token cannot push to `main`; a production deploy waits for approval.

## B10 Persona workstations
Each person runs `./scripts/setup-persona.sh architect|developer|tester`, opens a new terminal, starts `cc-arch` /
`cc-dev` / `cc-qa`, signs in to the MCPs with `/mcp`, and runs their first command. Install this plugin for each
person: `/plugin marketplace add <org>/<plugin-repo>` then `/plugin install sf-delivery-circuit@conscendo-delivery`.

## B11 Dry run (all acceptance tests)
1. Write `inputs/transcripts/000-sample-case-escalation.md`: a short made-up call with one new field, one Flow or
   trigger, one LWC, two personas with different access, clear answers.
2. Set `DEPLOY_ENVIRONMENT=production-dryrun` (an environment holding QA secrets under the PROD names) and
   `AI_LOOP_DRY_RUN=false`. Use Jira label `dryrun`.
3. Push it on `intake/sample`, then run the whole circuit with people at every gate (**HC-9**). Tick in build-state.md:
   spec PR + spec-gate red until G1 by an architect; Jira epic/Story 00/stories with blocks links, second push creates
   nothing; test cases per AC and persona, linked in Jira; Rule A fires only after Story 00 is Done and G2; draft PR has
   only PLAN.md and TESTPLAN.md with matching TC ids; build starts only after both labels by the right teams; removing
   a `// TC:` reference makes `static` fail; verification-evidence.md present; a forced failure gives 3 attempts then
   `needs-human`; a blocked AI-tester case gives `needs-qa`; merge is architect-only; deploy waits for approval.
4. Clean up: close dry-run issues, delete branches, keep the PRs as evidence; set `DEPLOY_ENVIRONMENT` back.

## B12 Go live
One small real feature, `transcripts.source: file`. Claude only watches and reports; people act at every gate.
Retro per persona → constitution, CLAUDE.md, `.coderabbit.yaml`, test conventions. Mark build-state.md COMPLETE.

## Emergency stop
`gh workflow disable` for `spec-from-transcript`, `claude-plan`, `claude-build`, `ai-fix-loop`; disable Jira Rule A.
Merges and deploys already need people.
