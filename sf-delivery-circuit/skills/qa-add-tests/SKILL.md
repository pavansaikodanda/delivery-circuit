---
name: qa-add-tests
description: Tester commits the runnable tests of a story to the Developer's draft PR - tests/<KEY>.tc.json (with Jira test case keys) and test-cases/<KEY>.sf-tests.yaml - after validating them, committing only tests/ and test-cases/ on the story branch. Also used to correct a test problem found later. Use with a story key ("Add tests to ACME-12") once the Developer has opened the draft PR.
---

# Tester: add tests to the story PR

Persona: **Tester** (`cc-qa`; extension queue item "Add tests to <KEY>"). Input: `$ARGUMENTS` = story key.
You add commits to the Developer's PR; you never open a PR. The guard refuses any commit on a story branch that
holds files outside `tests/` and `test-cases/`.

## Steps
1. **PR:** `gh pr list --search "<KEY> in:title" --state open --json number,headRefName,isDraft,url`. No PR yet →
   stop: "Waiting for the Developer to start <KEY> (dev-start-story)".
2. **Sources:** the local drafts from `qa-design-tests` (`.specify/specs/NNN-slug/tests/<KEY>.tc.json` and
   `<KEY>.sf-tests.yaml`, with Jira keys from `qa-push-tests`). If they are missing (other machine), rebuild them from
   the Jira test cases linked to the story (`story_get` / `searchJiraIssuesUsingJql`), then validate as below.
3. **Check out** the branch: `git fetch origin` and `gh pr checkout <n>`; `git status` must be clean.
4. **Place** the files: `tests/<KEY>.tc.json`, `test-cases/<KEY>.sf-tests.yaml`. Each case has `jira` set; ids are
   `<KEY>-TC-nn`; `designVersion` equals the story's *Approved design version*.
5. **Validate:**
   - `python .claude/skills/sf-ai-tester-suites/scripts/validate_suite.py test-cases/<KEY>.sf-tests.yaml`
   - `node scripts/ci/check-tc-coverage.mjs --key <KEY> --design`
   Fix every error in your files (never by weakening an expected result).
6. **Commit only tests:** `git add tests/<KEY>.tc.json test-cases/<KEY>.sf-tests.yaml`; `git status --porcelain` must
   show nothing else staged; `git commit -m "<KEY> tests: test-case index and SF AI Tester suite"`;
   `git push` (the story branch, never `main`, never `--force`).
7. **Comment** on the PR: case count by level, the Jira test case keys, "TESTPLAN.md must list every TC id"
   (`gh pr comment <n> --body-file …`).

**Correcting a test problem later** (from `qa-explore` or a `needs-qa` label): same steps; change only the affected
cases, say why in the commit message and PR comment, and never weaken an expected result. If the design changed
the expectation, the Architect records a decision first (`record-decision`).

Next: human Tester reviews TESTPLAN.md (`qa-review-testplan`) and adds `testplan-approved` (G4).
