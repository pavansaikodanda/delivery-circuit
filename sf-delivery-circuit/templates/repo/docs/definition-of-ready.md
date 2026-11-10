# Definition of Ready (a story may get `ai-ready`)

- [ ] Spec, clarification (no `OPEN` items) and `plan.md` merged to `main`, with Architect Sign-Off ticked by a human (G1).
- [ ] The story file exists, reviewed by `/speckit-sf-review` and `dev-review-stories`; acceptance criteria are Given/When/Then.
- [ ] Affected metadata is listed; schema changes live in Story 00 (or the story is marked `Schema change = yes`).
- [ ] Test cases designed (`tests/story_NN.tc.json` + SF AI Tester suite for `ui` cases), validated, and merged.
- [ ] **Test cases pushed to Jira and linked to the story** (`qa-push-tests`).
- [ ] Every story that blocks this one (normally Story 00) is Done.
- [ ] Points estimated. "Testability confirmed" set and label `ai-ready` added by a Tester (G2).
