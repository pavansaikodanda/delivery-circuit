# Delivery Circuit for VS Code

One VS Code extension for the AI + Human Salesforce delivery circuit, v3 (the
[`sf-delivery-circuit`](../sf-delivery-circuit/) plugin; design contract [`docs/CIRCUIT-V3.md`](../docs/CIRCUIT-V3.md)).
It works on a client Salesforce DX repo that the circuit bootstrap set up. It shows each person what waits on them,
runs the human gates with their own GitHub account, starts Claude as their persona, keeps the Architect's sources,
runs AI tests, and shows every connection the circuit needs in one place.

**Nothing is stored.** The extension uses logins you already have: VS Code's GitHub sign-in, the logged-in `claude`
CLI, the `sf` CLI, the Atlassian CLI (`acli`), and the MCP sign-ins in Claude Code. It never asks for an API token.

AI never approves, merges or deploys to production from here. Gate buttons act as the signed-in person, always
confirm first ("Add label plan-approved to PR #42 in acme-org/acme-shipping as demo.user"), and the guard hook and
GitHub rules still enforce the rest.

## What each persona sees

Your persona comes from your GitHub team membership (`deliveryCircuit.githubTeams`; defaults `architects`,
`developers`, `testers`). For a repo owned by a personal account there are no teams, so set
`deliveryCircuit.personaOverride` instead. If you hold more than one persona, **Switch Persona** picks the one you act as.

| | Architect | Developer | Tester |
|---|---|---|---|
| Persona views | All three (acts only as Architect; the others are view only) | Own view | Own view |
| Waiting on you | Approve design (G1), clarifications, design changed (C5), G7 design review, G8 merge, G9 release approval | Story review, **Start story**, G3 plan approval, **Fix with AI**, **Open review room**, **Record verdict**, G5 code review | Test design, G2 testability, **Add tests to <KEY>**, G4 test-plan approval, `needs-qa` cases, G6 QA |
| AI actions (Claude as the persona) | Intake from a source, design, record decision, Jira push, PR review | Review stories, start story, fix, review room, review plan, review PR | Design tests, push tests, add tests, review test plan, QA exploration |
| Sources page | Yes (only persona that can read sources) | No | No |
| Testing page | Yes, read only | No | Yes, runs tests |
| Connections page | Yes | Yes | Yes |
| Project setup wizard | Admins only (org or repo admin), any persona | | |

Surfaces:

- **Sidebar (Circuit):** your login and active persona, the top 8 items waiting on you (oldest first; each with its
  gate icon, status and age), and navigation. Empty states cover no git remote, not signed in, no persona, and a repo
  not yet set up with the circuit.
- **Status bar:** `Circuit: <Persona> · N waiting`; click to focus the sidebar.
- **Persona panel:** what waits on you, features with a stage line (source to release, gates in the expanded row),
  pull requests with one computed status (checks, reviews and the review-room verdict in the expanded row), and the
  persona's AI actions in the "Start AI session" menu.
- **Feature panel:** stage line and the next gate, the Confluence design page with its approved version, decisions,
  stories from Jira with their PR state, and (Architect only) the sources it used.

Features come from **Jira epics and Confluence design pages** (read with `acli` and the Atlassian MCP), not from
`.specify/specs` files on `main`. Every row that refers to something outside VS Code links to it: GitHub, Jira,
Confluence, Lucid, Salesforce, Slack, Fireflies, CodeRabbit, or the file.

## The v3 queue

| Item | Shows for | When | Action |
|---|---|---|---|
| Approve design | Architect | design page drafted, not yet Approved | `arch:approve-design` opens the Confluence page so a person sets Approved (G1) |
| Design changed | Architect, Developer | the page's approved version is newer than the story's *Approved design version* (C5) | re-plan or re-approve |
| Start story | Developer | story has G2 (`ai-ready` + *Testability confirmed*) and no PR | `dev:start-story`: Claude reads the story, ACs, approved design and test cases, writes PLAN.md + TESTPLAN.md, creates `feature/<KEY>-<slug>` and a draft PR titled `<KEY> …` |
| Add tests to <KEY> | Tester | the story PR exists without `tests/<KEY>.tc.json` | `qa:add-tests` commits the suite and the test-case index to the PR |
| Fix with AI | Developer | a check failed on the story PR | `dev:fix` with the failure prefilled; after 3 AI attempts the PR gets `needs-human` |
| Blocked UI case | Tester | SF AI Tester reports a blocked case (`needs-qa`) | open the case and re-run or fix the test |
| Open review room | Developer | checks are green and no thread exists | `review:open-room`: your Claude posts the kick-off in `#review-room` through the Slack MCP |
| Record verdict | Developer | a review-room thread exists | `review:record-verdict` posts Must fix / Disputed / Dropped as a PR comment |
| Record decision | any | from a feature's menu | `decision:record` adds a row to the design page's Decisions section (C1) |

The existing gate actions (G3, G4, G5 to G8 reviews, G9) stay as they were.

## Sources (Architect)

**Delivery Circuit: Sources** collects what the Architect turns into a spec:

- **Paste or dictate** into a text box (works with Wispr Flow or any dictation tool).
- **Attach a local file**: txt, md, docx, vtt, srt or pdf.
- **Fireflies**: a list of recent meetings fetched through the Fireflies MCP in a Claude call, or a Fireflies file
  export.
- **Wispr Flow import**: paste, a file export, or reading Wispr Flow's local history **read-only**, only after you give
  explicit consent.
- **Watch folder** (optional): files dropped into a folder you choose are added as sources.

Content is stored encrypted (AES-256-GCM, key in VS Code SecretStorage) in the extension's global storage. The repo
keeps only `.circuit/sources.json` (ids, titles, dates, which epic used it). Transcripts never enter git.

## Connections

**Delivery Circuit: Connections** lists everything the circuit uses, filtered to what your personas need. Every row
is a login or an install; none asks for a token. Personal connections are yours; project connections are visible to
everyone and only admins can change them.

| Group | Connection | How it is checked |
|---|---|---|
| Personal | GitHub | VS Code GitHub sign-in (scopes `repo`, `read:org`, `workflow`) |
| | Claude (subscription) | `claude auth status`; warns when `ANTHROPIC_API_KEY` is set |
| | Salesforce DEV org, QA org | `sf org display` for the aliases in `build.config.yml`; **Log in** opens `sf org login web` in a terminal. Any org edition is accepted; only the production alias is refused |
| | Atlassian CLI (Jira) | `acli jira auth status` plus a one-item search; **Log in** opens `acli jira auth login --web`. Warns when `acli` is missing or older than its 6-month support window |
| | Test browsers | Playwright browser check, with an install terminal |
| Claude MCP servers | Atlassian, Fireflies, Slack, Lucid (and Salesforce DX) | Read from `.claude/personas/*.mcp.json` and `claude mcp list`. Sign-in happens in Claude Code (`/mcp`) or as claude.ai connectors |
| Project | Self-hosted runner | GitHub API: a runner with labels `circuit` (and `circuit-release`) is online |
| | Rulesets, `production` environment | Present and matching the templates |
| | GitHub for Atlassian | A recent branch or PR shows in the Jira development panel |
| | CodeRabbit | `.coderabbit.yaml` plus a recent `coderabbitai[bot]` review; Connect opens the GitHub App page to give the repo access |
| | Salesforce Code Analyzer, AI Reviewer | Run as self-hosted jobs in `pr-checks`; the row shows the last result |

The v2 token prompts for Jira, Confluence and Fireflies, the AI Reviewer token flow, and the CI-secrets section are
gone. The page instead warns if the repo still has `CLAUDE_CODE_OAUTH_TOKEN`, `SF_JWT_*` or `JIRA_API_TOKEN` secrets
(visible to repo admins).

Review results reach the views too: every PR shows its signals grouped by source (human reviews, CodeRabbit, AI
Reviewer `VERDICT: PASS|BLOCK`, Code Analyzer, SF AI Tester, review-room verdict), with "No signal yet" for a tool
that hasn't reported.

## Circuit MCP

The extension runs a small MCP server so Claude sessions can read circuit state without scraping files:

- Streamable HTTP on `127.0.0.1` (random port, started on first use), one random bearer token per persona, created in
  memory for the session, loopback-only Host and Origin checks.
- Endpoints are issued only for personas you hold. Tools a persona may not use are not registered at all.
- Tools: `circuit_status`, `feature_get`, `queue_get`, `story_get` (Jira), `design_get` (approved version),
  `decisions_get`, `org_snapshot_get`, `test_results_get` (all personas); `prs_list`, `pr_get`, `connections_status`
  (people personas); `sources_list`, `transcript_get` (Architect only). `jira_map_get` is removed.
- Terminal sessions get `.claude/personas/<persona>.local.mcp.json` (gitignored, rewritten each session) with the
  Circuit server plus the vendor servers; panel sessions get an in-process server.
- `dist/circuit-mcp.js` is a stand-alone stdio build with the repository-only tools (for the runner or Claude outside
  VS Code).

## AI sessions

**Start AI Session** (or any AI action) starts Claude as the persona, as set by `deliveryCircuit.sessionMode`:

- `terminal` (default): `claude --agent <persona> --mcp-config <persona config> --strict-mcp-config "<prompt>"` in
  an integrated terminal. The prompt is one argument; `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from
  the terminal environment, so your Claude Team login is used.
- `panel`: a chat panel driven by the Claude Agent SDK, with the repo's agents, skills, settings and guard hook,
  permission prompts (Allow / Allow for this session / Deny), streaming text, tool rows, Stop and resume.

## Testing

The SF AI Tester engine is built in (**Delivery Circuit: Testing**, Tester and Architect):

- Suites from `test-cases/*.sf-tests.yaml` (per story: `test-cases/<KEY>.sf-tests.yaml`), with the last status per
  case and the Jira test case each one maps to.
- Manual, automation (Playwright specs under `tests/sf-ai/`) or both; model fallback chain; parallel workers;
  re-runs replay recorded actions and only ask the AI to verify.
- Runs against the `dev` or `qa` alias through the sf CLI (frontdoor login; no password stored), writing
  `.sf-ai-tester/runs/<time>/` with `results.json`, `status.json`, `report.html`; the route (pass, dev, qa, infra)
  matches the runner's `ai-tester-verdict.mjs`.
- Generate cases from a requirement (validated before saving), validate a suite, export to Excel or PDF.
- Settings: `deliveryCircuit.testing.headless`, `.models`, `.workers`, `.maxTurns`.

## Project setup wizard

**Delivery Circuit: Project Setup** (admins only) walks the v3 setup phases, reading and writing `build-state.md`:
tools and logins (`gh`, `claude`, `sf`, `acli`), MCP sign-ins, Jira and Confluence checks, the bundled installer,
labels, rulesets and the `production` environment, GitHub for Atlassian, CodeRabbit, and **self-hosted runner
registration** (labels `circuit` and `circuit-release`, run as a service under the logged-in user, fork-PR settings).
It has no secrets step. Each step is an automatic check, a safe command that confirms first, a terminal for an
interactive login, or a "You do this" step with the vendor link, a checklist and a Verify button.
`build.config.yml` is edited through a form that keeps comments and refuses values that look like secrets. The plugin
is bundled in the VSIX, so the wizard works offline. The full steps are in
[`ConnectionsSetup.md`](../ConnectionsSetup.md).

## Look and feel

The pages follow design v2, "Quiet Circuit" (`design/DESIGN.md`, prototype in `design/prototype.html`, screenshots
in `design/screens/`). The design aims to be calm and easy to scan:

- **One line per item.** Each row shows its title, one status, its age and one main action. Links, other actions,
  checks and reviews appear when you hover the row (app logos and a "…" menu) or click it to expand.
- **Three colours.** Indigo for actions and selection, teal for progress and the count of items waiting on you, slate
  for text and icons. Status is a small dot and a word. Your persona is a small chip in the header and does not tint
  the page.
- **App logos.** GitHub, Jira, Confluence, Atlassian, Lucid, CodeRabbit, Claude and Anthropic use monochrome logos
  from the `simple-icons` package. Slack, Salesforce, Fireflies and Wispr Flow use neutral icons.
- **Unavailable actions say why.** A greyed-out button shows the reason in its tooltip, and the expanded row repeats
  it. For example, an Architect looking at the Developer tab sees "Only a Developer can run this".
- **Follows VS Code.** Backgrounds and fonts come from your theme. The pages work in dark, light and high contrast.
  Motion is short and turns off when your system asks for reduced motion.

## Install

Requirements: VS Code 1.90 or later, Git, the Salesforce CLI (`sf`), Claude Code (`claude`, signed in on a Claude
Team seat), the Atlassian CLI (`acli`), Node 20+. Python is needed only to validate test suites.

1. Build the package (see Develop) or take `delivery-circuit.vsix` from a release.
2. `code --install-extension delivery-circuit.vsix` (or Extensions view → … → Install from VSIX).
3. Open the client repo, sign in to GitHub from the Circuit sidebar, then open **Connections** and log in to each row.
4. Testers: run **Install** on the Test browsers row once.

The VSIX ships the runtime dependencies (Agent SDK, Playwright, Playwright MCP, ExcelJS) but **not** the Agent SDK's
330 MB platform binary of Claude Code. Panel sessions and the testing engine use your installed Claude Code instead
(found on `PATH`; native `claude.exe` / `claude`, or an npm install).

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

The integration test opens a copy of `../salesDemoOrg` (without `node_modules`, `.sf`, `.sfdx`) once per persona
(Architect, Developer, Tester) and checks activation, command registration, the visible views, allowed and refused
actions, and the Circuit MCP tool list for each persona (only the Architect has `transcript_get`). It replaces the
GitHub identity through a test-only hook that exists only when VS Code runs the extension in test mode. The live
end-to-end script is [`docs/E2E-TEST-PLAN.md`](../docs/E2E-TEST-PLAN.md).

## Limits

- **Vendor MCP sign-in is per person and happens in Claude Code.** The Connections page shows the state, but each
  server needs a one-time `/mcp` sign-in, or a claude.ai connector. `claude -p` cannot run the OAuth flow, so sign in
  from an interactive session first. Slack's MCP does not support dynamic client registration, so use the claude.ai
  Slack connector.
- Persona terminal sessions use `--strict-mcp-config`, which does not load claude.ai connectors. Servers that are only
  available as claude.ai connectors (Slack, and Fireflies or Lucid if added that way) need to be listed in the persona
  MCP config or reached from a panel session; the Connections page says which.
- MCP sign-in status is best effort: `claude mcp list` has no JSON output and does not read the persona config files,
  so rows match servers by host and may say "Not verified, check /mcp".
- `acli` has no Confluence commands in Atlassian's official reference, so Confluence reads go through the Atlassian
  MCP. The output format of `acli jira auth status` and of `--json` is not documented; the extension parses it
  defensively and falls back to a one-item search.
- Confluence cannot restrict status changes to a group. The extension and `design-gate` accept Approved only when the
  version that set it was saved by an `architects` member.
- `@salesforce/mcp`, which the persona templates use, reached end of life on 2026-11-02 (replacement:
  forcedotcom/sf-skills). The rows flag it.
- Listing runners and Actions secrets needs repo admin; for other people project rows say "not visible to you".
- Automation-mode tests need `@playwright/test` in the client repo. Manual replays repeat recorded actions literally
  (including record names).
- Panel mode uses your local Claude Code subscription login. The Agent SDK terms do not allow third-party products
  to offer claude.ai login without approval, so keep panel mode to internal use; terminal mode (the default) avoids
  the question.
