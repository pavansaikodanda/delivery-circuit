# Delivery Circuit v3: design spec

Status: decided with the product owner on 2026-11-12. This document is the contract for the v3 rebuild of the plugin
(`sf-delivery-circuit/`), the workflows it installs, and the VS Code extension (`delivery-circuit-extension/`).
Where it conflicts with older docs (README, AgenticImplementation.md, CredentialsSetup.md, ReviewRoom.md), this wins
and those docs must be updated.

## 1. Principles

1. **No stored credentials anywhere.** Every connection is a login the person already has:
   GitHub (VS Code sign-in, `gh`), Claude (the logged-in `claude` CLI on a Claude Team seat), Salesforce (`sf` CLI
   login), Atlassian (Atlassian Remote MCP OAuth for Claude; Atlassian CLI `acli` web login for the extension and the
   runner), Fireflies (Fireflies MCP OAuth), Slack (installed apps; Slack MCP OAuth for Claude sessions).
   No `CLAUDE_CODE_OAUTH_TOKEN`, no Salesforce JWT keys, no Jira or Fireflies API tokens in GitHub, in files, or in
   the extension. `ANTHROPIC_API_KEY` is never used.
2. **The repo holds code and tests only.** Specs, design and decisions live in **Confluence**; epics, stories and test
   cases live in **Jira**. Spec Kit / spec-kit-sf remain the Architect's local drafting scaffold: `.specify/specs/` is
   gitignored and its output is published to Confluence and Jira.
3. **People keep creative control.** AI drafts; people decide. Architects never create PRs. Developers start stories
   and own their PRs. AI never approves, merges or deploys to the org the project names as production.
4. **No org-type checks.** Any connected org (sandbox, scratch, Developer Edition, SDO or other production-edition demo
   org) may be used as DEV or QA. Only the org the project *names* as production (sf-config prod alias, `prod`,
   `production`, `live`, `CIRCUIT_PROD_ALIASES`) is off limits to AI.
5. **Everything shared is written down.** Every step writes to Confluence, Jira, the PR or Slack; the next step reads
   from there (via the Circuit MCP or the person's login). No private hand-offs.

## 2. Where things live

| What | Where | Written by |
|---|---|---|
| House rules | repo `CLAUDE.md`, `.specify/memory/constitution.md` | Architect |
| Transcripts | at their source (Fireflies), or encrypted in the extension's local storage (paste, file, Wispr Flow) | the call / the Architect |
| Transcript index | repo `.circuit/sources.json` (ids, titles, dates, which epic used it; no content) | extension |
| Spec + clarifications + technical plan + data model | **Confluence design page** (one per feature) | Architect + AI |
| Decision log (C1) | section "Decisions" on the design page (date · decision · who · why · source link) | anyone, via extension / skill |
| Org snapshot (C4) | child page "Org snapshot" of the design page: objects, fields, flows, permission sets the feature touches | Architect AI |
| Epic, stories (Story 00 first) | **Jira**; each story has fields *Design page*, *Approved design version*, *Acceptance criteria* | Architect AI |
| Test cases | **Jira** test cases linked to each story (Tester) | Tester AI |
| Runnable tests | on the story PR: `tests/<KEY>.tc.json` + `test-cases/<KEY>.sf-tests.yaml` | Tester (commit on the PR) |
| Story plan | on the story PR: `docs/plans/<KEY>/PLAN.md`, `TESTPLAN.md` | Developer AI |
| Code | on the story PR: `force-app/` | Developer AI + Developer |
| Gates, reviews, CI results | the GitHub PR (labels, statuses, comments) | people, CI |
| Review-room debate + verdict | Slack `#review-room` thread; verdict copied to the PR (C3) | CodeRabbit, Claude Tag, Developer |
| Jira ↔ PR link | branch `feature/<KEY>-<slug>`, PR title starts with `<KEY>`; GitHub for Jira app | Developer |

The extension's Jira map (`jira-map.json` per feature) is replaced by Jira itself: the epic key and story keys come
from Jira queries (epic link + labels), cached by the extension.

## 3. The flow (one feature, one story)

| # | Step | Who | App | Gate |
|---|---|---|---|---|
| 1 | **Add a source**: paste text, attach a local file (txt, md, docx, vtt, srt, pdf), fetch a Fireflies meeting, or import from Wispr Flow (paste, file, or read its local history read-only) | Architect | Extension → Sources | |
| 2 | **Intake**: Claude (Architect) reads the source, the org (sf CLI), house rules; drafts spec + open questions with Spec Kit locally; publishes a Confluence design page (Atlassian MCP) | Architect + AI | Extension → Claude session | |
| 3 | **Clarify and design**: answers recorded as decisions (C1); plan + data model + org snapshot (C4) + Lucid diagram on the design page | Architect + AI | Confluence, Lucid MCP | |
| 4 | **Approve design**: an `architects` member sets the page status to Approved; the approved version number is recorded | Architect (human) | Confluence / extension | **G1** |
| 5 | **Stories**: epic + stories in Jira (Story 00 first, blocks links), each with *Approved design version* | Architect AI | Jira (Atlassian MCP or acli) | |
| 6 | **Story review**: buildability, estimates, dependencies, as Jira comments | Developer | Extension → Claude session | |
| 7 | **Test design**: test cases per acceptance criterion in Jira, linked to the story; runnable suite drafted locally (validated against the org) | Tester + AI | Jira, sf CLI | |
| 8 | **Testability**: Tester sets *Testability confirmed* + label `ai-ready` | Tester | Jira | **G2** |
| 9 | **Start story**: in the Developer's queue; "Start story" runs the Developer's Claude: reads the story, ACs, design page (approved version only), test cases; writes PLAN.md + TESTPLAN.md; creates branch `feature/<KEY>-<slug>` and a **draft PR** titled `<KEY> …` | Developer + AI | Extension | |
| 10 | **Tests onto the PR**: Tester's queue shows "Add tests to <KEY>"; the suite + tc index are committed to the PR by the Tester | Tester | Extension | |
| 11 | **Approve plans**: `plan-approved` (Developer), `testplan-approved` (Tester) | Developer, Tester | Extension (own GitHub login) | **G3**, **G4** |
| 12 | **Build**: the Developer's Claude implements; proves with check-only `sf project deploy validate` on DEV; references test cases (`// TC: …`); pushes to the branch | Developer + AI | Extension → Claude session | |
| 13 | **Checks** (on PR): no-login checks on GitHub-hosted runners (guard, lint, Jest, TC coverage, design-gate); Salesforce/Claude checks on the **self-hosted runner** (QA deploy, Apex tests, SF AI Tester, AI Reviewer, Code Analyzer) | CI | GitHub Actions | |
| 14 | **Fix**: failed checks become a queue item "Fix with AI" for the Developer with the failure prefilled (cap 3 AI attempts, then `needs-human`); blocked UI cases go to the Tester (`needs-qa`) | Developer / Tester | Extension | |
| 15 | **Review room** (C2, C8): the Developer clicks "Open review room": their Claude posts a kick-off thread in `#review-room` via Slack MCP with a brief (ACs, key decisions, design link, CI results); people then mention `@coderabbit` and `@Claude` for the rounds (automated rounds if bots answer each other) | Developer, CodeRabbit, Claude Tag | Slack | |
| 16 | **Verdict to PR** (C3): "Record verdict" reads the thread (Slack MCP) and posts Must fix / Disputed / Dropped as a PR comment | Developer | Extension | |
| 17 | **Reviews**: code review; QA exploration on QA with SF AI Tester; schema/design review against the approved design | Developer, Tester, Architect | Extension | **G5**, **G6**, **G7** |
| 18 | **Merge**: architects only | Architect | Extension | **G8** |
| 19 | **Release**: `deploy-prod` on the self-hosted runner (no AI), after environment approval; delta validate + quick deploy using the runner's `sf` login of the named production org | Architect | GitHub environment | **G9** |

## 4. Gates (unchanged owners)

| Gate | Owner | v3 source of truth |
|---|---|---|
| G1 | Architect | Confluence design page status Approved (by `architects` group) + version |
| G2 | Tester | Jira label `ai-ready` + *Testability confirmed* |
| G3 | Developer | PR label `plan-approved` (added by `developers` member) |
| G4 | Tester | PR label `testplan-approved` (added by `testers` member) |
| G5 / G6 / G7 | Developer / Tester / Architect | statuses `gate/developer`, `gate/tester`, `gate/architect` from approving reviews by team members |
| G8 | Architect | merge (ruleset: architects only) |
| G9 | Architect | `production` environment approval |

**C5 (re-sign on change):** `design-gate` (PR check) and the extension compare the story's *Approved design version*
with the page's current approved version; if the design changed after the story's version, the check fails with
"Design changed since this story was planned: re-plan or re-approve".

## 5. Plugin changes (`sf-delivery-circuit/`)

- Skills, new or rewritten:
  - `circuit-intake` (source → spec drafted locally → Confluence page);
  - `arch-design` (plan, data model, decisions, org snapshot, Lucid);
  - `arch-approve-design` (instructions for the human approval; AI cannot approve);
  - `arch-jira-push` (Jira via Atlassian MCP or `acli`, records the approved version);
  - `dev-review-stories` (Jira comments);
  - `dev-start-story` (new: plan + branch + draft PR);
  - `dev-review-plan`, `dev-review-pr`;
  - `dev-fix` (new: fix from failed checks, attempt cap);
  - `qa-design-tests` (Jira test cases + local suite);
  - `qa-push-tests` (Jira);
  - `qa-add-tests` (new: commit suite + tc index to the story PR);
  - `qa-review-testplan`, `qa-explore`;
  - `review-room` (new: kick-off brief + verdict to PR, Slack MCP);
  - `record-decision` (new: C1);
  - `arch-review-pr`;
  - `circuit` (map, conventions v3);
  - `circuit-bootstrap` (v3 phases: no secrets, self-hosted runner setup, acli/MCP logins).
- `scripts/jira-sync.mjs`: switch to the Atlassian CLI (`acli`) or MCP calls; no API token. Keep idempotency.
- Agents: Architect can't run `gh pr create`; Developer may create draft PRs; Tester may commit only `tests/` and
  `test-cases/` to story branches.
- Guard: deny `gh pr create` for the architect persona; allow developer; keep all other rules.
- Workflows:
  - remove `claude-plan.yml` and `claude-build.yml` (AI now runs on laptops);
  - replace `spec-gate.yml` with `design-gate.yml` (G1 + C5 via the runner's `acli`);
  - `pr-checks.yml` split into `runs-on: ubuntu-latest` jobs (no logins) and `runs-on: [self-hosted, circuit]` jobs (QA deploy, Apex, SF AI Tester, AI Reviewer, Code Analyzer);
  - `ai-fix-loop.yml` becomes `fix-router.yml`, which labels and notifies instead of running AI;
  - `persona-gates.yml` stays;
  - `deploy-prod.yml` runs on `[self-hosted, circuit-release]`, with no AI.
  - No workflow reads `CLAUDE_CODE_OAUTH_TOKEN`, `SF_JWT_*` or `JIRA_API_TOKEN`.
- `CredentialsSetup.md` is rewritten as **ConnectionsSetup.md** (logins only, plus the self-hosted runner).

## 6. Extension changes (`delivery-circuit-extension/`)

- **Sources page** (Architect): paste/dictate box, file attach, Fireflies list (via Fireflies MCP through a Claude
  call, or file export), Wispr Flow import (paste, file, local history read-only with explicit consent), watch-folder
  option; all stored encrypted locally; index in `.circuit/sources.json`.
- **Connections**:
  - Atlassian via `acli` login status, plus the Atlassian MCP status;
  - Fireflies MCP and Slack MCP status;
  - self-hosted runner online status (GitHub API);
  - remove the token prompts for Jira, Confluence and Fireflies, and the CI-secrets section;
  - Project section: runner, rulesets, environments, GitHub for Jira app, CodeRabbit repo access.
- **Project context**: features from Jira epics + Confluence pages (via `acli`), no `.specify/specs` parsing on main;
  queue rules per the v3 flow (Start story, Add tests, Fix with AI, Open review room, Record verdict, Approve design).
- **Actions**:
  - new: `dev:start-story`, `qa:add-tests`, `dev:fix`, `review:open-room`, `review:record-verdict`, `decision:record`, `arch:approve-design` (opens the Confluence page);
  - the existing gate actions stay.
- **Circuit MCP**: new tools `decisions_get`, `design_get` (approved version), `story_get` (Jira), `org_snapshot_get`; drop `jira_map_get`.
- **Setup wizard**: v3 phases (no secrets; runner registration steps; acli and MCP logins).

## 7. Testing plan

1. Unit: every parser, queue rule, action grammar, guard rule (v3 cases), workflow lint (actionlint), shellcheck.
2. Integration: VS Code launch test per persona (architect, developer, tester) on a copy of the demo project,
   asserting visible views, allowed and refused actions, MCP tool lists per persona.
3. Live end-to-end (after the owner connects GitHub org repo, Jira, Confluence, Slack, CodeRabbit, runner): one
   feature through every step of section 3, once per persona, using every app; results recorded in
   `docs/E2E-RESULTS.md`.
