---
name: record-decision
description: Append a decision row (date, decision, who, why, source) to the Decisions table of a feature's Confluence design page. Use when an open question is answered, a trade-off is chosen in a call, review or Slack thread, or the user says "record that decision".
---

# Record a decision

Persona: usually **Architect** (anyone may). Input: `$ARGUMENTS` = feature slug, design page link or a story/epic key,
plus the decision. Ask for what is missing: **who** decided (a person, never "AI"), **why**, and the **source**
(source id, meeting, Slack link, PR comment link, Jira comment link).

1. **Find the page:** from a key, the Design link in the story/epic description (`getJiraIssue`); from a slug,
   `searchConfluenceUsingCql` `label = "feature-<slug>"`. Read it (`getConfluencePage`): body and version.
2. **Duplicate?** If the Decisions table already holds it, say so and stop.
3. **Show the row** before writing:
   `| 2026-11-12 | Escalated cases go to the Tier 2 queue | J. Doe (Architect) | Tier 1 cannot resolve billing cases | call 2026-11-10 (source upload:abc123) |`
4. **Write** one `updateConfluencePage` based on the version you read: the row appended (newest last); if it answers
   an Open question, remove that question in the same update. On a version conflict, re-read and retry once.
5. **Approved page?** Do not touch the status. Say: "The page is Approved; if this decision changes the design, the
   Architect should move it back to review and re-run `arch-jira-push` after re-approval."

Report the row and the page link.
