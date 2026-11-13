# Delivery Circuit v4: the simple circuit

v4 replaces v3 ([CIRCUIT-V3.md](CIRCUIT-V3.md) is kept for history only). v3 had too many connections, gates and
moving parts. v4 keeps AI where it saves real time (design and build) and uses plain GitHub, Jira, Confluence and
CodeRabbit mechanics for everything else.

## 1. Principles

1. **AI designs and builds; people decide.** AI never approves a design, a story, a PR or a deployment.
2. **Few connections.** GitHub, the `sf` CLI, the Atlassian MCP (Jira + Confluence), Lucid, CodeRabbit (GitHub App +
   Slack agent). Fireflies is optional. No Claude Tag, no review-room debate, no self-hosted runner, no AI in CI.
3. **Branches are environments.** Merging into a branch deploys it to that branch's sandbox. Nobody deploys by hand.
4. **CI uses GitHub-hosted runners.** Each sandbox has a GitHub Environment holding one secret, `SFDX_AUTH_URL`
   (from `sf org display --verbose --json` → `sfdxAuthUrl`). That is the only stored credential. Laptops still use
   their own `sf`, `gh`, `claude` and MCP logins.
5. The repo holds code, tests and config. The design lives on Confluence; stories and test cases live in Jira.

## 2. The flow

| # | Who | What | Where |
|---|---|---|---|
| 1 | Architect | Brings a transcript: paste, file (.vtt/.srt/.txt/.md/.docx/.pdf) or Fireflies | extension "New design from transcript" / `/circuit-intake` |
| 2 | Architect + AI | AI reads the transcript and **checks the org** (`sf`, read-only, DEV alias): what already exists | `/circuit-intake` |
| 3 | Architect + AI | AI writes the **design page** on Confluence and a **Lucid diagram**. Every component is tagged **EXISTS · EXTEND · CHANGE · REBUILD · NEW**. Open questions are answered by people and recorded as decisions | `/circuit-intake`, `/arch-design`, `/record-decision` |
| 4 | Architect (human) | Sets the Confluence page status to **Approved** | Confluence |
| 5 | Architect + AI | AI creates the Jira **epic and stories** from the approved page. Each story carries its part of the change table (what exists, extend, change, rebuild, new), acceptance criteria and the design link | `/arch-jira-push` |
| 6 | Scrum team (humans) | Refinement: Developer and QA agree; the story moves to **Ready for Dev** | Jira |
| 7 | QA + AI | AI drafts **test cases** in Jira from the acceptance criteria and an SF AI Tester suite `test-cases/<KEY>.sf-tests.yaml` | `/qa-design-tests`, `/qa-add-tests` |
| 8 | Developer + AI | AI plans and builds the story on `feature/<KEY>-<slug>` (branched from the current sprint branch), validates against the developer's own DEV org, and opens the PR **into the sprint branch** with auto-merge on | `/dev-start-story` |
| 9 | GitHub Actions | **scan** job: Code Analyzer, LWC Jest, check-only deploy + Apex tests against the target sandbox. Only when scan passes, the **coderabbit** job comments `@coderabbitai review` | `pr-checks.yml` |
| 10 | CodeRabbit | Reviews. Approves, or requests changes (visible on the PR and in Slack) | GitHub, Slack |
| 11 | Developer + AI | Fixes failed checks or CodeRabbit comments | `/dev-fix` |
| 12 | GitHub | scan green + CodeRabbit review + human code-owner approval → auto-merge into the sprint branch → `deploy.yml` deploys the sprint branch to the **QA** sandbox | GitHub |
| 13 | QA | Manual testing in QA; SF AI Tester runs the story's suite; results go to Jira; story → Done or back to the Developer | QA sandbox, Jira |
| 14 | Team leads + Dev + QA | **Sprint review**: walk through what is implemented. A lead approves the promotion PR `sprint/<name>` → `dev` | GitHub |
| 15 | Leads | Promote by PR: `dev` → `sit` → `uat` → `main`. Each merge deploys to that sandbox. `main` deploys to production only after a required human approval on the `production` environment | GitHub |

## 3. Branches and environments

```
feature/<KEY>-<slug> ──PR──► sprint/<name> ──PR──► dev ──PR──► sit ──PR──► uat ──PR──► main
                             deploys QA            DEV          SIT          UAT          PROD (human approval)
```

The map lives in one place, `build.config.yml` → `environments` (branch pattern → GitHub Environment → sf alias):

```yaml
environments:
  - { branch: "sprint/*", environment: qa,         test_level: RunLocalTests }
  - { branch: dev,        environment: dev,        test_level: RunLocalTests }
  - { branch: sit,        environment: sit,        test_level: RunLocalTests }
  - { branch: uat,        environment: uat,        test_level: RunLocalTests }
  - { branch: main,       environment: production, test_level: RunLocalTests }
```

`scripts/ci/env-for-branch.mjs <branch>` (Node, no dependencies) reads this and prints `environment` and
`test_level`. Both workflows use it. Changing the ladder is a config edit.

Rules (rulesets created by `/circuit-bootstrap`):
- `sprint/*`, `dev`, `sit`, `uat`, `main`: no direct pushes, PR only, required check `scan`, linear history off,
  no force-push, no deletion.
- `sprint/*`: 1 human approval from a code owner (`developers` or `leads`, via CODEOWNERS; teams may raise it to 2). CodeRabbit is an extra layer: its review is required in practice because its "changes requested" blocks the merge, but its approval never replaces a person. Auto-merge allowed.
- `dev`, `sit`, `uat`, `main`: 1 approval from the `leads` team (promotion = sprint review / release sign-off).
- GitHub Environment `production`: required reviewers = `leads`, prevent self-review, branch `main` only.

## 4. CI

**`pr-checks.yml`** on `pull_request` to `sprint/**`, `dev`, `sit`, `uat`, `main`. GitHub-hosted (`ubuntu-latest`).
- `scan` (required): resolve the target environment from the **base** branch; install `@salesforce/cli` and
  the code-analyzer plugin; `sf code-analyzer run` (fail on severity 1–2); LWC Jest if present; log in with the
  environment's `SFDX_AUTH_URL` (`sf org login sfdx-url --sfdx-url-stdin`, never echoed) and
  `sf project deploy validate --source-dir force-app --test-level <test_level>`. Same-repo PRs only (fork PRs fail
  without running anything that touches secrets).
- `coderabbit`: `needs: scan`, only for PRs whose head is `feature/*` (promotion PRs skip it). Posts
  `@coderabbitai review` once per head commit with `GITHUB_TOKEN` (`pull-requests: write`). `.coderabbit.yaml` sets
  `auto_review.enabled: false`, so CodeRabbit reviews only after the scan passed, and `request_changes_workflow: true`.

**`deploy.yml`** on `push` to the same branches: resolve the environment from the branch, `environment:` set to it
(so production waits for its reviewers), log in with `SFDX_AUTH_URL`, `sf project deploy start --source-dir force-app
--test-level <test_level>`, and write a job summary. One deployment per environment at a time (`concurrency`).

Removed from v3: `design-gate.yml`, `persona-gates.yml`, `fix-router.yml`, `deploy-prod.yml`, the self-hosted runner
and every script that served them. No Claude, Jira or Slack calls from CI.

## 5. Plugin skills (names kept so the extension's buttons still work)

| Skill | Who | Does |
|---|---|---|
| `circuit` | all | Conventions: flow, branches, change tags, Jira story layout, what AI may never do |
| `circuit-bootstrap` | admin | Sets up a repo: files, branches `dev sit uat main` (+ first `sprint/<name>`), environments and their `SFDX_AUTH_URL` secrets (the admin pastes each with `gh secret set --env`), rulesets, CodeRabbit config, labels |
| `circuit-intake` | Architect | Transcript → org check → Confluence design page (+ change table) → Lucid diagram → open questions |
| `arch-design` | Architect | Answers open questions with the Architect, refines the change table, data model and story outline, sets status "Ready for review" (never Approved) |
| `record-decision` | Architect | Appends a decision row (date, decision, who, why, source) to the design page |
| `arch-jira-push` | Architect | Approved page → Jira epic + stories through the Atlassian MCP; idempotent (finds existing issues by label `feature-<slug>` and summary); Story 00 (shared data model) blocks the rest |
| `dev-review-stories` | Developer | Reads stories + design, comments buildability, estimate and dependencies on each Jira story (refinement prep) |
| `dev-start-story` | Developer | `<KEY>`: requires Ready for Dev; branch from the current sprint branch; plan in the PR body; build; local validate against the developer's DEV alias; push; `gh pr create --base sprint/<name>`; `gh pr merge --auto --squash` |
| `dev-fix` | Developer | Reads failed `scan` logs and CodeRabbit comments on the PR, fixes, pushes |
| `dev-review-plan`, `dev-review-pr` | Developer | Read-only second look at a PR before asking for review |
| `qa-design-tests` | QA | Jira test cases from the acceptance criteria (linked to the story) |
| `qa-add-tests` | QA | SF AI Tester suite `test-cases/<KEY>.sf-tests.yaml` from the Jira test cases, PR into the sprint branch |
| `qa-explore` | QA | Exploratory run in the QA sandbox; results as a Jira comment |
| `review-room` | Developer | Summarises CodeRabbit's review of a PR and, if the Slack MCP is connected, posts the summary and PR link to the team channel so people can ask `@coderabbit` there |

Removed: `arch-approve-design`, `arch-review-pr`, `qa-push-tests`, `qa-review-testplan` (folded into the ones above).

## 6. What AI may never do (guard hook)

- Push to or force-push `sprint/*`, `dev`, `sit`, `uat`, `main`; delete those branches.
- Approve or merge a PR (`gh pr review --approve`, `gh pr merge` without `--auto`, the equivalent `gh api` calls).
  Turning on auto-merge for the Developer's own feature PR is allowed: the rulesets still decide.
- Deploy anywhere except the developer's own DEV alias; never the production alias. Validate (`--dry-run` /
  `deploy validate`) is allowed against DEV.
- Set a Confluence page to Approved, or move a Jira story to Ready for Dev / Done.
- Read, print or set `SFDX_AUTH_URL` values, `sf org display --verbose`, or any secret.

## 7. VS Code extension

One sidebar view with **three tabs**. Nothing else opens except a story detail panel. Calm, short, one action per
row (keep the approved "Quiet Circuit" look: indigo/teal/slate, monochrome app logos, airy spacing).

Header: user · role chip (Architect / Developer / QA / Lead, click to switch) · refresh.

**Work** (default tab)
- *Next steps* for the current role, at most 5 rows, each with one button that starts the matching skill:
  - Architect: "New design from transcript" (paste, file or Fireflies chosen in a quick pick; transcript stays local
    and is never committed) → `/circuit-intake`; "Finish design <feature>" (open questions) → `/arch-design`;
    "Create stories for <feature>" (page Approved, no epic yet) → `/arch-jira-push`.
  - Developer: "Build <KEY>" (story Ready for Dev, no PR) → `/dev-start-story <KEY>`; "Fix <KEY>" (scan failed or
    CodeRabbit requested changes) → `/dev-fix <KEY>`; "Review PR #n" (a teammate's PR waits for a code-owner
    approval) → opens the PR.
  - QA: "Write tests for <KEY>" (Ready for Dev, no test cases) → `/qa-design-tests <KEY>` then `/qa-add-tests`;
    "Test <KEY> in QA" (merged into the sprint branch, deployed) → `/qa-explore <KEY>`.
  - Lead: "Sprint review: promote sprint/<name> → dev" (opens or creates the promotion PR); "Approve production
    deploy" (deploy.yml waiting on the production environment) → opens the run.
- *Sprint* list: the sprint's stories, one line each with a single status: Design · Ready · Building · In PR · QA ·
  Done. Click → story panel: a 5-step line (Design → Stories → Build → QA → Release), PR status (scan ✓/✗,
  CodeRabbit: approved / changes / pending, human approval), links (Jira, Design page, Diagram, PR).

**Connections** (about 7 rows, no tokens, no secrets): GitHub (`gh` / VS Code sign-in) · Claude (logged-in `claude`)
· Salesforce DEV org (`sf`; QA org for the QA role) · Atlassian (Jira + Confluence via the Atlassian MCP; `acli` only
if installed) · Lucid (Architect) · CodeRabbit (GitHub App on the repo) · Fireflies (optional). Each row: status dot,
who it is connected as, one button (Connect / Fix / Check). Rows not needed by the current role are hidden.

**Missing** (badge with a count; empty state "Nothing missing"): everything that blocks the flow, each with a fix
button or a link to the place to fix it:
- connections needed by this role that are not connected;
- repo setup: environment branches (`sprint/*`, `dev`, `sit`, `uat`, `main`), GitHub Environments without
  `SFDX_AUTH_URL` (checked by name only via `gh api`, never the value), rulesets, CodeRabbit app, auto-merge;
- story gaps: no approved design, no acceptance criteria, no test cases, PR without the Jira key, scan failing,
  CodeRabbit changes requested, waiting for a human approval for more than a day.

Removed from v3: the persona view, gates G1–G9 panel, feature page, Sources page (replaced by the quick pick),
Testing page (SF AI Tester has its own extension), Setup wizard (replaced by the Missing tab + `/circuit-bootstrap`),
token/secret/webhook rows, runner and Claude Tag rows. Commands: Refresh, Switch Role, New Design from Transcript,
Open Story.

## 8. Live test

[E2E-TEST-PLAN.md](E2E-TEST-PLAN.md): the "Case Escalation" use case (agents escalate a Case with a reason, it routes
to a Tier 2 queue, the account owner is notified) through every row of section 2, on an SDO org.
