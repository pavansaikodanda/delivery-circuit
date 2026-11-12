# sf-delivery-circuit

A Claude Code plugin for AI + Human Salesforce delivery. It handles transcript → spec → Jira → test cases → code →
deploy, with Architect, Developer and Tester personas, nine human gates (G1–G9), and a guard that keeps AI away from
production, merges and approvals.

Install:

```
/plugin marketplace add pavansaikodanda/delivery-circuit
/plugin install sf-delivery-circuit@conscendo-delivery
```

See the [repository README](../README.md) for the full picture: what each stage does, the gates, and the workflows.

## What's inside

| Folder | Contents |
|---|---|
| `agents/` | `architect`, `developer`, `tester` personas, and the read-only `reviewer` used in CI |
| `skills/circuit/` | Map of the circuit, shared conventions (folders, ids, branches, labels), feature/story status |
| `skills/circuit-bootstrap/` | B0–B12 setup of a client repo; `scripts/install.mjs` copies the templates; `reference/connect.md` has the Salesforce/Jira/Slack screens |
| `skills/circuit-intake/` | Transcript → spec → clarification → plan |
| `skills/arch-*` | `arch-design`, `arch-jira-push` (with `scripts/jira-sync.mjs`), `arch-review-pr` |
| `skills/dev-*` | `dev-review-stories`, `dev-review-plan` (G3), `dev-review-pr` (G5) |
| `skills/qa-*` | `qa-design-tests`, `qa-push-tests` (G2), `qa-review-testplan` (G4), `qa-explore` (G6) |
| `hooks/hooks.json` | Registers circuit-guard for every session |
| `templates/repo/` | Installed into a client repo: CLAUDE.md, `.claude/` (settings, guard, persona MCP configs), CODEOWNERS, PR template, DoR/DoD, sf-config, `.coderabbit.yaml`, `scripts/ci/*`, `scripts/setup-persona.sh` |
| `templates/workflows/` | 7 GitHub Actions workflows |
| `templates/github/` | Rulesets: main-branch gates; architects-only merge |
| `templates/bootstrap/` | `build.config.yml` and `build-state.md` |
| `tests/` | `guard.test.mjs`, 52 policy cases |

## circuit-guard

`templates/repo/.claude/hooks/circuit-guard.mjs` is a PreToolUse hook. The plugin registers it for every session;
when a repo has its own copy (installed by the bootstrap), the plugin's copy steps aside so the repo's version wins.

| Rule | Applies to |
|---|---|
| No `sf` command against a production-like alias (`prod`, `production`, `live`, `sf-config.yml` prod alias, `CIRCUIT_PROD_ALIASES`), including commands with no `--target-org` when the project default org is production (logins are not checked by org type: SDO and demo orgs are production-edition orgs) | everyone |
| No `gh pr merge`, approving reviews, merges through the API, pushes to `main`/`master`, `deploy-prod` dispatch | everyone |
| No force push; no changes to rulesets, branch protection or environments; no `plan-approved` / `testplan-approved` labels | personas |
| Real deploys: Developer and Architect none (check-only `deploy validate` only); Tester only to `CIRCUIT_DEPLOY_ORGS` (default `qa`) | personas |
| Developer can't write `test-cases/`, `tests/`, specs, plans, stories or the constitution; Tester can't write `force-app/`; Architect can't write `force-app/` or tests | personas |
| Nobody (AI) may tick `[x] APPROVED` in a `plan.md` | everyone |
| No reading `*.key`, `*.pem`, `.env*`, `~/.sf`, `~/.sfdx` | everyone |

The persona is set by `CIRCUIT_PERSONA`, which the `cc-arch` / `cc-dev` / `cc-qa` aliases and the CI workflows set.

## Conventions

Feature folders `.specify/specs/NNN-slug/`; test-case index `tests/story_NN.tc.json` (levels `ui`, `unit`,
`manual`; ids `SNN-TC-nn`); UI suites `test-cases/NNN-slug-story-NN.sf-tests.yaml`; Jira mapping `jira-map.json`
(written only by `jira-sync.mjs`); per-story build docs `docs/plans/<KEY>/`. Full list: `skills/circuit/SKILL.md`.

## Development

```bash
node tests/guard.test.mjs
actionlint templates/workflows/*.yml
shellcheck -S warning templates/repo/scripts/ci/*.sh templates/repo/scripts/setup-persona.sh
claude plugin validate .        # from the repo root: validates the marketplace and this plugin
```
