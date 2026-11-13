# Delivery Circuit for VS Code

The v4 sidebar for Salesforce teams that run the [`sf-delivery-circuit`](../sf-delivery-circuit/) plugin
(design contract: [`docs/CIRCUIT-V4.md`](../docs/CIRCUIT-V4.md) section 7). One view, three tabs, one story panel.
Every connection is the person's own login; the extension stores no token and never reads a secret value.

## The sidebar

Header: your GitHub login · role chip (Architect / Developer / QA / Lead, click to switch) · refresh.

**Work** (default)
- *Next steps* for your role, at most five rows, one button each:
  - Architect: New design from transcript (`/circuit-intake`), Finish design (`/arch-design`, open questions),
    Create stories (`/arch-jira-push`, page Approved and no epic yet).
  - Developer: Fix `<KEY>` (`/dev-fix`: scan failed or CodeRabbit asked for changes), Review PR #n (a teammate's PR
    waits for a code-owner approval; opens the PR), Build `<KEY>` (`/dev-start-story`: Ready for Dev, no PR).
  - QA: Test `<KEY>` in QA (`/qa-explore`: merged into the sprint branch and deployed), Write tests for `<KEY>`
    (`/qa-design-tests`, then `/qa-add-tests`).
  - Lead: Approve production deploy (`deploy.yml` waiting on `production`), Sprint review: promote `sprint/<name>` →
    dev (opens the PR, or GitHub's compare page to create it), Promote dev → sit (and on up).
- *Sprint*: the sprint's stories with one status: Design · Ready · Building · In PR · QA · Done. Click → story panel.

**Connections**: GitHub, Claude, Salesforce DEV org (QA org for QA), Atlassian (Jira + Confluence through the Atlassian
MCP; `acli` only if installed), Lucid (Architect), CodeRabbit (GitHub App), Fireflies (optional). Each row: status
dot, who it is connected as, one button (Connect / Fix / Check). Rows your role does not need are hidden.

**Missing** (badge with the count, "Nothing missing" when empty): connections your role needs, repo setup (branches
`sprint/*`, `dev`, `sit`, `uat`, `main`; GitHub Environments and whether each has a secret **named** `SFDX_AUTH_URL`;
rulesets; CodeRabbit; auto-merge) and story gaps (design not approved, no acceptance criteria, no test cases, PR
without a Jira key, scan failing, CodeRabbit changes requested, no human approval for more than a day).

**Story panel**: Design → Stories → Build → QA → Release, the PR state (scan, CodeRabbit, human approval) and links
(Jira, design page, Lucid diagram, PR).

Buttons that start a skill open a terminal running `claude --agent <role>` with the skill command. New design from
transcript asks where the transcript is (paste from the clipboard, a file `.txt .md .vtt .srt .docx .pdf`, or a
Fireflies meeting); pasted text and files are stored encrypted in the extension's storage, never in the repo, and
`/circuit-intake` reads them through the Circuit MCP tool `transcript_get` (Architect only).

## Where the data comes from

| What | How |
|---|---|
| Roles | GitHub team membership: `architects`, `developers`, `testers` (QA), `leads` (`deliveryCircuit.githubTeams`). No team (or a personal repo): the chip offers every role. |
| Stories, test cases | Jira: `acli` when installed and logged in, otherwise a read-only `claude -p` call through your Atlassian MCP login. The open sprint's stories, else the stories of open epics. |
| Design pages | One read-only listing of the `circuit-design` pages in `confluence.space_key` (status, open questions, Lucid link). |
| PRs, checks, reviews | One GitHub GraphQL query (VS Code GitHub sign-in): PRs into `sprint/*`, the `scan` check, CodeRabbit reviews by `coderabbitai`, human approvals. |
| Deploys, repo setup | GitHub REST: `deploy.yml` runs, environments, environment secret **names**, rulesets. |

`build.config.yml` supplies `jira.project_key`, `jira.ready_status`, `confluence.space_key`, the `salesforce` aliases
and the `environments` ladder.

## Commands and settings

Commands: **Refresh**, **Switch Role**, **New Design from Transcript**, **Open Story**.

Settings: `deliveryCircuit.refreshSeconds`, `deliveryCircuit.githubTeams`, `deliveryCircuit.acliPath` (user settings
only), `deliveryCircuit.designReader` (`claude` | `off`), `deliveryCircuit.designReaderModel`.

## Develop

```bash
npm install
npm run build              # dist/extension.js (one bundle), codicons, monochrome logos
npx tsc --noEmit -p .      # typecheck
npx vitest run             # unit tests
npm run test:integration   # one VS Code test instance on a copy of ../salesDemoOrg, every role
npm run preview            # http://127.0.0.1:5178/ - pages with preview/fixtures (#tab=work|connections|missing)
npm run screens            # retakes design/screens/*.png (light + dark) with Playwright
npm run package            # delivery-circuit.vsix
```

Preview fixtures are generated from the view-model builders:
`DC_WRITE_FIXTURES=1 npx vitest run test/unit/views.test.ts`. Fixtures and docs use placeholders only (acme-org,
ABC/ACME keys, demo.user@example.com).
