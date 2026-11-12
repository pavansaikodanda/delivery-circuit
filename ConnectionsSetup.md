# Connections Setup: logins only

This guide connects every app the Delivery Circuit v3 uses. It replaces the old `CredentialsSetup.md`. The design
contract is [`docs/CIRCUIT-V3.md`](docs/CIRCUIT-V3.md).

**The rule: nothing is stored.** Every connection is a login that a person (or the self-hosted runner's service
account) already has. There are no API tokens, JWT keys, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, webhook URLs
or GitHub App private keys in GitHub secrets, in files, or in the extension. If a step below asks you to paste a
long-lived token anywhere, it is the wrong step.

Work through the sections in order. Each one ends with a **Verify** line. The Delivery Circuit extension's
**Connections** page shows the same checks as rows, so you can also verify there.

Placeholders used below (replace them with your own values; never commit real ones to examples):

| Placeholder | Example | Meaning |
|---|---|---|
| `<ORG>` / `<REPO>` | `acme-org` / `acme-shipping` | GitHub organisation and the new circuit repo |
| `<SITE>` | `acme.atlassian.net` | Jira and Confluence site |
| `<PROJECT>` | `ACME` | Jira project key (stories look like `ACME-12`) |
| `<SPACE>` | `ACMEDESIGN` | Confluence space for design pages |
| `dev`, `qa` | | Salesforce CLI aliases for the DEV and QA orgs |
| `prod` | | The alias the project names as production (only the release runner logs in to it) |

---

## Who does what

| Section | Who | How often |
|---|---|---|
| 1. GitHub organisation and repo | GitHub org owner | once |
| 2. Your laptop (VS Code, `gh`, `claude`, `sf`, `acli`) | every person | once per laptop |
| 3. Claude MCP sign-ins (Atlassian, Fireflies, Slack, Lucid) | every person who needs them | once, then when a sign-in expires |
| 4. Jira and Confluence site setup | Atlassian site admin | once |
| 5. GitHub for Jira | Jira site admin + GitHub org owner | once |
| 6. CodeRabbit | GitHub org owner + Slack admin | once |
| 7. Claude Tag and `#review-room` | Claude org Owner + Slack admin | once |
| 8. Self-hosted runner | repo admin, on the runner machine | once per runner |
| 9. Wispr Flow and transcript files | Architect | nothing to connect |

---

## 1. GitHub organisation and repo

The circuit runs in a repository owned by your GitHub **organisation** (teams are needed for the persona gates).

1. Sign in to the org in the browser. Create the repo `<ORG>/<REPO>`. **Make it private.** Self-hosted runners
   (section 8) should almost never serve a public repository (see 8.5).
2. **Org → Teams:** create `architects`, `developers` and `testers`, and add people. Give each team **Write** on the
   repo; give `architects` **Maintain**. Your persona in the extension comes from these teams.
3. **Repo → Settings → Environments → New environment `production`:** required reviewers = team `architects`,
   tick *Prevent self-review*, deployment branches = `main` only. This is gate G9.
4. **Repo → Settings → Actions → General → Workflow permissions:** *Read repository contents*. Leave *Allow GitHub
   Actions to create and approve pull requests* unticked.
5. Rulesets (gates G3 to G8, architects-only merge) are applied by `/circuit-bootstrap` from
   `sf-delivery-circuit/templates/github/` after you confirm the JSON.

**Verify:** `gh api orgs/<ORG>/teams --jq '.[].slug'` lists the three teams, and
`gh api repos/<ORG>/<REPO>/environments/production --jq '.protection_rules[].type'` shows `required_reviewers`.

---

## 2. Your laptop

### 2.1 GitHub: VS Code sign-in and `gh`

1. In VS Code, open the Circuit sidebar and click **Sign in to GitHub**. Accept the scopes the extension asks for
   (`repo`, `read:org`, `workflow`). Gate buttons act as you with this sign-in.
2. In a terminal: `gh auth login` (GitHub.com, HTTPS, log in with a web browser). Repo admins setting up the runner
   also need `gh auth refresh -s admin:org` if the org owns the runner.

**Verify:** `gh auth status` shows you logged in to github.com, and the sidebar shows your login and persona.

### 2.2 Claude: the logged-in `claude` CLI on a Claude Team seat

Everyone uses their **own** Claude Team seat. No token is created or copied.

1. Install Claude Code (`npm i -g @anthropic-ai/claude-code`, or the native installer).
2. Run `claude`, then `/login`, and choose your Claude (claude.ai) account on the Team plan.
3. Make sure `ANTHROPIC_API_KEY` is **not** set in your shell profile or user environment. If it is, Claude Code bills
   the API instead of your seat. The extension removes it from the terminals it opens, and warns if it sees it.

**Verify:** `claude auth status` shows your claude.ai account, and the Connections page row "Claude (subscription)"
is green.

### 2.3 Salesforce: `sf` CLI logins for DEV and QA

Any connected org (sandbox, scratch, Developer Edition, SDO or other demo org) can be DEV or QA. There is no org-type
check. Only the alias the project names as production is off limits to AI.

```bash
sf org login web --alias dev  --instance-url https://acme-demo.my.salesforce.com   # everyone
sf org login web --alias qa   --instance-url https://acme-demo.my.salesforce.com   # Testers (and Developers who explore on QA)
```

Use your org's My Domain URL. Nobody logs in to the production alias on a laptop.

**Verify:** `sf org display --target-org dev --json` and `--target-org qa` both return a username, and the Connections
rows "Salesforce dev org" / "QA org" are green.

### 2.4 Atlassian CLI (`acli`): Jira login for the extension

The extension and the runner read Jira with the official Atlassian CLI. In the official reference `acli` has only
the `admin`, `feedback`, `jira` and `rovodev` command groups, so the circuit treats it as **Jira only**. Confluence
goes through the Atlassian MCP (section 3.1).

Install (developer.atlassian.com/cloud/acli/guides/install-acli/):

| OS | Install |
|---|---|
| Windows | `Invoke-WebRequest -Uri https://acli.atlassian.com/windows/latest/acli_windows_amd64/acli.exe -OutFile acli.exe` (use `acli_windows_arm64` on ARM), then put the folder on `PATH` |
| macOS | `brew tap atlassian/homebrew-acli && brew install acli` |
| Linux | the apt repo `https://acli.atlassian.com/linux/deb` (key `https://acli.atlassian.com/gpg/public-key.asc`), the yum repo `https://acli.atlassian.com/linux/rpm/acli.repo`, or the binary from `https://acli.atlassian.com/linux/latest/acli_linux_amd64/acli` |

Log in with the browser (no API token):

```bash
acli jira auth login --web
```

Accept in the browser, then pick the same site (`<SITE>`) in the terminal.

Each `acli` version is supported for only **6 months**. Update it when the Connections page says it is old.

**Verify:** `acli jira auth status` reports your site, and
`acli jira workitem search --jql "project = <PROJECT>" --limit 1 --json` returns one item.
(The docs do not describe the status output or its exit code when you are logged out, so the extension also runs a
one-item search.)

---

## 3. Claude MCP sign-ins

Claude sessions reach Atlassian, Fireflies, Slack and Lucid through MCP servers with OAuth. Tokens are kept and
refreshed by Claude Code. `claude -p` (headless) cannot run the OAuth flow, so **sign in once from an interactive
session first**: run `claude`, then `/mcp`, pick the server, and finish the browser sign-in.

Connectors you add at claude.ai (Settings → Connectors) also appear in Claude Code when you are logged in with that
claude.ai account.

| Server | Who needs it | Add it | Notes |
|---|---|---|---|
| **Atlassian** (Rovo) | everyone | `claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp`, then `/mcp` | Uses your own Jira and Confluence permissions. Confluence tools are `getConfluenceContent`, `createConfluenceContent`, `updateConfluenceContent`, `setConfluenceContentStatus` and others. Search tools that use Rovo credits are avoided |
| **Fireflies** | Architect | the Fireflies connector at claude.ai, or `claude mcp add --transport http fireflies https://api.fireflies.ai/mcp` (the Claude Code command is not in Fireflies' docs), then `/mcp` | Streamable HTTP only. Used for `fireflies_get_transcripts` and `fireflies_get_transcript` |
| **Slack** | Developer (review room), anyone posting updates | the Slack connector at claude.ai | Slack's MCP (`https://mcp.slack.com/mcp`) does not support dynamic client registration, so `claude mcp add` alone will not connect. A Slack workspace admin must approve the integration |
| **Lucid** | Architect | the Lucid connector at claude.ai, or the URL Lucid documents, then `/mcp` | Diagrams on the design page. Auto-updating embeds need the Lucid for Confluence app |

**Verify:** in `claude`, `/mcp` lists each server as connected. In the extension, the Connections rows for the
Atlassian MCP, Fireflies MCP and Slack MCP are green (status is best effort; a row may say "Not verified, check /mcp").

---

## 4. Jira and Confluence site setup (site admin)

### 4.1 Jira

1. Project `<PROJECT>` (company-managed), with issue types Epic, Story and a test-case type (Xray/Zephyr Test, or a
   "Test Case" type with a "tests / is tested by" link type).
2. Custom fields on Story: **Design page** (URL), **Approved design version** (number), **Acceptance criteria**
   (paragraph), **Testability confirmed** (checkbox).
3. Groups `architects`, `developers`, `testers` (admin.atlassian.com), matching the GitHub teams.
4. Labels used by the circuit: `ai-ready` (G2). No automation rule calls GitHub.

**Verify:** `acli jira workitem create --project <PROJECT> --type Story --summary "Connection check" --json` creates a
story, and you can delete it in Jira afterwards.

### 4.2 Confluence

1. Space `<SPACE>` for design pages (one page per feature).
2. **Space settings → page status:** add **Approved** as a suggested status (there is no Approved status by default;
   the defaults are Rough draft, In progress and Ready for review).
3. Confluence has no native way to let only a group set a status. The circuit therefore **checks it itself**: the
   design gate reads the page history and accepts Approved only if the version that set it was saved by an
   `architects` member. To stop others editing an approved page, restrict its edit permission to `architects`.

**Verify:** as an architect, set a test page's status to Approved in the browser; in Claude, ask the Atlassian MCP to
read that page and confirm the status and version number.

---

## 5. GitHub for Jira (GitHub for Atlassian app)

Links branches, commits and PRs to Jira stories. Developers create their own draft PRs; the link is automatic.

1. In Jira: **Apps → Explore more apps → "GitHub for Atlassian" → Get app** (needs a Jira site admin).
2. Open the app → **Connect GitHub organization** → `<ORG>` → select `<REPO>` (needs a GitHub org owner to approve).
3. Convention: branch `feature/<KEY>-<slug>` and PR title starting with `<KEY>` (uppercase, for example `ACME-12`).

**Verify:** push a branch `feature/ACME-12-connection-check`. Within a few minutes it shows in the Development panel of
`ACME-12`. Delete the branch.

---

## 6. CodeRabbit

1. In the CodeRabbit dashboard, sign in with GitHub, choose `<ORG>`, and give the CodeRabbit GitHub App access to
   `<REPO>` (Only select repositories → add the new repo).
2. `.coderabbit.yaml` is installed into the repo by `/circuit-bootstrap`.
3. Install the **CodeRabbit Slack agent** from the CodeRabbit dashboard, in the same Slack workspace.

**Verify:** open a test PR; CodeRabbit posts a review. In Slack, `@coderabbit` answers in `#review-room`.

---

## 7. Claude Tag and `#review-room`

Claude Tag is the `@Claude` app in Slack on the Claude Team or Enterprise plan. Its use in channels is billed to the
Claude organisation; no personal credential is stored.

1. A Claude organisation Owner opens claude.ai/admin-settings/claude-tag and starts setup.
2. In Slack, send `@Claude connect` and enter the pairing code on the setup page. Scope it to `#review-room` and set a
   monthly spend limit.
3. A Slack admin approves the Claude app if asked, creates `#review-room` (public is simplest; for a private channel
   run `/invite @coderabbit`) and adds Claude.

Details and the review flow are in [`ReviewRoom.md`](ReviewRoom.md).

**Verify:** `@Claude say hello` in `#review-room` gets a reply.

---

## 8. Self-hosted runner

Salesforce and Claude checks need logins, so they run on a machine you control. That machine is the only place CI logs
in, and it logs in the same way a person does.

| Label set | Runs | Logins on the runner's service account |
|---|---|---|
| `self-hosted, circuit` | QA deploy, Apex tests, SF AI Tester, AI Reviewer, Code Analyzer, design gate | `sf` (alias `qa`), `claude` (a Claude Team seat), `acli` |
| `self-hosted, circuit-release` | `deploy-prod` (no AI) | `sf` (the production alias only) |

Register **two runners, on separate machines or separate service users**, one label set each. Never give one runner
both labels: the `circuit` runner runs code from PR branches (8.6), so it must never be where the production login is.
The extension's setup check refuses a runner that carries both labels.

### 8.1 Register the runner

1. **Repo → Settings → Actions → Runners → New self-hosted runner.** Pick the OS. GitHub shows download and configure
   commands with a one-time registration token that expires after one hour. Use it straight away; it is not stored.
2. Run the configure command and add the labels:
   ```bash
   ./config.sh --url https://github.com/<ORG>/<REPO> --token <one-time token from that page> --labels circuit
   # for the release runner: --labels circuit-release
   ```
   On Windows use `config.cmd` in an admin shell from `C:\actions-runner`. Labels can't be added to an
   already-registered runner by `config`; use **Settings → Actions → Runners → (runner) → Labels** instead.

### 8.2 Run it as a service, under a real user

The logins live in that user's home folder, so the service must run as the user who logs in (8.3).

| OS | Command |
|---|---|
| Linux | `sudo ./svc.sh install <user>`, then `sudo ./svc.sh start` |
| macOS | `./svc.sh install`, then `./svc.sh start` |
| Windows | answer **Y** to "run as service" when `config.cmd` asks, and give the user account (not NETWORK SERVICE). Manage it with `Get-Service "actions.runner.*"` |

### 8.3 Log in on the runner, as the service user

```bash
gh auth login     # as a dedicated service user with read access to <REPO> only (8.6); persona-gates reads teams
claude            # then /login with the runner's Claude Team seat; make sure ANTHROPIC_API_KEY is not set
sf org login web --alias qa --instance-url https://acme-demo.my.salesforce.com
acli jira auth login --web
# release runner only, done by an architect:
sf org login web --alias prod --instance-url <production My Domain URL>
```

If the machine has no browser, use the device or URL flow each CLI offers, signing in from your own browser.

### 8.4 Verify

- `gh api repos/<ORG>/<REPO>/actions/runners --jq '.runners[] | {name, status, labels: [.labels[].name]}'` shows the
  runner `online` with `circuit` (or `circuit-release`).
- The extension's Connections → Project → **Self-hosted runner** row is green.
- Run the `pr-checks` workflow on a test PR: the self-hosted jobs pick up on the runner.

### 8.5 Fork-PR safety

GitHub warns that self-hosted runners should almost never be used with public repositories: anyone who can fork and
open a PR could run code on the runner and use its logins.

1. Keep `<REPO>` **private**. In a private repo, leave **Settings → Actions → General → Fork pull request workflows**
   off (no running, no write tokens, no secrets for forks).
2. If the repo must be public, set *Require approval for all external contributors* (the other options can be bypassed
   after one merged PR), and approve runs only after reading the change.
3. The circuit's self-hosted jobs also carry a guard so they never run for a fork:
   `if: github.event.pull_request.head.repo.full_name == github.repository`.
4. Runner groups that limit a runner to chosen repos exist only at org level. If you register at org level, restrict
   the group to `<REPO>`.

### 8.6 Every repo writer can run code on the `circuit` runner

For a `pull_request` event GitHub takes the workflow file from the PR branch, so anyone who can push a branch to
`<REPO>` (people, and the Developer's Claude) can run code on the `circuit` runner with its logins. The circuit limits
what that reaches:

1. The `circuit` runner holds only the DEV/QA `sf` logins, the `claude` seat and `acli`. The production login lives on
   the separate `circuit-release` runner, which only `deploy-prod` (push to `main` after G8, environment approval G9)
   uses.
2. Gate and guard scripts (`scripts/ci/*`, `protected-paths.txt`, `jira-config.json`) run from the PR's **base commit**
   (`.circuit-trusted/` in `pr-checks`, `ref: base.sha` in `design-gate`, `persona-gates` and `fix-router`); the PR head
   is checked out only as data. A branch that edits them cannot weaken its own checks, and the AI guard denies every
   persona writes to `scripts/`, `.github/` and `.claude/`.
3. Sign the runner's `gh` in as a **dedicated service user** that is an org member with *read* access to `<REPO>` only
   (no write, not admin). `gh auth login` always asks for the `repo` scope; on a read-only account it grants nothing
   more than reading, and `read:org` lets `team-member.sh` read team membership. Jobs write labels, comments and
   statuses with their own short-lived `GITHUB_TOKEN`.
4. A PR that changes `force-app/` must come from a story branch (`feature/<KEY>-<slug>`): `guard` and `design-gate`
   fail it otherwise, so a branch name cannot skip G1/C5 or the protected-path check.

---

## 9. Wispr Flow and transcript files

Nothing to connect. The Architect adds sources on the extension's **Sources** page:

- **Paste or dictate** (for example with Wispr Flow) into the text box.
- **Attach a local file**: txt, md, docx, vtt, srt or pdf.
- **Wispr Flow import**: paste, a file export, or reading Wispr Flow's local history read-only, after you consent.
- **Fireflies**: pick a meeting (through the Fireflies MCP, section 3).

Content is stored encrypted in the extension's local storage. The repo keeps only `.circuit/sources.json` (ids,
titles, dates, which epic used it).

---

## Final checklist

| Connection | Where it lives | Verify |
|---|---|---|
| GitHub (VS Code + `gh`) | each laptop | `gh auth status`; sidebar shows your persona |
| Claude (`claude` CLI, Team seat) | each laptop, runner | `claude auth status`; no `ANTHROPIC_API_KEY` |
| Salesforce DEV / QA (`sf`) | each laptop, `circuit` runner | `sf org display --target-org dev` / `qa` |
| Salesforce production (`sf`) | `circuit-release` runner only | `sf org display --target-org prod` on that runner |
| Jira (`acli`) | each laptop, `circuit` runner | `acli jira auth status` |
| Atlassian MCP | each person's Claude | `/mcp` |
| Fireflies MCP | Architect's Claude | `/mcp` |
| Slack MCP | Developer's Claude | `/mcp` |
| Lucid MCP | Architect's Claude | `/mcp` |
| GitHub for Atlassian | Jira + GitHub org | branch appears in the Development panel |
| CodeRabbit (GitHub App + Slack agent) | GitHub org, Slack | review on a test PR; `@coderabbit` replies |
| Claude Tag | Claude org, Slack | `@Claude` replies in `#review-room` |
| Self-hosted runners | runner machine(s) | `online` with labels `circuit` / `circuit-release` |
| GitHub secrets | none | `gh secret list --repo <ORG>/<REPO>` shows no `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `SF_JWT_*` or `JIRA_API_TOKEN` |

**If a login is lost or a laptop is stolen:** sign the person out at the source (GitHub sessions, claude.ai sessions,
Salesforce user, Atlassian account) and log in again on a trusted machine. There are no shared secrets to rotate.
