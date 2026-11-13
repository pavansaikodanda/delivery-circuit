> **Superseded by [`docs/CIRCUIT-V4.md`](docs/CIRCUIT-V4.md).** This file describes the original flow and is kept for history.

# AI + Human Salesforce Delivery Pipeline: Implementation Guide

This guide is written for Claude Code. It implements the workflow from the deck "From client call to a deployed org":

- **Loop 1, refine:** Gather → Design → Backlog creation → groomed into the sprint.
- **Loop 2, sprint:** Build → Review → Test, repeated until the Definition of Done is met.
- **Release:** Approve → Deploy (no AI) → Retro.

**How to use this file in Claude Code**

1. Put this file in the root of the Salesforce DX repo as `docs/IMPLEMENTATION.md`.
2. Open Claude Code in the repo and say:
   > Read docs/IMPLEMENTATION.md. Implement Phase 1 only. Show me every file you create, then stop and list what I must do by hand (secrets, apps, Jira rules).
3. Repeat for each phase. Do not let it run all phases at once: each phase has a manual setup step and an acceptance test.

> Tool facts were checked against vendor docs on 12 Oct 2026. Action versions, MCP URLs and CLI flags change. Before each phase, ask Claude Code to confirm the current version and inputs from the official README of every action and MCP server used in that phase.

---

## 0. Target architecture

```
LOOP 1 (people + Claude Code, interactive, on a developer laptop)
  Fireflies MCP ─┐
  Salesforce DX MCP ─┤
  GitHub MCP ─┼─> Claude Code session ─> Lucid diagram ─> Confluence design page ─> Jira stories
  Lucid MCP ─┤        (architect approves in Confluence, analyst fills gaps, team grooms)
  Atlassian MCP ─┘
                                     │  story moves to "Ready for Dev" with label ai-ready
                                     ▼
BRIDGE   Jira Automation "Send web request" ─> GitHub API repository_dispatch (event: jira-ready)
                                     ▼
LOOP 2 (GitHub Actions)
  claude-build.yml   : Claude Code (headless) builds on a feature branch, App-token step opens the PR
  pr-checks.yml      : Code Analyzer + quality gate ─> deploy to QA sandbox ─> Apex tests ─> Playwright
  CodeRabbit (App)   : reviews every PR with codebase context
  ai-fix-loop.yml    : on failure or "changes requested", re-dispatch (event: claude-fix), max 3 tries
                       after 3 tries: label needs-human + Slack alert
                                     ▼  all green
RELEASE
  Slack evidence pack ─> tech lead approves + merges (branch protection, CODEOWNERS)
  deploy-prod.yml (push to main, NO AI): sf org login jwt ─> sf project deploy start
  Jira Automation "Pull request merged" ─> story to Done
  Retro: lessons go into CLAUDE.md and .coderabbit.yaml
```

**Hard rules for the whole system**

- AI never has production credentials. Only `deploy-prod.yml` has them, and it contains no AI step.
- AI never approves or merges. Branch protection requires a human approval from CODEOWNERS.
- Every AI build runs against a sandbox or a scratch org, never production.
- Every loop has a hard stop: 3 AI attempts, then a person takes over.

---

## 1. Prerequisites (manual, do these first)

> All names, usernames and secrets in this guide are examples. Create and test each real credential step by step with `CredentialsSetup.md` before you start Phase 1.

| Item | Owner | Notes |
|---|---|---|
| GitHub repo (SFDX project, `force-app/`) | DevOps | Protected `main` branch |
| GitHub App "conscendo-delivery-bot" | DevOps | Permissions: Contents RW, Pull requests RW, Issues RW, Actions RW, Metadata R. Install it on the repo. |
| Fine-grained PAT, or the App's credentials, for Jira | DevOps | Used by Jira to call `repository_dispatch`. Needs Contents: write on the repo only. |
| Anthropic API key (or Bedrock/Vertex) | Tech lead | For headless Claude Code in CI |
| Connected App with JWT (cert + key) per org: DEV sandbox, QA sandbox, PROD | Salesforce admin | Pre-authorise an integration user per org. PROD user is only for `deploy-prod.yml`. |
| CodeRabbit GitHub App | Tech lead | Install on the repo, plan with private-repo support |
| Slack incoming webhook for `#release-review` | Tech lead | |
| Jira Cloud + "GitHub for Jira" app | PM / Jira admin | Needed for the "Pull request merged" trigger |
| Confluence + Lucid for Confluence app | PM | Lucid embed with auto update needs a Lucid Team or Enterprise plan |
| Fireflies, with the MCP connector enabled | Analyst | Fireflies webhooks only send the meeting ID, so use MCP to read transcripts |
| Node 20+, Salesforce CLI (`sf`), Claude Code, Playwright on dev laptops | Everyone | |

### GitHub secrets and variables

| Name | Type | Used by |
|---|---|---|
| `APP_ID`, `APP_PRIVATE_KEY` | secret | all workflows that push or open PRs |
| `ANTHROPIC_API_KEY` | secret | `claude-build.yml` |
| `SF_CLIENT_ID_DEV`, `SF_USERNAME_DEV`, `SF_JWT_KEY_DEV` | secret | `claude-build.yml` (read-only org context) |
| `SF_CLIENT_ID_QA`, `SF_USERNAME_QA`, `SF_JWT_KEY_QA` | secret | `pr-checks.yml` |
| `SF_CLIENT_ID_PROD`, `SF_USERNAME_PROD`, `SF_JWT_KEY_PROD` | secret, in **environment `production` only** | `deploy-prod.yml` |
| `SF_INSTANCE_URL_SANDBOX` = `https://test.salesforce.com` | variable | |
| `SF_INSTANCE_URL_PROD` = `https://login.salesforce.com` | variable | |
| `SLACK_WEBHOOK_URL` | secret | evidence pack and alerts |
| `MAX_AI_ATTEMPTS` = `3` | variable | `ai-fix-loop.yml` |

---

## Phase 1: Repo foundation

**Goal:** the repo teaches Claude the rules before any automation runs.

### 1.1 Files to create

```
CLAUDE.md
.claude/settings.json
.claude/commands/design.md
.claude/commands/backlog.md
.claude/commands/build-story.md
.mcp.json
.coderabbit.yaml
.github/CODEOWNERS
.github/pull_request_template.md
docs/definition-of-ready.md
docs/definition-of-done.md
docs/IMPLEMENTATION.md          (this file)
```

### 1.2 `CLAUDE.md`

```markdown
# Project rules for Claude

## Context
Salesforce DX project. Source in force-app/. Client org metadata is the source of truth.

## Before writing any code
1. Read the Jira story and its acceptance criteria. If they are unclear, stop and say so.
2. Search the existing code (force-app/) and the org (Salesforce DX MCP: metadata, SOQL)
   for classes, flows, fields and objects that already do part of the job.
3. Write a short plan: files to change, files to add, why reuse is not possible for anything new.
4. Prefer extending existing classes, triggers handlers, flows and LWCs over creating new ones.
   New custom objects or fields need a design page approved by the architect (link it).

## Apex
- `with sharing` unless the design says otherwise; enforce CRUD/FLS (`WITH USER_MODE` / `Security.stripInaccessible`).
- Bulkify everything. No SOQL or DML inside loops. One trigger per object, logic in the handler class.
- No hard-coded IDs, URLs or credentials. Use Custom Metadata / Named Credentials.
- Test classes: positive, negative and bulk (200 records) cases, assertions on outcomes,
  `@TestSetup` data, no `SeeAllData=true`. Target 85%+ coverage on touched classes.

## LWC
- Use Lightning Data Service / UI API before Apex. Handle loading and error states.
- Add Jest tests for new components.

## Tests
- Playwright specs live in tests/e2e/. Each story gets at least one UI spec for its acceptance criteria.

## Never
- Never touch production, never deploy, never change .github/workflows, never edit CODEOWNERS.
- Never disable or weaken a test, a rule, or a security check to make CI pass.
- Never delete metadata without saying so in the PR description.

## Retro rules (append below, newest first)
<!-- Each retro adds rules learned from what reviewers caught. -->
```

### 1.3 `.claude/settings.json` (keep CI and laptops safe)

```json
{
  "permissions": {
    "allow": [
      "Read", "Edit", "Write", "Glob", "Grep",
      "Bash(sf project retrieve start:*)",
      "Bash(sf data query:*)",
      "Bash(sf apex run test:*)",
      "Bash(npm run lint:*)",
      "Bash(npx jest:*)",
      "Bash(npx playwright test:*)",
      "Bash(git status)", "Bash(git diff:*)", "Bash(git log:*)"
    ],
    "deny": [
      "Bash(sf project deploy:*)",
      "Bash(git push:*)",
      "Edit(.github/**)",
      "Write(.github/**)",
      "Read(**/*.key)",
      "Read(.env*)"
    ]
  }
}
```

### 1.4 Slash commands for Loop 1 and local builds

`.claude/commands/design.md`

```markdown
Create a solution design for: $ARGUMENTS

1. Read the Fireflies transcript for this meeting (Fireflies MCP). List requirements, open questions, decisions.
2. Query the org (Salesforce DX MCP) and the repo (GitHub MCP or local files) for what already exists:
   objects, fields, flows, Apex classes, LWCs related to these requirements.
3. Draft the design: reuse first, then the smallest set of new metadata. Note risks and security.
4. Create the architecture diagram with the Lucid MCP.
5. Create a Confluence page (Atlassian MCP) titled "Design: <topic>" with requirements, existing assets,
   proposed changes, diagram link, open questions. Status: "Awaiting architect approval".
6. Print the page link and the open questions. Do not create Jira stories yet.
```

`.claude/commands/backlog.md`

```markdown
Create backlog stories from the approved design page: $ARGUMENTS

1. Read the Confluence page. Stop if its status is not "Approved".
2. Split into INVEST stories. Each story: summary, description, acceptance criteria (Given/When/Then),
   affected metadata, test notes, story points estimate, link to the design page.
3. Create them in Jira (Atlassian MCP) in the backlog with label "ai-candidate". Do NOT set "ai-ready":
   the team sets it during grooming.
4. Print a table of the created keys and anything the analyst must fill in.
```

`.claude/commands/build-story.md`

```markdown
Implement Jira story $ARGUMENTS locally (same rules as CI).
Follow CLAUDE.md. Plan first and wait for my approval, then implement, add Apex + Jest + Playwright tests,
run them, and summarise the diff. Do not push.
```

### 1.5 `.mcp.json` (laptop, Loop 1)

Ask Claude Code to fill in the current command or URL for each server from its official docs. The shape:

```json
{
  "mcpServers": {
    "salesforce": {
      "command": "npx",
      "args": ["-y", "@salesforce/mcp", "--orgs", "DEFAULT_TARGET_ORG",
               "--toolsets", "orgs,metadata,data,testing,code-analysis"]
    },
    "github":    { "type": "http", "url": "https://api.githubcopilot.com/mcp/" },
    "atlassian": { "type": "http", "url": "<Atlassian Rovo remote MCP URL from Atlassian docs>" },
    "fireflies": { "type": "http", "url": "<Fireflies MCP URL from Fireflies docs>" },
    "lucid":     { "type": "http", "url": "<Lucid MCP URL from Lucid docs>" }
  }
}
```

Notes:
- The Salesforce DX MCP server is in Developer Preview. Point `DEFAULT_TARGET_ORG` at a sandbox, never prod.
- Remote servers use OAuth. The first `/mcp` in Claude Code opens the browser to sign in.

### 1.6 `.github/CODEOWNERS`

```
*                       @conscendo/tech-leads
/.github/               @conscendo/devops
/force-app/main/default/permissionsets/  @conscendo/tech-leads @conscendo/devops
```

### 1.7 `docs/definition-of-ready.md` and `docs/definition-of-done.md`

Ready: acceptance criteria in Given/When/Then, design page approved and linked, affected metadata listed, test data noted, points estimated, label `ai-ready` set by the team in grooming.

Done: Code Analyzer gate passed (0 sev 1, 0 sev 2), CodeRabbit has no open "changes requested", Apex tests pass with 85%+ coverage on touched classes, Playwright specs pass in QA sandbox, QA reviewed the results, PR description lists the changes and the evidence, tech lead approved.

**Phase 1 acceptance test:** run `/design <a recent meeting>` on a laptop. A Confluence page with a Lucid diagram appears and lists existing org assets correctly. Then `/backlog <page>` creates stories with acceptance criteria.

---

## Phase 2: Jira configuration (manual, in Jira UI)

### 2.1 Board and fields
- Statuses: Backlog → Ready for Dev → In Progress → In Review → QA → Done.
- Labels: `ai-candidate` (created by Claude), `ai-ready` (set by the team), `needs-human`.
- Branch and PR names must contain the issue key (for example `feature/REN-142-flag-renewals`) so GitHub for Jira links them.

### 2.2 Automation rule A: "Dispatch AI build"
- **Trigger:** Work item transitioned to `Ready for Dev`.
- **Condition:** labels contains `ai-ready`.
- **Action:** Send web request
  - URL: `https://api.github.com/repos/<OWNER>/<REPO>/dispatches`
  - Method: POST
  - Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`
  - Body (custom data):
    ```json
    {
      "event_type": "jira-ready",
      "client_payload": {
        "key": "{{issue.key}}",
        "summary": {{issue.summary.jsonEncode}},
        "description": {{issue.description.jsonEncode}},
        "attempt": 1
      }
    }
    ```
- Then: transition the work item to `In Progress`.

GitHub limits `client_payload` to 10 top-level keys. Claude fetches the rest (acceptance criteria, design link) with the Jira API in the build job.

### 2.3 Automation rule B: "Close on merge"
- **Trigger:** Pull request merged (DevOps trigger, needs GitHub for Jira).
- **Action:** Transition work item to `Done`, comment with the PR link.

### 2.4 Automation rule C (optional): "In review"
- **Trigger:** Pull request created → transition to `In Review`.

**Phase 2 acceptance test:** move a test story with `ai-ready` to Ready for Dev. In GitHub, Actions shows a `repository_dispatch` run (create a dummy workflow that only echoes the payload for this test).

---

## Phase 3: AI build workflow (`claude-build.yml`)

Runs Claude Code headless on a feature branch. A separate step with the GitHub App token pushes and opens the PR, so the PR events trigger the check workflows. Pushes made with the default `GITHUB_TOKEN` would not trigger them.

```yaml
name: claude-build
on:
  repository_dispatch:
    types: [jira-ready, claude-fix]

concurrency:
  group: claude-${{ github.event.client_payload.key }}
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      KEY: ${{ github.event.client_payload.key }}
      ATTEMPT: ${{ github.event.client_payload.attempt }}
    steps:
      - id: app
        uses: actions/create-github-app-token@v1   # confirm latest major
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}

      - uses: actions/checkout@v4
        with:
          token: ${{ steps.app.outputs.token }}
          fetch-depth: 0

      - name: Select branch
        run: |
          SLUG=$(echo "${{ github.event.client_payload.summary }}" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | cut -c1-40 | sed 's/-$//')
          BRANCH="feature/${KEY}-${SLUG}"
          if [ "${{ github.event.action }}" = "claude-fix" ]; then BRANCH="${{ github.event.client_payload.branch }}"; fi
          git fetch origin "$BRANCH" 2>/dev/null && git checkout "$BRANCH" || git checkout -b "$BRANCH"
          echo "BRANCH=$BRANCH" >> $GITHUB_ENV

      - uses: actions/setup-node@v4
        with: { node-version: 20 }

      - name: Install tools
        run: npm i -g @salesforce/cli @anthropic-ai/claude-code && npm ci

      - name: Salesforce login (DEV sandbox, read context only)
        run: |
          echo "${{ secrets.SF_JWT_KEY_DEV }}" > /tmp/dev.key
          sf org login jwt --client-id "${{ secrets.SF_CLIENT_ID_DEV }}" --username "${{ secrets.SF_USERNAME_DEV }}" \
            --jwt-key-file /tmp/dev.key --instance-url "${{ vars.SF_INSTANCE_URL_SANDBOX }}" --alias dev --set-default
          rm /tmp/dev.key

      - name: Build prompt
        run: |
          cat > /tmp/prompt.md <<'EOF'
          You are implementing Jira story ${{ github.event.client_payload.key }}: ${{ github.event.client_payload.summary }}
          Description:
          ${{ github.event.client_payload.description }}

          Follow CLAUDE.md exactly. Steps:
          1. Search force-app/ and the org (dev alias, sf data query / sf project retrieve) for existing assets.
          2. Write PLAN.md in the repo root: what you reuse, what you change, what you add and why.
          3. Implement the smallest change that meets the acceptance criteria.
          4. Add or update Apex tests, Jest tests and a Playwright spec in tests/e2e/${{ github.event.client_payload.key }}.spec.ts.
          5. Run Apex tests for touched classes against the dev org and run Jest locally. Fix failures.
          6. Finish with a summary of changes and evidence. Do not push, do not deploy.
          EOF
          if [ -n "${{ github.event.client_payload.feedback }}" ]; then
            printf '\n\nThis is attempt %s. Previous run failed. Fix these problems first:\n%s\n' "$ATTEMPT" \
              "${{ github.event.client_payload.feedback }}" >> /tmp/prompt.md
          fi

      - name: Run Claude Code (headless)
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          claude -p "$(cat /tmp/prompt.md)" \
            --max-turns 60 \
            --allowedTools "Read,Edit,Write,Glob,Grep,Bash(sf data query:*),Bash(sf project retrieve start:*),Bash(sf apex run test:*),Bash(npx jest:*),Bash(npm run lint:*)" \
            --output-format json > /tmp/claude.json
          jq -r '.result' /tmp/claude.json > /tmp/summary.md

      - name: Commit and push (App token)
        run: |
          git config user.name "conscendo-delivery-bot[bot]"
          git config user.email "${{ steps.app.outputs.app-slug }}[bot]@users.noreply.github.com"
          git add -A
          git diff --cached --quiet && { echo "No changes produced"; exit 1; }
          git commit -m "${KEY}: AI build attempt ${ATTEMPT}"
          git push -u origin "$BRANCH"

      - name: Open PR if missing
        env:
          GH_TOKEN: ${{ steps.app.outputs.token }}
        run: |
          if ! gh pr view "$BRANCH" >/dev/null 2>&1; then
            gh pr create --base main --head "$BRANCH" --title "${KEY}: ${{ github.event.client_payload.summary }}" \
              --body-file /tmp/summary.md --label ai-generated --label "ai-attempt-${ATTEMPT}"
          else
            gh pr edit "$BRANCH" --add-label "ai-attempt-${ATTEMPT}"
            gh pr comment "$BRANCH" --body-file /tmp/summary.md
          fi
```

Notes for Claude Code when generating this file:
- Escape payload values before they reach the shell. Pass them through `env:` and reference them as `"$VAR"`, not by direct `${{ }}` interpolation inside `run:`. This prevents script injection from Jira text. Rewrite the steps above this way.
- `anthropics/claude-code-action` is an alternative to the CLI step. In automation mode (with a `prompt`) it supports `repository_dispatch`. It also commits to a branch but cannot open, approve or merge PRs, so the App-token PR step stays either way.
- The DEV org user should have a read-mostly permission set. Claude uses it for context and to run tests, not to deploy.

**Phase 3 acceptance test:** a dummy story ("Add a Description help text to Account.Rating") produces a branch, PLAN.md, a code change, tests and a PR with label `ai-attempt-1`.

---

## Phase 4: PR checks (`pr-checks.yml`)

```yaml
name: pr-checks
on:
  pull_request:
    branches: [main]

jobs:
  static:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm i -g @salesforce/cli && sf plugins install code-analyzer
      - run: npm ci && npm run lint && npx jest --ci
      - name: Code Analyzer
        id: ca
        uses: forcedotcom/run-code-analyzer@v2   # confirm inputs/outputs in its README
        with:
          run-arguments: --workspace force-app --rule-selector Recommended --output-file ca-results.html --output-file ca-results.json
          results-artifact-name: code-analyzer-results
      - name: Quality gate
        run: |
          if [ "${{ steps.ca.outputs.num-sev1-violations }}" -gt 0 ] || [ "${{ steps.ca.outputs.num-sev2-violations }}" -gt 0 ]; then
            echo "Quality gate failed: sev1=${{ steps.ca.outputs.num-sev1-violations }} sev2=${{ steps.ca.outputs.num-sev2-violations }}"; exit 1
          fi

  qa-deploy-and-test:
    needs: static
    runs-on: ubuntu-latest
    concurrency: { group: qa-sandbox, cancel-in-progress: false }
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm i -g @salesforce/cli && npm ci && npx playwright install --with-deps chromium
      - name: Login QA sandbox
        run: |
          echo "${{ secrets.SF_JWT_KEY_QA }}" > /tmp/qa.key
          sf org login jwt --client-id "${{ secrets.SF_CLIENT_ID_QA }}" --username "${{ secrets.SF_USERNAME_QA }}" \
            --jwt-key-file /tmp/qa.key --instance-url "${{ vars.SF_INSTANCE_URL_SANDBOX }}" --alias qa --set-default
          rm /tmp/qa.key
      - name: Deploy branch to QA sandbox
        run: sf project deploy start --source-dir force-app --target-org qa --test-level NoTestRun --wait 60
      - name: Apex tests
        run: |
          sf apex run test --target-org qa --test-level RunLocalTests --code-coverage \
            --result-format json --output-dir test-results/apex --wait 60
      - name: Playwright
        run: npx playwright test --reporter=html,junit
        env:
          SF_ALIAS: qa
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-evidence
          path: |
            test-results/
            playwright-report/

  evidence-pack:
    needs: [static, qa-deploy-and-test]
    runs-on: ubuntu-latest
    steps:
      - uses: slackapi/slack-github-action@v2   # confirm v2 input names
        with:
          webhook: ${{ secrets.SLACK_WEBHOOK_URL }}
          webhook-type: incoming-webhook
          payload: |
            text: "Ready for review: ${{ github.event.pull_request.title }}"
            blocks:
              - type: section
                text:
                  type: mrkdwn
                  text: "*Evidence pack* for <${{ github.event.pull_request.html_url }}|${{ github.event.pull_request.title }}>\n• Code Analyzer gate: passed\n• Apex tests: passed\n• Playwright: passed\n• CodeRabbit: see PR\nTech lead: please review and merge."
```

Notes:
- If two PRs share one QA sandbox, deploys can clash. The `concurrency` group serialises them. For more scale, use scratch orgs per PR (`sf org create scratch`) with a Dev Hub.
- Add a Code Analyzer config (`code-analyzer.yml`) to tune rules. Never lower severities to pass a PR.
- An optional speed-up is to deploy only changed metadata with the `sfdx-git-delta` plugin.

### 4.1 Playwright login to Salesforce

`tests/e2e/global-setup.ts`:

```ts
import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';

export default async function globalSetup() {
  const alias = process.env.SF_ALIAS ?? 'qa';
  const org = JSON.parse(execSync(`sf org display --target-org ${alias} --json`).toString()).result;
  const url = `${org.instanceUrl}/secur/frontdoor.jsp?sid=${org.accessToken}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForURL(/lightning/);
  await page.context().storageState({ path: 'tests/e2e/.auth.json' });
  process.env.SF_INSTANCE_URL = org.instanceUrl;
  await browser.close();
}
```

`playwright.config.ts` sets `globalSetup`, `use.storageState: 'tests/e2e/.auth.json'`, `use.baseURL` from the org instance URL, `retries: 1`, `trace: 'retain-on-failure'`. Add `.auth.json` to `.gitignore`.

Optional: run `npx playwright init-agents` (with the Claude option) to add the Playwright planner, generator and healer agents. They help Claude write and repair specs locally.

### 4.2 CodeRabbit (`.coderabbit.yaml`)

Confirm keys against the CodeRabbit config schema.

```yaml
language: en
reviews:
  profile: assertive
  request_changes_workflow: true
  high_level_summary: true
  auto_review:
    enabled: true
    drafts: false
    base_branches: [main]
  path_instructions:
    - path: "force-app/**/classes/**"
      instructions: >
        Salesforce Apex. Flag SOQL/DML in loops, missing sharing keywords, missing CRUD/FLS,
        hard-coded IDs, duplicated logic that already exists elsewhere in force-app, and tests without assertions.
    - path: "force-app/**/lwc/**"
      instructions: "Check error handling, LDS use before Apex, and Jest coverage."
    - path: "force-app/**/flows/**"
      instructions: "Check for recursion, missing fault paths and hard-coded values."
knowledge_base:
  code_guidelines:
    enabled: true
    filePatterns: ["CLAUDE.md", "docs/definition-of-done.md"]
```

**Phase 4 acceptance test:** the Phase 3 PR shows four green checks, a CodeRabbit review and a Slack evidence message. Then break a test on purpose: the check fails and the evidence pack is not sent.

---

## Phase 5: Fix loop (`ai-fix-loop.yml`)

Re-dispatches Claude when checks fail or CodeRabbit requests changes. It stops after `MAX_AI_ATTEMPTS`.

```yaml
name: ai-fix-loop
on:
  workflow_run:
    workflows: [pr-checks]
    types: [completed]
  pull_request_review:
    types: [submitted]

jobs:
  loop:
    if: >
      (github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'failure') ||
      (github.event_name == 'pull_request_review' && github.event.review.state == 'changes_requested'
        && github.event.review.user.login == 'coderabbitai[bot]')
    runs-on: ubuntu-latest
    steps:
      - id: app
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
      - name: Collect context and decide
        env:
          GH_TOKEN: ${{ steps.app.outputs.token }}
          MAX: ${{ vars.MAX_AI_ATTEMPTS }}
          PR_FROM_RUN: ${{ github.event.workflow_run.pull_requests[0].number }}
          PR_FROM_REVIEW: ${{ github.event.pull_request.number }}
          RUN_ID: ${{ github.event.workflow_run.id }}
          REVIEW_BODY: ${{ github.event.review.body }}
        run: |
          PR=${PR_FROM_RUN:-$PR_FROM_REVIEW}
          INFO=$(gh pr view "$PR" --repo "$GITHUB_REPOSITORY" --json headRefName,labels,title)
          echo "$INFO" | jq -e '.labels[].name | select(.=="ai-generated")' >/dev/null || { echo "Not an AI PR"; exit 0; }
          BRANCH=$(echo "$INFO" | jq -r .headRefName)
          KEY=$(echo "$BRANCH" | grep -oE '[A-Z][A-Z0-9]+-[0-9]+')
          LAST=$(echo "$INFO" | jq -r '[.labels[].name | select(startswith("ai-attempt-")) | ltrimstr("ai-attempt-") | tonumber] | max // 1')
          NEXT=$((LAST+1))
          if [ -n "$RUN_ID" ]; then
            FEEDBACK=$(gh run view "$RUN_ID" --repo "$GITHUB_REPOSITORY" --log-failed | tail -c 6000)
          else
            FEEDBACK=$(printf '%s\n' "$REVIEW_BODY"; gh api "repos/$GITHUB_REPOSITORY/pulls/$PR/comments" --jq '.[] | select(.user.login=="coderabbitai[bot]") | "\(.path):\(.line) \(.body)"' | tail -c 6000)
          fi
          if [ "$NEXT" -gt "$MAX" ]; then
            gh pr edit "$PR" --repo "$GITHUB_REPOSITORY" --add-label needs-human
            echo "STOP=1" >> $GITHUB_ENV; echo "PR=$PR" >> $GITHUB_ENV; exit 0
          fi
          jq -n --arg key "$KEY" --arg branch "$BRANCH" --arg fb "$FEEDBACK" --argjson n "$NEXT" \
            '{event_type:"claude-fix", client_payload:{key:$key, branch:$branch, attempt:$n, feedback:$fb, summary:$key}}' \
            | gh api "repos/$GITHUB_REPOSITORY/dispatches" --input -
      - if: env.STOP == '1'
        uses: slackapi/slack-github-action@v2
        with:
          webhook: ${{ secrets.SLACK_WEBHOOK_URL }}
          webhook-type: incoming-webhook
          payload: |
            text: "AI stopped after ${{ vars.MAX_AI_ATTEMPTS }} attempts on PR #${{ env.PR }}. A developer needs to take over."
```

Notes:
- `client_payload` has a size limit. The feedback is trimmed to the last 6,000 characters of the failing log.
- `workflow_run` only carries `pull_requests` for PRs from the same repo, which is the case here.
- Add a Jira comment at stop time (Jira REST API or a Jira Automation incoming webhook) so the analyst sees it.

**Phase 5 acceptance test:** a story with an impossible criterion produces attempts 1, 2 and 3, then label `needs-human` and a Slack alert. No 4th run starts.

---

## Phase 6: Release (no AI)

### 6.1 Branch protection on `main` (GitHub settings or `gh api`)
- Require a pull request, 1 approval, review from CODEOWNERS, dismiss stale approvals on new commits.
- Required status checks: `static`, `qa-deploy-and-test`.
- Block force pushes and deletions. Include administrators.
- Do not add the GitHub App to the bypass list.

### 6.2 `deploy-prod.yml`

```yaml
name: deploy-prod
on:
  push:
    branches: [main]

concurrency: { group: prod-deploy, cancel-in-progress: false }

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production        # add required reviewers (DevOps) on this environment
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm i -g @salesforce/cli
      - name: Login PROD
        run: |
          echo "${{ secrets.SF_JWT_KEY_PROD }}" > /tmp/prod.key
          sf org login jwt --client-id "${{ secrets.SF_CLIENT_ID_PROD }}" --username "${{ secrets.SF_USERNAME_PROD }}" \
            --jwt-key-file /tmp/prod.key --instance-url "${{ vars.SF_INSTANCE_URL_PROD }}" --alias prod
          rm /tmp/prod.key
      - name: Validate
        run: sf project deploy validate --source-dir force-app --target-org prod --test-level RunLocalTests --wait 120
      - name: Deploy
        run: sf project deploy start --source-dir force-app --target-org prod --test-level RunLocalTests --wait 120
      - if: always()
        uses: slackapi/slack-github-action@v2
        with:
          webhook: ${{ secrets.SLACK_WEBHOOK_URL }}
          webhook-type: incoming-webhook
          payload: |
            text: "Production deploy ${{ job.status }} for ${{ github.sha }}"
```

Optional: deploy with the job ID from validation (`sf project deploy quick --job-id`) to avoid running tests twice.

### 6.3 Jira
Rule B (Phase 2) moves the story to Done on merge.

**Phase 6 acceptance test:** the tech lead approves and merges the Phase 3 PR. `deploy-prod` validates and deploys (point it at a staging org first), Slack reports success and the Jira story is Done.

---

## Phase 7: Retro loop

- After each sprint, export reviewer comments: CodeRabbit comments the developers marked useful, human review comments, and the reasons for `needs-human` PRs.
- Ask Claude Code locally: "Summarise recurring issues from these comments and propose new rules for CLAUDE.md and .coderabbit.yaml path_instructions." A person approves and merges the change as a normal PR.
- Track these per sprint: AI first-pass success rate, average attempts, `needs-human` count, review time, escaped defects.

---

## 8. Security checklist (verify before go-live)

- [ ] Payload values reach shell steps only through `env:` variables (no `${{ }}` inside `run:` for Jira or PR text).
- [ ] The production JWT key exists only in the `production` environment, which has required reviewers.
- [ ] The AI build job uses a DEV sandbox user with no deploy and no admin rights.
- [ ] `.claude/settings.json` denies deploy, push and `.github/` edits. CI also passes an explicit `--allowedTools` list.
- [ ] The GitHub App cannot bypass branch protection.
- [ ] The PAT used by Jira is fine-grained, scoped to one repo, with an expiry date and an owner.
- [ ] Artifacts and logs contain no access tokens (`sf org display` output is never printed).
- [ ] Claude in CI uses `--max-turns` and the job has `timeout-minutes`, which caps cost and runaway runs.
- [ ] CodeRabbit and Anthropic data-retention settings match the client's contract. Check before using client code.

## 9. Rollout plan

| Week | Scope |
|---|---|
| 1 | Phases 1 and 2 on an internal demo repo. Loop 1 on one real meeting. |
| 2 | Phases 3 and 4 with dummy stories against a dev sandbox. |
| 3 | Phase 5, then a dry run of Phase 6 against a staging org. |
| 4 | Pilot on one client project with 2 or 3 low-risk stories per sprint. Measure, then widen. |

## 10. Prompts to give Claude Code, phase by phase

1. "Implement Phase 1 of docs/IMPLEMENTATION.md. Fetch the current MCP server URLs and install commands from official docs and tell me which ones need my sign-in."
2. "Write the Jira automation rules from Phase 2 as a step-by-step click guide for our Jira admin, with the exact web request body."
3. "Implement Phase 3. Rewrite every step so Jira and PR text only enters shell commands through env variables. Check the latest inputs of every action you use."
4. "Implement Phase 4 including Playwright global setup and one example spec for an Account page."
5. "Implement Phase 5. Add a dry-run mode (variable `AI_LOOP_DRY_RUN=true`) that logs the dispatch instead of sending it."
6. "Implement Phase 6 and give me the `gh api` command to set branch protection exactly as described."
7. "Run the security checklist in section 8 against the repo and report each item as pass or fail with evidence."