# Connecting the external systems (screens and checks)

VERIFY every Setup label and menu path against current vendor docs on the day you do it.

## Salesforce (per sandbox, DEV and QA; PROD is done by a person, HC-5)
1. Setup → Users → New User: `ai-dev@<client>.dev` / `ai-qa@<client>.qa`. Licence: Salesforce Integration or a full
   licence if the permission set needs it.
2. Permission set `Circuit_CI_<Org>`:
   - DEV: API Enabled, View Setup and Configuration, read on the objects in scope, Author Apex (for running tests),
     Modify Metadata Through Metadata API Functions **only if** check-only validation needs it in your edition. No
     Modify All Data, no Manage Users.
   - QA: API Enabled, deploy metadata, Author Apex, create/edit/delete on test-data objects.
3. Setup → External Client App Manager → New: Local; Enable OAuth; callback `http://localhost:1717/OauthRedirect`;
   scopes `api`, `refresh_token offline_access`; Enable JWT Bearer Flow; upload `<org>.crt`.
   Policies: Admin approved users are pre-authorised; add the permission set. Copy the Consumer Key.
   (If the org still allows Connected Apps, the same settings work there.)
4. A sandbox refresh replaces these: re-run this section and update the secrets after each refresh.

## Jira
- Fields: create in Settings → Issues → Custom fields; add each to the Story / Test (Case) screens.
  Types: Spec file (short text), Feature (short text), Story type (select: foundation, feature), Schema change
  (select: yes, no), Persona (short text), Test level (select: ui, unit, manual), AC id (short text),
  Testability confirmed (checkbox or select), Acceptance criteria (paragraph).
- Rule A "Dispatch AI plan":
  - Trigger: Work item transitioned to **Ready for Dev**.
  - Conditions: labels contains `ai-ready`; Testability confirmed is set; Related issues condition "all issues that
    *block* this one are Done".
  - Action: Send web request, POST `https://api.github.com/repos/<org>/<repo>/dispatches`, headers
    `Authorization: Bearer <PAT>` (HC-7, hidden value if available), `Accept: application/vnd.github+json`,
    `X-GitHub-Api-Version: 2022-11-28`. Body (custom data), **key only**:
    ```json
    { "event_type": "jira-ready", "client_payload": { "key": "{{issue.key}}" } }
    ```
    CI reads everything else from the repo (`jira-map.json`) and Jira REST, so no free text leaves Jira.
  - Then: transition to **Plan Review**.
- Rule B "Status sync" (one rule per row; trigger "Comment added", condition "comment contains", author = bot account):
  | Comment starts with | Transition to |
  |---|---|
  | `AI plan ready for review` | Plan Review |
  | `Developer approved the AI plan` / `Tester approved the AI test plan` | (no transition; audit only) |
  | `Build complete` | Code Review |
  | `AI stopped` | (add label `needs-human`) |
  | Trigger "Pull request merged" | Done |
- PAT for Rule A: fine-grained, resource owner = org, this repo only, Contents: Read and write, expiry ≤ 90 days,
  created on a machine user.

## Slack
api.slack.com/apps → Create app "Delivery Gates" → Incoming Webhooks → On → Add New Webhook → pick `#arch-gate`;
repeat for `#dev-gate`, `#qa-gate`. Each URL goes straight into `gh secret set SLACK_WEBHOOK_ARCH|DEV|QA` in the
person's terminal.

## GitHub App token check (throwaway workflow)
```yaml
name: verify-bootstrap
on: workflow_dispatch
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - id: app
        uses: actions/create-github-app-token@v2
        with: { app-id: "${{ secrets.APP_ID }}", private-key: "${{ secrets.APP_PRIVATE_KEY }}" }
      - env: { GH_TOKEN: "${{ steps.app.outputs.token }}" }
        run: gh api "repos/$GITHUB_REPOSITORY" --jq .full_name
      - run: npm i -g @anthropic-ai/claude-code && claude -p "Reply with the single word ok" --max-turns 1
        env: { CLAUDE_CODE_OAUTH_TOKEN: "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}" }
```
