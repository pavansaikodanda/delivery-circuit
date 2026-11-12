---
name: qa-design-tests
description: Tester designs test cases for a Jira story before the build - one or more per acceptance criterion and per persona (ui/unit/manual levels, positive/negative/boundary), grounded in the QA org - and drafts the runnable SF AI Tester suite and tc index locally, validated. Use with a story key (or an epic key for all its stories) after arch-jira-push.
---

# Tester: design test cases (before the build)

Persona: **Tester** (`cc-qa`). Input: `$ARGUMENTS` = story key (or epic key → each story). Conventions and the
`tc.json` schema: `circuit` skill. For UI suites follow the **`sf-ai-tester-suites`** skill exactly.

## Steps
1. **Read** the story (`story_get` / `getJiraIssue`): acceptance criteria, access matrix, *Approved design version*;
   the design page at that version (`design_get`): data model, security model, decisions; and the Org snapshot.
   Design from these, never from code.
2. **Ground in the org:** run the `sf-ai-tester-suites` snapshot against `qa` for every object the story touches
   (labels, required fields, picklists, validation rules and messages, list views). Fields that Story 00 adds won't
   exist yet: take their labels from the Data model and list them as assumptions.
3. **Plan coverage** (show a table before writing):
   - each acceptance criterion gets at least one case; each persona in the access matrix a positive or negative case;
   - plus required fields, each validation rule, bulk/boundary (unit level, 201 records), automation side effects;
   - level: `ui` for user-visible behaviour, `unit` for logic and bulk, `manual` only when neither works (emails,
     external systems). `automated: true` for `ui` and `unit`. Story 00 normally gets only `unit` cases.
4. **Draft locally** (gitignored; committed later by `qa-add-tests`), under `.specify/specs/NNN-slug/tests/`:
   - `<KEY>.tc.json`: ids `<KEY>-TC-01`…, `ac` = criterion id, `designVersion` = the story's approved version;
   - `<KEY>.sf-tests.yaml`: one case per `ui` TC, **case id = TC id**, `section` = story summary, tags `<KEY>` plus
     `smoke`/`regression` where they belong long term;
   - manual cases: numbered steps (Step | Action | Expected) for the Jira test case description.
5. **Validate:**
   - `python .claude/skills/sf-ai-tester-suites/scripts/validate_suite.py <suite>`; fix all errors, justify warnings;
   - copy both files to a scratch checkout layout (`tests/`, `test-cases/`) or pass paths and run
     `node scripts/ci/check-tc-coverage.mjs --key <KEY> --design` (ids unique and well-formed, every `ui` TC has a
     suite case and vice versa).
6. **Report** the coverage table (criterion → TC ids → level) and assumptions. Next: `qa-push-tests <KEY>` (Jira),
   then the human Tester decides G2.

Never write under `force-app/`. Never weaken an expected result later to make a run pass.
