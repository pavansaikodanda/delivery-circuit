# Definition of Done (a PR may be merged)

- [ ] `plan-approved` (Developer, G3) and `testplan-approved` (Tester, G4) were set by team members.
- [ ] `pr-checks` green: protected-path guard, lint + Jest, Code Analyzer gate (0 sev 1, 0 sev 2), TC coverage,
      deploy to QA, Apex tests (85%+ on touched classes), SF AI Tester verdict `pass` (0 failed, 0 blocked, 0 error).
- [ ] Reviewer verdict `PASS`; CodeRabbit has no open "changes requested".
- [ ] `verification-evidence.md` present.
- [ ] Approvals: `gate/developer` (G5), `gate/tester` after `qa-explore` (G6), `gate/architect` after `arch-review-pr` (G7).
- [ ] PR description lists changes, deletions and evidence. Merge by an Architect (G8).
