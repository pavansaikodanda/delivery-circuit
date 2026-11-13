---
name: qa-add-tests
description: QA turns a story's Jira test cases into the SF AI Tester suite test-cases/<KEY>.sf-tests.yaml, validates it, and opens a PR from feature/<KEY>-tests into the current sprint branch with auto-merge on. Also used to correct a suite later. Use with a story key once qa-design-tests has created the Jira test cases.
---

# QA: SF AI Tester suite → PR into the sprint branch

Persona: **Tester (QA)**. Input: `$ARGUMENTS` = story key. Suite format: follow the **`sf-ai-tester-suites`** skill
exactly. QA alias: `build.config.yml` → `salesforce.qa_alias` (default `qa`).

1. **Read** the story and its test cases (`searchJiraIssuesUsingJql` `issue in linkedIssues(<KEY>) AND labels = "circuit-test"`).
   None → stop: "Run `qa-design-tests <KEY>` first."
2. **Branch:** current sprint branch = newest remote `sprint/*`
   (`git fetch origin && git for-each-ref --sort=-committerdate --format='%(refname:lstrip=3)' 'refs/remotes/origin/sprint/*' | head -1`).
   `git switch -c feature/<KEY>-tests origin/sprint/<name>` (or switch to it if it exists and `git pull`).
3. **Write** `test-cases/<KEY>.sf-tests.yaml`: one case per `ui` test case, case id = `<KEY>-TC-<nn>`, `section` =
   story summary, tags `<KEY>` plus `smoke`/`regression` where they belong long term. Ground labels in the QA org
   (the skill's `org_snapshot.py --alias <qa>`).
4. **Validate:** `python .claude/skills/sf-ai-tester-suites/scripts/validate_suite.py test-cases/<KEY>.sf-tests.yaml`.
   Fix every error in the suite, never by weakening an expected result.
5. **Commit and PR:** `git add test-cases/<KEY>.sf-tests.yaml`, commit `<KEY> tests: SF AI Tester suite`,
   `git push -u origin feature/<KEY>-tests`, then
   `gh pr create --base sprint/<name> --head feature/<KEY>-tests --title "<KEY> tests" --body "<Jira link>; cases: <ids>"`
   and `gh pr merge <n> --auto --squash`.
6. **Report:** PR link and case count. Comment the PR link on the story (`addCommentToJiraIssue`).

**Correcting a suite later:** same steps on a new `feature/<KEY>-tests-<n>` branch; change only the affected cases
and say why. If the expected behaviour itself changed, the Architect records a decision first.
