# Build state (Delivery Circuit v3)

Updated by Claude after every step. Resume from here after an interruption. No secrets, tokens or keys here:
every connection is a login.

| Phase | Status | Verified | Evidence | Notes |
|---|---|---|---|---|
| B0 Preflight | TODO | | | |
| B1 GitHub repo, teams, labels, Actions settings | TODO | | | |
| B2 Self-hosted runners and their logins | TODO | | | |
| B3 Salesforce logins | TODO | | | |
| B4 Repo foundation | TODO | | | |
| B5 Spec Kit (local drafting) | TODO | | | |
| B6 Jira and acli | TODO | | | |
| B7 Confluence, Atlassian MCP, Lucid, Fireflies | TODO | | | |
| B8 Slack and the review room | TODO | | | |
| B9 Workflows and CodeRabbit | TODO | | | |
| B10 Protect main and production | TODO | | | |
| B11 Persona workstations | TODO | | | |
| B12 Dry run, every persona, every app | TODO | | | |
| B13 Go live | TODO | | | |

## Tool versions (B0)

## Runners (B2)
| Runner | Labels | OS | Service user | gh | sf aliases | acli | claude | Slack MCP |
|---|---|---|---|---|---|---|---|---|
| | circuit | | | | dev, qa (no prod) | | | |
| | circuit-release | | | | prod only | | | |

## Facts re-checked (date, source)

## Deviations from the runbook (and why)

## Open issues

## Reminders
- acli versions are supported for 6 months: update acli on every laptop and runner before: <date>
- Salesforce logins on the runners end when an org is refreshed or the session policy expires them: re-run
  `sf org login web|device --alias <alias>` as the runner's service user.
- Re-check runner logins after OS updates or password changes: `bash scripts/ci/runner-check.sh --gh --acli --claude --sf qa --not-sf prod`.
