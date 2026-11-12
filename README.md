# Agentic Implementation Circuit

**From a client call to a deployed Salesforce org, with AI doing the drafting and building, and people approving
every step that matters.**

This repository holds a [Claude Code](https://claude.com/claude-code) plugin, `sf-delivery-circuit`, a VS Code
extension, `delivery-circuit-extension`, and the guides for setting them up. Together they turn a client call into a
Confluence design, Jira stories and test cases, working Salesforce code and a production deployment. Three AI
personas (Architect, Developer, Tester) draft the work, and nine human gates (G1 to G9) control it.

This is **v3**. The design contract is [`docs/CIRCUIT-V3.md`](docs/CIRCUIT-V3.md); where any other doc disagrees,
that one wins.

> AI never approves, never merges, and never touches the org the project names as production. A guard hook enforces
> this on every laptop and on the runner. It isn't left to the prompt.

## The v3 principles

1. **No stored credentials.** Every connection is a login people already have: GitHub (VS Code sign-in, `gh`),
   Claude (the logged-in `claude` CLI on a Claude Team seat), Salesforce (`sf` CLI), Atlassian (`acli` web login and
   the Atlassian MCP), Fireflies and Slack (MCP sign-in). No API keys, JWT keys or `CLAUDE_CODE_OAUTH_TOKEN`.
2. **The repo holds code and tests only.** Specs, designs and decisions live in **Confluence**; epics, stories and
   test cases live in **Jira**. Transcripts stay at their source or encrypted on the Architect's machine.
3. **People keep creative control.** AI drafts; people decide. Architects never create PRs. Developers start their
   own stories and own their PRs.
4. **No org-type checks.** Any connected org can be DEV or QA (sandbox, scratch, Developer Edition, SDO or demo org).
   Only the alias the project names as production is off limits to AI.
5. **Everything shared is written down** in Confluence, Jira, the PR or Slack, so the next step reads from there.

---

## The flow

| # | Step | Who | App | Gate |
|---|---|---|---|---|
| 1 | **Add a source**: paste, attach a file (txt, md, docx, vtt, srt, pdf), fetch a Fireflies meeting, or import from Wispr Flow | Architect | Extension → Sources | |
| 2 | **Intake**: Claude reads the source, the org and the house rules, drafts the spec with Spec Kit locally, and publishes a Confluence design page | Architect + AI | Claude, Atlassian MCP | |
| 3 | **Clarify and design**: answers become decisions; plan, data model, org snapshot and a Lucid diagram go on the design page | Architect + AI | Confluence, Lucid | |
| 4 | **Approve design**: an `architects` member sets the page status to Approved; the version is recorded | Architect | Confluence | **G1** |
| 5 | **Stories**: epic and stories in Jira (Story 00 first), each with its *Approved design version* | Architect + AI | Jira | |
| 6 | **Story review**: buildability, estimates, dependencies as Jira comments | Developer | Claude, Jira | |
| 7 | **Test design**: Jira test cases per acceptance criterion; runnable suite drafted locally | Tester + AI | Jira, `sf` | |
| 8 | **Testability**: *Testability confirmed* + label `ai-ready` | Tester | Jira | **G2** |
| 9 | **Start story**: the Developer's Claude writes PLAN.md and TESTPLAN.md, creates `feature/<KEY>-<slug>` and a **draft PR** titled `<KEY> …` | Developer + AI | Extension | |
| 10 | **Tests onto the PR**: the suite and test-case index are committed to the PR | Tester | Extension | |
| 11 | **Approve plans**: `plan-approved`, `testplan-approved` | Developer, Tester | Extension | **G3**, **G4** |
| 12 | **Build**: check-only `sf project deploy validate` on DEV; pushes to the branch | Developer + AI | Claude | |
| 13 | **Checks**: no-login checks on GitHub-hosted runners; Salesforce and Claude checks on the **self-hosted runner** | CI | GitHub Actions | |
| 14 | **Fix**: failed checks become "Fix with AI" (3 AI attempts, then `needs-human`); blocked UI cases go to the Tester | Developer / Tester | Extension | |
| 15 | **Review room**: the Developer's Claude opens a `#review-room` thread; CodeRabbit and Claude Tag debate the PR | Developer | Slack | |
| 16 | **Verdict to PR**: Must fix / Disputed / Dropped posted as a PR comment | Developer | Extension | |
| 17 | **Reviews**: code review, QA exploration with SF AI Tester on QA, design review against the approved version | Developer, Tester, Architect | Extension | **G5 · G6 · G7** |
| 18 | **Merge**: architects only | Architect | GitHub | **G8** |
| 19 | **Release**: `deploy-prod` on the release runner, no AI, after environment approval | Architect | GitHub environment | **G9** |

If the design page changes after a story was planned, the `design-gate` check and the extension say "Design changed
since this story was planned: re-plan or re-approve" (C5).

```
 source ─▶ /circuit-intake ─▶ Confluence design page ─▶ /arch-design (decisions, org snapshot, Lucid) ──[G1 Approved]
     ─▶ /arch-jira-push ─▶ Jira epic + stories ─▶ /dev-review-stories ─▶ /qa-design-tests ──[G2 ai-ready]
     ─▶ Developer: Start story ─▶ PLAN.md + TESTPLAN.md + draft PR ◀── Tester: Add tests
     ──[G3 plan-approved][G4 testplan-approved] ─▶ build (check-only on DEV) ─▶ pr-checks (hosted + self-hosted)
     ─▶ Fix with AI (≤ 3) ─▶ review room (Slack) ─▶ verdict on PR ──[G5][G6][G7] ──[G8 merge] ─▶ deploy-prod ──[G9]
```

### The personas

| Persona | Does | Never does |
|---|---|---|
| **Architect** | Sources, intake, Confluence design, decisions, org snapshot, Lucid, Jira epic and stories, design review, merge, release | Write code or tests, create PRs, approve the design for itself (a person sets Approved), deploy |
| **Developer** | Story review, Start story (plan, branch, draft PR), build with check-only validation, Fix with AI, review room, code review | Edit test cases, the design or the constitution, deploy for real, merge |
| **Tester** | Jira test cases, runnable suites, Add tests to the PR, test-plan review, QA exploration with SF AI Tester | Edit `force-app/`, weaken an expected result, deploy anywhere but QA, commit outside `tests/` and `test-cases/` |
| **Reviewer** (runner only) | Read-only check of each PR against the approved design, security and limits | Edit files or approve |

### The safety model

`circuit-guard` is a Claude Code hook that runs before every tool call, on laptops and on the self-hosted runner. It
denies:

- any Salesforce command aimed at the alias the project names as production;
- `gh pr merge`, approving reviews, pushes to `main`, and force pushes;
- `gh pr create` for the Architect persona (Developers may create draft PRs);
- persona boundary violations: the Developer editing tests, the Tester editing code, the Architect editing either;
- AI adding the gate labels or marking a design approved;
- reading keys, `.env` files or Salesforce session files.

On top of that: GitHub rulesets (code-owner reviews, required checks, architects-only merge), a protected `production`
environment, team checks on every gate, a hard limit of 3 AI fix attempts, and fork-PR guards on the self-hosted jobs.

---

## Repository layout

| Path | What it is |
|---|---|
| [`docs/CIRCUIT-V3.md`](docs/CIRCUIT-V3.md) | **The v3 design contract** |
| [`ConnectionsSetup.md`](ConnectionsSetup.md) | Every login the circuit uses, step by step, plus the self-hosted runner and fork-PR safety |
| [`docs/E2E-TEST-PLAN.md`](docs/E2E-TEST-PLAN.md) | Live test script per persona, covering every step and every app |
| [`sf-delivery-circuit/`](sf-delivery-circuit/) | **The plugin**: personas, skills, guard hook, templates ([details](sf-delivery-circuit/README.md)) |
| [`delivery-circuit-extension/`](delivery-circuit-extension/) | **The VS Code extension**: queues, sources, connections, Circuit MCP, AI testing, setup wizard ([details](delivery-circuit-extension/README.md)) |
| [`ReviewRoom.md`](ReviewRoom.md) | Slack `#review-room`: CodeRabbit and Claude Tag debate each PR; the verdict goes to the PR |
| [`AgenticImplementation.md`](AgenticImplementation.md) | The v2 build runbook (history; superseded sections are marked) |
| [`AgenticImplementation.v1.md`](AgenticImplementation.v1.md) | The original pipeline design (history) |
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

1. **Connect everything once:** follow [`ConnectionsSetup.md`](ConnectionsSetup.md). It is logins only: GitHub org and
   repo, VS Code sign-in, `claude` on a Claude Team seat, `sf` for DEV and QA, `acli`, the Atlassian, Fireflies, Slack
   and Lucid MCP sign-ins, CodeRabbit, Claude Tag, GitHub for Atlassian, and the self-hosted runner.
2. **Set up the client repo:** open it in VS Code and run **Delivery Circuit: Project Setup** (or `/circuit-bootstrap`
   in Claude Code). It installs the workflows, rulesets and house rules, and stops at each step that needs you.
3. **Start a feature:** as the Architect, add a source on the Sources page (paste, file, Fireflies or Wispr Flow) and
   run intake. The design page appears in Confluence.
4. **Follow your queue:** each person's view in the extension shows the next action (Approve design, Start story, Add
   tests, Fix with AI, Open review room, Record verdict). `/circuit` in Claude Code shows the map and where any story
   stands.

## Skills

| Skill | Persona | What it does |
|---|---|---|
| `/circuit` | any | Map, v3 conventions, and status of a feature or story |
| `/circuit-bootstrap` | admin | Sets up a client repo: no secrets, runner setup, `acli` and MCP logins |
| `/circuit-intake` | Architect | Source → spec drafted locally → Confluence design page |
| `/arch-design` | Architect | Plan, data model, decisions, org snapshot, Lucid diagram on the design page |
| `/arch-approve-design` | Architect | Walks the human through G1 (AI cannot approve) |
| `/arch-jira-push` | Architect | Epic, Story 00 and stories in Jira with the approved design version |
| `/arch-review-pr` | Architect | Schema and design review against the approved design (G7) |
| `/record-decision` | any | Adds a decision to the design page's Decisions section (C1) |
| `/dev-review-stories` | Developer | Buildability, estimates and dependencies as Jira comments |
| `/dev-start-story` | Developer | PLAN.md + TESTPLAN.md, branch and draft PR |
| `/dev-review-plan` | Developer | Reviews the plan (G3) |
| `/dev-fix` | Developer | Fixes failed checks, attempt cap 3 |
| `/dev-review-pr` | Developer | Code review (G5) |
| `/review-room` | Developer | Kick-off brief to `#review-room`; verdict to the PR |
| `/qa-design-tests` | Tester | Jira test cases per acceptance criterion, local SF AI Tester suite |
| `/qa-push-tests` | Tester | Test cases to Jira, linked to stories; guides G2 |
| `/qa-add-tests` | Tester | Commits the suite and test-case index to the story PR |
| `/qa-review-testplan` | Tester | Reviews the test plan (G4) |
| `/qa-explore` | Tester | QA on the QA org: re-runs, manual scripts, exploration, triage (G6) |

Spec Kit and spec-kit-sf remain the Architect's local drafting scaffold. `.specify/specs/` is gitignored, and its
output is published to Confluence and Jira.

## GitHub workflows installed into a client repo

| Workflow | Runs on | Does |
|---|---|---|
| `design-gate` | self-hosted `circuit` | G1 + C5: the story's approved design version matches the page's current approved version (read with `acli` and Confluence) |
| `pr-checks` | GitHub-hosted (no logins) | guard, lint, Jest, test-case coverage |
| `pr-checks` | self-hosted `circuit` | QA deploy, Apex tests, SF AI Tester, AI Reviewer, Code Analyzer |
| `persona-gates` | GitHub-hosted | Only `developers` set `plan-approved`, only `testers` set `testplan-approved`; approvals become `gate/*` statuses |
| `fix-router` | GitHub-hosted | Labels failures and notifies the Developer or Tester; no AI runs in CI |
| `deploy-prod` | self-hosted `circuit-release` | **No AI.** Environment approval, then delta validate and quick deploy |

No workflow reads `CLAUDE_CODE_OAUTH_TOKEN`, `SF_JWT_*` or `JIRA_API_TOKEN`.

## Requirements

- Claude Code on a **Claude Team** seat per person (and one for the runner). No Anthropic API key is used anywhere.
- A GitHub organisation with teams, and a **private** repo for the circuit.
- Salesforce DEV and QA orgs (any edition), and the org the project names as production.
- Jira Cloud and Confluence on one Atlassian site; Lucid; Slack with Claude Tag and the CodeRabbit Slack agent;
  CodeRabbit on the repo; GitHub for Atlassian. Fireflies and Wispr Flow are optional sources.
- A machine for the self-hosted runner (Linux, macOS or Windows).
- Node 22+, Salesforce CLI, `gh`, `acli`, `jq`, `uv` + `specify-cli`, Python 3 (for the SF AI Tester validator).
- [SF AI Tester](https://github.com/pavansaikodanda/sf-ai-tester) for UI acceptance tests.
- Built on [GitHub Spec Kit](https://github.com/github/spec-kit) and
  [spec-kit-sf](https://github.com/Evernorth/spec-kit-sf) v2.0.1, installed from upstream into each client repo.

## Status

v3 is being built to [`docs/CIRCUIT-V3.md`](docs/CIRCUIT-V3.md). Unit tests (guard rules, parsers, queue rules,
workflow lint) and the VS Code integration tests run locally. The live end-to-end run happens after the owner connects
the GitHub org repo, Jira, Confluence, Slack, CodeRabbit and the runner; it follows
[`docs/E2E-TEST-PLAN.md`](docs/E2E-TEST-PLAN.md), and results go in `docs/E2E-RESULTS.md`.

Facts the vendors do not document yet are checked during that run, for example the `acli` JSON output format, Slack
MCP tool names and the Fireflies Claude Code command.
