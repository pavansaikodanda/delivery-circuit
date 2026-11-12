# Review Room: CodeRabbit and Claude debate each PR in Slack

A Slack channel, `#review-room`, where CodeRabbit's Slack agent (`@coderabbit`) and Claude Tag (`@Claude`) review the
same pull request, challenge each other's findings, and hand people one clear verdict. People still decide: disputed
items wait for the Developer (G5) or the Architect (G7), and nothing here approves or merges.

## What you need

| Item | Notes |
|---|---|
| Claude Team or Enterprise plan | Claude Tag is available on Team and Enterprise. Channel use is billed to the Claude organisation. |
| Slack (Pro or higher) | Both apps install on Pro. |
| CodeRabbit with the GitHub App on the repo | The Slack agent reads code through the GitHub App. |

No personal credentials are stored anywhere. Claude Tag and CodeRabbit sign in through their own app installs.

## Setup (about 15 minutes)

**Claude Tag** (a Claude organisation Owner):
1. Open claude.ai/admin-settings/claude-tag and start setup.
2. In Slack, send `@Claude connect` in any channel and enter the pairing code on the setup page.
3. Scope it to `#review-room` and set a monthly spend limit.

**Slack** (a workspace admin):
4. Approve the Claude app install if Slack asks.
5. Create `#review-room`. A public channel is simplest, because CodeRabbit joins public channels automatically. For a
   private channel, run `/invite @coderabbit`.
6. Add Claude to the channel.

**CodeRabbit:**
7. Install the CodeRabbit Slack agent from the CodeRabbit dashboard, and make sure the CodeRabbit GitHub App is
   installed on the repository.

## How a review runs (one thread per PR)

```
1. Kick-off           "PR #42 CE-12 Agent escalates a Case · <link>"
2. @coderabbit        review PR #42: issues by severity with file:line
3. @Claude            challenge each finding above (real bug / nitpick / wrong) and add anything missed
4. @coderabbit        respond to Claude's points
5. @Claude            final verdict: must fix · disputed (both arguments) · dropped (with reason)
6. A person           decides the disputed items; "must fix" goes to the Developer AI fix loop
```

Claude Tag reads the whole thread, so in step 3 it sees CodeRabbit's review and answers it point by point. In a thread
with several participants, mention `@coderabbit` again to get a reply.

## First test (10 minutes)

In `#review-room`, start a thread on an open PR and send steps 2 to 5 by hand. Note whether each bot answers every
mention. Then check whether a message posted by the circuit's own Slack app (not a person) triggers them: many Slack
bots ignore other bots to avoid loops.

## Planned circuit integration

- **Kick-off:** when a PR's checks pass, the circuit posts the thread with the PR link. If the bots respond to the
  circuit's Slack app, the circuit runs the rounds itself, capped at two; otherwise a person runs the turns.
- **Verdict:** "must fix" items feed the Developer AI fix loop; disputed items wait for G5 / G7.
- **Extension:** each PR row shows a "Review room" status (for example "3 must fix · 1 disputed") with a link to the
  Slack thread.
- The circuit's Slack app uses its own bot token, stored as a GitHub Actions secret.

## Sources

- CodeRabbit Slack agent: https://docs.coderabbit.ai/overview/slack-agent and https://docs.coderabbit.ai/slack-agent/use-in-slack
- Claude Tag: https://claude.com/docs/claude-tag/overview and https://claude.com/docs/claude-tag/admins/for-slack-admins
