---
name: qa-design-tests
description: Tester designs test cases for every story of a spec-kit-sf feature before the build - a test-case index per story (ui/unit/manual levels, personas, positive/negative/boundary), SF AI Tester YAML suites for UI cases grounded in the QA org, and manual scripts - all validated. Use with a spec folder name after stories are reviewed.
---

# Tester: design test cases (before the build)

Persona: **Tester** (`cc-qa`). Input: `$ARGUMENTS` = `NNN-slug`. Conventions and the `tc.json` schema: `circuit` skill.
For UI suites, follow the **`sf-ai-tester-suites`** skill exactly (it is installed in the repo by bootstrap).

## Steps
1. **Read** every `task_story_NN.md` (acceptance criteria, Security & Access Matrix, implementation layers), plus
   `spec.md`, `plan.md` and `data-model.md`. Design from these, never from code.
2. **Ground in the org:** run the `sf-ai-tester-suites` snapshot against `qa` for every object the stories touch
   (labels, required fields, picklists, validation rules and messages, list views). New fields from Story 00 won't
   exist yet: take their labels from `data-model.md` and list them as assumptions.
3. **Plan coverage per story** (show a table before writing):
   - each acceptance criterion gets at least one case;
   - each persona in the Security & Access Matrix gets a positive or a negative case;
   - plus required fields, each validation rule, bulk/boundary (unit level, 201 records), automation side effects;
   - choose the level: `ui` for user-visible behaviour, `unit` for logic and bulk, `manual` only when neither
     works (e.g. emails, external systems). Mark `automated: true` for `ui` and `unit`.
4. **Write** for each story NN:
   - `.specify/specs/NNN-slug/tests/story_NN.tc.json`, ids `SNN-TC-01`…;
   - `test-cases/NNN-slug-story-NN.sf-tests.yaml` with one case per `ui` TC, **case id = TC id**, `section` =
     story title, tags `story-NN` plus `smoke`/`regression` where they belong long term;
   - for `manual` cases, run `/speckit-sf-qa` in script-only mode for that story or write
     `task_story_NN_test_scripts.md` (Step | Action | Expected | Pass/Fail).
   Story 00 normally gets only `unit` cases (deploys, FLS on new fields, trigger shells).
5. **Validate:**
   - `python .claude/skills/sf-ai-tester-suites/scripts/validate_suite.py test-cases/NNN-slug-story-NN.sf-tests.yaml`
     for every suite; fix all errors and justify warnings;
   - `node scripts/ci/check-tc-coverage.mjs --design-only .specify/specs/NNN-slug` (checks that every `ui` TC
     has a suite case and that ids are unique and well-formed).
6. **Commit** on the spec branch and comment on the spec PR with the coverage table
   (criterion → TC ids → level) and assumptions. Next: Architect merges the spec PR and runs `arch-jira-push`,
   then you run `qa-push-tests`.

Never write under `force-app/`. Never weaken an expected result later to make a run pass.
