# Connections Setup (v4)

This guide connects every app the Delivery Circuit v4 uses. The design contract is
[`docs/CIRCUIT-V4.md`](docs/CIRCUIT-V4.md).

**One stored credential.** Each sandbox has a GitHub Environment holding one secret, `SFDX_AUTH_URL`. The admin sets
it by hand. Everything else is a person's own login: `gh`, `claude`, `sf`, and the MCP sign-ins. No API keys, no
`ANTHROPIC_API_KEY`, no Jira or Slack tokens, no self-hosted runner.

Placeholders (use your own values; never commit real ones):

| Placeholder | Example | Meaning |
|---|---|---|
| `<ORG>` / `<REPO>` | `acme-org` / `acme-delivery` | GitHub organisation and circuit repo |
| `<SITE>` | `acme.atlassian.net` | Jira and Confluence site |
| `<PROJECT>` | `ACME` | Jira project key |
| `<SPACE>` | `ACMEDESIGN` | Confluence space for design pages |
| `<alias>` | `acme-qa`, `acme-sit` | `sf` alias of a sandbox on the admin's laptop |

| Section | Who | How often |
|---|---|---|
| 1. GitHub org, repo, teams | GitHub org owner | once |
| 2. Laptop logins | everyone | once per laptop |
| 3. MCP sign-ins | everyone who needs them | once, then when a sign-in expires |
| 4. Jira and Confluence | Atlassian site admin | once |
| 5. GitHub for Atlassian | Jira admin + GitHub org owner | once |
| 6. CodeRabbit | GitHub org owner + Slack admin | once |
| 7. Environments and `SFDX_AUTH_URL` | repo admin | once per sandbox, and when a login expires |

---

## 1. GitHub organisation, repo and teams

1. Create `<ORG>/<REPO>` and make it **private**.
2. **Org → Teams:** create `architects`, `developers`, `testers` and `leads`. Add people. Give each team **Write** on
   the repo. `leads` approve promotion PRs and production.
3. **Repo → Settings → Actions → General:** workflow permissions *Read repository contents*; leave *Allow GitHub
   Actions to create and approve pull requests* unticked; fork pull request workflows off.
4. Branches, rulesets and environments are created by `/circuit-bootstrap` (section 7 covers the secrets).

**Verify:** `gh api orgs/<ORG>/teams --jq '.[].slug'` lists the four teams.

---

## 2. Laptop logins (everyone)

| Tool | Do | Verify |
|---|---|---|
| `gh` | `gh auth login` (GitHub.com, HTTPS, browser) | `gh auth status` |
| `claude` | Install Claude Code, run `claude`, then `/login` with your claude.ai account on the **Claude Team** seat. Make sure `ANTHROPIC_API_KEY` is **not** set (it would bill the API instead of your seat) | `claude auth status`; `echo $ANTHROPIC_API_KEY` is empty (PowerShell: `$env:ANTHROPIC_API_KEY`) |
| `sf` | `sf org login web --alias dev --instance-url https://acme-dev.my.salesforce.com` against **your own DEV org**. AI reads and validates here; it never deploys elsewhere | `sf org display --target-org dev` |
| `acli` | Only because the unchanged VS Code extension still reads Jira with it. Install from the Atlassian docs, then `acli jira auth login --web` and pick `<SITE>` | `acli jira auth status` |
| VS Code | Install the extension; Circuit sidebar → **Sign in to GitHub** | Sidebar shows your login and persona |

Nobody logs in to production on a laptop, and nobody gives Claude a sandbox auth URL.

---

## 3. MCP sign-ins

Sign in once from an interactive session: run `claude`, then `/mcp`, pick the server, finish the browser sign-in.
Connectors added at claude.ai (Settings → Connectors) also show up in Claude Code.

| Server | Who | Add it |
|---|---|---|
| **Atlassian** (Jira + Confluence) | everyone | `claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp`, then `/mcp`. Uses your own Jira and Confluence permissions |
| **Lucid** | Architect | The Lucid connector at claude.ai, then `/mcp` |
| **Fireflies** (optional) | Architect | The Fireflies connector at claude.ai, then `/mcp`. Only if transcripts come from Fireflies |
| **Slack** (optional) | Developer | The Slack connector at claude.ai. Lets `/review-room` post summaries; without it, the summary is printed to paste |

**Verify:** `/mcp` lists each server as connected.

---

## 4. Jira and Confluence (site admin)

### Jira

1. Project `<PROJECT>` with issue types **Epic**, **Story** and a **test case** type (Xray/Zephyr Test, or a
   "Test Case" type with a "tests / is tested by" link).
2. A status **Ready for Dev** in the Story workflow, between refinement and In Progress. Only people move stories
   into it.

**Verify:** in Claude, ask the Atlassian MCP to read `<PROJECT>` issue types and the Story workflow statuses.

### Confluence

1. Space `<SPACE>` for design pages (one page per feature).
2. **Space settings → page status:** add **Approved** as a status. The defaults are Rough draft, In progress and
   Ready for review. AI sets "Ready for review" at most; a person sets Approved.
3. To stop edits after approval, restrict the page's edit permission to `architects`.

**Verify:** set a test page to Approved in the browser, then ask the Atlassian MCP to read it and report the status.

---

## 5. GitHub for Atlassian

Links branches, commits and PRs to Jira stories.

1. In Jira: **Apps → Explore more apps → "GitHub for Atlassian" → Get app**.
2. **Connect GitHub organization** → `<ORG>` → select `<REPO>` (a GitHub org owner approves).
3. Convention: branch `feature/<KEY>-<slug>`, PR title starts with `<KEY>` (for example `ACME-12`).

**Verify:** push `feature/ACME-1-connection-check`; it shows in the Development panel of `ACME-1`. Delete the branch.

---

## 6. CodeRabbit

1. In the CodeRabbit dashboard, sign in with GitHub, choose `<ORG>`, and give the CodeRabbit GitHub App access to
   `<REPO>`. Its approval only counts toward the `sprint/*` ruleset if the app has write access; check this on the
   first PR, otherwise a Developer lead approves.
2. `.coderabbit.yaml` comes from `/circuit-bootstrap` (`auto_review.enabled: false`, `request_changes_workflow: true`),
   so CodeRabbit reviews only when the `coderabbit` job asks, after the scan passed.
3. Install the **CodeRabbit Slack agent** from the CodeRabbit dashboard in your Slack workspace. It joins public
   channels by itself. In a **private** channel, run `/invite @coderabbit`.

**Verify:** on a test PR, comment `@coderabbitai review`; CodeRabbit replies. In Slack, `@coderabbit hello` replies.
More in [`ReviewRoom.md`](ReviewRoom.md).

---

## 7. GitHub Environments and `SFDX_AUTH_URL`

One environment per sandbox. The names match `build.config.yml` → `environments`:

| Environment | Deployed from branch | Sandbox |
|---|---|---|
| `qa` | `sprint/*` | QA |
| `dev` | `dev` | DEV (shared integration sandbox, not a developer's own org) |
| `sit` | `sit` | SIT |
| `uat` | `uat` | UAT |
| `production` | `main` | production |

### 7.1 Create the environments

`/circuit-bootstrap` creates them. To do it by hand: **Repo → Settings → Environments → New environment**, one per row
above. For `production`: **Required reviewers** = team `leads`, tick **Prevent self-review**, deployment branches =
`main` only.

> VERIFY your GitHub plan. In private repos, environment secrets need GitHub Team (or higher), and GitHub documents
> required reviewers on private repos as a GitHub Enterprise feature. Without them, the `leads` approval on the PR into
> `main` is the only production gate; record that in the test results.

### 7.2 Set each secret (admin only, never with Claude)

Do this in your own terminal, not in a Claude session. The guard blocks Claude from these commands anyway.

1. Log in to the sandbox with a web login (this gives a refresh token). Use the deploy user you want CI to act as:
   ```bash
   sf org login web --alias <alias> --instance-url https://acme--qa.sandbox.my.salesforce.com
   ```
2. Show the auth URL:
   ```bash
   sf org display --verbose --json --target-org <alias>
   ```
   Copy the value of `result.sfdxAuthUrl` (it starts with `force://`).
3. Store it in the environment. Paste it **at the prompt**, never as a command-line argument:
   ```bash
   gh secret set SFDX_AUTH_URL --env <env> --repo <ORG>/<REPO>
   ```
4. Clear the clipboard and the terminal. Do not paste the value into chat, Slack, Jira, a file or a Claude session.
5. Repeat for `qa`, `dev`, `sit`, `uat` and `production`.

To rotate: log the deploy user out (or revoke its OAuth session in Salesforce Setup), log in again, set the secret
again.

**Verify:** `gh secret list --env <env> --repo <ORG>/<REPO>` shows `SFDX_AUTH_URL` for every environment (names only,
never values). `gh secret list --repo <ORG>/<REPO>` shows no repo-level `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
`SF_JWT_*` or `JIRA_API_TOKEN`.

---

## Final checklist

| Connection | Where | Verify |
|---|---|---|
| GitHub org, private repo, teams `architects` `developers` `testers` `leads` | GitHub | `gh api orgs/<ORG>/teams` |
| `gh` | each laptop | `gh auth status` |
| `claude` on a Claude Team seat, no `ANTHROPIC_API_KEY` | each laptop | `claude auth status`; variable empty |
| `sf` to your own DEV org (alias `dev`) | each laptop | `sf org display --target-org dev` |
| `acli` (extension only) | each laptop | `acli jira auth status` |
| Atlassian MCP (Jira + Confluence) | each person's Claude | `/mcp` |
| Lucid MCP | Architect's Claude | `/mcp` |
| Fireflies MCP (optional) | Architect's Claude | `/mcp` |
| Slack MCP (optional) | Developer's Claude | `/mcp` |
| Jira: Epic, Story, test case type, status Ready for Dev | Jira | issue types and workflow visible |
| Confluence space with Approved status | Confluence | status set and read back |
| GitHub for Atlassian | Jira + GitHub | branch in the Development panel |
| CodeRabbit GitHub App on the repo | GitHub | review on a test PR |
| CodeRabbit Slack agent (`/invite @coderabbit` in private channels) | Slack | `@coderabbit` replies |
| Environments `qa` `dev` `sit` `uat` `production`, each with `SFDX_AUTH_URL` | GitHub | `gh secret list --env <env>` |
| `production`: required reviewers `leads`, prevent self-review, `main` only | GitHub | Settings → Environments → production |

**If a laptop is lost:** sign the person out at the source (GitHub, claude.ai, Salesforce, Atlassian). If it was the
admin's laptop, also rotate every `SFDX_AUTH_URL` (section 7.2).
