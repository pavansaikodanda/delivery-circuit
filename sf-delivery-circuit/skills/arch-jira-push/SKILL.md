---
name: arch-jira-push
description: Push an approved feature design to Jira idempotently - one Epic, Story 00 first and every story with acceptance criteria, Design page, Approved design version and "blocks" links from Story 00 - through the Atlassian CLI (acli web login) or the Atlassian MCP, never an API token. Re-running updates instead of duplicating. Use after G1 (design page Approved).
---

# Architect: approved design → Jira

Persona: **Architect** (`cc-arch`). Input: `$ARGUMENTS` = `NNN-slug` or the design page link. Conventions: `circuit`.
The AI **extracts**; the script **writes** (or emits the exact MCP calls). That keeps Jira changes deterministic.
Script: `${CLAUDE_PLUGIN_ROOT}/skills/arch-jira-push/scripts/jira-sync.mjs` (below: `jira-sync`).

## Prerequisites
- **G1:** the design page status is Approved (`getConfluenceContent`), and you know the approved version N
  (`listConfluenceContentVersions`; the version where the status became Approved, set by an `architects` member, see
  `arch-approve-design`). Stop otherwise.
- **A login:** `node jira-sync status` → `"acli": "logged-in"`, or the Atlassian MCP is connected. If neither, ask
  the person to run `acli jira auth login --web` in their own terminal or `/mcp` → atlassian. Never ask for a token.
- **Field ids (once per project):** `.specify/extensions/jira/jira-config.json` maps the circuit field names (*Design
  page*, *Approved design version*, *Acceptance criteria*, *Story type*, *Schema change*, *Persona*, *Test level*,
  *AC id*, *Testability confirmed*) to `customfield_*` ids. If missing, build it with the Atlassian MCP
  (`getJiraIssueTypeMetaWithFields` for Epic, Story and the test type in the project) as
  `{ "project": "ACME", "fields": { "Design page": { "id": "customfield_10050", "type": "string", "custom": "...:url" }, ... }, "issueTypes": [...], "linkTypes": [...] }`
  (`listJiraIssueLinkTypes`). Any field that doesn't exist must be created by a Jira admin (bootstrap) first.

## Steps
1. **Extract** the story outline from the approved page version (Technical plan + story outline + acceptance
   criteria) into `.specify/specs/NNN-slug/jira-plan.json` (gitignored):
   ```json
   { "project": "ACME", "feature": "001-shipping-rates", "labels": ["circuit", "feature-001"],
     "design": { "pageId": "123456", "url": "https://acme.atlassian.net/wiki/spaces/ACME/pages/123456", "approvedVersion": 7 },
     "issues": [
       { "ref": "epic", "type": "Epic", "summary": "[001] Shipping rates", "description": "…" },
       { "ref": "00", "type": "Story", "parent": "epic", "summary": "[001-S00] Foundation: objects, fields, permission sets",
         "description": "…", "acceptanceCriteria": "Given … When … Then …",
         "fields": { "Story type": "foundation", "Schema change": "yes" } },
       { "ref": "02", "type": "Story", "parent": "epic", "summary": "[001-S02] Agent sees the Acme Shipping rate",
         "acceptanceCriteria": "Given … When … Then …", "fields": { "Story type": "feature", "Schema change": "no" },
         "links": [ { "type": "Blocks", "from": "00" } ] } ] }
   ```
   Copy acceptance criteria verbatim (Given/When/Then). Story 00 comes first and blocks every other story. The script
   adds *Design page*, *Approved design version* (stories only; never the epic's, that is G1) and *Acceptance
   criteria*, plus a description footer with the same values.
2. **Dry run:** `node jira-sync push --plan .specify/specs/NNN-slug/jira-plan.json --config .specify/extensions/jira/jira-config.json --ops .specify/specs/NNN-slug/jira-ops.json`
   Show the create/update/link table. Backend `auto` uses acli when logged in, else MCP.
3. **Apply** after the user confirms:
   - **acli:** same command plus `--apply`. Then run the MCP ops in `jira-ops.json` (`editJiraIssue` for the circuit
     custom fields, which acli has no documented flag for).
   - **MCP:** run the lookup it asks for (`searchJiraIssuesUsingJql` with the printed JQL, save the result as JSON),
     `node jira-sync resolve --plan … --search-result <file>`, re-run step 2, then run each op in order; after each
     `createJiraIssue` or `editJiraIssue`, `node jira-sync record --plan … --ref <ref> --key <KEY>`. Skip a link op if
     `getJiraIssue` already shows it.
4. **Verify:** re-run the dry run: 0 creates, only "unchanged" (or updates you expect). Open the epic in Jira and
   check Story 00 blocks the others and each story shows *Approved design version* N.
5. **Report** the epic and story keys (no repo files to commit: Jira is the record; the local map is a cache).
   Next: the human Architect runs the epic's **Approve design** transition if not done (G1, version N); Developers run
   `dev-review-stories <EPIC>`; the Tester runs `qa-design-tests <KEY>` per story.

Re-running after a re-approval stamps the new version on every story; stories already started then need re-planning.
