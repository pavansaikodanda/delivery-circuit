# Connecting the external systems (v4)

VERIFY every Setup label, menu path and command against current vendor docs on the day you do it. Sample values
are placeholders (acme-org, acme-salesforce, ACME, acme.atlassian.net, demo.user@example.com).

The circuit stores exactly one kind of credential: an `SFDX_AUTH_URL` secret in each GitHub Environment. Everything
else is a person's own login. Claude never reads, prints or sets an auth URL.

## GitHub Environments and SFDX_AUTH_URL (B5)
Docs: docs.github.com → Actions → Deployments and environments; cli.github.com/manual/gh_secret_set;
developer.salesforce.com → sf CLI reference → `org login sfdx-url`, `org display`.
- Environments: `qa`, `dev`, `sit`, `uat` (no reviewers) and `production` (required reviewers = team `leads`,
  prevent self-review, deployment branch `main`). Payload: `templates/github/environment-production.json`.
- The auth URL holds a refresh token for the user who ran `sf org login web`. Use a dedicated CI user per org with
  only the permissions a deploy needs (Modify Metadata through Metadata API Functions, or the deploy permission set
  the org uses: VERIFY), so a person leaving does not break CI.
- The admin, in their own terminal:
  ```bash
  sf org login web --alias acme-qa --instance-url https://test.salesforce.com
  sf org display --verbose --json --target-org acme-qa | jq -r .result.sfdxAuthUrl \
    | gh secret set SFDX_AUTH_URL --env qa --repo acme-org/acme-salesforce
  ```
  `gh secret set` without `--body` reads the value from stdin. Nothing is echoed, nothing is written to disk.
- CI logs in with `printf '%s' "$SFDX_AUTH_URL" | sf org login sfdx-url --sfdx-url-stdin --alias circuit-target`
  (VERIFY the flag with `sf org login sfdx-url --help`) and logs out at the end of the job. GitHub masks the secret in
  logs as well.
- Rotation: sandbox refresh, password-policy expiry or a revoked OAuth session invalidates the URL; the next `scan`
  or `deploy` fails at "Log in": repeat the two commands for that environment.
- Fork PRs never receive environment secrets; `scan` fails for them before any login step.

## Rulesets (B7)
Docs: docs.github.com → Repositories → Rulesets; REST `POST /repos/{owner}/{repo}/rulesets`.
- `templates/github/ruleset-sprint.json`: `refs/heads/sprint/*`, PR with 1 approval, required check `scan`
  (not strict, so auto-merge does not need every feature PR rebased), no force-push, no deletion.
- `templates/github/ruleset-promotion.json`: `dev`, `sit`, `uat`, `main`, PR with 1 approval from `leads`
  (`required_reviewers`, VERIFY), required check `scan` (strict), no force-push, no deletion.
- The required check name is the job name `scan` from `pr-checks.yml`.

## CodeRabbit (B6)
Docs: docs.coderabbit.ai.
- GitHub App: install on this repository with write access to pull requests (needed for its approval to count).
- `.coderabbit.yaml`: `reviews.auto_review.enabled: false` and `reviews.request_changes_workflow: true`. The
  `coderabbit` job in `pr-checks.yml` comments `@coderabbitai review` once per head SHA (marker
  `<!-- circuit:coderabbit-review:<sha> -->`), only for `feature/*` PRs after `scan` passed. VERIFY on the first PR
  that CodeRabbit acts on a command posted by `github-actions[bot]`; if it ignores bot comments, the Developer posts
  the command (the `dev-start-story` / `dev-fix` skills can do it from their own `gh` login).
- Slack: the CodeRabbit Slack agent in `slack.channel` (workspace admin approves it).

## Atlassian (B8)
- Atlassian Rovo MCP: `https://mcp.atlassian.com/v2/mcp` (OAuth 2.1, the user's own permissions; VERIFY URL). Add it
  with `claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp` or the claude.ai connector, then
  `/mcp` in an interactive session. No API tokens.
- Jira: story workflow with the status in `jira.ready_status` ("Ready for Dev"), set by people at refinement; the
  test issue type in `jira.test_issue_type`. "GitHub for Atlassian" links `feature/ACME-12-…` branches and
  `ACME-12 …` PR titles to the work item (use uppercase keys).
- Confluence: space `confluence.space_key`; Space settings → Content status → add **Approved**. Restrict edit of
  approved design pages to the architects group.
- Lucid for Confluence (admin install); Architects sign in to the Lucid MCP with `/mcp`. Fireflies is optional
  (`https://api.fireflies.ai/mcp`, OAuth; VERIFY).

## Salesforce on laptops (B9)
- Each Developer: `sf org login web --alias dev` to their own DEV org. AI may validate and deploy only there.
- The production alias (`salesforce.prod_alias`) is never used by AI; the guard blocks it. Production deploys come
  only from `deploy.yml` on `main` after a lead approves the `production` environment.
