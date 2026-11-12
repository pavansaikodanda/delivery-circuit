---
name: arch-review-pr
description: Architect schema and design review of a story PR (gate G7) - checks every metadata change against the Confluence design page at the story's approved version (data model, security model, decisions, org snapshot), the Story 00 contract and deployment risk, and posts findings for the human Architect. Use with a PR number or story key.
---

# Architect: schema and design review (G7)

Persona: **Architect** (`cc-arch`). Input: `$ARGUMENTS` = PR number or Jira key. You review and comment; you never
approve, merge or create PRs.

1. **PR:** `gh pr view <n> --json title,headRefName,labels,files,body,statusCheckRollup` and `gh pr diff <n>`.
   The key is in the branch (`feature/<KEY>-…`) and title.
2. **Story and design:** the story (`story_get` or `getJiraIssue`): acceptance criteria, *Story type*, *Approved
   design version* N, *Design page*. The design at version N (`design_get`, or `getConfluenceContentVersion` for
   version N), its Decisions (`decisions_get`) and the Org snapshot child page (`org_snapshot_get`).
   If `design-gate` failed (C5), stop: the story must be re-planned or the design re-approved first.
3. **Check every changed file under `force-app/`:**
   - **Objects, fields, record types, permission sets:** each is in the Data model at version N, or in Story 00 when
     it is foundation metadata. Types, lengths, required flags and FLS match.
   - **Security model:** sharing, permission set assignments, FLS on new fields, no profile edits unless designed.
   - **Story 00 contract:** non-foundation stories don't add schema; if they do, that is a BLOCKER.
   - **Automation order:** no second trigger on an object; flows vs triggers as the design decided; nothing the
     org snapshot shows would be duplicated.
   - **Decisions:** nothing contradicts a recorded decision.
   - **Destructive changes:** listed in the PR body.
4. **Post** the review as a PR comment (not an approval):
   `gh pr review <n> --comment --body-file <file>` with a findings table (BLOCKER / MAJOR / MINOR, file, issue, fix),
   the design version reviewed, and a final line `G7 RECOMMENDATION: APPROVE` or `G7 RECOMMENDATION: CHANGES`.
5. Tell the human Architect: approve the PR in GitHub yourself if you agree (sets `gate/architect`); G8 (merge, after
   G5–G7 and green checks) and G9 (production environment approval) are also yours.
