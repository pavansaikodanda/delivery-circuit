---
name: dev-review-stories
description: Developer reviews the Jira stories of an epic before they are built - buildability, Story 00 completeness, dependencies, estimates, reuse and test hooks - and posts findings as Jira comments. Read-only on the stories and the design. Use with an epic key (or a story key) after arch-jira-push.
---

# Developer: review stories (Jira comments)

Persona: **Developer** (`cc-dev`). Input: `$ARGUMENTS` = epic key (all its stories) or one story key.
You comment; you never edit stories or the design (the Architect applies agreed changes).

1. **Read** the stories: `searchJiraIssuesUsingJql` (or `acli jira workitem search --jql "parent = <EPIC>" --json`)
   and each story (`story_get` / `getJiraIssue`): summary, acceptance criteria, *Story type*, *Schema change*, links,
   *Approved design version*. Read the design page at that version (`design_get`) and the Org snapshot.
2. **Check each story and record:**
   1. **Buildable:** every acceptance criterion maps to concrete metadata or code. Flag vague criteria ("works
      correctly", "is fast").
   2. **Story 00:** contains every object, field, permission set, trigger shell, test data factory and shared selector
      later stories use. Anything missing is a BLOCKER (it breaks parallel work).
   3. **Dependencies:** "blocks" links have no cycles; two stories don't change the same class or flow in parallel
      without saying so.
   4. **Reuse:** check `force-app/` and `dev` (`sf data query`, `sf sobject describe --target-org dev`) for existing
      classes, flows and fields the story re-creates.
   5. **Size:** more than about 2 days or 8 points should be split. Give a points estimate.
   6. **Testability hooks:** unit-testable seams (handler/service/selector) and stated test data needs.
3. **Post** one Jira comment per story (`addOrEditJiraIssueComment`, or
   `acli jira workitem comment create --key <KEY> --body-file <file>`), starting `Developer story review:` with
   verdict (OK / CHANGES / BLOCKER), findings and estimate. Then add the label `dev-reviewed` to each story you
   reviewed (`acli jira workitem edit --key <KEY> --labels dev-reviewed --yes`, or `editJiraIssue` adding that label)
   so the Developer queue drops the review item. Change no other field, label or status.
4. **Summarise** in the chat: `story | verdict | findings | estimate`. Decisions agreed with the Architect go to
   `record-decision`.

Next owners: Architect (apply changes, re-run `arch-jira-push`), Tester (`qa-design-tests <KEY>`).
