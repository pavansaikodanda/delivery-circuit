---
name: circuit
description: Map, conventions and status of the AI + Human Salesforce delivery circuit v3 (source → Confluence design page → Jira epic/stories/test cases → Developer-started draft PR → checks → Slack review room → gates G1-G9 → release), with Architect/Developer/Tester personas. Use to find which skill and persona handles a task, to check where a feature or Jira story is, or when another circuit skill refers to "circuit conventions".
---

# Delivery circuit v3: map, conventions, status

Contract: `docs/CIRCUIT-V3.md` in the circuit repo. Principles: connections are logins (no stored credentials); the
repo holds code and tests only (design in Confluence, work in Jira); people keep creative control (AI drafts, people
decide; Architects never create PRs; Developers start stories and own their PRs); only the org the project names as
production is off limits; everything shared is written down in Confluence, Jira, the PR or Slack.

## The flow

```
source (paste / file / Fireflies / Wispr Flow, in the extension) ─▶ circuit-intake ─▶ Confluence design page
  ─▶ arch-design (+ record-decision) ─▶ [G1 an architect sets the page Approved; epic gets Approved design version]
  ─▶ arch-jira-push (epic, Story 00 first, stories with Approved design version) ─▶ dev-review-stories (Jira comments)
  ─▶ qa-design-tests ─▶ qa-push-tests ─▶ [G2 Tester: Testability confirmed + ai-ready]
  ─▶ dev-start-story: PLAN.md + TESTPLAN.md, branch feature/<KEY>-<slug>, DRAFT PR "<KEY> …"
  ─▶ qa-add-tests: tests/<KEY>.tc.json + test-cases/<KEY>.sf-tests.yaml committed to the PR by the Tester
  ─▶ [G3 Developer: plan-approved] [G4 Tester: testplan-approved] ─▶ build (dev-start-story build)
  ─▶ checks: GitHub-hosted (guard, lint, Jest, TC coverage, design-gate) + self-hosted runner (QA deploy, Apex,
     SF AI Tester, AI Reviewer, Code Analyzer) ─▶ dev-fix (max 3 AI attempts, then needs-human; UI blocks → needs-qa)
  ─▶ review-room open (Slack #review-room: CodeRabbit + Claude Tag) ─▶ review-room verdict (PR comment)
  ─▶ [G5 dev-review-pr] [G6 qa-explore] [G7 arch-review-pr] ─▶ [G8 architects merge] ─▶ deploy-prod (no AI) [G9]
```

| Gate | Owner | Source of truth | Mechanism |
|---|---|---|---|
| G1 | Architect | design page status Approved by an `architects` member + version on the epic | `design-gate` check (C5) |
| G2 | Tester | Jira *Testability confirmed* + label `ai-ready` | Jira transition restricted to testers |
| G3 | Developer | PR label `plan-approved` added by a `developers` member | `persona-gates` |
| G4 | Tester | PR label `testplan-approved` added by a `testers` member | `persona-gates` |
| G5 / G6 / G7 | Developer / Tester / Architect | approving reviews → statuses `gate/developer`, `gate/tester`, `gate/architect` | `persona-gates` |
| G8 | Architect | merge | ruleset: architects only |
| G9 | Architect | `production` environment approval | environment reviewers |

**C5 (re-sign on change):** if the epic's approved version is newer than the story's *Approved design version*, the
check fails with "Design changed since this story was planned: re-plan or re-approve".

## Which skill for which task

| Persona | Task | Skill |
|---|---|---|
| any | install the circuit into a repo | `circuit-bootstrap` |
| Architect | source → draft spec → Confluence design page | `circuit-intake` |
| Architect | clarify, plan, data model, org snapshot, Lucid diagram | `arch-design` |
| Architect (human) | approve the design (G1) | `arch-approve-design` |
| Architect | epic + stories to Jira | `arch-jira-push` |
| Architect | schema/design review of a PR (G7) | `arch-review-pr` |
| any | record a decision on the design page (C1) | `record-decision` |
| Developer | review stories (Jira comments) | `dev-review-stories` |
| Developer | start a story: plan, branch, draft PR; later build | `dev-start-story` |
| Developer | review the plan (G3) | `dev-review-plan` |
| Developer | fix failed checks | `dev-fix` |
| Developer | open the Slack review room / record its verdict | `review-room` |
| Developer | code review (G5) | `dev-review-pr` |
| Tester | design test cases, draft the suite | `qa-design-tests` |
| Tester | test cases to Jira, prepare G2 | `qa-push-tests` |
| Tester | commit suite + tc index to the story PR | `qa-add-tests` |
| Tester | review the test plan (G4) | `qa-review-testplan` |
| Tester | run, explore, triage on QA (G6) | `qa-explore` |

`/speckit-sf-*` commands are the Architect's local drafting scaffold. `deploy`, `hotfix` and `pr` are disabled by the
circuit guard.

## Connections (logins only)

| Service | Claude sessions | Scripts / extension / runner |
|---|---|---|
| GitHub | `gh` CLI (person's login) | `gh`, VS Code GitHub sign-in |
| Salesforce | `sf` CLI (`dev`, `qa`) | `sf` CLI; the runner's login for QA and the named production org |
| Jira | Atlassian Remote MCP (`https://mcp.atlassian.com/v2/mcp`, OAuth) | `acli jira auth login --web` (Jira only) |
| Confluence | Atlassian Remote MCP (Content tools) | Atlassian MCP through Claude; `acli` has no Confluence commands |
| Lucid / Fireflies / Slack | their MCP servers (OAuth in `/mcp` or claude.ai connectors) | the extension asks Claude |
| Circuit | Circuit MCP (`circuit`), added by the extension per session | — |

Never ask for, store, print or commit a token. If a login is missing, name it and stop.

Circuit MCP tools (when the session comes from the extension): `circuit_status`, `queue_get`, `prs_list`, `pr_get`,
`test_results_get`, `sources_list` + `transcript_get` (Architect), `design_get` (design page at its approved version),
`decisions_get`, `story_get` (Jira story with ACs and test cases), `org_snapshot_get`. If one is missing, use the
Atlassian MCP or `acli` for the same read.

## Conventions

| Thing | Location / format |
|---|---|
| Feature id | `NNN-slug` (3 digits), e.g. `001-shipping-rates`; used in page titles, labels, `cref-` labels |
| Local Spec Kit drafts | `.specify/specs/NNN-slug/` (gitignored; never committed) |
| Design page | Confluence page "Design: NNN Feature name" in `confluence.space_key`, labels `circuit-design`, `feature-NNN` |
| Design page sections | Summary · Sources · Requirements (user stories, Given/When/Then) · Open questions · **Decisions** · Technical plan · Data model · Security model · Diagram · Risks |
| Decisions (C1) | table on the design page: Date · Decision · Who · Why · Source |
| Org snapshot (C4) | child page "Org snapshot: NNN slug": objects, fields, flows, permission sets the feature touches |
| Approved version | epic field *Approved design version* (set by an architect in Jira, G1); story field of the same name (the version it was planned against, set by `arch-jira-push`) |
| Epic / stories | summaries `[NNN] Feature`, `[NNN-S00] Foundation …`, `[NNN-S02] …`; labels `circuit`, `feature-NNN`, `cref-NNN-<ref>`; Story 00 **blocks** the others |
| Story fields | *Design page*, *Approved design version*, *Acceptance criteria*, *Story type*, *Schema change*, *Testability confirmed* |
| Test case id | `<KEY>-TC-<nn>`, e.g. `ACME-12-TC-03`; unit tests reference it: `// TC: ACME-12-TC-03` |
| Test cases in Jira | per `jira.test_tool`: sub-task "Test Case" (none) or "Test" issues linked "Tests" (xray/zephyr) |
| Runnable tests (story PR) | `tests/<KEY>.tc.json` + `test-cases/<KEY>.sf-tests.yaml` (Tester commits) |
| Story plan (story PR) | `docs/plans/<KEY>/PLAN.md`, `TESTPLAN.md`, `verification-evidence.md` (Developer) |
| Branch / PR | `feature/<KEY>-<slug>`; draft PR titled `<KEY> <summary>`; GitHub for Jira links it to the story |
| Labels (PR) | `plan-approved`, `testplan-approved`, `ai-generated`, `ai-attempt-1..3`, `needs-human`, `needs-qa` |
| Org aliases | `dev` (check-only deploys, read queries), `qa` (QA org); any org type; the named production org is off limits |
| Slack | `#review-room` (review rooms), persona channels from `build.config.yml` |

`tests/<KEY>.tc.json`:

```json
{
  "story": "ACME-12",
  "feature": "001-shipping-rates",
  "designVersion": 7,
  "cases": [
    { "id": "ACME-12-TC-01", "ac": "AC-1", "title": "Agent sees the Acme Shipping rate on an Order",
      "level": "ui", "persona": "Support Agent", "type": "positive", "automated": true, "jira": "ACME-31" },
    { "id": "ACME-12-TC-02", "ac": "AC-1", "title": "Rate handler bulk-updates 201 Orders",
      "level": "unit", "persona": "System", "type": "boundary", "automated": true, "jira": "ACME-32" },
    { "id": "ACME-12-TC-03", "ac": "AC-2", "title": "Read-only user cannot edit the rate",
      "level": "manual", "persona": "Read Only", "type": "negative", "automated": false, "jira": "ACME-33" }
  ]
}
```

`level`: `ui` (a case with the same id is in the SF AI Tester suite), `unit` (an Apex or Jest test names the id),
`manual` (steps in the Jira test case). Checks: `node scripts/ci/check-tc-coverage.mjs --key <KEY> --design|--testplan|--code`.

## Status of a feature or story

When asked "where is X?", report each line as done / pending / blocked with evidence (links, keys, versions):

1. Design page exists; no open questions; Decisions section current; org snapshot child page and Lucid link present.
2. G1: page status Approved, the epic's *Approved design version* set, and the approver is an `architects` member
   (page versions: `listConfluenceContentVersions`).
3. Epic and stories in Jira (Story 00 first, blocks links), each story's *Approved design version* = the epic's (C5).
4. Test cases linked to each story; G2 (`ai-ready` + *Testability confirmed*).
5. For a story key: `gh pr list --search "<KEY> in:title" --state all --json number,title,labels,isDraft,statusCheckRollup`:
   draft PR, tests committed, `plan-approved` / `testplan-approved` (G3/G4), checks, review-room verdict comment,
   `gate/*` statuses (G5–G7), merge (G8) and the last `deploy-prod` run (G9).

Finish with the next gate and its owner.
