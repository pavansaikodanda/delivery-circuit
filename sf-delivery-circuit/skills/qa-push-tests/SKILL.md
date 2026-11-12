---
name: qa-push-tests
description: Tester pushes the designed test cases of a story to Jira idempotently (Test Case sub-tasks, or Xray/Zephyr Test issues linked "Tests") through the Atlassian CLI or MCP with no API token, records their keys in the local tc index, then guides the human Tester through gate G2 (Testability confirmed + ai-ready). Use with a story key after qa-design-tests.
---

# Tester: test cases → Jira, then G2

Persona: **Tester** (`cc-qa`). Input: `$ARGUMENTS` = story key (or epic key → each story).
Writer: `${CLAUDE_PLUGIN_ROOT}/skills/arch-jira-push/scripts/jira-sync.mjs` (below: `jira-sync`), same rules as
`arch-jira-push`: AI extracts, the script writes or emits the MCP calls; dry run first; re-running never duplicates.

## Prerequisites
- The story exists in Jira and the local draft `.specify/specs/NNN-slug/tests/<KEY>.tc.json` exists
  (`qa-design-tests`). Stop otherwise.
- A login: `node jira-sync status` (acli) or the Atlassian MCP. Never ask for a token.
- `build.config.yml` → `jira.test_tool`: `none` (sub-task "Test Case"), `xray` or `zephyr` (issue type "Test").
- `.specify/extensions/jira/jira-config.json` with the *Test level*, *Persona*, *AC id* field ids (see `arch-jira-push`).

## Steps
1. **Extract** the tc index into `.specify/specs/NNN-slug/jira-tests-<KEY>.json`. Name the story by its Jira key in
   `parent` / `links` (the script accepts a key wherever a ref is expected):
   ```json
   { "project": "ACME", "feature": "001-shipping-rates", "labels": ["circuit", "feature-001", "test-case"],
     "issues": [
       { "ref": "ACME-12-TC-01", "type": "Test Case", "parent": "ACME-12",
         "summary": "[001-ACME-12-TC-01] Agent sees the Acme Shipping rate on an Order",
         "description": "Level: ui\nPersona: Support Agent\nSuite: test-cases/ACME-12.sf-tests.yaml\nSteps: …",
         "fields": { "Test level": "ui", "Persona": "Support Agent", "AC id": "AC-1" } } ] }
   ```
   - `test_tool: none`: `"type": "Test Case"` with `parent` = the story key.
   - `xray` / `zephyr`: `"type": "Test"`, no `parent`, `"links": [ { "type": "Tests", "to": "ACME-12" } ]` ("TC tests
     story"). Check the exact link type name with `listJiraIssueLinkTypes` (Xray often names it "Test").
2. **Dry run**, then **apply** after the user confirms (acli: `--apply`, then the MCP field ops; MCP: lookup → resolve
   → ops → record), exactly as in `arch-jira-push`:
   `node jira-sync push --plan <file> --config .specify/extensions/jira/jira-config.json --ops <ops> [--apply]`
3. **Verify:** dry run again shows 0 creates; the story in Jira shows its test cases.
4. **Keys into the tc index:** set `"jira": "<test case key>"` on each case of the local `<KEY>.tc.json` (from the map).
5. **G2 for the human Tester:** when the test cases are linked and the story is testable, they set *Testability
   confirmed*, add label `ai-ready`, and move the story to **Ready for Dev** themselves (Jira lets only testers do
   that transition). The AI cannot: the guard blocks `ai-ready` writes.

Next: Developer starts the story (`dev-start-story <KEY>`), then you add the tests to the PR (`qa-add-tests <KEY>`).
