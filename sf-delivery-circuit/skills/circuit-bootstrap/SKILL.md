---
name: circuit-bootstrap
description: Install and connect the Delivery Circuit v3 in a client Salesforce DX repo, phase by phase (B0-B13) - tools, GitHub teams/labels/Actions settings, self-hosted runners and their own logins, Salesforce logins, repo files, Spec Kit (local drafting), Jira and the Atlassian CLI, Confluence/Atlassian MCP/Lucid/Fireflies, Slack review room, workflows, rulesets, persona workstations, dry run - with no stored credentials and a stop at every human checkpoint. Use when setting up the circuit for a new project or resuming a setup from build-state.md.
---

# Bootstrap the delivery circuit v3 (B0–B13)

You install the circuit into one repo and connect it to GitHub, Salesforce, Jira, Confluence, Fireflies and Slack.
**State lives in `build-state.md`** in the repo root: update it after every step; resume from it.
Contract: `docs/CIRCUIT-V3.md` in the plugin repo. Where this skill and the contract disagree, the contract wins.

## Rules for the whole bootstrap
- **No stored credentials, anywhere.** Every connection is a login the person (or the runner's service user)
  already has: `gh` / VS Code GitHub sign-in, the logged-in `claude` CLI (Claude Team seat), `sf` CLI logins,
  `acli jira auth login --web`, and MCP OAuth (Atlassian, Fireflies, Slack, Lucid). Never create or set a GitHub
  secret, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, a Salesforce JWT key, a Jira/Confluence/Fireflies API token
  or a Slack webhook. If a vendor screen offers a token, choose the browser login instead.
- Before each phase, re-check every fact marked VERIFY (action majors, CLI flags, MCP URLs, Setup labels) against
  official docs. Report differences **before** changing anything, and record them under "Facts re-checked".
- **Human checkpoints (HC-n):** stop, say exactly what the person must do, wait. Never do these yourself. Every
  browser sign-in is a human step: Claude's shell cannot finish an OAuth flow, and `claude -p` cannot sign in to MCPs.
- Never approve, merge, or deploy to the org the project names as production (`salesforce.prod_alias`), and never
  log in to it. Release-runner steps that touch it are HC-5. There are no org-type checks: any connected org may be
  DEV or QA.
- Pushing: only non-`main` branches (`pipeline/*`). A person merges each pipeline PR.
- End every phase by running its **Verify** steps and showing the results; mark DONE only when they pass.

Templates: `${CLAUDE_PLUGIN_ROOT}/templates/`. Installer: `${CLAUDE_PLUGIN_ROOT}/skills/circuit-bootstrap/scripts/install.mjs`.
Screens and commands for each system: `reference/connect.md` next to this file. Sample values below are placeholders
(acme-org, ACME, demo.user@example.com).

---

## B0 Preflight
1. Versions into `build-state.md`: `git gh node npm python uv sf claude jq actionlint shellcheck acli` and
   `sf plugins` (code-analyzer, sfdx-git-delta). Install what's missing (`npm i -g @salesforce/cli`,
   `sf plugins install @salesforce/plugin-code-analyzer`, `uv tool install specify-cli` (VERIFY), `jq`, `actionlint`,
   `shellcheck`; acli per `reference/connect.md` → Atlassian CLI).
2. `gh auth status`: needs scopes `repo, admin:org, workflow` (`gh auth refresh -s admin:org,workflow`).
3. Repo: clone it, or create it **private**: `gh repo create <org>/<repo> --private --clone`, then
   `sf project generate --name <repo> --manifest` (VERIFY flags) and move the files to the repo root.
4. Run the installer in **dry-run** mode to show what will be added:
   `node .../install.mjs --repo . --org <org> --dry-run`. It refuses to run if any template workflow or CI script
   reads a stored credential, and lists v2 files still in the repo as STALE.
5. **HC-1:** the person fills `build.config.yml` (created in B4; no secrets in it) and signs in, in the browser, to
   GitHub, Atlassian, the DEV and QA orgs and Slack.

Verify: every tool prints a version; `gh auth status` OK; the dry run prints no ERROR.

## B1 GitHub repo, teams, labels, Actions settings
1. Teams `architects`, `developers`, `testers` (`gh api -X POST orgs/$ORG/teams -f name=… -f privacy=closed`), add
   members from config (`gh api -X PUT orgs/$ORG/teams/<t>/memberships/<user> -f role=member`), give each team
   `push` on the repo (`gh api -X PUT orgs/$ORG/teams/<t>/repos/$ORG/$REPO -f permission=push`).
   **Check the teams are disjoint**: one person in two persona teams would satisfy two gates with one approval.
2. Labels (`gh label create <l> -R $ORG/$REPO --force`): the list the installer prints
   (`plan-review plan-approved testplan-approved ai-generated ai-attempt-1 ai-attempt-2 ai-attempt-3 needs-fix
   needs-human needs-qa`).
3. Actions settings (self-hosted runners make these mandatory):
   - keep the repo **private**. GitHub: "self-hosted runners should almost never be used for public repositories".
   - Private repo: Settings → Actions → General → *Fork pull request workflows*: leave "Run workflows from fork pull
     requests" **off**. Public repo (not recommended): "Require approval for **all external contributors**".
   - Workflow permissions: "Read repository contents and packages permissions" (each workflow asks for more per job).
4. Variables (no secrets; `gh variable set NAME -R $ORG/$REPO --body …`):
   `MAX_AI_ATTEMPTS=3`, `CIRCUIT_QA_ALIAS=qa`, `CIRCUIT_PROD_ALIAS=prod`, `CIRCUIT_RELEASE_ALIAS=prod`,
   `DESIGN_PENDING_STATUSES="Backlog,Design Review"`, `SLACK_CHANNEL_DEV=dev-gate`, `SLACK_CHANNEL_QA=qa-gate`,
   `CIRCUIT_SLACK_TRANSPORT=claude`, `SF_AI_TESTER_IN_CI=false`, `SF_AI_TESTER_REF=<sha>`, `SF_AI_TESTER_MODE=manual`.
   `JIRA_FIELD_APPROVED_DESIGN_VERSION` / `JIRA_FIELD_DESIGN_PAGE` only if B6's jira-config.json is not committed.

Verify: teams and members listed and disjoint; labels listed; `gh secret list -R $ORG/$REPO` is **empty**;
`gh api repos/$ORG/$REPO --jq .private` is `true` (or the public-repo approval setting is shown in the UI).

## B2 Self-hosted runners and their logins
Two runners, two machines or two service users (see `reference/connect.md` → Self-hosted runners):
- `circuit` (labels `self-hosted, circuit`): PR checks that need logins (QA deploy, Apex, SF AI Tester, AI Reviewer,
  Code Analyzer), `design-gate`, `persona-gates`, `fix-router`. Holds DEV/QA logins only, **never** production.
- `circuit-release` (labels `self-hosted, circuit-release`): `deploy-prod` only. Holds the one login to the
  production alias, no AI tooling needed.
1. Registration token (expires in 1 hour): `gh api -X POST repos/$ORG/$REPO/actions/runners/registration-token --jq .token`.
   **HC-2:** the person runs the runner's `config.sh` / `config.cmd` on the machine with
   `--url https://github.com/$ORG/$REPO --token <token> --labels circuit` (or `circuit-release`) and installs it as a
   service. Claude never sees the token in chat: the person pipes it straight from `gh` on the runner machine.
2. **HC-3:** as the runner's service user, the person signs in once: `gh auth login` (scopes `repo, read:org`),
   `claude` (Claude Team seat; then `/mcp` → sign in to the Slack connector if Slack notices use transport `claude`),
   `acli jira auth login --web`, and on `circuit` only `sf org login web --alias dev` / `--alias qa` (or
   `sf org login device` on a headless machine). Install `sf plugins install @salesforce/plugin-code-analyzer` and
   `sfdx-git-delta` (release runner), Node 22, jq, and the SF AI Tester (`scripts/ci/install-sf-ai-tester.sh` with
   `SF_AI_TESTER_WITH_DEPS=1`, once).
3. **HC-5 production:** on `circuit-release` only, the person runs `sf org login web --alias prod` (the name in
   `salesforce.prod_alias`). Claude does not.

Verify: `gh api repos/$ORG/$REPO/actions/runners --jq '.runners[] | {name, status, labels: [.labels[].name]}'` shows
both runners online with the right labels; on each runner, from a checkout:
`bash scripts/ci/runner-check.sh --gh --acli --claude --sf dev --sf qa --not-sf prod` (circuit) and
`bash scripts/ci/runner-check.sh --tools sf,jq,git --sf-plugin sfdx-git-delta --sf prod` (release) print `ok`.

## B3 Salesforce logins (people)
1. DEV and QA are any connected orgs (sandbox, scratch, Developer Edition or a demo org). Each person logs in with
   their own user: `sf org login web --alias dev` / `--alias qa`. No integration users, no External Client App, no
   JWT key.
2. `.specify/extensions/sf/sf-config.yml` names the production alias; the guard blocks AI deploys to it and to
   `prod`, `production`, `live` and any name in `CIRCUIT_PROD_ALIASES`.
3. Permission hygiene (recommended): Developers deploy only check-only to DEV from their AI sessions (the guard
   enforces it); QA deploys come from the `circuit` runner.

Verify: `sf org list` on each laptop shows dev and qa and **no** production alias (Architect laptops may hold it for
manual work; their AI sessions are still blocked by the guard).

## B4 Repo foundation
1. `git switch -c pipeline/foundation`; run the installer for real:
   `node .../install.mjs --repo . --org <org> --project-name "<client>" [--prune]`.
   It adds CLAUDE.md, `.claude/` (agents, personas, hooks, merged settings, sf-ai-tester-suites skill), CODEOWNERS,
   PR template, DoR/DoD, `scripts/ci/*`, `scripts/setup-persona.sh`, `.github/actionlint.yaml`,
   `inputs/transcripts/README.md` (a pointer: transcripts never enter git), `.coderabbit.yaml`,
   `.specify/extensions/sf/sf-config.yml`, `build.config.yml`, `build-state.md` and the workflows (committed in B9).
   `--prune` deletes v2 files (`claude-plan.yml`, `claude-build.yml`, `ai-fix-loop.yml`, `spec-gate.yml`,
   `scripts/ci/sf-login.sh`).
2. Check the MCP URLs in `.claude/personas/*.mcp.json` against official docs (VERIFY).
3. Commit everything **except** `.github/workflows/` (B9 adds those), push, open the PR. The person merges.

Verify: `claude` in the repo lists the agents; inside a `CIRCUIT_PERSONA=developer` session,
`sf project deploy start --target-org dev …` is denied by circuit-guard; inside `CIRCUIT_PERSONA=architect`,
`gh pr create` is denied; CODEOWNERS shows no errors on the PR.

## B5 Spec Kit (the Architect's local drafting scaffold)
1. `git switch -c pipeline/speckit`:
   ```bash
   specify init --here --integration claude --integration-options="--no-model-invocation"   # VERIFY with specify init --help
   specify extension add sf --from https://github.com/Evernorth/spec-kit-sf/archive/refs/tags/v2.0.1.zip   # VERIFY tag
   ```
   Then re-run the installer (it merges `.claude/settings.json` again, keeping Spec Kit's entries).
2. Read every installed `speckit-sf-*` skill; the guard blocks `speckit-sf-deploy|hotfix|pr`; delete those three
   skill folders as well.
3. `.specify/specs/` stays **gitignored** (the circuit block in `.gitignore`): specs are published to Confluence and
   Jira, never committed. Commit `.specify/memory/constitution.md`, `.specify/extensions/` and `.claude/skills/`.
4. Constitution: run `/speckit-sf-constitution` against `dev`; append the house rules from CLAUDE.md as Article X.
5. Open the PR; the **Architect** reviews and merges.

Verify: `specify extension list` shows sf; `git check-ignore .specify/specs/x` matches; invoking a deploy skill is
denied.

## B6 Jira and acli — see `reference/connect.md` → Jira
1. Every person and both runners: acli installed and signed in (`acli jira auth login --web`); `acli jira auth status`.
   Record the acli version and its support end date (6 months) under Reminders.
2. **HC-6 (Jira admin, browser):** groups `architects`, `developers`, `testers`; project (company-managed); issue
   types Epic, Story, Test (Xray/Zephyr) or sub-task "Test Case"; custom fields *Design page*, *Approved design
   version*, *Acceptance criteria*, *Story type*, *Schema change*, *Persona*, *Test level*, *AC id*, *Testability
   confirmed*.
3. Workflow (epic): Backlog → Design Review → **Approve design** (transition restricted to `architects`, screen sets
   *Approved design version*) → Design Approved. Story: Backlog → Ready for Dev (`testers` only, *Testability
   confirmed* set: G2) → In Build → Code Review → QA → Done. `design-gate` treats the epic statuses in
   `DESIGN_PENDING_STATUSES` as "not approved".
4. **GitHub for Atlassian** app: Jira site admin + GitHub org owner connect the org (HC-6). Branches
   `feature/<KEY>-<slug>` and PR titles `<KEY> …` link automatically.
5. Field ids: build `.specify/extensions/jira/jira-config.json` once as `arch-jira-push` describes (Atlassian MCP
   `getJiraIssueTypeMetaWithFields` + `listJiraIssueLinkTypes`); commit via PR (`design-gate` reads it on the runner).
   `node ${CLAUDE_PLUGIN_ROOT}/skills/arch-jira-push/scripts/jira-sync.mjs status` shows acli as logged-in.

Verify: `acli jira workitem search --jql "project = <KEY>" --limit 1 --json` works on a laptop and on the `circuit`
runner; a non-architect cannot run **Approve design** on a test epic; a non-tester cannot move a test story to
Ready for Dev.

## B7 Confluence, Atlassian MCP, Lucid, Fireflies
1. Space from config (`confluence.space_key`); a space admin adds **Approved** as a suggested page status (Space
   settings → Content status). Confluence cannot limit status changes to a group: restrict **edit** of approved
   design pages to `architects` (page restrictions), and the circuit checks the approver from page history
   (`arch-approve-design`).
2. Lucid for Confluence installed (HC-7, admin).
3. Each Architect, in an interactive `cc-arch` session: `/mcp` → sign in to `atlassian` (Rovo MCP, OAuth),
   `lucid`, `fireflies`. Developers and Testers sign in to `atlassian` (and Slack, B8). `claude -p` cannot run the
   OAuth flow, so this must happen interactively first.

Verify: in the Architect session, `listConfluenceSpaces` shows the space, `getJiraIssue` reads a test issue, a Lucid
document can be created, and (if used) `fireflies_get_transcripts` lists meetings.

## B8 Slack and the review room
1. Channels `#arch-gate`, `#dev-gate`, `#qa-gate`, `#review-room` (names from config).
2. **HC-8 (Slack admin):** approve the Claude Slack connector (claude.ai → Connectors → Slack) for the workspace,
   install the **GitHub app for Slack** and subscribe `#arch-gate` to deployments and `#dev-gate` to PRs/labels;
   invite CodeRabbit and Claude to `#review-room`.
3. Each person (and the `circuit` runner's service user when transport is `claude`) signs in to the Slack MCP once in
   an interactive session. No webhook URL, no bot token.

Verify: from a Developer session, the Slack MCP posts and reads a thread in `#review-room`; on the runner,
`CIRCUIT_SLACK_TRANSPORT=claude bash scripts/ci/slack.sh dev-gate "Circuit test notice"` prints "sent".

## B9 Workflows and CodeRabbit
1. `git switch -c pipeline/workflows`; add the five v3 workflows from the installer: `pr-checks.yml`,
   `design-gate.yml`, `persona-gates.yml`, `fix-router.yml`, `deploy-prod.yml`. Pin action majors to current
   versions (VERIFY each; list them in build-state.md).
2. `actionlint .github/workflows/*.yml` must be clean (uses `.github/actionlint.yaml` for the runner labels), and
   `shellcheck scripts/ci/*.sh`.
3. Install the CodeRabbit GitHub App on this repo only (browser).
4. Open the PR; the Architect merges (CODEOWNERS covers `.github/`).

Verify: actionlint and shellcheck clean; all five workflows visible in Actions; on a same-repo test PR `guard` and
`static` run on GitHub-hosted runners and `code-analyzer`, `qa`, `design-gate` on `circuit`; CodeRabbit comments.

## B10 Protect main and production (HC-9)
1. Resolve the team id: `gh api orgs/$ORG/teams/architects --jq .id`; put it in a copy of
   `templates/github/ruleset-merge-architects.json`.
2. Show both rulesets (`ruleset-main.json`: PRs, code owners, stale-approval dismissal, required checks `guard static
   code-analyzer qa design-gate gate/developer gate/tester gate/architect`, no force push or deletion, no bypass; and
   the merge ruleset: only `architects` may update `main`, through a PR). **HC-9:** the person confirms; then
   `gh api -X POST repos/$ORG/$REPO/rulesets --input <file>` for each.
3. Environment `production`: required reviewers = team `architects`, prevent self-review, branches `main` only
   (`gh api -X PUT repos/$ORG/$REPO/environments/production` then the reviewers in the UI).

Verify: a developer cannot merge; a production deploy waits for approval and runs only on `circuit-release`.

## B11 Persona workstations
Each person: install the Delivery Circuit VS Code extension and this plugin
(`/plugin marketplace add <org>/<plugin-repo>`, `/plugin install sf-delivery-circuit@<marketplace>`), then
`./scripts/setup-persona.sh architect|developer|tester`, opens a new terminal, starts `cc-arch` / `cc-dev` / `cc-qa`,
signs in to the MCPs with `/mcp`, and checks the extension's Connections page (all green: GitHub, Claude, sf, acli,
Atlassian MCP, Fireflies MCP, Slack MCP, runner online).

## B12 Dry run (every persona, every app)
1. Set `DEPLOY_ENVIRONMENT=production-dryrun` (an environment whose variable `CIRCUIT_RELEASE_ALIAS=qa`; for the dry
   run the person also logs the `circuit-release` service user in to `qa`, and logs it out afterwards) and
   `FIX_ROUTER_DRY_RUN=false`. Use Jira label `dryrun`.
2. Run one made-up feature through every step of the v3 flow with people at every gate (**HC-10**). Tick in
   build-state.md: source added; Confluence design page with Decisions and Org snapshot; G1 by an architect at
   version N; epic + Story 00 + stories with *Approved design version* N and blocks links (a second push creates
   nothing); test cases per AC in Jira; G2; "Start story" creates `feature/<KEY>-<slug>` and a draft PR; Tester adds
   tests to the PR; G3/G4 by the right teams; removing a `// TC:` reference makes `static` fail; re-approving the
   design at N+1 makes `design-gate` fail with "Design changed since this story was planned"; a forced failure gives
   `needs-fix` up to 3 attempts then `needs-human`; a blocked AI-tester case gives `needs-qa`; review room thread and
   verdict on the PR; merge is architect-only; deploy waits for approval and runs on `circuit-release`.
3. Clean up: close dry-run issues, delete branches, keep the PRs as evidence; set `DEPLOY_ENVIRONMENT` back.

## B13 Go live
One small real feature. Claude only watches and reports; people act at every gate. Retro per persona → constitution,
CLAUDE.md, `.coderabbit.yaml`, test conventions. Mark build-state.md COMPLETE.

## Emergency stop
`gh workflow disable fix-router -R $ORG/$REPO` (and `pr-checks` if the runner is suspect); stop the runner service
(`sudo ./svc.sh stop`, or `Stop-Service "actions.runner.*"` on Windows). No AI runs in CI except the read-only AI
Reviewer and SF AI Tester on `circuit`; merges and deploys already need people.
