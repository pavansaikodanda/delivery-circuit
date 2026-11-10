---
name: qa-push-tests
description: Tester pushes designed test cases to Jira idempotently (Xray/Zephyr Test issues or "Test Case" sub-tasks, linked to their story with "Tests"), updates jira-map.json, then guides gate G2 (Testability confirmed + ai-ready). Use with a spec folder name after arch-jira-push.
---

# Tester: test cases → Jira, then G2

Persona: **Tester** (`cc-qa`). Input: `$ARGUMENTS` = `NNN-slug`.
Uses the same deterministic writer as the Architect: `${CLAUDE_PLUGIN_ROOT}/skills/arch-jira-push/scripts/jira-sync.mjs`.

## Prerequisites
- `jira-map.json` already has the epic and every story (from `arch-jira-push`). Stop otherwise.
- `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` in the shell (your own token). Never print them.
- `build.config.yml` → `jira.test_tool`: `none` (sub-task "Test Case"), `xray` or `zephyr` (issue type "Test").

## Steps
1. **Extract** every `tests/story_NN.tc.json` into `.specify/specs/NNN-slug/jira-tests-plan.json`:
   ```json
   { "project": "ABC", "feature": "001-case-escalation", "labels": ["sdd", "spec-001", "test-case"],
     "issues": [
       { "ref": "S02-TC-01", "type": "Test Case", "parent": "02",
         "summary": "[001-S02-TC-01] Agent escalates a Case with a reason",
         "description": "Level: ui\nPersona: Support Agent\nSuite: test-cases/001-case-escalation-story-02.sf-tests.yaml",
         "fields": { "Test level": "ui", "Persona": "Support Agent", "AC id": "AC-02.1" } } ] }
   ```
   - `test_tool: none`: sub-task type "Test Case" with `parent` = the story ref. No link needed.
   - `xray` / `zephyr`: `"type": "Test"`, no `parent`, and `"links": [ { "type": "Tests", "to": "02" } ]`
     ("S02-TC-01 tests 02"). Check the exact link type name in `jira-config.json` → `linkTypes` (Xray often names
     it "Test"). For Xray test steps, follow the current Xray docs (verify) or keep the steps in the description.
2. **Dry run**, then **apply** after the user confirms:
   `node .../jira-sync.mjs push --plan .specify/specs/NNN-slug/jira-tests-plan.json --config .specify/extensions/jira/jira-config.json [--apply]`
   (the map file is shared, so story refs resolve).
3. **Verify:** dry run again shows 0 creates; each story in Jira shows its test cases.
4. Commit `jira-tests-plan.json` and `jira-map.json` (spec branch, or a small `tests/NNN-slug` PR if the spec PR
   is merged).
5. **G2 for the human Tester**, per story: when its tests are linked and the story is testable, set
   "Testability confirmed", add label `ai-ready`, and move it to **Ready for Dev**. Jira only lets `testers` do that
   transition, and Rule A dispatches the AI plan only after Story 00 is Done.
