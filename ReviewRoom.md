# Review Room: CodeRabbit and Claude debate each PR in Slack

A Slack channel, `#review-room`, where CodeRabbit's Slack agent (`@coderabbit`) and Claude Tag (`@Claude`) review the
same pull request, challenge each other's findings, and hand people one clear verdict. People still decide: disputed
items wait for the Developer (G5) or the Architect (G7), and nothing here approves or merges.

In v3 ([`docs/CIRCUIT-V3.md`](docs/CIRCUIT-V3.md), steps 15 and 16) the **Developer** opens the room from the
extension, and the verdict is **recorded on the PR**, so everyone can see it without reading Slack.

## What you need

| Item | Notes |
|---|---|
| Claude Team or Enterprise plan | Claude Tag is available on Team and Enterprise. Channel use is billed to the Claude organisation. |
| Slack (Pro or higher) | Both apps install on Pro. |
| CodeRabbit with the GitHub App on the repo | The Slack agent reads code through the GitHub App. |
| Slack MCP signed in for the Developer | The Developer's Claude posts the kick-off and reads the thread through the Slack MCP (the claude.ai Slack connector). See [`ConnectionsSetup.md`](ConnectionsSetup.md) section 3. |

No credentials are stored anywhere. Claude Tag and CodeRabbit sign in through their own app installs, and the
Developer's Claude uses the Developer's own Slack MCP sign-in. There is no circuit bot token and no webhook.

## Setup (about 15 minutes)

**Claude Tag** (a Claude organisation Owner):
1. Open claude.ai/admin-settings/claude-tag and start setup.
2. In Slack, send `@Claude connect` in any channel and enter the pairing code on the setup page.
3. Scope it to `#review-room` and set a monthly spend limit.

**Slack** (a workspace admin):
4. Approve the Claude app install, and the Slack MCP client integration, if Slack asks.
5. Create `#review-room`. A public channel is simplest, because CodeRabbit joins public channels automatically. For a
   private channel, run `/invite @coderabbit`.
6. Add Claude to the channel.

**CodeRabbit:**
7. Install the CodeRabbit Slack agent from the CodeRabbit dashboard, and make sure the CodeRabbit GitHub App has access
   to the repository.

**Each Developer:**
8. Sign in to the Slack connector at claude.ai (Settings → Connectors), then check `/mcp` in Claude Code shows Slack as
   connected.

## How a review runs (one thread per PR)

```
1. Open review room   Developer clicks "Open review room" on the PR row. Their Claude posts the kick-off
                      thread through the Slack MCP: PR link, ACs, key decisions, design page link, CI results
2. @coderabbit        review PR #42: issues by severity with file:line
3. @Claude            challenge each finding above (real bug / nitpick / wrong) and add anything missed
4. @coderabbit        respond to Claude's points
5. @Claude            final verdict: must fix · disputed (both arguments) · dropped (with reason)
6. Record verdict     Developer clicks "Record verdict". Their Claude reads the thread (Slack MCP) and posts
                      one PR comment: Must fix / Disputed / Dropped, with a link to the thread
7. People decide      must-fix items become "Fix with AI" for the Developer; disputed items wait for G5 / G7
```

The kick-off is posted with the Developer's own Slack identity, so it reads as a person starting the thread. People
then mention `@coderabbit` and `@Claude` for each round. If the bots turn out to answer each other, rounds can run on
their own, capped at two; otherwise a person sends steps 2 to 5.

Claude Tag reads the whole thread, so in step 3 it sees CodeRabbit's review and answers it point by point. In a thread
with several participants, mention `@coderabbit` again to get a reply.

## The verdict on the PR

"Record verdict" posts one PR comment like this (run it again after more rounds to post an updated verdict):

```
Review room verdict (thread: <Slack link>)
Must fix
- force-app/main/default/classes/ShipmentService.cls:42  null check on Carrier__c (CodeRabbit, agreed by Claude)
Disputed
- naming of ShipmentDelayHandler: CodeRabbit says rename, Claude says matches house rules. Decision: Developer (G5)
Dropped
- trailing whitespace nit (both agreed)
```

The extension's PR row shows the counts, for example "2 must fix · 1 disputed", with links to the comment and the
thread.

## First test (10 minutes)

In `#review-room`, click "Open review room" on an open PR (or post the kick-off yourself) and send steps 2 to 5 by
hand. Note whether each bot answers every mention, then click "Record verdict" and check the PR comment. The full
script is in [`docs/E2E-TEST-PLAN.md`](docs/E2E-TEST-PLAN.md).

## Known unknowns

- Slack's MCP documentation names only its file-upload tools exactly. The tool names for sending a message and reading
  a thread are taken from what the connector lists in `/mcp`, not hard-coded.
- Slack plan or general-availability requirements for the MCP server are not documented yet.

## Sources

- CodeRabbit Slack agent: https://docs.coderabbit.ai/overview/slack-agent and https://docs.coderabbit.ai/slack-agent/use-in-slack
- Claude Tag: https://claude.com/docs/claude-tag/overview and https://claude.com/docs/claude-tag/admins/for-slack-admins
- Slack MCP server: https://docs.slack.dev/ai/slack-mcp-server
