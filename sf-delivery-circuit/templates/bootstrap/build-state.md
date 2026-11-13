# Build state (Delivery Circuit v4)

Updated by Claude after every step. Resume from here after an interruption. No secrets, tokens, keys or auth URLs
here: the only stored credentials are the SFDX_AUTH_URL secrets in GitHub Environments, set by the admin.

| Phase | Status | Verified | Evidence | Notes |
|---|---|---|---|---|
| B0 Preflight | TODO | | | |
| B1 Project settings (build.config.yml) | TODO | | | |
| B2 Repo files | TODO | | | |
| B3 Branch ladder (main, uat, sit, dev, sprint/<name>) | TODO | | | |
| B4 GitHub teams, labels and settings (auto-merge) | TODO | | | |
| B5 Environments and their SFDX_AUTH_URL | TODO | | | |
| B6 CodeRabbit | TODO | | | |
| B7 Rulesets | TODO | | | |
| B8 Jira, Confluence, Atlassian MCP, Lucid | TODO | | | |
| B9 Workstations | TODO | | | |
| B10 Dry run | TODO | | | |

## Tool versions (B0)

## Environments (B5)
| Environment | Branch(es) | sf alias / CI user (names only) | Secret set (date) | Reviewers |
|---|---|---|---|---|
| qa | sprint/* | | | none |
| dev | dev | | | none |
| sit | sit | | | none |
| uat | uat | | | none |
| production | main | | | leads |

## Current sprint branch

## Facts re-checked (date, source)

## Deviations from the runbook (and why)

## Open issues

## Reminders
- A sandbox refresh or the CI user's password policy invalidates that environment's SFDX_AUTH_URL: the admin repeats
  B5.3 for it.
