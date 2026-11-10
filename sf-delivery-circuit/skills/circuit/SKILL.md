---
name: circuit
description: Map, conventions and status of the AI + Human Salesforce delivery circuit (transcript → spec → Jira → tests → code → deploy, gates G1-G9, Architect/Developer/Tester personas). Use to find which skill and persona handles a task, to check where a feature or Jira story is in the circuit, or when another circuit skill refers to "circuit conventions".
---

# Delivery circuit: map, conventions, status

## The circuit

```
transcript ─▶ circuit-intake ─▶ spec.md + clarification ─▶ arch-design ─▶ plan.md ──[G1 Architect signs plan]
   ─▶ /speckit-sf-stories + /speckit-sf-review ─▶ dev-review-stories ─▶ qa-design-tests ─▶ spec PR merged
   ─▶ arch-jira-push ─▶ qa-push-tests ──[G2 Tester: testability + ai-ready]
   ─▶ CI claude-plan: PLAN.md + TESTPLAN.md ──[G3 Developer: plan-approved] [G4 Tester: testplan-approved]
   ─▶ CI claude-build ─▶ pr-checks + CodeRabbit + Reviewer ─▶ ai-fix-loop (max 3)
   ──[G5 Developer code review] [G6 Tester QA: qa-explore] [G7 Architect schema: arch-review-pr]
   ──[G8 Architect merges] ─▶ deploy-prod.yml (no AI) ──[G9 Architect approves production environment]
```

| Gate | Owner | Evidence | Mechanism |
|---|---|---|---|
| G1 | Architect | `plan.md` Architect Sign-Off ticked by a human | `spec-gate` check + architect review |
| G2 | Tester | Jira "Testability confirmed" + label `ai-ready` | Jira transition restricted to `testers` |
| G3 | Developer | label `plan-approved` | `persona-gates` checks team, removes it otherwise |
| G4 | Tester | label `testplan-approved` | same |
| G5 | Developer | PR approval by `developers` member | status `gate/developer` |
| G6 | Tester | PR approval by `testers` member after `qa-explore` | status `gate/tester` |
| G7 | Architect | PR approval by `architects` member after `arch-review-pr` | status `gate/architect` |
| G8 | Architect | merge (ruleset: only `architects` can merge) | ruleset |
| G9 | Architect | `production` environment approval | environment reviewers |

## Which skill for which task

| Persona (`cc-arch` / `cc-dev` / `cc-qa`) | Task | Skill |
|---|---|---|
| any | install the circuit into a repo | `circuit-bootstrap` |
| Architect | transcript to draft spec | `circuit-intake` |
| Architect | answer open questions, plan, Lucid + Confluence | `arch-design` |
| Architect | push stories to Jira | `arch-jira-push` |
| Architect | schema/design review of a PR (G7) | `arch-review-pr` |
| Developer | review stories before Jira | `dev-review-stories` |
| Developer | review AI plan (G3) | `dev-review-plan` |
| Developer | review AI code (G5) | `dev-review-pr` |
| Tester | design test cases | `qa-design-tests` |
| Tester | push test cases to Jira | `qa-push-tests` |
| Tester | review AI test plan (G4) | `qa-review-testplan` |
| Tester | run, explore and triage on QA (G6) | `qa-explore` |

Spec Kit commands (`/speckit-sf-*`) are installed per repo by `circuit-bootstrap`. `deploy`, `hotfix` and `pr` are
disabled by the circuit guard: CI opens PRs, and only `deploy-prod.yml` deploys to production.

## Conventions (all circuit skills rely on these)

| Thing | Location / format |
|---|---|
| Feature folder | `.specify/specs/NNN-slug/` (spec.md, clarification report, plan.md, data-model.md, `task_story_NN.md`) |
| Test-case index | `.specify/specs/NNN-slug/tests/story_NN.tc.json` (schema below) |
| UI test suite | `test-cases/NNN-slug-story-NN.sf-tests.yaml` (SF AI Tester format; case id = TC id) |
| Jira mapping | `.specify/specs/NNN-slug/jira-map.json` `{ "refs": { "epic": "ABC-1", "00": "ABC-2", "02": "ABC-4", "S02-TC-01": "ABC-31" } }` (written only by `jira-sync.mjs`) |
| Per-story build docs | `docs/plans/<KEY>/PLAN.md`, `TESTPLAN.md`, `verification-evidence.md` |
| Branches | `intake/<slug>`, `spec/NNN-slug`, `feature/<KEY>-<slug>` |
| TC id | `S<story>-TC-<nn>`, e.g. `S02-TC-03`. Unit tests reference it in a comment: `// TC: S02-TC-03` |
| Labels | `sdd`, `needs-clarification`, `plan-review`, `plan-approved`, `testplan-approved`, `ai-generated`, `ai-attempt-1..3`, `needs-human`, `needs-qa` |
| Org aliases | `dev` (DEV sandbox, check-only deploys), `qa` (QA sandbox). No production alias exists on any laptop. |

Test-case index schema:

```json
{
  "feature": "001-case-escalation",
  "story": "02",
  "cases": [
    { "id": "S02-TC-01", "ac": "AC-02.1", "title": "Agent escalates a Case with a reason",
      "level": "ui", "persona": "Support Agent", "type": "positive", "automated": true },
    { "id": "S02-TC-02", "ac": "AC-02.1", "title": "Escalation handler bulk-updates 201 Cases",
      "level": "unit", "persona": "System", "type": "boundary", "automated": true },
    { "id": "S02-TC-03", "ac": "AC-02.2", "title": "Read-only user cannot see Escalate",
      "level": "manual", "persona": "Read Only", "type": "negative", "automated": false }
  ]
}
```

`level`: `ui` (a case with the same id exists in the SF AI Tester suite), `unit` (an Apex or Jest test names the id),
`manual` (a step-by-step script in `task_story_NN_test_scripts.md` from `/speckit-sf-qa`).

## Status of a feature or story

When asked "where is X?", report each line as done / pending / blocked with evidence:

1. Spec folder exists; clarification report has no `OPEN` items.
2. `plan.md` sign-off ticked (G1). Check `git log -p -- <plan.md>` for who ticked it.
3. Stories exist, including `task_story_00.md`; `/speckit-sf-review` report present.
4. Each story has a `tests/story_NN.tc.json` and, if it has `ui` cases, a suite in `test-cases/`.
5. `jira-map.json` has keys for the epic, every story and every test case.
6. For a Jira key: `gh pr list --search "<KEY> in:title" --state all --json number,title,labels,isDraft,statusCheckRollup`
   and report labels (G3/G4), checks, and `gate/*` statuses (G5–G7), merge (G8) and the last `deploy-prod` run (G9).

Finish with the next gate and its owner.
