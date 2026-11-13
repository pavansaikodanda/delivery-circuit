# sf-delivery-circuit

A Claude Code plugin for AI + Human Salesforce delivery (v4). It takes a feature from a client call to a Confluence
design page, Jira stories and test cases, code on a Developer-owned PR into the sprint branch, and a promotion ladder
of sandboxes up to production. AI designs and builds; people approve. A guard hook keeps AI away from approvals,
merges, protected branches, secrets and every org except the developer's own DEV org.

The design contract is [`../docs/CIRCUIT-V4.md`](../docs/CIRCUIT-V4.md). Connections are in
[`../ConnectionsSetup.md`](../ConnectionsSetup.md).

Install:

```
/plugin marketplace add pavansaikodanda/delivery-circuit
/plugin install sf-delivery-circuit@conscendo-delivery
```

See the [repository README](../README.md) for the full picture: the flow, the branch ladder and the workflows.

## What's inside

| Folder | Contents |
|---|---|
| `agents/` | Persona agents: `architect`, `developer`, `tester` |
| `skills/circuit/` | Conventions: flow, branches, change tags (EXISTS · EXTEND · CHANGE · REBUILD · NEW), Jira story layout, what AI may never do |
| `skills/circuit-bootstrap/` | Repo setup: files, branches `dev sit uat main` + first `sprint/<name>`, environments and their `SFDX_AUTH_URL` (pasted by the admin), rulesets, CodeRabbit config, labels |
| `skills/circuit-intake/` | Transcript → org check (read-only, DEV) → Confluence design page with change table → Lucid diagram → open questions |
| `skills/arch-design/` | Answers open questions with the Architect; refines change table, data model and story outline; status "Ready for review" |
| `skills/record-decision/` | Appends a decision row (date, decision, who, why, source) to the design page |
| `skills/arch-jira-push/` | Approved page → Jira epic + stories (Story 00 blocks the rest); idempotent by label `feature-<slug>` and summary |
| `skills/dev-*` | `dev-review-stories` (Jira comments), `dev-start-story` (branch, build, validate on DEV, PR into the sprint branch with auto-merge), `dev-fix` (failed scan, CodeRabbit comments), `dev-review-plan` and `dev-review-pr` (read-only second look) |
| `skills/qa-*` | `qa-design-tests` (Jira test cases), `qa-add-tests` (SF AI Tester suite PR), `qa-explore` (exploratory run in QA) |
| `skills/review-room/` | Summarises CodeRabbit's review; posts it to Slack if the Slack MCP is connected |
| `hooks/hooks.json` | Registers circuit-guard for every session |
| `templates/repo/` | Installed into a client repo: CLAUDE.md, `.claude/` (settings, guard), PR template, DoR/DoD, `.coderabbit.yaml`, `build.config.yml`, `scripts/ci/env-for-branch.mjs` |
| `templates/workflows/` | `pr-checks.yml`, `deploy.yml` |
| `templates/github/` | Rulesets for `sprint/*`, `dev`, `sit`, `uat`, `main` |
| `tests/` | Guard policy cases, CI config and workflow checks |

Removed in v4: `arch-approve-design`, `arch-review-pr`, `qa-push-tests`, `qa-review-testplan`, and the workflows
`design-gate`, `persona-gates`, `fix-router`, `deploy-prod`.

## Where things live (v4)

| What | Where |
|---|---|
| Design, change table, data model, decisions | Confluence design page (one per feature), Lucid diagram linked on it |
| Epic, stories, test cases | Jira |
| Story plan | the PR body |
| Code | `force-app/` on the story PR |
| UI tests | `test-cases/<KEY>.sf-tests.yaml` (SF AI Tester) |
| Branch → environment map | `build.config.yml` → `environments` |
| Sandbox credentials | GitHub Environment secret `SFDX_AUTH_URL`, one per environment |

## Branches and environments

```
feature/<KEY>-<slug> ──PR──► sprint/<name> ──PR──► dev ──PR──► sit ──PR──► uat ──PR──► main
                             deploys QA            DEV          SIT          UAT          PROD (human approval)
```

`scripts/ci/env-for-branch.mjs <branch>` reads `build.config.yml` and prints the environment and test level. Both
workflows use it.

## circuit-guard

`templates/repo/.claude/hooks/circuit-guard.mjs` is a PreToolUse hook. The plugin registers it for every session;
when a repo has its own copy (installed by the bootstrap), the repo's version wins.

| Denies | Notes |
|---|---|
| Push, force-push or delete `sprint/*`, `dev`, `sit`, `uat`, `main` | Feature branches are fine |
| `gh pr review --approve`, `gh pr merge` without `--auto`, the equivalent `gh api` calls | Auto-merge on your own feature PR is allowed |
| Deploys to anything but the developer's DEV alias; any command against the production alias | Validate (`--dry-run`, `deploy validate`) against DEV is allowed |
| Setting a Confluence page to Approved; moving a Jira story to Ready for Dev or Done | People do these |
| Reading, printing or setting `SFDX_AUTH_URL`, `sf org display --verbose`, or any secret | Only the admin handles secrets |

## Conventions

Branch `feature/<KEY>-<slug>`, branched from the current `sprint/<name>`. PR title starts with `<KEY>` (GitHub for
Atlassian links it to Jira). Every component in the design and the stories carries one change tag. Full list:
`skills/circuit/SKILL.md`.

## Development

```bash
node tests/guard.test.mjs
node tests/ci.test.mjs
actionlint templates/workflows/*.yml
claude plugin validate .        # from the repo root: validates the marketplace and this plugin
```
