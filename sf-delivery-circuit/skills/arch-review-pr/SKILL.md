---
name: arch-review-pr
description: Architect schema and design review of a PR (gate G7) - checks every metadata change against the approved plan.md and data-model.md, security model, Story 00 contract and deployment risk, and posts findings for the human Architect. Use with a PR number.
---

# Architect: schema and design review (G7)

Persona: **Architect** (`cc-arch`). Input: `$ARGUMENTS` = PR number.

1. `gh pr view $ARGUMENTS --json title,headRefName,labels,files,body` and `gh pr diff $ARGUMENTS`.
   Find the Jira key in the branch name and the story file through `.specify/specs/*/jira-map.json`.
2. Read the story file, `plan.md`, `data-model.md` and the constitution.
3. Check every changed file under `force-app/`:
   - **Objects, fields, record types, permission sets:** each must be in `data-model.md` / `plan.md`, or in
     Story 00 when it is foundation metadata. Field types, lengths, required flags and FLS match the plan.
   - **Security model:** sharing, permission set assignments, FLS on new fields, and no profile edits unless the
     plan says so.
   - **Story 00 contract:** non-foundation stories don't add schema; if they do, that is a BLOCKER.
   - **Automation order:** no second trigger on an object; flows vs triggers as the plan decided.
   - **Destructive changes:** listed in the PR body.
4. Post the review as a PR comment (not an approval):
   `gh pr review $ARGUMENTS --comment --body-file <file>` with a findings table (BLOCKER / MAJOR / MINOR,
   file, issue, fix) and a final line `G7 RECOMMENDATION: APPROVE` or `G7 RECOMMENDATION: CHANGES`.
5. Tell the human Architect: approve the PR in GitHub yourself if you agree (that sets `gate/architect`), and
   remember G8 (merge) and G9 (production approval) are also yours.
