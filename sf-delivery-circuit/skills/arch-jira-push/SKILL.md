---
name: arch-jira-push
description: Push a reviewed spec-kit-sf feature to Jira idempotently - one Epic, Story 00 and every story with acceptance criteria, Spec file field and "blocks" links from Story 00 - and write jira-map.json. Re-running updates instead of duplicating. Use after the spec PR has its stories reviewed (dev-review-stories done).
---

# Architect: stories → Jira

Persona: **Architect** (`cc-arch`). Input: `$ARGUMENTS` = `NNN-slug`. Conventions: `circuit` skill.

The AI **extracts**; the script **writes**. That keeps Jira changes deterministic and repeatable.

## Prerequisites
- `plan.md` sign-off ticked (G1). Stop otherwise.
- `.specify/extensions/jira/jira-config.json` exists (field ids). If not, run step 0.
- Jira credentials in the shell: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (the person's own token on a
  laptop). Never print them. If they are missing, tell the user to export them in their terminal.

## Steps
0. **Discover fields (once per project):**
   `node ${CLAUDE_PLUGIN_ROOT}/skills/arch-jira-push/scripts/jira-sync.mjs discover --project <KEY> --out .specify/extensions/jira/jira-config.json`
   It maps the circuit field names (Spec file, Feature, Story type, Schema change, Persona, Test level, AC id,
   Testability confirmed, Acceptance criteria) to `customfield_*` ids. Show the result; any `null` must be created in
   Jira first (bootstrap B5).
1. **Extract** every `task_story_NN.md` into `.specify/specs/NNN-slug/jira-plan.json` (schema below). Copy the
   acceptance criteria verbatim (Given/When/Then). `Story type` = `foundation` for 00, else `feature`.
   `Schema change` = yes if the story adds or changes objects, fields or permission sets.
2. **Dry run:** `node .../jira-sync.mjs push --plan .specify/specs/NNN-slug/jira-plan.json --config .specify/extensions/jira/jira-config.json`
   Show the table of create/update/link actions.
3. **Apply** after the user confirms: same command plus `--apply`. The script writes `jira-map.json`.
4. **Verify:** re-run the dry run. It must report 0 creates (only "unchanged" or updates).
5. Commit `jira-plan.json` and `jira-map.json` on the spec branch. Next: Tester runs `qa-push-tests NNN-slug`.

## `jira-plan.json` schema
```json
{
  "project": "ABC",
  "feature": "001-case-escalation",
  "labels": ["sdd", "spec-001"],
  "issues": [
    { "ref": "epic", "type": "Epic", "summary": "[001] Case escalation", "description": "…" },
    { "ref": "00", "type": "Story", "parent": "epic", "summary": "[001-S00] Foundation: objects, fields, permission sets",
      "description": "…", "fields": { "Spec file": ".specify/specs/001-case-escalation/task_story_00.md",
      "Feature": "001-case-escalation", "Story type": "foundation", "Schema change": "yes",
      "Acceptance criteria": "Given … When … Then …" } },
    { "ref": "02", "type": "Story", "parent": "epic", "summary": "[001-S02] Agent escalates a Case",
      "fields": { "…": "…" }, "links": [ { "type": "Blocks", "from": "00" } ] }
  ]
}
```
The bracketed prefix in `summary` (`[001-S02]`) is the idempotency key: the script finds existing issues by it.
