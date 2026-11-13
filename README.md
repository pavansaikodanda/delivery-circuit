# Agentic Implementation Circuit

**From a client call to a deployed Salesforce org. AI designs and builds; people decide.**

This repository holds a [Claude Code](https://claude.com/claude-code) plugin, `sf-delivery-circuit`, a VS Code
extension, `delivery-circuit-extension`, and the guides for setting them up. Together they turn a client call into a
Confluence design, Jira stories and test cases, Salesforce code on a pull request, and a deployment that climbs a
branch-per-sandbox ladder up to production.

This is **v4**. The design contract is [`docs/CIRCUIT-V4.md`](docs/CIRCUIT-V4.md); where any other doc disagrees,
that one wins.

> AI never approves a design, a story, a PR or a deployment. It never merges, never pushes to a protected branch and
> never deploys anywhere but the developer's own DEV org. A guard hook enforces this on every laptop.

## The v4 principles

1. **AI designs and builds; people decide.** AI drafts the design and writes the code. People approve the design page,
   move stories to Ready for Dev, approve PRs and approve production.
2. **Few connections.** GitHub, the `sf` CLI, the Atlassian MCP (Jira + Confluence), Lucid, CodeRabbit (GitHub App +
   Slack agent). Fireflies is optional. No AI in CI, no self-hosted runner.
3. **Branches are environments.** Merging into a branch deploys it to that branch's sandbox. Nobody deploys by hand.
4. **CI uses GitHub-hosted runners.** Each sandbox has a GitHub Environment with one secret, `SFDX_AUTH_URL`. That is
   the only stored credential. Laptops use each person's own `sf`, `gh`, `claude` and MCP logins.
5. **The repo holds code, tests and config.** The design lives on Confluence; stories and test cases live in Jira.

---

## The flow

| # | Who | What | Where |
|---|---|---|---|
| 1 | Architect | Brings a transcript: paste, file (.vtt/.srt/.txt/.md/.docx/.pdf) or Fireflies | Extension Sources, `/circuit-intake` |
| 2 | Architect + AI | AI reads the transcript and checks the org (read-only, DEV alias) for what already exists | `/circuit-intake` |
| 3 | Architect + AI | AI writes the Confluence design page and a Lucid diagram. Each component is tagged EXISTS, EXTEND, CHANGE, REBUILD or NEW. People answer open questions; answers become decisions | `/circuit-intake`, `/arch-design`, `/record-decision` |
| 4 | Architect | Sets the Confluence page status to **Approved** | Confluence |
| 5 | Architect + AI | AI creates the Jira epic and stories from the approved page, each with its part of the change table, acceptance criteria and the design link | `/arch-jira-push` |
| 6 | Scrum team | Refinement: Developer and QA agree; the story moves to **Ready for Dev** | Jira |
| 7 | QA + AI | AI drafts Jira test cases and an SF AI Tester suite `test-cases/<KEY>.sf-tests.yaml` | `/qa-design-tests`, `/qa-add-tests` |
| 8 | Developer + AI | AI builds the story on `feature/<KEY>-<slug>`, validates against the developer's DEV org, and opens a PR into the sprint branch with auto-merge on | `/dev-start-story` |
| 9 | GitHub Actions | `scan`: Code Analyzer, LWC Jest, check-only deploy and Apex tests against the target sandbox. Only when scan passes does the `coderabbit` job ask CodeRabbit to review | `pr-checks.yml` |
| 10 | CodeRabbit | Approves or requests changes, on the PR and in Slack | GitHub, Slack |
| 11 | Developer + AI | Fixes failed checks or CodeRabbit comments | `/dev-fix` |
| 12 | GitHub | Scan green + CodeRabbit review + human approval: auto-merge into the sprint branch, then `deploy.yml` deploys it to QA | GitHub |
| 13 | QA | Manual testing and the SF AI Tester suite in QA; results in Jira; story to Done or back to the Developer | QA sandbox, Jira |
| 14 | Leads + Dev + QA | Sprint review. A lead approves the promotion PR `sprint/<name>` → `dev` | GitHub |
| 15 | Leads | Promote by PR: `dev` → `sit` → `uat` → `main`. Each merge deploys to that sandbox; `main` waits for a human approval on the `production` environment | GitHub |

```
feature/<KEY>-<slug> ──PR──► sprint/<name> ──PR──► dev ──PR──► sit ──PR──► uat ──PR──► main
                             deploys QA            DEV          SIT          UAT          PROD (human approval)
```

The map lives in `build.config.yml` → `environments` (branch → GitHub Environment → test level). Changing the ladder
is a config edit.

### Roles

| Role | Does | Never does (AI on their behalf) |
|---|---|---|
| **Architect** | Transcript, intake, design page, Lucid, decisions, Jira epic and stories | Set the page to Approved, write code, deploy |
| **Developer** | Story review, build, PR, fixes | Approve or merge a PR, push to protected branches, deploy beyond their DEV org |
| **QA** | Jira test cases, SF AI Tester suites, testing in QA | Move a story to Done for the team, deploy |
| **Leads** | Sprint review, promotion PRs, production approval | (people only) |

### The safety model

`circuit-guard` is a Claude Code hook that runs before every tool call. It denies:

- pushes and force-pushes to `sprint/*`, `dev`, `sit`, `uat`, `main`, and deleting those branches;
- approving or merging a PR (turning on auto-merge for your own feature PR is allowed; the rulesets still decide);
- deploying anywhere except the developer's own DEV alias, and anything against the production alias;
- setting a Confluence page to Approved or moving a Jira story to Ready for Dev or Done;
- reading, printing or setting `SFDX_AUTH_URL` values, `sf org display --verbose`, or any secret.

On top of that: GitHub rulesets (PR only, required check `scan`, approvals from `leads` on promotion branches) and the
`production` environment with required reviewers and prevent self-review.

---

## Repository layout

| Path | What it is |
|---|---|
| [`docs/CIRCUIT-V4.md`](docs/CIRCUIT-V4.md) | **The v4 design contract** |
| [`ConnectionsSetup.md`](ConnectionsSetup.md) | Every connection v4 uses, step by step, including the `SFDX_AUTH_URL` environment secrets |
| [`docs/E2E-TEST-PLAN.md`](docs/E2E-TEST-PLAN.md) | Live test: the "Case Escalation" use case through every step, one person playing all roles |
| [`ReviewRoom.md`](ReviewRoom.md) | How CodeRabbit reviews after the scan passes, and how to discuss a PR with `@coderabbit` in Slack |
| [`sf-delivery-circuit/`](sf-delivery-circuit/) | **The plugin**: personas, skills, guard hook, templates ([details](sf-delivery-circuit/README.md)) |
| [`delivery-circuit-extension/`](delivery-circuit-extension/) | **The VS Code extension** (unchanged in v4; see below) ([details](delivery-circuit-extension/README.md)) |
| [`docs/CIRCUIT-V3.md`](docs/CIRCUIT-V3.md) | The v3 contract (history) |
| [`AgenticImplementation.md`](AgenticImplementation.md), [`AgenticImplementation.v1.md`](AgenticImplementation.v1.md) | Earlier designs (history) |
| `.claude-plugin/marketplace.json` | Lets Claude Code install the plugin straight from this repo |

## Install

In Claude Code:

```
/plugin marketplace add pavansaikodanda/delivery-circuit
/plugin install sf-delivery-circuit@conscendo-delivery
```

For local development, run `claude --plugin-dir ./sf-delivery-circuit`. Install the extension from
`delivery-circuit-extension/delivery-circuit.vsix` (see its README).

## Quick start

1. **Connect everything once:** follow [`ConnectionsSetup.md`](ConnectionsSetup.md): GitHub org, repo and teams,
   laptop logins (`gh`, `claude`, `sf`), the Atlassian and Lucid MCPs, Jira and Confluence, GitHub for Atlassian,
   CodeRabbit, and one GitHub Environment per sandbox with its `SFDX_AUTH_URL`.
2. **Set up the client repo:** run `/circuit-bootstrap` in Claude Code. It installs the files and workflows, creates
   `dev sit uat main` and the first `sprint/<name>`, the environments, rulesets and CodeRabbit config, and stops where
   you must paste a secret yourself.
3. **Start a feature:** as the Architect, add a transcript on the extension's Sources page (or pass it to
   `/circuit-intake`). The design page appears in Confluence.
4. **Follow the flow:** approve the page, push stories, refine, build, review, test, promote. `/circuit` shows the map
   and where a story stands.

## Skills

| Skill | Who | What it does |
|---|---|---|
| `/circuit` | all | Conventions: flow, branches, change tags, Jira story layout, what AI may never do |
| `/circuit-bootstrap` | admin | Repo files, branches, environments (admin pastes each `SFDX_AUTH_URL`), rulesets, CodeRabbit config, labels |
| `/circuit-intake` | Architect | Transcript → org check → Confluence design page with change table → Lucid diagram → open questions |
| `/arch-design` | Architect | Answers open questions, refines change table, data model and story outline; status "Ready for review" (never Approved) |
| `/record-decision` | Architect | Adds a decision row (date, decision, who, why, source) to the design page |
| `/arch-jira-push` | Architect | Approved page → Jira epic + stories; idempotent; Story 00 (shared data model) blocks the rest |
| `/dev-review-stories` | Developer | Buildability, estimate and dependencies as a comment on each story |
| `/dev-start-story` | Developer | Needs Ready for Dev; branch from the sprint branch; plan in the PR body; build; validate on DEV; PR with auto-merge |
| `/dev-fix` | Developer | Reads failed `scan` logs and CodeRabbit comments, fixes, pushes |
| `/dev-review-plan`, `/dev-review-pr` | Developer | Read-only second look at a PR before asking for review |
| `/qa-design-tests` | QA | Jira test cases from the acceptance criteria, linked to the story |
| `/qa-add-tests` | QA | SF AI Tester suite `test-cases/<KEY>.sf-tests.yaml`, PR into the sprint branch |
| `/qa-explore` | QA | Exploratory run in the QA sandbox; results as a Jira comment |
| `/review-room` | Developer | Summarises CodeRabbit's review and, if the Slack MCP is connected, posts it with the PR link |

## GitHub workflows installed into a client repo

| Workflow | Trigger | Does |
|---|---|---|
| `pr-checks.yml` | PR to `sprint/**`, `dev`, `sit`, `uat`, `main` | `scan` (required): Code Analyzer, LWC Jest, check-only deploy + Apex tests against the target sandbox. `coderabbit`: after scan passes, on feature PRs only, comments `@coderabbitai review` |
| `deploy.yml` | push to the same branches | Deploys the branch to its environment's sandbox; `production` waits for its required reviewers |

Both run on GitHub-hosted `ubuntu-latest`. The only secret is `SFDX_AUTH_URL` per environment. No Claude, Jira or
Slack calls from CI.

## Requirements

- Claude Code on a **Claude Team** seat per person. No `ANTHROPIC_API_KEY`.
- A GitHub organisation with teams (`architects`, `developers`, `testers`, `leads`) and a **private** repo.
- A Salesforce DEV org per developer, sandboxes for QA, DEV, SIT and UAT, and production.
- Jira Cloud and Confluence on one Atlassian site; Lucid; Slack with the CodeRabbit Slack agent; CodeRabbit on the
  repo; GitHub for Atlassian. Fireflies is optional.
- Node 22+, Salesforce CLI, `gh`, `acli` (the extension still reads Jira with it), Python 3 (SF AI Tester validator).
- [SF AI Tester](https://github.com/pavansaikodanda/sf-ai-tester) for UI acceptance tests.

## VS Code extension

Unchanged in v4. It still reads Jira through `acli`, and its Connections page still lists v3 rows (self-hosted runner,
Claude Tag). Those rows may show as not configured; ignore them. A later pass will slim it to the v4 flow.

## Status

v4 is being built to [`docs/CIRCUIT-V4.md`](docs/CIRCUIT-V4.md). The live run follows
[`docs/E2E-TEST-PLAN.md`](docs/E2E-TEST-PLAN.md); results go in `docs/E2E-RESULTS.md`.
