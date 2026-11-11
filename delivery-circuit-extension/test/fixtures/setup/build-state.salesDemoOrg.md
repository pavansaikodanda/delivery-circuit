| B4 Spec Kit | PARTIAL | `specify extension list` shows sf 2.0.1 | commit 876212c on pipeline/speckit | deploy/hotfix/pr skills removed; constitution not yet generated || B3 Repo foundation | DONE (local) | guard checks run in repo | commit 55be182 on pipeline/foundation | not pushed: no GitHub repo yet; workflows held for B8; MCP URLs still VERIFY || B2 Salesforce access | PARTIAL | aliases only | `sf alias list` | DEV and QA = SDO trial org salesOrgSDO (demo.user@example.com); CI JWT users not yet created || B0 Preflight | PARTIAL | tools: yes; gh admin: no | versions below | gh token has repo,workflow but not admin:org; user is a plain member of acme-org |# Build state

Updated by Claude after every step. Resume from here after an interruption.

| Phase | Status | Verified | Evidence | Notes |
|---|---|---|---|---|
| B0 Preflight | TODO | | | |
| B1 GitHub org and bot | TODO | | | |
| B2 Salesforce access | TODO | | | |
| B3 Repo foundation | TODO | | | |
| B4 Spec Kit | TODO | | | |
| B5 Jira | TODO | | | |
| B6 Confluence, Lucid, Fireflies | TODO | | | |
| B7 Slack | TODO | | | |
| B8 Workflows and CodeRabbit | TODO | | | |
| B9 Protect main and production | TODO | | | |
| B10 Persona workstations | TODO | | | |
| B11 Dry run | TODO | | | |
| B12 Go live | TODO | | | |

## Tool versions (B0)
2026-11-10: git 2.53.0, gh 2.73.0, node 22.23.3, npm 10.9.9, python 3.13.1, uv 0.13.0, sf 2.157.8 (code-analyzer 5.1.0), claude 2.1.318, openssl 3.5.5, jq 1.7.1, actionlint 1.7.7, specify 1.3.4.dev0

## Facts re-checked (date, source)
- 2026-11-10 SF AI Tester (github.com/pavansaikodanda/sf-ai-tester @ 8a5b5c2): CLI `dist/cli.js run <suite> --mode --login --workers`; `SF_ALIAS` login through the sf CLI; keeps CLAUDE_CODE_OAUTH_TOKEN and removes ANTHROPIC_API_KEY; exits 1 unless all cases pass; writes .sf-ai-tester/runs/<ts>/results.json { suite, org, results[] }. Live check on the trial org: run 1 had 1 blocked case (Region not on the layout; a test problem, route qa); after fixing the suite, run 2 passed 2/2 (route pass).
- 2026-11-10 `specify init --help`: --here, --force, --non-interactive, --integration, --integration-options, --script, --ignore-agent-tools exist. `specify extension add --from <url>` asks to confirm untrusted URLs.
- 2026-11-10 GitHub API: spec-kit-sf latest release is still v2.0.1. It installed 19 commands and 2 optional hooks (after_tasks → review, after_implement → verify).

## Deviations from the runbook (and why)
- DEV and QA are the same org: the SDO trial org salesOrgSDO (Enterprise Edition, not a sandbox). The owner confirmed on 2026-11-10 that it is a trial org the AI may use freely. There is no production org (sf-config prod: "none").
- CI logins to this org use https://login.salesforce.com, not test.salesforce.com: set SF_INSTANCE_URL_SANDBOX accordingly in B1.

## Open issues
- GitHub: which org and repo name? Teams, rulesets and the App need an org admin (or admin:org scope).
- Jira site/project, Confluence space, Slack workspace, and the people per team are not provided yet.

## Reminders
- CLAUDE_CODE_OAUTH_TOKEN expires: <date + 1 year>
- Jira PAT for Rule A expires: <date>
- Salesforce JWT certificates expire: <date>
