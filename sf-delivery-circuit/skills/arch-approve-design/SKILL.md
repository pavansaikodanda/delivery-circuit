---
name: arch-approve-design
description: Gate G1 - step-by-step instructions for the human Architect to approve a Confluence design page (status Approved, version recorded on the Jira epic), and a read-only check afterwards that the approval was made by an architects member at the expected version. The AI never approves. Use when a design is "Ready for review" or someone asks "approve the design".
---

# Architect: approve the design (G1, human)

Persona: **Architect**. Input: `$ARGUMENTS` = `NNN-slug`, the design page link, or the epic key.
**You cannot approve.** The guard blocks `setConfluenceContentStatus` to Approved and edits of `ai-ready`; Confluence
has no per-group control of page status, so the circuit verifies the approver from page history and Jira.

## 1. Tell the human Architect exactly what to do
> 1. Open the design page (the extension's **Approve design** action opens it). Read the Requirements, Decisions,
>    Technical plan, Data model, Security model, Org snapshot and the Lucid diagram. No open questions may remain.
> 2. Set the page status to **Approved** (status menu at the top of the page). If "Approved" is not offered, a space
>    admin adds it as a suggested status (Space settings → Content status). Do this yourself, as a member of the
>    `architects` group.
> 3. Open **Page history** and note the version number now shown as current. That is the approved version. If you
>    publish anything while approving (for example a last wording fix), use the change message `Approved v<N>`:
>    the extension reads the approved version from that message (otherwise from the current version).
> 4. In Jira, on the feature's epic, run the **Approve design** transition (only `architects` can) and enter that
>    number in *Approved design version*. If the epic doesn't exist yet, run `arch-jira-push NNN-slug` first: it
>    creates the epic without that field, then do this step.
> 5. Recommended once per space: restrict edit of approved design pages to the `architects` group (page
>    restrictions). That is the only native lever that stops others from changing an approved page.

## 2. Verify (read-only, after the human says it is done)
1. `getConfluenceContent` → status is Approved. `listConfluenceContentVersions` → current version number and the
   author of the version where the status became Approved.
2. The author must be an `architects` member: map the Atlassian account to a person in `build.config.yml` →
   `people.architects[].atlassian` (use `lookupJiraAccountId` for the email), or ask the Architect to confirm, and
   check `gh api orgs/<org>/teams/architects/members --jq '.[].login'` for their GitHub login.
3. Epic (`getJiraIssue` or `acli jira workitem view <EPIC> --json --fields '*all'`): *Approved design version*
   equals the page version from step 1.
4. Stories already in Jira with an older *Approved design version* now fail `design-gate` (C5): list them and say
   "Design changed since this story was planned: re-plan or re-approve". Their Developers re-run
   `dev-start-story <KEY>`; the Architect re-runs `arch-jira-push` to stamp the new version.

Report: `G1: APPROVED at version N by <person>` or what is missing. Next: Architect runs `arch-jira-push NNN-slug`
(or, if stories exist, the re-plan list above).
