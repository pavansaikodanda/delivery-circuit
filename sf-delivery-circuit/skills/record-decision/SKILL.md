---
name: record-decision
description: Record a design decision (C1) as a row in the Decisions section of the feature's Confluence design page - date, decision, who, why, source link - so every later step reads it from there. Use when an open question is answered, a trade-off is chosen in a call, a review, a Slack thread or a build, or the user says "record that decision".
---

# Record a decision (C1)

Persona: any (Architect, Developer or Tester). Input: `$ARGUMENTS` = the decision in one sentence, plus the feature
(`NNN-slug`, design page link, epic or story key). Ask for whatever is missing: **who** decided (a person, never
"AI"), **why**, and the **source** (meeting source id, Slack thread link, PR comment link, Jira comment link).

## Steps
1. **Find the page:** from a story or epic key, read *Design page* (`story_get` / `getJiraIssue`); from `NNN-slug`,
   `searchConfluence` with `label = "feature-NNN"`. Read it with `getConfluenceContent` (body and version).
2. **Check for duplicates:** if the Decisions table already has the same decision, say so and stop.
3. **Draft the row** and show it to the user before writing:
   `| 2026-11-12 | Rates are stored per carrier, not per region | Dana (Architect) | Acme Shipping prices per carrier | [call](source: fireflies:abc123) |`
   Paraphrase; never paste transcript or Slack text beyond a short phrase.
4. **Write:** `updateConfluenceContent` with the same body plus the row appended to the Decisions table (newest
   last), based on the version you read. If the update conflicts, re-read and retry once.
5. **Answered question:** if the decision answers an item under Open questions, remove that item in the same update.
6. **Approval impact:** if the page status was Approved, say clearly: "This edit created a new page version. If the
   decision changes the design, the Architect must re-approve (G1) and started stories re-plan (C5). If it only
   records an existing choice, no re-approval is needed." Never change the status yourself.

Report the row written and the page link. Next owner: whoever the decision unblocks.
