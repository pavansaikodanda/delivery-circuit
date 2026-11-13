---
name: qa-design-tests
description: QA designs test cases for a Jira story from its acceptance criteria - at least one per criterion plus negative, permission and bulk cases, grounded in the org - and creates them in Jira linked to the story. Use with a story key (or an epic key for all its stories) after arch-jira-push.
---

# QA: test cases in Jira

Persona: **Tester (QA)**. Input: `$ARGUMENTS` = story key, or epic key → each story. Design from the story and the
design page, never from code.

1. **Read** the story (`getJiraIssue`): Changes rows, acceptance criteria, Design link; the design page's Data model,
   Security and Decisions. Existing test cases: `searchJiraIssuesUsingJql` `issue in linkedIssues(<KEY>) AND labels = "circuit-test"`.
2. **Ground in the org:** read-only `sf sobject describe` / `sf data query` on the QA alias
   (`build.config.yml` → `salesforce.qa_alias`, default `qa`) for labels, picklists, required fields and validation
   messages. Components tagged NEW are not there yet: take them from the Data model and mark them as assumptions.
3. **Plan coverage** and show it before writing: `TC id | AC | title | type (positive/negative/boundary/permission) | level (ui/unit/manual)`.
   Every AC gets at least one case; each persona with access gets a positive or negative case; add required fields,
   validation rules, bulk (201 records, unit level) and automation side effects.
4. **Create** after the user confirms, skipping ones that already exist (same summary): one Jira issue per case
   (`build.config.yml` → `jira.test_issue_type`, default `Task`) with summary `<KEY>-TC-<nn> <title>`, description
   `Given / When / Then` plus numbered steps (Step | Action | Expected), labels `circuit`, `circuit-test`,
   `feature-<slug>`, and a "Tests" (or "Relates") link to the story.
5. **Report** the coverage table with Jira keys and the assumptions. Next: `qa-add-tests <KEY>` for the `ui` cases.

Never weaken an expected result later to make a run pass.
