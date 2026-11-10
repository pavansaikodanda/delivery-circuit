# Agentic Implementation Circuit

**From a client call to a deployed Salesforce org, with AI doing the drafting and building, and people approving
every step that matters.**

This repository is a [Claude Code](https://claude.com/claude-code) plugin, `sf-delivery-circuit`, plus the runbook
and guides for setting it up. It turns a client-call transcript into a reviewed spec, Jira stories, test cases,
working Salesforce code and a production deployment. Three AI personas (Architect, Developer, Tester) do the work,
and nine human gates (G1–G9) control it.

> AI never approves, never merges, and never touches production. A guard hook enforces this on every
> laptop and in CI. It isn't left to the prompt.

---

## What it can do

| Stage | What happens | Who acts | Gate |
|---|---|---|---|
| **1. Intake** | A transcript (file or Fireflies) becomes a Spec Kit feature spec: personas, Given/When/Then acceptance criteria, object map, security model, and open questions checked against the real DEV org | AI (Architect persona) | |
| **2. Design** | Open questions are answered, the technical plan is written (reuse first, blast radius), the architecture is drawn in Lucid and mirrored to Confluence | Architect + AI | **G1** human Architect signs the plan |
| **3. Stories** | Atomic stories, with Story 00 holding the shared objects, fields and permission sets so stories can be built in parallel | AI, reviewed by Developer | |
| **4. Test design** | Test cases are written **before any code**, from the acceptance criteria: UI cases as SF AI Tester suites, unit and manual cases in a test-case index | AI (Tester persona) | |
| **5. Jira** | Epic, stories, "blocks" links and test cases are pushed to Jira idempotently (re-running never duplicates) | Architect, Tester | **G2** Tester confirms testability and sets `ai-ready` |
| **6. Plan** | Jira triggers GitHub. AI writes `PLAN.md` and `TESTPLAN.md` for the story on a draft PR | AI (Developer persona) | **G3** Developer approves plan · **G4** Tester approves test plan |
| **7. Build** | AI implements the story, proving it with check-only deploys to DEV, and references every unit test case | AI (Developer persona) | |
| **8. Checks** | Protected-path guard, lint/Jest, test-case coverage, Code Analyzer gate, AI Reviewer (design conformance), deploy to QA, Apex tests, optional SF AI Tester run, CodeRabbit | CI | |
| **9. Fix loop** | Failures are routed: defects back to the AI (max 3 attempts), blocked tests to QA, infrastructure to an automatic re-run, then a human | CI | |
| **10. Review** | Code review, QA exploration on the QA sandbox, schema/design review | Developer, Tester, Architect | **G5 · G6 · G7** |
| **11. Release** | Architect merges; production deploys a delta (including deletions) after approval, **with no AI in the workflow** | Architect | **G8** merge · **G9** production |

## How it works

```
 transcript ─▶ /circuit-intake ─▶ spec + clarification ─▶ /arch-design ─▶ plan.md ──[G1]
     ─▶ stories (Story 00 first) ─▶ /dev-review-stories ─▶ /qa-design-tests ─▶ spec PR merged
     ─▶ /arch-jira-push ─▶ /qa-push-tests ──[G2 ai-ready]
                                   │  Jira Rule A sends only the issue key
                                   ▼
 GitHub Actions:  claude-plan ─▶ PLAN.md + TESTPLAN.md ──[G3 plan-approved][G4 testplan-approved]
                  claude-build ─▶ pr-checks + Reviewer + CodeRabbit ─▶ ai-fix-loop (≤ 3)
                  ──[G5 Developer][G6 Tester][G7 Architect] ──[G8 merge] ─▶ deploy-prod ──[G9]
```

### The personas

| Persona | Does | Never does |
|---|---|---|
| **Architect** (`cc-arch`) | Transcript to spec, design, Lucid/Confluence, stories, Jira push, schema review, release notes | Write code or tests, tick its own sign-off, deploy |
| **Developer** (`cc-dev`) | Story review, plans, implementation with check-only validation, code review | Edit test cases, specs or the constitution, deploy for real, merge |
| **Tester** (`cc-qa`) | Test design from acceptance criteria, Jira test push, test-plan review, QA exploration and triage | Edit code in `force-app/`, weaken an expected result, deploy anywhere but QA |
| **Reviewer** (CI only) | Read-only check of every AI PR against the approved plan, security and limits | Edit files or approve |

### The safety model

`circuit-guard` is a Claude Code hook that runs before every tool call, on laptops (through the plugin or the repo
settings) and in CI. It denies:

- any Salesforce command aimed at production, and any login to a production URL;
- `gh pr merge`, approving reviews, pushes to `main`, and force pushes;
- persona boundary violations: the Developer editing tests, the Tester editing code, the Architect editing either;
- AI ticking the Architect Sign-Off or adding the gate labels;
- reading keys, `.env` files or Salesforce session files.

On top of that: GitHub rulesets (code-owner reviews, required checks, architects-only merge), a protected
`production` environment, team checks on every gate, write-scope checks after every AI step, and a hard limit of 3
AI attempts.

---

## Repository layout

| Path | What it is |
|---|---|
| [`sf-delivery-circuit/`](sf-delivery-circuit/) | **The plugin**: personas, skills, guard hook, templates ([details](sf-delivery-circuit/README.md)) |
| [`AgenticImplementation.md`](AgenticImplementation.md) | The build runbook: phases B0–B12 and human checkpoints HC-1…HC-9 |
| [`CredentialsSetup.md`](CredentialsSetup.md) | Step-by-step screens for every credential (GitHub App, Salesforce JWT, Jira, Slack, Claude token) |
| [`AgenticImplementation.v1.md`](AgenticImplementation.v1.md) | The original pipeline design (history) |
| `.claude-plugin/marketplace.json` | Lets Claude Code install the plugin straight from this repo |

## Install

In Claude Code:

```
/plugin marketplace add pavansaikodanda/agentic-implementation-circuit
/plugin install sf-delivery-circuit@conscendo-delivery
```

For local development, run `claude --plugin-dir ./sf-delivery-circuit`.

## Quick start

1. **Set up a client repo:** open Claude Code in the client's Salesforce DX repo and run `/circuit-bootstrap`. It
   works through B0–B12: tools, GitHub teams and App, Salesforce JWT access, Spec Kit + spec-kit-sf, Jira,
   Confluence, Slack, workflows and rulesets. It stops at each step that needs you (sign-ins, tokens, approvals) and
   records progress in `build-state.md`.
2. **Each person, once:** `./scripts/setup-persona.sh architect|developer|tester`. This adds the `cc-arch`, `cc-dev`
   and `cc-qa` commands and signs in to the sandboxes. It never signs in to production.
3. **Start a feature:** drop a transcript in `inputs/transcripts/` on an `intake/<name>` branch, or run
   `/circuit-intake <file>` as the Architect.
4. **Anytime:** `/circuit` shows the map and tells you where any feature or Jira story stands and who acts next.

## Skills

| Skill | Persona | What it does |
|---|---|---|
| `/circuit` | any | Map, conventions, and status of a feature or story |
| `/circuit-bootstrap` | admin | Installs and connects the whole circuit in a repo (B0–B12) |
| `/circuit-intake` | Architect | Transcript to draft spec, clarification and (if clear) plan |
| `/arch-design` | Architect | Answers open questions, plan, Lucid diagram, Confluence page; prepares G1 |
| `/arch-jira-push` | Architect | Epic, Story 00 and stories to Jira, idempotent, with blocks links |
| `/arch-review-pr` | Architect | Schema and design review of a PR (G7) |
| `/dev-review-stories` | Developer | Buildability, Story 00 completeness, dependencies and estimates |
| `/dev-review-plan` | Developer | Reviews the AI plan (G3) |
| `/dev-review-pr` | Developer | Code review of an AI PR (G5) |
| `/qa-design-tests` | Tester | Test cases per acceptance criterion and persona, SF AI Tester suites, validated |
| `/qa-push-tests` | Tester | Test cases to Jira and linked to stories; guides G2 |
| `/qa-review-testplan` | Tester | Reviews the AI test plan (G4) |
| `/qa-explore` | Tester | QA on the sandbox: re-runs, manual scripts, exploration, triage (G6) |

Spec Kit's own commands (`/speckit-sf-specify`, `/speckit-sf-plan`, `/speckit-sf-stories`, `/speckit-sf-implement`, …)
are installed into each client repo by the bootstrap. The plugin orchestrates them; `deploy`, `hotfix` and `pr` are
disabled because CI and the no-AI release workflow handle those.

## GitHub workflows installed into a client repo

| Workflow | Trigger | Does |
|---|---|---|
| `spec-from-transcript` | push to `intake/**` | AI drafts the spec and opens a draft spec PR; pings `#arch-gate` |
| `spec-gate` | every PR | Enforces G1: no open questions, sign-off ticked **by an architects member**, Story 00 present |
| `claude-plan` | Jira Rule A (`jira-ready`) | AI writes PLAN.md + TESTPLAN.md; checks every test case is planned at its level |
| `persona-gates` | label / review | Only `developers` can set `plan-approved`, only `testers` can set `testplan-approved`; approvals become `gate/*` statuses |
| `claude-build` | both plan labels | Re-checks G3/G4, AI builds with check-only deploys, write-scope guard, pushes with the bot App |
| `pr-checks` | every PR | guard · static (lint, Jest, TC coverage, Code Analyzer) · reviewer · qa (deploy, Apex, SF AI Tester) |
| `ai-fix-loop` | failed checks / changes requested | Routes to Developer AI, QA, re-run or human; max 3 attempts; one dispatch per commit |
| `deploy-prod` | merge to `main` | **No AI.** Environment approval, then delta validate and quick deploy, including deletions |

## Requirements

- Claude Code on a Claude subscription (Pro, Max, Team or Enterprise). CI uses `CLAUDE_CODE_OAUTH_TOKEN` from
  `claude setup-token` on a dedicated seat. **No Anthropic API key is used anywhere.**
- GitHub (organisation with teams), Salesforce DEV and QA sandboxes plus production, Jira Cloud, Confluence + Lucid,
  Slack. Fireflies, CodeRabbit and SF AI Tester are optional.
- Node 22+, Salesforce CLI, `gh`, `jq`, `uv` + `specify-cli`, Python 3 (for the SF AI Tester validator).
- Built on [GitHub Spec Kit](https://github.com/github/spec-kit) and
  [spec-kit-sf](https://github.com/Evernorth/spec-kit-sf) v2.0.1. Both are installed from upstream into each client
  repo, so they stay updatable.

## Status

The plugin, its templates and its tests are built and checked locally:

- guard policy tests: 52/52 pass (`node sf-delivery-circuit/tests/guard.test.mjs`);
- all 8 workflows pass `actionlint`; the CI scripts pass `shellcheck`;
- the installer was tested on a scratch repo, including re-runs (idempotent, merges existing settings).

Not yet run end to end against live systems: that is runbook phase B11 (dry run). Items marked **VERIFY** (action
versions, MCP URLs, Spec Kit flags, SF AI Tester CLI flags and output format, sfdx-git-delta flags) are checked
against vendor docs during bootstrap.
