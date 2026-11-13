# Delivery Circuit v4: live end-to-end test plan

This is the live test named in section 8 of [`CIRCUIT-V4.md`](CIRCUIT-V4.md). One feature, **Case Escalation**, goes
through every row of the flow (section 2) and up the promotion ladder (section 3). Every app is touched at least
once; the coverage table at the end shows where.

**First pass: one person plays every role.** Use **Switch Persona** in the VS Code extension to move between Architect,
Developer and QA, and act as the lead yourself. Rows marked **2nd person** cannot be done alone, because GitHub does not
let you approve your own PR or your own production deployment (*Prevent self-review*). Ask a second member of `leads`
for those rows only.

Copy this file to `docs/E2E-RESULTS.md` before you start and fill in **Result** there: `Pass`, `Fail` (what you saw)
or `Skip` (why). Do not paste real org names, URLs or emails into either file.

---

## 0. Before you start

### 0.1 Test data (placeholders)

| Item | Value |
|---|---|
| GitHub repo | `acme-org/acme-delivery` (private) |
| Jira project / site | `ACME` on `acme.atlassian.net` |
| Confluence space | `ACMEDESIGN` |
| Salesforce | An SDO org as your DEV org, alias `dev`. Sandboxes for `qa`, `dev`, `sit`, `uat`, `production` environments |
| Sprint branch | `sprint/s1` |
| Use case | "Agents should be able to escalate a Case with a reason. Escalated Cases go to the Tier 2 queue, and the account owner gets notified." |
| Epic | `ACME-10` Case Escalation |
| Stories (expected) | `ACME-11` Story 00 data model: `Escalation_Reason__c` picklist on Case + permission set · `ACME-12` Escalate a Case with a reason · `ACME-13` Route escalated Cases to the Tier 2 queue · `ACME-14` Notify the account owner |
| Slack channel | `#acme-delivery` (private, with `@coderabbit` invited) |

If you have only one SDO org, every environment's `SFDX_AUTH_URL` may point at it for the first pass. Write that in the
results; a promotion then redeploys the same org.

### 0.2 Setup checks

Follow [`ConnectionsSetup.md`](../ConnectionsSetup.md) for anything that fails.

| ID | Do | Expected | Result |
|---|---|---|---|
| S-01 | `gh auth status` | Logged in to github.com | |
| S-02 | `claude auth status`; `echo $ANTHROPIC_API_KEY` (PowerShell: `$env:ANTHROPIC_API_KEY`) | claude.ai account on the Team plan; variable empty | |
| S-03 | `sf org display --target-org dev` | SDO org username returned | |
| S-04 | `acli jira auth status` | Site `acme.atlassian.net` shown (extension only) | |
| S-05 | `claude`, then `/mcp` | Atlassian and Lucid connected; Fireflies and Slack if you use them | |
| S-06 | `gh api orgs/acme-org/teams --jq '.[].slug'` | `architects`, `developers`, `testers`, `leads`; you are in all four | |
| S-07 | `/circuit-bootstrap` has run; `git branch -r` | `origin/dev`, `sit`, `uat`, `main`, `sprint/s1` exist | |
| S-08 | `gh secret list --env <env> --repo acme-org/acme-delivery` for `qa dev sit uat production` | `SFDX_AUTH_URL` listed in each (no values shown) | |
| S-09 | `gh secret list --repo acme-org/acme-delivery` | No `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `SF_JWT_*`, `JIRA_API_TOKEN` | |
| S-10 | Settings → Environments → `production` | Required reviewers `leads`, Prevent self-review on, branch `main` only | |
| S-11 | Settings → Rules | Rulesets on `sprint/*`, `dev`, `sit`, `uat`, `main`: PR only, required check `scan`, no force-push or delete | |
| S-12 | Jira `ACME`: issue types and Story workflow | Epic, Story, a test case type; status **Ready for Dev** exists | |
| S-13 | Confluence `ACMEDESIGN`: page status list | **Approved** is available | |
| S-14 | Jira → Apps → GitHub for Atlassian | `acme-org/acme-delivery` connected | |
| S-15 | CodeRabbit dashboard; Slack `#acme-delivery`: `@coderabbit hello` | Repo enabled; CodeRabbit replies in Slack | |
| S-16 | Extension → Connections | Rows for GitHub, Claude, `sf`, `acli`, Atlassian MCP green. v3 rows (runner, Claude Tag) may be red; ignore them | |

---

## 1. Design (flow rows 1 to 5, persona Architect)

### 1.1 Transcript and org check (rows 1 and 2)

| ID | Do | Expected | Result |
|---|---|---|---|
| A-01 | Extension → **Sources** → paste the sample transcript (section 7) → Save | Source listed with title and date; no transcript text in the repo | |
| A-02 | Attach the same transcript as `.vtt` and as `.docx` | Each becomes a source; preview readable | |
| A-03 | (optional) Fireflies → pick a meeting → Add | Source added from Fireflies | |
| A-04 | On the source → **Run intake** (or `/circuit-intake`) | Claude starts as Architect with the source | |
| A-05 | Watch the session | Claude runs read-only `sf` queries against `dev` only (Case fields, queues, flows, permission sets, notification types). No deploy | |
| A-06 | Ask Claude what already exists | It names what it found in the SDO (for example Case, existing Case flows, any Tier 2 queue) | |

### 1.2 Design page and Lucid (row 3)

| ID | Do | Expected | Result |
|---|---|---|---|
| A-07 | Open Confluence `ACMEDESIGN` | New page "Case Escalation" created through the Atlassian MCP | |
| A-08 | Read the change table | Every component tagged: Case **EXISTS**; `Escalation_Reason__c` **NEW**; permission set **NEW**; Tier 2 queue **EXISTS** or **NEW** to match the org check; Case flow **EXTEND** or **NEW**; Case page / quick action **EXTEND** or **NEW**; owner notification **NEW** | |
| A-09 | Check the page | Lucid diagram created through the Lucid MCP and linked or embedded | |
| A-10 | Check open questions | For example "Which picklist values?", "Notify by email, bell, or both?" | |
| A-11 | `/arch-design`; answer the open questions | Change table, data model and story outline updated; status **Ready for review** | |
| A-12 | `/record-decision` "Notify the account owner by bell notification" | New decision row: date, decision, who, why, source | |

### 1.3 Approve (row 4)

| ID | Do | Expected | Result |
|---|---|---|---|
| A-13 | Ask Claude to set the page to Approved | Refused (guard or skill): AI never approves | |
| A-14 | In Confluence, set status **Approved** yourself | Page shows Approved | |

### 1.4 Epic and stories (row 5)

| ID | Do | Expected | Result |
|---|---|---|---|
| A-15 | `/arch-jira-push` | Epic `ACME-10` and stories `ACME-11` to `ACME-14` created through the Atlassian MCP, label `feature-case-escalation` | |
| A-16 | Open `ACME-11` (Story 00) | Data model only: picklist + permission set. It **blocks** `ACME-12` to `ACME-14` | |
| A-17 | Open `ACME-12` | Its slice of the change table, acceptance criteria, design page link | |
| A-18 | Run `/arch-jira-push` again | No duplicates | |
| A-19 | Run `/arch-jira-push` on a page that is not Approved | Refused | |

---

## 2. Refinement and test design (rows 6 and 7)

| ID | Persona | Do | Expected | Result |
|---|---|---|---|---|
| R-01 | Developer | `/dev-review-stories ACME-10` | A comment on each story: buildability, estimate, dependencies | |
| R-02 | Developer | `/dev-start-story ACME-12` before refinement | Refused: story is not Ready for Dev | |
| R-03 | any | Ask Claude to move `ACME-11` to Ready for Dev | Refused: AI never moves stories | |
| R-04 | you (team) | In Jira, move `ACME-11` and `ACME-12` to **Ready for Dev** | Status shows Ready for Dev | |
| Q-01 | QA | `/qa-design-tests ACME-12` | Jira test cases, one or more per acceptance criterion, linked to `ACME-12` | |
| Q-02 | QA | `/qa-add-tests ACME-12` | `test-cases/ACME-12.sf-tests.yaml` built from the Jira test cases; PR into `sprint/s1` | |
| Q-03 | QA | Check the suite PR checks | `scan` runs; the suite PR follows the same path as code (rows 9 to 12) | |

---

## 3. Build, scan and review (rows 8 to 12, persona Developer)

Do Story 00 (`ACME-11`) end to end first, then `ACME-12`. Repeat for `ACME-13` and `ACME-14` if time allows.

### 3.1 Build (row 8)

| ID | Do | Expected | Result |
|---|---|---|---|
| D-01 | `/dev-start-story ACME-11` | Branch `feature/ACME-11-<slug>` from `sprint/s1`; plan in the PR body | |
| D-02 | Watch the build | `Escalation_Reason__c` picklist on Case and a permission set in `force-app/`; `sf project deploy validate` (or `--dry-run`) against `dev` only | |
| D-03 | Check GitHub | PR `ACME-11 …` into `sprint/s1`, opened by your account, auto-merge (squash) on | |
| D-04 | Jira `ACME-11` → Development panel | Branch and PR shown (GitHub for Atlassian) | |
| D-05 | After `ACME-11` merges: `/dev-start-story ACME-12` | Quick action / LWC to escalate with a reason; same PR pattern | |

### 3.2 Scan and CodeRabbit (rows 9 and 10)

| ID | Do | Expected | Result |
|---|---|---|---|
| D-06 | PR → Checks → `pr-checks` | `scan` on `ubuntu-latest`: Code Analyzer, LWC Jest (if present), login with `qa`'s `SFDX_AUTH_URL`, `sf project deploy validate --test-level RunLocalTests` | |
| D-07 | Read the `scan` log | The auth URL is never printed | |
| D-08 | After scan passes | `coderabbit` job posts `@coderabbitai review` once for this head commit | |
| D-09 | CodeRabbit on the PR | Review posted; approves or requests changes | |
| D-10 | `/review-room <PR>` | Summary of CodeRabbit's review; posted to `#acme-delivery` with the PR link if the Slack MCP is connected, else printed | |
| D-11 | In the Slack thread: `@coderabbit why did you flag this?` | CodeRabbit answers in Slack | |
| D-12 | Push a commit with a Code Analyzer severity 1–2 violation (or a failing Apex test) | `scan` fails; `coderabbit` job **skipped**; no review requested | |

### 3.3 Fix and merge (rows 11 and 12)

| ID | Do | Expected | Result |
|---|---|---|---|
| D-13 | `/dev-fix <PR>` | Claude reads the failed scan log and CodeRabbit comments, fixes, pushes | |
| D-14 | Wait | `scan` green, CodeRabbit reviews the new commit and approves | |
| D-15 | **2nd person** only if CodeRabbit's approval does not count (app without write access) | A Developer lead approves the PR. Record which case applied | |
| D-16 | Auto-merge | PR squash-merged into `sprint/s1` without anyone clicking merge | |
| D-17 | Actions → `deploy` on `sprint/s1` | Environment `qa`; `sf project deploy start` succeeds; job summary written | |
| D-18 | QA sandbox | `Escalation_Reason__c` and the permission set exist | |

---

## 4. QA (row 13, persona QA)

| ID | Do | Expected | Result |
|---|---|---|---|
| Q-04 | Assign the permission set in QA; escalate a Case with reason "Customer at risk" | Case escalated, reason saved | |
| Q-05 | Run `test-cases/ACME-12.sf-tests.yaml` in SF AI Tester against QA (manual and automation modes) | Run report; each Jira test case passes or fails | |
| Q-06 | `/qa-explore ACME-12` | Exploratory notes posted as a Jira comment | |
| Q-07 | Record results on the Jira test cases | Results in Jira | |
| Q-08 | You (QA) move `ACME-12` to **Done** (or back to the Developer with a comment) | Status changed by a person | |
| Q-09 | After `ACME-13` and `ACME-14`: escalate a Case on an account with a known owner | Case lands in the Tier 2 queue; account owner gets the notification | |

---

## 5. Sprint review and promotion (rows 14 and 15, persona Lead)

| ID | Do | Expected | Result |
|---|---|---|---|
| P-01 | Sprint review: walk through `ACME-11` to `ACME-14` in QA | Notes recorded | |
| P-02 | Open PR `sprint/s1` → `dev` | `scan` runs against the `dev` environment; `coderabbit` job skipped (not a feature branch) | |
| P-03 | **2nd person** (a `leads` member) approves | Ruleset satisfied; you merge | |
| P-04 | Actions → `deploy` on `dev` | Deployed to the DEV sandbox | |
| P-05 | Try `git push origin dev` directly | Rejected by the ruleset | |
| P-06 | PR `dev` → `sit`; **2nd person** approves; merge | `deploy` to SIT succeeds | |
| P-07 | PR `sit` → `uat`; **2nd person** approves; merge | `deploy` to UAT succeeds | |
| P-08 | PR `uat` → `main`; **2nd person** approves; merge | `deploy` job starts and **waits** for the `production` environment | |
| P-09 | Try to approve the production deployment yourself (you merged it) | Blocked by Prevent self-review | |
| P-10 | **2nd person** (`leads`) approves the deployment | Deploys to production; job summary written; no Claude step anywhere in the log | |
| P-11 | Push two merges to the same branch quickly | Second deploy waits for the first (`concurrency`) | |

---

## 6. Guard checks (any persona, in a Claude session)

| ID | Ask Claude to | Expected | Result |
|---|---|---|---|
| G-01 | `git push origin sprint/s1` or force-push `dev` | Denied | |
| G-02 | `gh pr merge <n>` (without `--auto`) or `gh pr review --approve` | Denied | |
| G-03 | `sf project deploy start --target-org` any alias except `dev` | Denied | |
| G-04 | `sf org display --verbose --target-org dev` or `gh secret set SFDX_AUTH_URL` | Denied | |
| G-05 | Set the Confluence page to Approved / move a story to Done | Refused | |
| G-06 | `gh pr merge --auto --squash` on its own feature PR | Allowed | |

---

## 7. Sample transcript (made up; paste into Sources)

```
[00:00] Service lead (Acme): Our agents can't flag a case as urgent in a structured way.
[00:12] Architect: What should happen when they escalate?
[00:18] Service lead (Acme): They pick a reason, like "Customer at risk" or "SLA breach". Then the case
        goes to our Tier 2 queue.
[00:35] Architect: Who needs to know?
[00:40] Service lead (Acme): The account owner. A bell notification is fine, email is optional.
[00:55] Architect: Should agents be able to escalate a case that's already escalated?
[01:02] Service lead (Acme): No. And only service agents should see the button.
[01:10] Architect: Any reporting?
[01:14] Service lead (Acme): Later. For now we just need the reason on the case.
```

---

## App coverage

| App | Rows |
|---|---|
| Sources (paste, file, Fireflies) | A-01 to A-03 |
| Salesforce DEV (`sf`, read-only + validate) | S-03, A-05, A-06, D-02 |
| Confluence (Atlassian MCP) | S-13, A-07 to A-14 |
| Lucid (MCP) | A-09 |
| Jira (Atlassian MCP) | S-12, A-15 to A-19, R-01 to R-04, Q-01, Q-06 to Q-08 |
| GitHub (repo, rulesets, environments) | S-06 to S-11, D-03, D-16, P-02 to P-10 |
| GitHub for Atlassian | S-14, D-04 |
| GitHub Actions `pr-checks.yml` | D-06 to D-08, D-12, P-02 |
| GitHub Actions `deploy.yml` | D-17, P-04, P-06 to P-11 |
| CodeRabbit on GitHub | D-08, D-09, D-14 |
| CodeRabbit in Slack | S-15, D-10, D-11 |
| SF AI Tester | Q-02, Q-05 |
| Sandboxes QA / DEV / SIT / UAT / production | D-17, D-18, Q-04, Q-09, P-04, P-06, P-07, P-10 |
| Circuit guard | A-13, R-03, G-01 to G-06 |
| VS Code extension (Switch Persona, Sources, Connections) | S-16, A-01, A-04 |

## Sign-off

| Pass | Name | Date | All rows Pass or justified Skip |
|---|---|---|---|
| One person, all roles | | | |
| Second person (2nd-person rows) | | | |

Record while running: whether CodeRabbit's approval satisfies the `sprint/*` ruleset, whether the GitHub plan enforces
required reviewers on the private repo's `production` environment, and whether every environment pointed at the same
SDO org.
