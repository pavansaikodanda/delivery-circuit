# Delivery Circuit v3: live end-to-end test plan

This is the script for the live test in section 7.3 of [`CIRCUIT-V3.md`](CIRCUIT-V3.md). One feature goes through
every step of the flow (section 3 of the spec), and each persona does their own part on their own laptop with their
own logins. Every app the circuit uses is touched at least once. The table at the end shows where.

Copy this file to `docs/E2E-RESULTS.md` before you start and fill in the **Result** column there: `Pass`, `Fail`
(with what you saw), or `Skip` (with why). Attach screenshots or links where they help.

---

## 0. Before you start

### 0.1 People and machines

| Role | Who | Machine | GitHub team | Atlassian group |
|---|---|---|---|---|
| Architect | | laptop A | `architects` | `architects` |
| Developer | | laptop B | `developers` | `developers` |
| Tester | | laptop C | `testers` | `testers` |
| Runner | service user | runner machine | (repo admin registers it) | (Jira user for `acli`) |

One person may play several roles on one laptop for a first pass. In that case use **Switch Persona** in the
extension, and note it in the results. A second pass with three different people is still needed to prove the team
checks on the gates.

### 0.2 Test data (placeholders)

| Item | Value used in this script |
|---|---|
| GitHub repo | `acme-org/acme-shipping` (private) |
| Jira project | `ACME` (story keys like `ACME-12`) |
| Confluence space | `ACMEDESIGN` |
| Salesforce aliases | `dev`, `qa` (production alias `prod`, only on the release runner) |
| Feature | "Shipment delay escalation" for Acme Shipping: a `Delay_Reason__c` field on Shipment, a Flow that creates a Case when a shipment is more than 2 days late, and an LWC banner on the Shipment page |
| Sample transcript | a short made-up call between "Acme Shipping ops lead" and the delivery team, saved as `acme-call.vtt`, `acme-call.docx` and `acme-call.pdf` |
| Slack channel | `#review-room` |

Use your own real site, repo and org names when you run it, but do not paste them into this file or the results
file if the repo is shared.

### 0.3 Connection check (all personas)

Do this first on every laptop and on the runner. Follow [`ConnectionsSetup.md`](../ConnectionsSetup.md) for anything
that fails.

| ID | Who | Do | Expected | Result |
|---|---|---|---|---|
| C-01 | everyone | Open the repo in VS Code. Circuit sidebar → **Sign in to GitHub** | Sidebar shows your login and the right persona chip | |
| C-02 | everyone | Terminal: `gh auth status` | Logged in to github.com | |
| C-03 | everyone | `claude auth status`; `echo $ANTHROPIC_API_KEY` (PowerShell: `$env:ANTHROPIC_API_KEY`) | claude.ai account on the Team plan; the variable is empty | |
| C-04 | everyone | `sf org display --target-org dev` (Tester also `qa`) | Each returns a username; no error | |
| C-05 | everyone | `acli jira auth status`; `acli jira workitem search --jql "project = ACME" --limit 1 --json` | Site shown; one item or an empty list, no auth error | |
| C-06 | everyone | `claude`, then `/mcp` | Atlassian connected (everyone); Fireflies and Lucid (Architect); Slack (Developer) | |
| C-07 | everyone | Extension → **Connections** | Every row needed for your persona is green, or says exactly what to do. No row asks for a token | |
| C-08 | repo admin | Connections → Project → **Self-hosted runner** | Runner online with label `circuit`; release runner online with `circuit-release` | |
| C-09 | repo admin | `gh secret list --repo acme-org/acme-shipping` | No `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `SF_JWT_*`, `JIRA_API_TOKEN` | |
| C-10 | repo admin | Repo settings → Actions → General | Repo is private; fork PR workflows are off (or public repo with *Require approval for all external contributors*) | |
| C-11 | runner user | On the runner: `claude auth status`, `sf org display --target-org qa`, `acli jira auth status` | All logged in as the runner's own accounts | |

---

## Part A. Architect

Laptop A, persona Architect. Steps 1 to 5 of the flow, then 17 (G7), 18 and 19 later in the run.

### A1. Add sources (step 1)

| ID | Do | Expected | Result |
|---|---|---|---|
| A-01 | Extension → **Sources** → paste the transcript text into the box → Save | Source appears with title, date and "paste"; no file appears in the repo except an update to `.circuit/sources.json` | |
| A-02 | Dictate a short note into the box with **Wispr Flow** → Save | Dictated text saved as a source | |
| A-03 | **Attach file** → `acme-call.vtt`, then `.srt`, `.txt`, `.md`, `.docx`, `.pdf` (one each) | Each file becomes a source; text preview is readable (speaker lines kept for vtt/srt) | |
| A-04 | **Fireflies** → list meetings | Recent meetings listed through the Fireflies MCP (titles, dates) | |
| A-05 | Pick one Fireflies meeting → Add | Source added with `fireflies:<id>`; full transcript readable in preview | |
| A-06 | **Wispr Flow import** → file export | Imported as a source | |
| A-07 | **Wispr Flow import** → local history | A consent prompt appears first. Decline: nothing is read. Accept: entries listed read-only; pick one to add | |
| A-08 | Turn on **Watch folder**, drop `acme-call.md` into it | Added as a new source within a few seconds | |
| A-09 | `git status`; open `.circuit/sources.json` | Only ids, titles, dates, kind; no transcript text anywhere in the repo | |
| A-10 | Check the extension's global storage folder | Source files are not readable plain text (encrypted) | |
| A-11 | Switch to Developer persona (or ask the Developer) → Sources page | Not available; "Only an Architect can read sources" | |

### A2. Intake (step 2)

| ID | Do | Expected | Result |
|---|---|---|---|
| A-12 | On a source row → **Run intake** | Claude starts as the Architect (terminal or panel) with the source id in the prompt | |
| A-13 | Watch the session | Claude reads the source with `transcript_get`, reads the org with `sf` (read-only) against `dev`, reads `CLAUDE.md` and the constitution | |
| A-14 | Check `.specify/specs/` locally; `git status` | Draft spec and open questions exist locally; the folder is gitignored (not in `git status`) | |
| A-15 | Check Confluence space `ACMEDESIGN` | A new design page "Shipment delay escalation" exists, created through the Atlassian MCP, with spec, acceptance criteria and open questions | |
| A-16 | In the session, ask Claude to run `gh pr create` | Denied by circuit-guard: the Architect cannot create PRs | |

### A3. Clarify and design (step 3)

| ID | Do | Expected | Result |
|---|---|---|---|
| A-17 | Run `/arch-design`; answer two open questions | Each answer appears in the page's **Decisions** section (date · decision · who · why · source link) | |
| A-18 | Feature menu → **Record decision** (C1) with a new decision | New row in Decisions; the extension's feature panel shows it | |
| A-19 | Check the page | Technical plan and data model sections are filled | |
| A-20 | Check the child page **Org snapshot** (C4) | Lists the objects, fields, flows and permission sets the feature touches, read from `dev` | |
| A-21 | Check the Lucid diagram | Created through the Lucid MCP and embedded or linked on the design page | |
| A-22 | In the session, ask Claude to set the page status to Approved | Refused: AI cannot approve the design | |

### A4. Approve design (step 4, G1)

| ID | Do | Expected | Result |
|---|---|---|---|
| A-23 | Queue → **Approve design** | Opens the Confluence page in the browser (the extension does not approve) | |
| A-24 | In Confluence, set status **Approved** as an `architects` member | Status shows Approved; the extension shows the approved version number after refresh | |
| A-25 | Negative: a non-architect sets Approved on a copy of the page | The extension and `design-gate` do **not** accept it ("Approved by someone outside architects") | |

### A5. Stories (step 5)

| ID | Do | Expected | Result |
|---|---|---|---|
| A-26 | Run `/arch-jira-push` | Jira epic, Story 00 (shared schema) and stories created; Story 00 **blocks** the others | |
| A-27 | Open a story (for example `ACME-12`) | *Design page* link, *Approved design version* = the version from A-24, *Acceptance criteria* filled | |
| A-28 | Run `/arch-jira-push` again | No duplicates created (idempotent) | |
| A-29 | Repeat one story push with `acli` as the path (MCP off, or the fallback the skill offers) | Same result through `acli jira workitem create`; still no duplicates | |
| A-30 | Extension → feature panel | Epic and stories listed from Jira (no `jira-map.json`) | |

Part A continues at A-50 (design review), A-55 (merge) and A-57 (release).

---

## Part B. Developer (story review)

Laptop B, persona Developer.

| ID | Do | Expected | Result |
|---|---|---|---|
| B-01 | Queue → **Story review** for the epic → run `/dev-review-stories` | Claude reads the stories and design page; buildability, estimates and dependencies posted as **Jira comments** on each story | |
| B-02 | Check that no story has a PR yet | Queue does **not** show "Start story" until G2 is set | |

---

## Part C. Tester (test design and G2)

Laptop C, persona Tester.

| ID | Do | Expected | Result |
|---|---|---|---|
| T-01 | Queue → **Design tests** for `ACME-12` → `/qa-design-tests` | Test cases per acceptance criterion and persona created in **Jira**, linked to the story | |
| T-02 | Check the local suite | `test-cases/ACME-12.sf-tests.yaml` and `tests/ACME-12.tc.json` drafted locally and validated against `qa` (validator passes) | |
| T-03 | `/qa-push-tests` again | No duplicate Jira test cases | |
| T-04 | In Jira, set *Testability confirmed* and label `ai-ready` on `ACME-12` (G2) | Extension shows G2 done for the story | |
| T-05 | Negative: ask Claude (Tester) to edit `force-app/` | Denied by circuit-guard | |

---

## Part D. Developer (start, build, fix, review room)

Back on laptop B.

### D1. Start story (step 9)

| ID | Do | Expected | Result |
|---|---|---|---|
| D-01 | Queue → **Start story** on `ACME-12` | Claude (Developer) starts with the story key in the prompt | |
| D-02 | Watch the session | Reads the story, ACs, the design page **at the approved version only**, and the Jira test cases | |
| D-03 | Check the branch and files | Branch `feature/ACME-12-<slug>`; `docs/plans/ACME-12/PLAN.md` and `TESTPLAN.md` committed | |
| D-04 | Check GitHub | A **draft** PR titled `ACME-12 …`, opened by the Developer's own account | |
| D-05 | Check Jira `ACME-12` → Development panel | The branch and PR show (GitHub for Atlassian) | |

### D2. Tests onto the PR (step 10, Tester)

| ID | Do | Expected | Result |
|---|---|---|---|
| T-06 | Tester queue → **Add tests to ACME-12** | `test-cases/ACME-12.sf-tests.yaml` and `tests/ACME-12.tc.json` committed to the PR branch by the Tester | |
| T-07 | Negative: ask Claude (Tester) to commit a file outside `tests/` and `test-cases/` | Denied | |
| T-08 | Negative: as Developer, ask Claude to edit `tests/ACME-12.tc.json` | Denied | |

### D3. Approve plans (step 11, G3 and G4)

| ID | Do | Expected | Result |
|---|---|---|---|
| D-06 | Developer → `/dev-review-plan`, then **Approve plan** | Confirm dialog names the label, PR and your login; label `plan-approved` added as you | |
| T-09 | Tester → `/qa-review-testplan`, then **Approve test plan** | Label `testplan-approved` added as the Tester | |
| D-07 | Negative: a Developer adds `testplan-approved` by hand in GitHub | `persona-gates` removes it or fails (not a `testers` member) | |
| D-08 | Negative: ask Claude to add `plan-approved` | Denied by circuit-guard | |

### D4. Build (step 12)

| ID | Do | Expected | Result |
|---|---|---|---|
| D-09 | Ask Claude to implement `ACME-12` | Code in `force-app/`; Apex tests reference cases with `// TC: …` | |
| D-10 | Watch for deploys | Only `sf project deploy validate` (check-only) against `dev`; a real deploy is denied | |
| D-11 | Negative: ask Claude to run any `sf` command with `--target-org prod` | Denied: production alias | |
| D-12 | Claude pushes to the branch | Push succeeds to `feature/ACME-12-…`; a push to `main` would be denied | |

### D5. Checks (step 13)

| ID | Do | Expected | Result |
|---|---|---|---|
| D-13 | Open the PR checks | Hosted jobs (guard, lint, Jest, test-case coverage) run on `ubuntu-latest` | |
| D-14 | Same PR | Self-hosted jobs (QA deploy, Apex tests, SF AI Tester, AI Reviewer, Code Analyzer) run on the runner with label `circuit` | |
| D-15 | `design-gate` result | Passes: the story's approved version equals the page's approved version | |
| D-16 | AI Reviewer output | `VERDICT: PASS` or `BLOCK` comment on the PR, made with the runner's `claude` login (no token) | |
| D-17 | SF AI Tester on `qa` | Results posted; route shown (pass, dev, qa, infra) | |
| D-18 | Extension PR row | Shows the checks grouped by source; one computed status | |

### D6. Fix (step 14)

| ID | Do | Expected | Result |
|---|---|---|---|
| D-19 | Break one Apex test on purpose and push | Check fails; `fix-router` labels the PR; no AI runs in CI | |
| D-20 | Developer queue → **Fix with AI** | Failure prefilled in the prompt; Claude fixes and pushes; label `ai-attempt-1` | |
| D-21 | Repeat the failure 3 times | After the third AI attempt the PR gets `needs-human` and Fix with AI is greyed out with the reason | |
| D-22 | Make one UI case blocked (for example remove a field from the page layout on `qa`) | PR gets `needs-qa`; the item shows in the **Tester's** queue, not the Developer's | |
| T-10 | Tester → open the blocked case, fix the test or the org setup, re-run | Case passes; `needs-qa` cleared | |

### D7. Review room (steps 15 and 16)

| ID | Do | Expected | Result |
|---|---|---|---|
| D-23 | PR row → **Open review room** | Developer's Claude posts a kick-off thread in `#review-room` through the Slack MCP: PR link, ACs, key decisions, design link, CI results | |
| D-24 | In the thread: `@coderabbit review PR #<n>` | CodeRabbit replies with findings by severity, file:line | |
| D-25 | `@Claude challenge each finding above and add anything missed` | Claude Tag answers point by point | |
| D-26 | `@coderabbit respond to Claude's points`, then `@Claude final verdict` | Verdict lists must fix · disputed · dropped | |
| D-27 | Note whether the bots answer each other without a person | Recorded (decides if rounds can be automated) | |
| D-28 | PR row → **Record verdict** | One PR comment with Must fix / Disputed / Dropped and the thread link; the PR row shows the counts | |
| D-29 | Must-fix items | Appear as **Fix with AI** in the Developer's queue | |

---

## Part E. Reviews, merge and release

| ID | Who | Do | Expected | Result |
|---|---|---|---|---|
| D-30 | Developer | `/dev-review-pr`, then approve the PR in GitHub (G5) | Status `gate/developer` green | |
| T-11 | Tester | `/qa-explore` on `qa` with SF AI Tester (manual and automation modes), then approve (G6) | Run report in `.sf-ai-tester/runs/`; status `gate/tester` green | |
| T-12 | Tester | Export the run to Excel and PDF from the Testing page | Both files open | |
| A-50 | Architect | `/arch-review-pr` against the approved design, then approve (G7) | Status `gate/architect` green | |
| A-51 | Architect | **C5 test:** edit the design page and re-approve it (new version) | `design-gate` fails on the PR: "Design changed since this story was planned: re-plan or re-approve"; the extension shows **Design changed** | |
| A-52 | Developer / Architect | Re-plan (Developer updates PLAN.md) or update the story's *Approved design version*, re-run checks | `design-gate` passes again | |
| A-53 | Developer | Try to merge in GitHub | Not allowed (architects only) | |
| A-54 | Architect | Ask Claude to run `gh pr merge` | Denied by circuit-guard | |
| A-55 | Architect | Mark the PR ready, merge in GitHub (G8) | Merged by the Architect's account | |
| A-56 | Architect | Check Jira `ACME-12` | PR shows as merged in the Development panel | |
| A-57 | Architect | `deploy-prod` starts on merge | Job waits for `production` environment approval; picked up by the `circuit-release` runner only | |
| A-58 | Architect | Approve the `production` environment (G9) | Delta validate, then quick deploy, using the release runner's `sf` login of `prod`; no Claude step in the log | |
| A-59 | Architect | Self-approval check with the same person who pushed | Blocked by *Prevent self-review* | |

---

## Part F. Runner and CI safety

| ID | Who | Do | Expected | Result |
|---|---|---|---|---|
| R-01 | repo admin | Stop the runner service, open a PR | Hosted jobs run; self-hosted jobs wait in "Queued"; Connections shows the runner offline | |
| R-02 | repo admin | Start the service again | Queued jobs run | |
| R-03 | repo admin | Open a PR from a fork (or simulate with a test account) | Self-hosted jobs are skipped by the fork guard, or wait for approval; nothing runs on the runner unapproved | |
| R-04 | repo admin | Search the workflow files and logs for `CLAUDE_CODE_OAUTH_TOKEN`, `SF_JWT_`, `JIRA_API_TOKEN`, `ANTHROPIC_API_KEY` | No matches | |
| R-05 | repo admin | Check `deploy-prod` runs only on `[self-hosted, circuit-release]` | The `circuit` runner never picks it up | |
| R-06 | runner user | On the runner, with `CIRCUIT_PERSONA` set, ask the reviewer agent to write a file | Denied (reviewer is read-only) | |

---

## Part G. Per-persona extension checks

Run on each laptop. These mirror the integration tests, but on the live repo.

| ID | Persona | Do | Expected | Result |
|---|---|---|---|---|
| P-01 | Architect | Open persona panel | Tabs for all three personas; acts only on the Architect tab; others say "Only a Developer can run this" etc. | |
| P-02 | Architect | Circuit MCP tools (ask Claude to list `circuit` tools) | Includes `sources_list`, `transcript_get`, `design_get`, `decisions_get`, `org_snapshot_get`, `story_get`; no `jira_map_get` | |
| P-03 | Developer | Same | No `sources_list` or `transcript_get` | |
| P-04 | Tester | Same | No `sources_list` or `transcript_get` | |
| P-05 | Developer | Sources and Testing pages | Sources not available; Testing not available | |
| P-06 | Tester | Testing page | Suites listed with Jira test-case keys; can run against `dev` or `qa` | |
| P-07 | each | Status bar and sidebar | `Circuit: <Persona> · N waiting`; top items match the queue | |
| P-08 | each | Theme switch (dark, light, high contrast) | Pages stay readable; one main action per row | |

---

## App coverage

Every app must have at least one passing row.

| App | Rows |
|---|---|
| Fireflies (MCP) | A-04, A-05 |
| Wispr Flow | A-02, A-06, A-07 |
| Local file upload | A-03, A-08 |
| Confluence (Atlassian MCP) | A-15, A-17 to A-25, A-51 |
| Lucid (MCP) | A-21 |
| Jira (Atlassian MCP and `acli`) | C-05, A-26 to A-30, B-01, T-01 to T-04, D-05, A-56 |
| GitHub (VS Code sign-in, `gh`, rulesets, environments) | C-01, C-02, D-04, D-06, D-07, A-53 to A-59 |
| GitHub for Atlassian | D-05, A-56 |
| Salesforce DEV (`sf`) | C-04, A-13, A-20, D-10 |
| Salesforce QA (`sf`) | C-04, T-02, D-14, T-10, T-11 |
| SF AI Tester | T-02, D-17, T-10, T-11, T-12 |
| Claude (`claude` CLI on Team) | C-03, A-12, B-01, T-01, D-01, D-20 |
| CodeRabbit (GitHub App + Slack agent) | D-24, D-26 |
| Claude Tag | D-25, D-26 |
| Slack (MCP) | D-23, D-28 |
| Self-hosted runner | C-08, C-11, D-14 to D-17, A-57, A-58, R-01 to R-06 |
| Circuit guard | A-16, A-22, T-05, T-07, T-08, D-08, D-10 to D-12, A-54 |

## Sign-off

| Persona | Name | Date | All rows Pass or justified Skip |
|---|---|---|---|
| Architect | | | |
| Developer | | | |
| Tester | | | |

Unknowns to record while running (vendors do not document them yet): the `acli jira auth status` output and exit code
when logged out, the `acli --json` shape, the separator for several `--labels`, the Slack MCP tool names for posting
and reading threads, whether the bots answer each other, and whether a Confluence status change made in the browser
creates a new page version.
