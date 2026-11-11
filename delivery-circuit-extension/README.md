# Delivery Circuit for VS Code

One VS Code extension for the AI + Human Salesforce delivery circuit (the
[`sf-delivery-circuit`](../sf-delivery-circuit/) plugin). It works on a client Salesforce DX repo that the circuit
bootstrap set up (`.specify/`, `.claude/`, `test-cases/`, `.github/workflows/`). It shows each person what waits on
them, runs the human gates with their own GitHub account, starts Claude as their persona, runs AI tests, and keeps
every connection the circuit needs in one place.

AI never approves, merges or deploys to production from here. Gate buttons act as the signed-in person, always
confirm first ("Add label plan-approved to PR #42 in acme/crm as pat"), and the guard hook and GitHub rules still
enforce the rest.

## What each persona sees

Your persona comes from your GitHub team membership (`deliveryCircuit.githubTeams`; defaults `architects`,
`developers`, `testers`). For a repo owned by a personal account there are no teams, so set
`deliveryCircuit.personaOverride` instead. If you hold more than one persona, **Switch Persona** picks the one you act as.

| | Architect | Developer | Tester |
|---|---|---|---|
| Persona views | All three (acts only as Architect; the others are view only) | Own view | Own view |
| Waiting on you | G1 sign-off, clarifications, G7 schema review, G8 merge, G9 production approval | Story review, G3 plan approval, G5 code review, AI take-over | G2 testability, test design, G4 test-plan approval, G6 QA |
| AI actions (Claude as the persona) | Intake from a transcript, design, Jira push, PR review | Review stories, review plan, review PR | Design tests, push tests, review test plan, QA exploration |
| Testing page | Yes, read only | No | Yes, runs tests |
| Transcripts and sources | Yes (only persona that can read them) | No | No |
| Connections page | Yes | Yes | Yes |
| Project setup wizard | Admins only (org or repo admin), any persona | | |

Surfaces:

- **Sidebar (Circuit):** your login and active persona, the top 8 items waiting on you (oldest first, gate badge,
  age, deep links, the main action), and navigation. Empty states cover no git remote, not signed in, no persona, and
  a repo not yet set up with the circuit.
- **Status bar:** `Circuit: <Persona> · N waiting`; click to focus the sidebar.
- **Persona panel:** features with the stage strip (intake to release) and gate strip (G1 to G9), pull requests with
  checks and review signals, the persona's AI actions. One tab per persona you can view.
- **Feature panel:** stage timeline, gates table, open questions, stories with Jira keys, test cases by level and
  PR links, spec files, and (Architect only) the cited transcript sources.

Every row that refers to something outside VS Code links to it: GitHub, Jira, Salesforce, Slack, Confluence, Lucid,
Fireflies, CodeRabbit, or the file.

## Connections

**Delivery Circuit: Connections** lists everything the circuit uses, filtered to what your personas need. Personal
connections are yours; project connections are visible to everyone and only admins can change them.

| Group | Connection | How it is checked / connected |
|---|---|---|
| Personal | GitHub | VS Code GitHub sign-in (scopes `repo`, `read:org`, `workflow`) |
| | Claude (subscription) | `claude auth status`; warns when `ANTHROPIC_API_KEY` is set |
| | Salesforce dev org, QA org | `sf org display` for the aliases in `build.config.yml`; `sf org login web` in a terminal; production login URLs refused unless the org is marked as a trial org |
| | Jira, Confluence | Site, email and API token, verified against the API, stored in VS Code SecretStorage |
| | Fireflies | API key, verified with a GraphQL user query, stored in SecretStorage |
| | Slack, Lucid | Guided: opens the page and asks you to confirm (no per-user API token is collected) |
| | Test browsers | Playwright browser check, with an install terminal |
| Claude MCP servers | Atlassian, GitHub, Salesforce DX, Slack, Lucid, Fireflies | Read from `.claude/personas/*.mcp.json` and `claude mcp list`. Sign-in happens in Claude Code (`/mcp` or `claude mcp login <name>`). Placeholder (`VERIFY`) URLs are flagged and can be filled with the documented URLs |
| **Review tools** (project) | CodeRabbit | `.coderabbit.yaml` plus a recent `coderabbitai[bot]` review; Connect adds the template config and opens the GitHub App install page |
| | Salesforce Code Analyzer | `sf plugins`; the row also says whether CI runs it |
| | AI Reviewer (CI) | `.claude/agents/reviewer.md` plus the `CLAUDE_CODE_OAUTH_TOKEN` repo secret. Connect runs `claude setup-token`, takes the token in a hidden box, seals it with the repo public key and stores it as the secret; the one-year expiry is tracked |
| Project | CI secrets, Slack webhooks, environment secrets | Read from the workflows; shows which exist (needs repo admin to list) and lets admins set them (libsodium sealed box). Expiry reminders come from `build-state.md` |

Review results reach the views too: every PR shows its signals grouped by source (human reviews, CodeRabbit, AI
Reviewer `VERDICT: PASS|BLOCK`, Code Analyzer, SF AI Tester), with "No signal yet" for a tool that hasn't reported.

Secrets live only in VS Code SecretStorage or go straight to GitHub Actions secrets. They are never logged, rendered
or written to files.

## Circuit MCP

The extension runs a small MCP server so Claude sessions can read circuit state without scraping files:

- Streamable HTTP on `127.0.0.1` (random port, started on first use), one random bearer token per persona,
  loopback-only Host and Origin checks.
- Endpoints are issued only for personas you hold. Tools a persona may not use are not registered at all.
- Tools: `circuit_status`, `feature_get`, `queue_get`, `jira_map_get`, `test_results_get` (all personas);
  `prs_list`, `pr_get`, `connections_status` (people personas); `sources_list`, `transcript_get` (Architect only).
- Terminal sessions get `.claude/personas/<persona>.local.mcp.json` (gitignored, rewritten each session) with the
  Circuit server plus the vendor servers; panel sessions get an in-process server.
- `dist/circuit-mcp.js` is a stand-alone stdio build with the repository-only tools (for CI or Claude outside VS Code).

Transcripts never enter git: uploads are stored encrypted (AES-256-GCM, key in SecretStorage) in the extension's
global storage, and the repo keeps only `.circuit/sources.json` (ids, titles, dates).

## AI sessions

**Start AI Session** (or any AI action) starts Claude as the persona, as set by `deliveryCircuit.sessionMode`:

- `terminal` (default): `claude --agent <persona> --mcp-config <persona config> --strict-mcp-config "<prompt>"` in
  an integrated terminal. The prompt is one argument; `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from
  the terminal environment, so your Claude subscription login is used.
- `panel`: a chat panel driven by the Claude Agent SDK, with the repo's agents, skills, settings and guard hook,
  permission prompts (Allow / Allow for this session / Deny), streaming text, tool rows, Stop and resume.

## Testing

The SF AI Tester engine is built in (**Delivery Circuit: Testing**, Tester and Architect):

- Suites from `test-cases/*.sf-tests.yaml`, with the last status per case, Jira keys from `jira-map.json`.
- Manual, automation (Playwright specs under `tests/sf-ai/`) or both; model fallback chain; parallel workers;
  re-runs replay recorded actions and only ask the AI to verify.
- Runs against the `dev` or `qa` org alias through the sf CLI (frontdoor login; no password stored), writing
  `.sf-ai-tester/runs/<time>/` with `results.json`, `status.json`, `report.html`; the route (pass, dev, qa, infra)
  matches CI's `ai-tester-verdict.mjs`.
- Generate cases from a requirement (validated before saving), validate a suite, export to Excel or PDF.
- Settings: `deliveryCircuit.testing.headless`, `.models`, `.workers`, `.maxTurns`.

## Project setup wizard

**Delivery Circuit: Project Setup** (admins only) walks phases B0 to B12 and human checkpoints HC-1 to HC-9 of the
runbook, reading and writing `build-state.md`. It runs automatic checks (CLI tools, GitHub, Jira, Confluence),
safe commands that confirm first (the bundled installer, labels, variables, rulesets), terminals for interactive
tools, and "You do this" steps with the vendor link, a checklist and a Verify button. `build.config.yml` is edited
through a form that keeps comments and refuses values that look like secrets. The plugin is bundled in the VSIX, so
the wizard works offline.

## Install

Requirements: VS Code 1.90 or later, Git, the Salesforce CLI (`sf`), Claude Code (`claude`, signed in with a
subscription), Node 20+. Python is needed only to validate test suites.

1. Build the package (see Develop) or take `delivery-circuit.vsix` from a release.
2. `code --install-extension delivery-circuit.vsix` (or Extensions view → … → Install from VSIX).
3. Open the client repo, sign in to GitHub from the Circuit sidebar, then open **Connections**.
4. Testers: run **Install** on the Test browsers row once.

The VSIX ships the runtime dependencies (Agent SDK, Playwright, Playwright MCP, ExcelJS, libsodium) but **not** the
Agent SDK's 330 MB platform binary of Claude Code. Panel sessions and the testing engine use your installed Claude
Code instead (found on `PATH`; native `claude.exe` / `claude`, or an npm install).

## Develop

```bash
npm install
node build.mjs            # dist/extension.js + dist/circuit-mcp.js; copies ../sf-delivery-circuit into plugin/
npx tsc --noEmit          # typecheck
npx vitest run            # unit tests (test/unit, vscode mocked)
npm run test:integration  # downloads VS Code into .vscode-test and runs test/integration on a temp copy of ../salesDemoOrg
npm run preview           # every webview page with fixture data: http://127.0.0.1:5178
npm run package           # build + delivery-circuit.vsix (with runtime dependencies)
npm run test:vsix         # unpacks the VSIX, checks its contents, runs the integration suite against the unpacked copy
```

Press F5 with this folder open to run the extension in a development host. Module layout and rules are in
[ARCHITECTURE.md](ARCHITECTURE.md): code against `src/core/contracts.ts`, keep VS Code-free logic in pure files with
unit tests, run processes with `run()` (array arguments), render webviews with `DC.h()`.

The integration test opens a copy of `../salesDemoOrg` (without `node_modules`, `.sf`, `.sfdx`) and checks
activation, command registration, the sidebar, the Circuit MCP tool lists for Architect (has `transcript_get`) and
Developer (does not), and that testing finds the `smoke-account` suite. It replaces the GitHub identity through a
test-only hook that exists only when VS Code runs the extension in test mode.

## Limits

- **Vendor MCP sign-in is per person and happens in Claude Code.** The Connections page shows the state, but
  Atlassian, Fireflies, Slack and Salesforce servers each need a one-time `/mcp` or `claude mcp login <name>`, and
  claude.ai connectors are authorised at claude.ai/customize/connectors. Servers without dynamic client registration
  (for example HubSpot and Zoom, and Slack's MCP) fail to connect from Claude Code. Persona sessions use
  `--strict-mcp-config`, so claude.ai org connectors are not loaded in them.
- MCP sign-in status is best effort: `claude mcp list` has no JSON output and does not read the persona config files,
  so rows match servers by host and may say "Not verified, check /mcp".
- `@salesforce/mcp`, which the persona templates use, reached end of life on 2026-11-02 (replacement:
  forcedotcom/sf-skills). The rows flag it.
- Listing Actions secrets needs repo admin; for other people project rows say "not visible to you".
- Some setup checks (GitHub App installations, teams) need an org owner or admin token and degrade to a warning
  otherwise. Jira transition restrictions cannot be read through the API.
- Automation-mode tests need `@playwright/test` in the client repo. Manual replays repeat recorded actions literally
  (including record names).
- Panel mode uses your local Claude Code subscription login. The Agent SDK terms do not allow third-party products
  to offer claude.ai login without approval, so keep panel mode to internal use; terminal mode (the default) avoids
  the question.
- The PR GraphQL query, deploy runs and Jira label lookup have been tested against fixtures, not yet against a live
  repo and Jira site.
