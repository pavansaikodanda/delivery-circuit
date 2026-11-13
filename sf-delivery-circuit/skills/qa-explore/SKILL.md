---
name: qa-explore
description: QA exploratory run of a merged story in the QA sandbox - runs the story's SF AI Tester suite and manual test cases, explores per persona outside the scripted paths, classifies issues, and posts the results as a Jira comment on the story. Never moves the story. Use with a story key once the story is merged into the sprint branch and deployed to QA.
---

# QA: explore in the QA sandbox

Persona: **Tester (QA)**. Input: `$ARGUMENTS` = story key. Org: the QA alias only (`build.config.yml` →
`salesforce.qa_alias`, default `qa`). No deploys; records you create start with `AI-TEST`.

1. **Deployed?** The story's PR is merged (`gh pr list --search "<KEY> in:title" --state merged --json number,mergedAt,baseRefName`)
   and the latest `deploy.yml` run for that sprint branch after the merge succeeded
   (`gh run list --workflow deploy.yml --branch sprint/<name> --limit 1`). Otherwise stop and say what is missing.
2. **Suite:** run `test-cases/<KEY>.sf-tests.yaml` with SF AI Tester against the QA alias (Mission Control in VS Code,
   or the SF AI Tester CLI). Record each case: passed / failed / blocked, with evidence path.
3. **Manual cases:** walk the steps of each `manual` Jira test case with the user; Pass/Fail per step.
4. **Explore (15-30 min):** for each persona, try the feature off the scripted paths: empty and maximum values,
   bulk edits, list views, back/refresh, access that should be denied.
5. **Classify** each issue: **defect** (app differs from an acceptance criterion: steps, expected vs actual,
   screenshot) / **test problem** (fix with `qa-add-tests`) / **environment** (QA sandbox issue: tell a lead).
6. **Report** as one Jira comment on the story (`addCommentToJiraIssue`): summary, `TC id | result | evidence`,
   exploratory notes, defects with repro steps. Then tell the human QA: "Move <KEY> to Done or back to the Developer
   in Jira." Never change the status yourself.
