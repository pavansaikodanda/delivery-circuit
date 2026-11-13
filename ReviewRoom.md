# Review Room: CodeRabbit reviews, people discuss in Slack

In v4 ([`docs/CIRCUIT-V4.md`](docs/CIRCUIT-V4.md), steps 9 to 11) CodeRabbit is the reviewer on every feature PR. It
reviews only after the `scan` job passes, so it never spends time on code that does not compile or deploy. People
talk to it on the PR or in Slack with `@coderabbit`. AI never approves or merges; CodeRabbit's approval plus a green
scan lets the ruleset auto-merge into the sprint branch.

## How a review runs

| Step | What happens | Where |
|---|---|---|
| 1 | The Developer's PR into `sprint/<name>` triggers `pr-checks.yml` | GitHub Actions |
| 2 | `scan` runs: Code Analyzer, LWC Jest, check-only deploy and Apex tests against the target sandbox | GitHub Actions |
| 3 | Only if scan passes, the `coderabbit` job comments `@coderabbitai review` (once per head commit). `.coderabbit.yaml` has `auto_review.enabled: false`, so this comment is the only trigger | GitHub |
| 4 | CodeRabbit approves, or requests changes (`request_changes_workflow: true`) | GitHub PR, Slack |
| 5 | The Developer runs `/review-room <PR>`: Claude summarises CodeRabbit's review and, if the Slack MCP is connected, posts the summary and PR link to the team channel | Claude, Slack |
| 6 | Anyone asks follow-ups in that thread: `@coderabbit why is this a bulkification risk?` | Slack |
| 7 | The Developer runs `/dev-fix`, pushes; scan runs again, then CodeRabbit reviews the new commit | Claude, GitHub |
| 8 | Scan green + CodeRabbit approval → auto-merge → `deploy.yml` deploys the sprint branch to QA | GitHub |

Promotion PRs (`sprint/<name>` → `dev`, `dev` → `sit`, and so on) skip the `coderabbit` job. Leads approve those.

## What you need

| Item | Notes |
|---|---|
| CodeRabbit GitHub App with access to the repo | Needed for the review and for its approval to count (it needs write access; check on the first PR) |
| CodeRabbit Slack agent in the workspace | Installed from the CodeRabbit dashboard. It joins public channels on its own; in a private channel run `/invite @coderabbit` |
| A team channel, for example `#acme-delivery` | Where `/review-room` posts summaries |
| Slack MCP for the Developer (optional) | Without it, `/review-room` prints the summary for you to paste |

Setup steps are in [`ConnectionsSetup.md`](ConnectionsSetup.md).

## Example summary posted by `/review-room`

```
ACME-12 Escalate a Case with a reason: PR #<n> <link>
Scan: passed. CodeRabbit: changes requested (2)
- force-app/main/default/classes/CaseEscalationService.cls:<line>  query inside a loop
- force-app/main/default/lwc/escalateCase/escalateCase.js:<line>  missing error toast
Ask questions here with @coderabbit.
```

## Not in v4

No Claude Tag, no bot-to-bot debate, no "Record verdict" PR comment, no gate labels. The PR and CodeRabbit's review
are the record.
