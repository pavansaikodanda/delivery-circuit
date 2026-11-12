# Connecting the external systems (v3: logins only)

VERIFY every Setup label, menu path and command against current vendor docs on the day you do it. Nothing here
creates a token, key, webhook or GitHub secret. Sample values are placeholders (acme-org, ACME,
acme.atlassian.net, demo.user@example.com).

## Self-hosted runners (B2)
Docs: docs.github.com → Actions → Hosting your own runners.
- Two runners: `circuit` (PR checks with logins) and `circuit-release` (deploy-prod only). Separate machines, or at
  least separate service users, so the circuit runner never holds the production login.
- Registration token (repo admin; expires after 1 hour):
  `gh api -X POST repos/acme-org/acme-salesforce/actions/runners/registration-token --jq .token`
- Download the runner from Settings → Actions → Runners → New self-hosted runner (it shows the current version), then:
  - Linux / macOS: `./config.sh --url https://github.com/acme-org/acme-salesforce --token <token> --labels circuit`
    then `sudo ./svc.sh install <service-user> && sudo ./svc.sh start` (macOS: `./svc.sh install && ./svc.sh start`).
  - Windows (admin shell, folder `C:\actions-runner`): `.\config.cmd --url … --token <token> --labels circuit` and
    answer **Y** to "run as service"; manage it with `Get-Service "actions.runner.*"`.
  - `config` cannot add labels to an already registered runner: change them in Settings → Actions → Runners →
    the runner → Labels.
- Workflows target `runs-on: [self-hosted, circuit]` / `[self-hosted, circuit-release]` (all listed labels must
  match). `.github/actionlint.yaml` declares the custom labels for actionlint.
- Fork safety (GitHub: "self-hosted runners should almost never be used for public repositories"):
  - keep the repo private and leave "Run workflows from fork pull requests" off;
  - public repo: "Require approval for all external contributors" (the first-time-contributor options can be bypassed);
  - every self-hosted job in the circuit also has `if: github.event.pull_request.head.repo.full_name == github.repository`
    (or the `workflow_run` equivalent), and `guard` (GitHub-hosted, required) fails fork PRs so they never merge.
- Service-user logins, done once by a person in a terminal on the runner, as that user:
  | Login | Command | Used by |
  |---|---|---|
  | GitHub | `gh auth login` (scopes `repo, read:org`) | team membership in persona-gates / fix-router |
  | Claude | `claude` (sign in with the Claude Team seat), then `/mcp` → Slack | AI Reviewer, SF AI Tester, slack.sh |
  | Jira | `acli jira auth login --web` | design-gate, jira.sh comments, AI Reviewer story context |
  | Salesforce (circuit) | `sf org login web --alias qa` (`sf org login device --alias qa` if headless); also `dev` if useful | qa job |
  | Salesforce (release) | `sf org login web --alias prod` (HC-5, the person) | deploy-prod |
- Check: `bash scripts/ci/runner-check.sh --gh --acli --claude --sf qa --not-sf prod` on `circuit`;
  `gh api repos/acme-org/acme-salesforce/actions/runners --jq '.runners[] | {name, status, labels: [.labels[].name]}'`.
- Logins expire (org refresh, session policy, password change): re-run the login as the service user. A failed
  "Runner logins" step is routed by fix-router to a re-run, then `needs-human`.

## Atlassian CLI (acli, B6)
Docs: developer.atlassian.com/cloud/acli. acli covers **Jira only** (no Confluence commands in the official
reference); Confluence goes through the Atlassian Rovo MCP server.
- Install:
  - Windows: `Invoke-WebRequest -Uri https://acli.atlassian.com/windows/latest/acli_windows_amd64/acli.exe -OutFile acli.exe`
    (arm64: `acli_windows_arm64`), put it on PATH, `acli --help`.
  - macOS: `brew tap atlassian/homebrew-acli && brew install acli`.
  - Linux: apt repo `https://acli.atlassian.com/linux/deb` (key `https://acli.atlassian.com/gpg/public-key.asc`),
    yum repo `https://acli.atlassian.com/linux/rpm/acli.repo`, or the binary from
    `https://acli.atlassian.com/linux/latest/acli_linux_amd64/acli`.
- Each acli version is supported for 6 months: update laptops and runners before then (Reminders in build-state.md).
- Login: `acli jira auth login --web` (browser OAuth; then pick the site, e.g. acme.atlassian.net, in the terminal).
  Do **not** use the `--token` form. Check: `acli jira auth status` (its output and signed-out exit code are not
  documented: VERIFY once and note it in build-state.md).

## Jira (B6)
- Groups `architects`, `developers`, `testers` with the same people as the GitHub teams.
- Fields (Settings → Issues → Custom fields; add each to the Epic / Story / Test screens):
  *Design page* (URL), *Approved design version* (number), *Acceptance criteria* (paragraph), *Story type*
  (select: foundation, feature), *Schema change* (select: yes, no), *Persona* (short text), *Test level* (select:
  ui, unit, manual), *AC id* (short text), *Testability confirmed* (checkbox or select).
- Epic workflow: Backlog → Design Review → **Approve design** → Design Approved. Restrict the Approve design
  transition to group `architects` (condition "User is in group") and show *Approved design version* on its screen.
  If the design is reopened, transition the epic back to Design Review (design-gate then fails every story).
- Story workflow: Backlog → **Ready for Dev** (condition: group `testers`, *Testability confirmed* set, label
  `ai-ready`: G2) → In Build → Code Review → QA → Done. Optional automation: on "Pull request merged" → Done.
- No Jira automation calls GitHub: Developers start stories from the extension. No PAT in any Jira rule.
- GitHub for Atlassian: Jira → Apps → Explore more apps → "GitHub for Atlassian" → Get app; connect the GitHub org
  (needs a Jira site admin and a GitHub org owner). Keys in branch names (`feature/ACME-12-…`) and PR titles
  (`ACME-12 …`) link development info to the work item; use uppercase keys.

## Confluence, Atlassian MCP, Lucid, Fireflies (B7)
- Atlassian Rovo MCP: `https://mcp.atlassian.com/v2/mcp` (OAuth 2.1, the user's own permissions). Already in
  `.claude/personas/*.mcp.json`; or `claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp`.
  Sign in with `/mcp` in an interactive session (`claude -p` cannot run OAuth). Connectors added on claude.ai also
  appear in Claude Code. Do not enable API-token auth for the MCP server.
- Confluence space: Space settings → Content status → add **Approved** as a suggested status. Status changes cannot
  be limited to a group natively: restrict **edit** of approved design pages to `architects`, and `arch-approve-design`
  checks the approver from page history.
- Lucid for Confluence: installed by a Confluence admin; Architects sign in to the Lucid MCP via `/mcp`.
- Fireflies: `https://api.fireflies.ai/mcp` (Streamable HTTP; OAuth through the claude.ai connector, or
  `claude mcp add --transport http fireflies https://api.fireflies.ai/mcp` then `/mcp`: VERIFY). No Fireflies API key.

## Slack (B8)
- Slack MCP: `https://mcp.slack.com/mcp`; use the claude.ai Slack connector (a workspace admin approves it), which
  appears in Claude Code as an MCP server (default name `claude_ai_Slack`: VERIFY with `claude mcp list`). Each
  person signs in once; so does the `circuit` runner's service user when `CIRCUIT_SLACK_TRANSPORT=claude`.
- GitHub app for Slack: `/github subscribe acme-org/acme-salesforce deployments` in `#arch-gate`, pulls and labels in
  `#dev-gate` (it also serves as the transport when `CIRCUIT_SLACK_TRANSPORT=github-app`).
- `#review-room`: invite CodeRabbit and Claude; the `review-room` skill posts the kick-off brief through the
  Developer's Slack MCP.
- No incoming webhooks, no bot tokens.

## Salesforce (B3)
- Any connected org can be DEV or QA (sandbox, scratch, Developer Edition, demo org). Each person logs in with their
  own user: `sf org login web --alias dev`, `sf org login web --alias qa`. No integration user, no External Client
  App, no JWT certificate.
- The production org is the one the project names (`salesforce.prod_alias`, also `prod|production|live` and
  `CIRCUIT_PROD_ALIASES`). Only Architects (manually) and the `circuit-release` runner hold that login; the guard
  blocks AI sessions from it.
