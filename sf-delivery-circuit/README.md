# sf-delivery-circuit

A Claude Code plugin for AI + Human Salesforce delivery (v3). It takes a feature from a client call to a Confluence
design, Jira stories and test cases, code on a Developer-owned PR, and a release, with Architect, Developer and Tester
personas, nine human gates (G1 to G9), and a guard that keeps AI away from production, merges and approvals.

The design contract is [`../docs/CIRCUIT-V3.md`](../docs/CIRCUIT-V3.md). Connections are logins only; see
[`../ConnectionsSetup.md`](../ConnectionsSetup.md).

Install:

```
/plugin marketplace add pavansaikodanda/delivery-circuit
/plugin install sf-delivery-circuit@conscendo-delivery
```

See the [repository README](../README.md) for the full picture: the flow, the gates, and the workflows.

## What's inside

| Folder | Contents |
|---|---|
| `agents/` | `architect`, `developer`, `tester` personas, and the read-only `reviewer` that runs on the self-hosted runner |
| `skills/circuit/` | Map of the circuit, v3 conventions (Confluence, Jira, branches, labels), feature and story status |
| `skills/circuit-bootstrap/` | Sets up a client repo in v3 phases: no secrets, `acli` and MCP logins, self-hosted runner registration |
| `skills/circuit-intake/` | Source → spec drafted locally with Spec Kit → Confluence design page |
| `skills/arch-*` | `arch-design` (plan, data model, decisions, org snapshot, Lucid), `arch-approve-design` (human G1 steps; AI cannot approve), `arch-jira-push` (with `scripts/jira-sync.mjs`), `arch-review-pr` (G7) |
| `skills/dev-*` | `dev-review-stories` (Jira comments), `dev-start-story` (plan, branch, draft PR), `dev-review-plan` (G3), `dev-fix` (failed checks, cap 3), `dev-review-pr` (G5) |
| `skills/qa-*` | `qa-design-tests` (Jira test cases + local suite), `qa-push-tests` (G2), `qa-add-tests` (suite onto the story PR), `qa-review-testplan` (G4), `qa-explore` (G6) |
| `skills/review-room/` | Kick-off brief to `#review-room` and verdict to the PR, through the Slack MCP |
| `skills/record-decision/` | Adds a decision (date, decision, who, why, source link) to the design page (C1) |
| `hooks/hooks.json` | Registers circuit-guard for every session |
| `templates/repo/` | Installed into a client repo: CLAUDE.md, `.claude/` (settings, guard, persona MCP configs), CODEOWNERS, PR template, DoR/DoD, sf-config, `.coderabbit.yaml`, `scripts/ci/*`, `scripts/setup-persona.sh` |
| `templates/workflows/` | `design-gate`, `pr-checks`, `persona-gates`, `fix-router`, `deploy-prod` |
| `templates/github/` | Rulesets: main-branch gates; architects-only merge |
| `templates/bootstrap/` | `build.config.yml` and `build-state.md` |
| `tests/` | `guard.test.mjs` policy cases, including the v3 persona rules |

## Where things live (v3)

| What | Where |
|---|---|
| Spec, clarifications, plan, data model, decisions | Confluence design page (one per feature) |
| Org snapshot | child page "Org snapshot" of the design page |
| Epic, stories, test cases | Jira (story fields *Design page*, *Approved design version*, *Acceptance criteria*) |
| Story plan | on the story PR: `docs/plans/<KEY>/PLAN.md`, `TESTPLAN.md` |
| Runnable tests | on the story PR: `tests/<KEY>.tc.json`, `test-cases/<KEY>.sf-tests.yaml` |
| Code | on the story PR: `force-app/` |
| Transcript index | `.circuit/sources.json` (ids, titles, dates; no content) |
| Spec Kit drafts | `.specify/specs/` (local only, gitignored) |

`jira-map.json` is gone: epic and story keys come from Jira queries (epic link and labels).
`scripts/jira-sync.mjs` uses the Atlassian CLI (`acli`) or Atlassian MCP calls and stays idempotent; it reads no API
token.

## circuit-guard

`templates/repo/.claude/hooks/circuit-guard.mjs` is a PreToolUse hook. The plugin registers it for every session;
when a repo has its own copy (installed by the bootstrap), the plugin's copy steps aside so the repo's version wins.

| Rule | Applies to |
|---|---|
| No `sf` command against the alias the project names as production (`prod`, `production`, `live`, the `sf-config.yml` prod alias, `CIRCUIT_PROD_ALIASES`), including commands with no `--target-org` when the project default org is that alias. Orgs are not checked by type: any sandbox, scratch, Developer Edition, SDO or demo org can be DEV or QA | everyone |
| No `gh pr merge`, approving reviews, merges through the API, pushes to `main`/`master`, `deploy-prod` dispatch | everyone |
| No `gh pr create` for the Architect. The Developer may create draft PRs | personas |
| No force push; no changes to rulesets, branch protection or environments; no `plan-approved` / `testplan-approved` labels | personas |
| Real deploys: Developer and Architect none (check-only `deploy validate` only); Tester only to `CIRCUIT_DEPLOY_ORGS` (default `qa`) | personas |
| Developer can't write `test-cases/`, `tests/` or the constitution; Tester can write and commit only `tests/` and `test-cases/`; Architect can't write `force-app/` or tests | personas |
| AI never marks a design approved or sets a gate | everyone |
| No reading `*.key`, `*.pem`, `.env*`, `~/.sf`, `~/.sfdx` | everyone |

The persona is set by `CIRCUIT_PERSONA`, which the `cc-arch` / `cc-dev` / `cc-qa` aliases, the extension and the
runner jobs set.

## Conventions

Branch `feature/<KEY>-<slug>`; PR title starts with `<KEY>` (the GitHub for Atlassian app links it to Jira).
Test-case ids are per story; levels `ui`, `unit`, `manual`; code references them with `// TC: <id>`. Labels:
`ai-ready` (Jira, G2), `plan-approved` (G3), `testplan-approved` (G4), `needs-human`, `needs-qa`. Full list:
`skills/circuit/SKILL.md`.

## Development

```bash
node tests/guard.test.mjs
actionlint templates/workflows/*.yml
shellcheck -S warning templates/repo/scripts/ci/*.sh templates/repo/scripts/setup-persona.sh
claude plugin validate .        # from the repo root: validates the marketplace and this plugin
```
