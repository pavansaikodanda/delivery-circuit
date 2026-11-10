---
name: qa-explore
description: Tester QA for gate G6 on the QA sandbox - reads the CI SF AI Tester verdict and evidence, re-runs failed/blocked cases, runs manual scripts and a short exploratory session per persona, triages each issue (defect / test problem / environment) and posts a QA report. Use with a PR number when pr-checks have finished.
---

# Tester: QA and exploration (G6)

Persona: **Tester** (`cc-qa`). Input: `$ARGUMENTS` = PR number. Org: `qa` only.

1. **CI evidence:** `gh run list --workflow pr-checks --branch <head> --limit 1`, then
   `gh run download <id> -n test-evidence -D .ai/evidence`. Read `verdict.json`, Apex results and the SF AI Tester
   `results.json` / `analysis.json` / screenshots.
2. **Re-check what didn't pass:** for each `failed` or `blocked` case, re-run that suite locally with SF AI Tester
   against `qa` (Mission Control, or `SF_ALIAS=qa sf-ai-tester run <suite> --mode manual`; verify CLI flags).
   Classify each one:
   - **defect:** the app behaves differently from an expected result → request changes on the PR with the case
     id, steps, expected vs actual and the screenshot path;
   - **test problem:** wrong label, data or permission in the case → fix the suite in a separate `tests/` PR
     (you own it), never by weakening the expectation;
   - **environment:** QA sandbox issue → note it and re-run checks.
3. **Manual cases:** walk through `task_story_NN_test_scripts.md` for this story with the Playwright MCP or by
   guiding the user, and record Pass/Fail per step.
4. **Exploratory (15–30 min):** for each persona in the story's Security & Access Matrix, try the feature outside
   the scripted paths: empty and maximum values, back/refresh, list views, mobile layout if relevant, and access
   that should be denied. Create AI-TEST records only.
5. **Report:** post a PR comment: summary, table `TC id | level | result | evidence`, exploratory notes, defects
   with repro steps, and a final line `G6 RECOMMENDATION: APPROVE` or `CHANGES`. Optionally comment the result on
   the Jira story.
6. Tell the human Tester: approve the PR in GitHub yourself if you agree (sets `gate/tester`). When the story
   is Done, promote its long-term cases (tags `smoke`/`regression`) into `test-cases/regression-<area>.sf-tests.yaml`.
