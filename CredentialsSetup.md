# Credentials and Connections: Step-by-Step Setup

> **Naming note:** the runbook (`AgenticImplementation.md`) and the `sf-delivery-circuit` plugin use the orgs **DEV**, **QA** and **PROD**, with secrets `SF_*_DEV`, `SF_*_QA` and `SF_*_PROD`. In those, the DEV user plays the AIBUILD role described here (check-only deploys). UAT is optional. The plugin's `circuit-bootstrap` skill is the authoritative order of steps. This file gives the detailed screens for each credential.

This is the companion to `AgenticImplementation.md`. The names there (`conscendo-delivery-bot`, `SF_*_AIBUILD`, `@conscendo/tech-leads` and so on) are examples. This guide shows how to create each real credential, where to store it, and how to test it before any workflow uses it.

Work through the steps in order. Each one ends with a **Verify** step. Don't start a step until the previous one passes.

Placeholders used below:

| Placeholder | Meaning |
|---|---|
| `<ORG>` / `<REPO>` | GitHub organisation and repository |
| `<JIRA_SITE>` | `yourcompany.atlassian.net` |
| `<AIBUILD_USER>`, `<QA_USER>`, `<UAT_USER>`, `<PROD_USER>` | Salesforce integration usernames (sandbox usernames carry the sandbox suffix, e.g. `ci.integration@client.com.aibuild`) |

> Never paste a secret into chat, a Jira comment, a Confluence page or a commit. Use `gh secret set` reading from a file or stdin, then delete the local copy, or move it into your password vault.

---

## Step 0. Before you start

1. You need admin access to: the GitHub org, the Jira site, each Salesforce org (AIBUILD sandbox, QA sandbox, UAT sandbox, PROD), the Slack workspace, and the Claude Team/Enterprise admin (for the CI seat).
2. Install the tools on the laptop you'll use for setup: `gh` (logged in with `gh auth login`), `sf`, `openssl`, `jq`.
3. Create a **shared vault entry** for each credential below (for example in 1Password or Bitwarden). Record the owner, the creation date and the expiry date. Expiry dates matter for the PAT (Step 3) and the certificates (Step 5).

---

## Step 1. GitHub repository settings

1. **Settings → Actions → General → Workflow permissions:** select *Read repository contents and packages permissions*. Leave *Allow GitHub Actions to create and approve pull requests* **unticked**. PRs are opened by the App token, not `GITHUB_TOKEN`.
2. **Settings → Environments → New environment → `production`:**
   - Required reviewers: the DevOps team (at least 1 person who isn't the tech lead approving the PR, if you want two-person control).
   - Deployment branches: *Selected branches* → `main` only.
3. **New environment → `uat`:** no reviewers. Deployment branches: `main` only. It holds the UAT org secrets.
4. Create the teams used in CODEOWNERS (**Org → Teams**): `tech-leads`, `qa`, `architects`, `devops`. Give each team **Write** access to the repo. CODEOWNERS ignores teams without write access. The `qa` team slug goes into the `QA_TEAM_SLUG` variable.

**Verify:** `gh api repos/<ORG>/<REPO>/environments/production --jq '.protection_rules'` shows a `required_reviewers` rule.

---

## Step 2. GitHub App (the delivery bot)

Gives you `APP_ID` and `APP_PRIVATE_KEY`.

1. **Org → Settings → Developer settings → GitHub Apps → New GitHub App.**
   - Name: your choice (e.g. `<company>-delivery-bot`).
   - Homepage URL: your repo URL.
   - Webhook: **untick Active** (the App receives no events).
2. **Repository permissions** (set nothing else):

   | Permission | Access | Why |
   |---|---|---|
   | Contents | Read & write | push feature branches, send `repository_dispatch` |
   | Pull requests | Read & write | open PRs, add labels, comment |
   | Issues | Read & write | labels live on the issues API |
   | Actions | Read | `gh run view --log-failed` and artifact download in the fix loop |
   | Commit statuses | Read & write | sets the `qa-signoff` status |
   | Metadata | Read | mandatory |
   | **Workflows** | **No access** | so the bot can never change `.github/workflows` |

   **Organization permissions:** Members: Read (so `/qa-approve` can check QA team membership). Nothing else.

3. *Where can this app be installed:* **Only on this account**. Create the App.
4. On the App page note the **App ID** (a number).
5. **Private keys → Generate a private key.** A `.pem` file downloads.
6. **Install App → your org → Only select repositories → `<REPO>`.**
7. Store the values:
   ```bash
   gh secret set APP_ID --repo <ORG>/<REPO> --body "<APP_ID>"
   gh secret set APP_PRIVATE_KEY --repo <ORG>/<REPO> < ~/Downloads/<app-name>.*.private-key.pem
   ```
   Move the `.pem` into the vault, then delete it from Downloads.
8. Don't add the App to any branch protection or ruleset bypass list (Step 10).

**Verify:** run this throwaway workflow once from the Actions tab (`workflow_dispatch`), then delete it:
```yaml
name: verify-app-token
on: workflow_dispatch
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - id: app
        uses: actions/create-github-app-token@v2   # confirm current major and input names in its README
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
      - env: { GH_TOKEN: "${{ steps.app.outputs.token }}" }
        run: gh api repos/${{ github.repository }} --jq .full_name
```
It should print `<ORG>/<REPO>`.

---

## Step 3. Token that Jira uses to call GitHub

Jira Automation can only send a static header, and GitHub App installation tokens expire after 1 hour. So Jira needs a **fine-grained personal access token**. Create it on a **dedicated machine user** (e.g. `<company>-jira-bridge`), not on a person's account, so it survives staff changes.

1. If the org requires approval for fine-grained PATs: **Org → Settings → Personal access tokens → Settings** → allow fine-grained tokens. Approve the request after step 3.
2. Add the machine user to the org with access to `<REPO>` only.
3. Signed in as the machine user: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.**
   - Resource owner: `<ORG>`
   - Expiration: 90 days. Put the renewal date in the vault entry and in a calendar reminder.
   - Repository access: **Only select repositories → `<REPO>`**
   - Permissions: **Contents: Read and write** (needed for `repository_dispatch`). Metadata: Read is added automatically. Nothing else.
4. Copy the token into the vault straight away. GitHub shows it only once.

**Verify** (expect HTTP `204`):
```bash
read -rs JIRA_PAT   # paste the token, press Enter
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H "Authorization: Bearer $JIRA_PAT" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/<ORG>/<REPO>/dispatches \
  -d '{"event_type":"ping-test","client_payload":{"key":"TEST-1"}}'
unset JIRA_PAT
```

---

## Step 4. Claude subscription token for CI (no API key)

The circuit runs on Claude subscription accounts. Nobody creates a Console API key.

1. Pick a **dedicated Team/Enterprise seat** for CI (e.g. `delivery-bot@acme…`), not a person's own account. CI usage counts against that seat's limits.
2. On a laptop, signed in to Claude Code as that seat, run `claude setup-token`. Approve in the browser. It prints a token valid for 1 year.
3. In **your own terminal** (not in a chat), store it:
   ```bash
   gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <ORG>/<REPO>   # paste when prompted
   ```
4. Put the expiry date in the vault entry and in `build-state.md` → Reminders.
5. Never set `ANTHROPIC_API_KEY` in the repo or the workflows: in `-p` mode it takes precedence over the OAuth token. Don't use `--bare` in CI either, because bare mode doesn't read `CLAUDE_CODE_OAUTH_TOKEN`.
6. Check the seat's data-retention settings against the client contract.

**Verify:** a throwaway `workflow_dispatch` workflow runs `claude -p "Reply with the single word ok" --max-turns 1` with `env: CLAUDE_CODE_OAUTH_TOKEN` and prints `ok` (see `circuit-bootstrap/reference/connect.md`). Also check that `gh secret list` shows **no** `ANTHROPIC_API_KEY`.

---

## Step 4b. Jira read-only API token (CI fetches stories)

The build workflow reads the story itself, so Jira only sends the issue key.

1. Create an Atlassian **service account** (or a dedicated user) with **Browse projects** permission on the delivery project only, plus **Add comments** if you want CI to comment on stories.
2. Signed in as that account: **id.atlassian.com → Security → API tokens → Create API token**. Set an expiry date and record it in the vault.
3. Find the Acceptance Criteria field id: open `https://<JIRA_SITE>/rest/api/2/field` and search for its name (e.g. `customfield_10050`).
4. Store:
   ```bash
   gh secret set JIRA_EMAIL --repo <ORG>/<REPO> --body "<service account email>"
   gh secret set JIRA_API_TOKEN --repo <ORG>/<REPO>      # paste when prompted
   gh variable set JIRA_BASE_URL --repo <ORG>/<REPO> --body "https://<JIRA_SITE>"
   gh variable set JIRA_AC_FIELD --repo <ORG>/<REPO> --body "customfield_XXXXX"
   ```

**Verify:** `curl -sf -u "<email>:<token>" "https://<JIRA_SITE>/rest/api/2/issue/<KEY>?fields=summary" | jq .fields.summary` prints the summary.

## Step 4c. SF AI Tester in CI

SF AI Tester is [pavansaikodanda/sf-ai-tester](https://github.com/pavansaikodanda/sf-ai-tester). It is not on npm, so
CI builds its CLI from source at a pinned commit (`scripts/ci/install-sf-ai-tester.sh`).

| Question | Answer (from the tool's source, `src/cli.ts`) |
|---|---|
| Install | `git clone` → `npm ci` → `npm run build` → browsers (`playwright install chromium`, `@playwright/mcp install-browser chrome-for-testing`). On Windows laptops, the VSIX in its `releases/` folder |
| Run | `node <tool>/dist/cli.js run <suite.yaml> --mode manual|automation|both --login headless --workers 1-4`, from the repo root |
| Salesforce login | `SF_ALIAS=<alias>`: it opens the org with the sf CLI session (`sf org open --url-only`), so the JWT login from Step 5 is enough. No password |
| Claude login | The Claude Code subscription login. It removes `ANTHROPIC_API_KEY` and keeps `CLAUDE_CODE_OAUTH_TOKEN` (Step 4) |
| Exit code | 0 only if every case passed, else 1 (CI ignores it and uses `scripts/ci/ai-tester-verdict.mjs`) |
| Output | `.sf-ai-tester/runs/<time>/results.json` (`{ suite, org, results: [{ id, mode, status, summary, defects }] }`), `report.html`, `analysis.json`, `evidence/` |

1. Set the repo variables:
   ```bash
   gh variable set SF_AI_TESTER_REF  --repo <ORG>/<REPO> --body "<commit SHA of sf-ai-tester to use>"
   gh variable set SF_AI_TESTER_MODE --repo <ORG>/<REPO> --body manual      # manual | automation | both
   ```
   The repo is public, so CI needs no token to fetch it. To use a fork, also set `SF_AI_TESTER_REPO=<owner>/<name>`.
2. Turn it on with `gh variable set SF_AI_TESTER_IN_CI --repo <ORG>/<REPO> --body true` after one PR run of the
   `qa` job passes with it. Until then, the Tester runs it on the laptop in `qa-explore` (G6).
3. The installer copies the `sf-ai-tester-suites` skill to `.claude/skills/sf-ai-tester-suites/`, so laptops and CI
   use the same suite rules and validator.

**Verify:** on a laptop logged in to the QA org, `SF_ALIAS=qa node <tool>/dist/cli.js run test-cases/<a suite>.sf-tests.yaml --mode manual --login headless`
writes `.sf-ai-tester/runs/<timestamp>/results.json`, and `node scripts/ci/ai-tester-verdict.mjs` prints a route.

---

## Step 5. Salesforce JWT access (repeat for AIBUILD, QA, UAT and PROD)

Gives you `SF_CLIENT_ID_<ENV>`, `SF_USERNAME_<ENV>` and `SF_JWT_KEY_<ENV>`. Use a **separate key pair, app and user for each org**. If one leaks, the others stay safe.

| Org | Purpose | Secrets stored as |
|---|---|---|
| AIBUILD | A dedicated Developer sandbox used only by the Developer persona. No real client data | repo secrets |
| QA | PR deploys, Apex tests, SF AI Tester acceptance runs | repo secrets |
| UAT | Post-merge deploy and full AI regression | `uat` environment secrets |
| PROD | `deploy-prod.yml` only | `production` environment secrets |

### 5.1 Create the key pair (laptop)
```bash
ENV=dev    # then qa, then prod
openssl req -x509 -sha256 -nodes -days 365 -newkey rsa:2048 \
  -keyout ci-$ENV.key -out ci-$ENV.crt -subj "/CN=ci-$ENV"
```
`ci-$ENV.key` is the secret. `ci-$ENV.crt` gets uploaded to Salesforce. Record the expiry date (365 days).

### 5.2 Create the integration user (in each org)
1. **Setup → Users → New User.** Use a dedicated user (e.g. `ci.integration@...`) with an email address the team monitors.
2. Give it **only** the permissions for its role, through a permission set:

   | Org | Needs | Must not have |
   |---|---|---|
   | AIBUILD | API Enabled, read access to metadata and data, deploy rights so it can run **check-only** validations (`sf project deploy validate`) and Apex tests | User management, Login as other users. It runs in a sandbox nobody else uses |
   | QA | API Enabled, permissions to deploy metadata and run tests (Modify Metadata through Metadata API Functions, plus whatever your deployments require), and the profile/permissions the SF AI Tester suites assume for the UI user | Login as other users, user management |
   | UAT | Same as QA | Same as QA |
   | PROD | Deploy rights only | Used by nothing except `deploy-prod.yml` |

   Permission names vary between editions and releases. Test the AIBUILD user with `sf project deploy validate --source-dir force-app --target-org <alias> --test-level RunLocalTests`. The command should succeed and leave the org unchanged.

   SF AI Tester runs the UI as the logged-in integration user. If your suites state a profile in `context` (e.g. "Sales User"), either give the QA/UAT integration user that profile's permissions, or confirm with the SF AI Tester owner how to run as a different test user.

### 5.3 Create the OAuth app (in each org)
In recent releases, Salesforce restricts creating new Connected Apps and recommends **External Client Apps**. Use an External Client App unless your org still allows Connected Apps. The settings are the same.

1. **Setup → External Client App Manager → New External Client App.**
   - Name: `CI JWT <ENV>`. Distribution state: **Local**.
   - **Enable OAuth.** Callback URL: `http://localhost:1717/OauthRedirect`
   - OAuth scopes: *Manage user data via APIs (api)* and *Perform requests at any time (refresh_token, offline_access)*.
   - Flow enablement: **Enable JWT Bearer Flow**, and upload `ci-$ENV.crt`.
2. Save. Then open the app's **Policies** tab:
   - Permitted users: **Admin approved users are pre-authorized.**
   - Add the integration user's permission set (or profile) as the only one allowed.
   - IP relaxation: leave the default unless logins fail. GitHub-hosted runners have no fixed IPs.
3. **Settings → OAuth settings → Consumer Key and Secret.** Copy the **Consumer Key**. This is `SF_CLIENT_ID_<ENV>`. The consumer secret isn't used.
4. Wait a few minutes. New OAuth apps take a while to become active.

> Sandbox note: an app created in PROD is copied into sandboxes on refresh. A refresh also replaces apps you created in the sandbox. Re-run 5.3 and the secrets step after every sandbox refresh.

### 5.4 Test the login (laptop)
```bash
sf org login jwt --client-id "<CONSUMER_KEY>" --jwt-key-file ci-$ENV.key \
  --username "<ENV_USER>" --instance-url https://test.salesforce.com --alias ci-$ENV-check
# For PROD use --instance-url https://login.salesforce.com
sf org display --target-org ci-$ENV-check --json | jq '.result | {username, instanceUrl}'
sf org logout --target-org ci-$ENV-check --no-prompt
```
If your org blocks login through `test.salesforce.com` / `login.salesforce.com`, use its My Domain URL instead. In that case store a separate `SF_INSTANCE_URL_<ENV>` variable for each org rather than the shared one.

### 5.5 Store the secrets
```bash
# AIBUILD and QA: repository secrets
gh secret set SF_CLIENT_ID_AIBUILD --repo <ORG>/<REPO> --body "<CONSUMER_KEY>"
gh secret set SF_USERNAME_AIBUILD  --repo <ORG>/<REPO> --body "<AIBUILD_USER>"
gh secret set SF_JWT_KEY_AIBUILD   --repo <ORG>/<REPO> < ci-aibuild.key
# ...same three for QA...

# UAT: environment secrets
gh secret set SF_CLIENT_ID_UAT --repo <ORG>/<REPO> --env uat --body "<CONSUMER_KEY>"
gh secret set SF_USERNAME_UAT  --repo <ORG>/<REPO> --env uat --body "<UAT_USER>"
gh secret set SF_JWT_KEY_UAT   --repo <ORG>/<REPO> --env uat < ci-uat.key

# PROD: environment secrets ONLY, never repository secrets
gh secret set SF_CLIENT_ID_PROD --repo <ORG>/<REPO> --env production --body "<CONSUMER_KEY>"
gh secret set SF_USERNAME_PROD  --repo <ORG>/<REPO> --env production --body "<PROD_USER>"
gh secret set SF_JWT_KEY_PROD   --repo <ORG>/<REPO> --env production < ci-prod.key
```
Move each `.key` into the vault, then delete the local files (`rm ci-*.key ci-*.crt`).

**Verify:** `gh secret list --repo <ORG>/<REPO>` shows **no** `SF_*_PROD` entries, and `gh secret list --repo <ORG>/<REPO> --env production` shows all three.

---

## Step 6. Repository variables

```bash
gh variable set SF_INSTANCE_URL_SANDBOX --repo <ORG>/<REPO> --body "https://test.salesforce.com"
gh variable set SF_INSTANCE_URL_PROD    --repo <ORG>/<REPO> --body "https://login.salesforce.com"
gh variable set MAX_AI_ATTEMPTS         --repo <ORG>/<REPO> --body "3"
gh variable set QA_TEAM_SLUG            --repo <ORG>/<REPO> --body "qa"
```

Create the PR labels once:
```bash
for l in ai-generated ai-attempt-1 ai-attempt-2 ai-attempt-3 needs-human needs-qa; do
  gh label create "$l" --repo <ORG>/<REPO> --force
done
```

**Verify:** `gh variable list --repo <ORG>/<REPO>`.

---

## Step 7. Slack incoming webhook

1. Go to **api.slack.com/apps → Create New App → From scratch**, name it `Delivery Pipeline`, and pick your workspace.
2. **Incoming Webhooks → On → Add New Webhook to Workspace** → choose `#release-review` → Allow.
3. Copy the webhook URL and store it:
   ```bash
   gh secret set SLACK_WEBHOOK_URL --repo <ORG>/<REPO>   # paste when prompted
   ```
4. Repeat for `#qa-alerts` and store it as `SLACK_QA_WEBHOOK_URL`. The fix loop posts `blocked` test alerts there for QA.

**Verify:**
```bash
read -rs HOOK; curl -s -X POST -H 'Content-Type: application/json' -d '{"text":"pipeline webhook test"}' "$HOOK"; unset HOOK
```
Slack should reply `ok`, and the message should appear in the channel.

---

## Step 8. Jira side

### 8.1 GitHub for Jira
1. **Jira → Apps → Explore more apps →** install **GitHub for Jira** (by Atlassian).
2. Open the app → **Connect GitHub organization** → `<ORG>` → select **only** `<REPO>`.
3. A GitHub org owner approves the installation request on the GitHub side.

**Verify:** create a branch `test/<ISSUE-KEY>-link` in the repo. Within a few minutes it appears in the issue's Development panel.

### 8.2 Put the PAT in Rule A
1. **Project settings → Automation → Rule A → Send web request** action.
2. Header `Authorization`, value `Bearer <PAT from Step 3>`. If your Jira plan supports hidden or secret header values in automation, use that option so the token isn't shown in the rule.
3. Restrict who can edit automation rules in this project. Anyone who can edit the rule can read the token.
4. Use **Validate** in the web request action to send a test. The response should be `204`.
5. Rule A's body sends only the key: `{"event_type":"jira-ready","client_payload":{"key":"{{issue.key}}","attempt":1}}`.

### 8.3 Incoming webhook for Rule C (move to QA)
1. Create Rule C with trigger **Incoming webhook**. Choose the option where issues are given in the webhook body.
2. Copy the webhook URL (and its secret, if your Jira shows one as a header) and store it:
   ```bash
   gh secret set JIRA_QA_WEBHOOK_URL --repo <ORG>/<REPO>   # paste when prompted
   ```
3. Action: transition the issue to `QA`.

**Verify:** `curl -X POST -H 'Content-Type: application/json' -d '{"issues":["<TEST-KEY>"]}' "<webhook URL>"` moves the test story to QA.

---

## Step 9. Tools that sign in with per-user OAuth (no shared secrets)

These run on each developer's laptop in Loop 1. Nothing goes into GitHub secrets.

| Tool | How each person connects | Notes |
|---|---|---|
| Salesforce DX MCP | `sf org login web --alias dev-sandbox --instance-url https://test.salesforce.com`, then set that alias as the default org in `.mcp.json` | **Sandbox only.** Never sign in to PROD on the laptop with this alias. |
| Atlassian (Rovo) MCP | Run `/mcp` in Claude Code, pick `atlassian`, and sign in through the browser | The access matches the person's Jira and Confluence permissions |
| GitHub MCP (remote) | `/mcp` → `github` → OAuth | Check GitHub's current requirements for the remote server (plan, org policy) |
| Fireflies MCP | `/mcp` → `fireflies` → OAuth or API key, depending on the current Fireflies docs | If it uses a personal API key, keep it in the user's environment. Never put it in `.mcp.json` |
| Lucid MCP | `/mcp` → `lucid` → OAuth | Auto-updating embeds in Confluence need the Lucid for Confluence app and a Team or Enterprise plan |

Keep `.mcp.json` free of tokens. It holds only commands and URLs, and it's committed.

---

## Step 10. Branch protection (do this after Steps 1–2)

Apply section 6.1 of the main guide. Then confirm:
```bash
gh api repos/<ORG>/<REPO>/branches/main/protection --jq '{
  reviews: .required_pull_request_reviews.required_approving_review_count,
  codeowners: .required_pull_request_reviews.require_code_owner_reviews,
  checks: .required_status_checks.contexts,
  admins: .enforce_admins.enabled }'
```
Also check **Settings → Rules → Rulesets**: no ruleset may list the delivery bot App in its bypass list.

---

## Step 11. Final credential checklist

| Credential | Stored in | Owner | Expires / rotate |
|---|---|---|---|
| `APP_ID`, `APP_PRIVATE_KEY` | Repo secrets | DevOps | Rotate key yearly (generate new key, update secret, delete old key on App page) |
| Jira PAT | Jira Rule A header + vault | DevOps (machine user) | 90 days |
| `CLAUDE_CODE_OAUTH_TOKEN` | Repo secret | Tech lead (dedicated CI seat) | 1 year (`claude setup-token`), or right away if leaked |
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | Repo secrets | Jira admin | Atlassian token expiry (max 1 year) |
| `JIRA_QA_WEBHOOK_URL` | Repo secret | Jira admin | When Rule C is recreated |
| `SF_*_AIBUILD`, `SF_*_QA` | Repo secrets | Salesforce admin | Certificate 365 days. Re-check after each sandbox refresh |
| `SF_*_UAT` | `uat` environment secrets | Salesforce admin | Certificate 365 days. Re-check after each sandbox refresh |
| `SF_*_PROD` | `production` environment secrets | Salesforce admin | Certificate 365 days |
| `SLACK_WEBHOOK_URL`, `SLACK_QA_WEBHOOK_URL` | Repo secrets | Tech lead | When the channel or app changes |
| MCP sign-ins | Each laptop | Each person | Per vendor session policy |

**If a credential leaks:** revoke it at the source first (GitHub App key, PAT, Claude OAuth token (sign the CI seat out, then run `claude setup-token` again), Salesforce app certificate or user deactivation, Slack webhook), then create a new one and update the secret. Updating the secret alone doesn't stop a leaked value from working.
