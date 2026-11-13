---
name: dev-review-stories
description: Developer refinement prep - reads the Jira stories of an epic and the design page, and comments on each story its buildability, an estimate and dependencies. Read-only on story fields and status. Use with an epic key (or one story key) after arch-jira-push.
---

# Developer: refinement prep (Jira comments)

Persona: **Developer**. Input: `$ARGUMENTS` = epic key (all its stories) or one story key. You comment only: never
edit a story's fields or status, never move it to Ready for Dev (the scrum team does that).

1. **Read** the stories (`searchJiraIssuesUsingJql` `parent = <EPIC> ORDER BY key`, then `getJiraIssue` each):
   Changes rows, acceptance criteria, links. Read the design page from the Design link.
2. **Check each story:**
   - **Buildable:** every acceptance criterion maps to concrete metadata or code; flag vague ones ("works correctly").
   - **Tags right:** look in `force-app/` and DEV (read-only `sf sobject describe` / `sf data query`, DEV alias) for
     anything tagged NEW that already exists, or EXISTS that does not.
   - **Story 00:** holds every shared object, field and permission set later stories use.
   - **Dependencies:** Blocks links make sense, no cycles; stories changing the same class or flow say so.
   - **Estimate:** story points; more than ~8 → suggest a split.
3. **Comment** one Jira comment per story (`addCommentToJiraIssue`): `Developer refinement note:` verdict
   (OK / CHANGES / BLOCKER), findings, estimate, dependencies.
4. **Summarise** in the chat: `story | verdict | estimate | notes`. Agreed design changes → `record-decision`.
