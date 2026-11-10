## Story
Jira: <!-- ABC-123 -->  ·  Story file: <!-- .specify/specs/NNN-slug/task_story_NN.md -->

## What changed
<!-- Files added / changed / deleted and why. List every metadata deletion explicitly. -->

## Evidence
- [ ] `docs/plans/<KEY>/PLAN.md` and `TESTPLAN.md` (approved: `plan-approved`, `testplan-approved`)
- [ ] `docs/plans/<KEY>/verification-evidence.md`
- [ ] Every `unit` TC referenced in tests; every `ui` TC has an SF AI Tester case (`pr-checks` → TC coverage)
- [ ] Code Analyzer gate, Apex tests, SF AI Tester verdict in `pr-checks`

## Gates
| Gate | Owner | Status |
|---|---|---|
| G5 code review | Developer | `gate/developer` |
| G6 QA | Tester | `gate/tester` |
| G7 schema / design | Architect | `gate/architect` |
| G8 merge | Architect | |
| G9 production | Architect | `production` environment |
