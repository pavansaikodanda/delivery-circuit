---
name: arch-jira-push
description: Turn an Approved Confluence design page into a Jira epic and stories through the Atlassian MCP - each story carries the design link, its change-table rows and Given/When/Then acceptance criteria, labels circuit and feature-<slug>; Story 00 (shared data model) blocks the rest. Idempotent - re-running updates instead of duplicating. Use after the Architect set the page to Approved.
---

# Architect: approved design → Jira

Persona: **Architect**. Input: `$ARGUMENTS` = `<slug>` or the design page link. Story layout: `circuit` skill.
All writes go through the Atlassian MCP. Never set a story to Ready for Dev or Done.

1. **Approved?** Read the page (`getConfluencePage`) and its status. Not *Approved* → stop: "The Architect sets the
   page to Approved in Confluence first."
2. **Project:** `build.config.yml` → `jira.project_key`. Read the Story outline and Change table from the page.
3. **Find what exists** (idempotency): `searchJiraIssuesUsingJql`
   `project = <KEY> AND labels = "feature-<slug>" ORDER BY created ASC`. Match existing issues by summary.
4. **Plan** and show it as a table before writing: `action (create / update / unchanged) | type | summary | change rows | ACs`.
   - Epic `<Feature name>`, description = design page link, labels `circuit`, `feature-<slug>`.
   - Story 00 `<Feature name>: S00 Data model` (all shared objects, fields, permission sets), then
     `<Feature name>: S01 ...` per outline line.
   - Each story description: **Design** (page link), **Changes** (its rows `Component | Type | Tag | Notes`),
     **Acceptance criteria** (`AC1: Given ... When ... Then ...`, copied from the page). Labels `circuit`,
     `feature-<slug>`. Parent = the epic.
5. **Apply** after the user confirms: `createJiraIssue` for new ones, `editJiraIssue` for changed ones (keep labels
   people added), then a "Blocks" link from Story 00 to every other story (`createIssueLink`; skip if `getJiraIssue`
   already shows it). Leave status as created.
6. **Verify:** re-run step 3; every outline line has exactly one story; no duplicates.
7. **Report:** epic and story keys with links. Next: refinement (Developers can run `dev-review-stories <EPIC>`);
   the scrum team moves stories to Ready for Dev; QA runs `qa-design-tests <KEY>`.

Re-running after the design changed updates descriptions in place; tell the user which stories changed.
