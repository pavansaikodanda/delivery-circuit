// Run: node sf-delivery-circuit/tests/guard.test.mjs
// Table-driven tests for circuit-guard. Each case: persona, tool, input, expected (deny|allow).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, '..', 'templates', 'repo', '.claude', 'hooks', 'circuit-guard.mjs');

const proj = mkdtempSync(join(tmpdir(), 'circuit-guard-'));
mkdirSync(join(proj, '.specify', 'extensions', 'sf'), { recursive: true });
writeFileSync(join(proj, '.specify', 'extensions', 'sf', 'sf-config.yml'), 'project:\n  org_aliases:\n    dev: "dev"\n    qa: "qa"\n    prod: "client-live"\n');
mkdirSync(join(proj, '.specify', 'specs', '001-x'), { recursive: true });
writeFileSync(join(proj, '.specify', 'specs', '001-x', 'plan.md'), '## Architect Sign-Off\n- Overall Sign-Off: [ ] APPROVED\n');
// The Architect's jira-sync cache names the epic; jira-config names the G1 field and transition ids.
writeFileSync(join(proj, '.specify', 'specs', '001-x', 'jira-cache.json'), JSON.stringify({ refs: { epic: 'ACME-1', '00': 'ACME-2' } }));
mkdirSync(join(proj, '.specify', 'extensions', 'jira'), { recursive: true });
writeFileSync(join(proj, '.specify', 'extensions', 'jira', 'jira-config.json'), JSON.stringify({ fields: { 'Approved design version': { id: 'customfield_10050' } }, transitions: { 'Approve design': { id: '31' } } }));
writeFileSync(join(proj, 'mutation.graphql'), 'mutation { mergePullRequest(input: { pullRequestId: "PR_x" }) { clientMutationId } }');

const B = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const W = (file_path, content = 'x') => ({ tool_name: 'Write', tool_input: { file_path, content } });
const E = (file_path, old_string, new_string) => ({ tool_name: 'Edit', tool_input: { file_path, old_string, new_string } });
const R = (file_path) => ({ tool_name: 'Read', tool_input: { file_path } });

const cases = [
  // production and deploys
  ['', B('sf project deploy start --source-dir force-app --target-org prod'), 'deny'],
  ['', B('sf data query -q "select id from account" --target-org client-live'), 'deny'],
  ['', B('sf org login jwt --client-id x --username u --jwt-key-file k --instance-url https://login.salesforce.com --alias ci'), 'allow'],
  ['', B('sf org login web --alias prod --instance-url https://acme.my.salesforce.com'), 'deny'],
  ['', B('sf org login jwt --client-id x --username u --jwt-key-file k --instance-url https://test.salesforce.com --alias ci-dev-test'), 'allow'],
  ['', B('sf org login web --alias qa --instance-url https://acme--qa.sandbox.my.salesforce.com'), 'allow'],
  ['', B('sf org login web --alias x --instance-url https://acme.my.salesforce.com'), 'allow'],
  ['developer', B('sf project deploy start --source-dir force-app --target-org dev'), 'deny'],
  ['developer', B('sf project deploy validate --source-dir force-app --target-org dev --test-level RunSpecifiedTests --tests FooTest'), 'allow'],
  ['developer', B('sf project deploy start --dry-run --source-dir force-app --target-org dev'), 'allow'],
  ['tester', B('sf project deploy start --source-dir force-app --target-org qa'), 'allow'],
  ['tester', B('sf project deploy start --source-dir force-app --target-org dev'), 'deny'],
  ['tester', B('sf project deploy start --source-dir force-app'), 'deny'],
  ['architect', B('sf sobject describe --sobject Case --target-org dev'), 'allow'],
  ['', B('sf org display --target-org dev --verbose'), 'deny'],
  // git and GitHub
  ['', B('git push origin main'), 'deny'],
  ['', B('git push origin HEAD:main'), 'deny'],
  ['', B('git push -u origin spec/001-case-escalation'), 'allow'],
  ['developer', B('git push --force origin feature/ABC-1-x'), 'deny'],
  ['', B('gh pr merge 12 --squash'), 'deny'],
  ['', B('gh pr review 12 --approve'), 'deny'],
  ['', B('gh pr review 12 --comment -b "looks fine"'), 'allow'],
  ['', B('gh api -X PUT repos/o/r/pulls/12/merge'), 'deny'],
  ['developer', B('gh pr edit 12 --add-label plan-approved'), 'deny'],
  ['architect', B('gh api -X POST repos/o/r/rulesets --input ruleset.json'), 'deny'],
  ['', B('gh api -X POST repos/o/r/rulesets --input ruleset.json'), 'allow'],
  ['architect', B('gh api repos/o/r/rulesets'), 'allow'],
  ['tester', B('gh api repos/o/r/environments/production --jq .protection_rules'), 'allow'],
  ['', B('gh workflow run deploy-prod.yml'), 'deny'],
  ['', B('cat ~/.sfkeys/dev.key'), 'deny'],
  ['', B('echo hello && git status'), 'allow'],
  // files and separation of duties
  ['developer', W('test-cases/001-x-story-02.sf-tests.yaml'), 'deny'],
  ['developer', W('.specify/specs/001-x/tests/story_02.tc.json'), 'deny'],
  ['developer', W('force-app/main/default/classes/Foo.cls'), 'allow'],
  ['developer', W('docs/plans/ABC-1/PLAN.md'), 'allow'],
  ['tester', W('force-app/main/default/classes/Foo.cls'), 'deny'],
  ['tester', W('test-cases/001-x-story-02.sf-tests.yaml'), 'allow'],
  ['architect', W('force-app/main/default/objects/Case/fields/X__c.field-meta.xml'), 'deny'],
  ['architect', W('.specify/specs/001-x/spec.md'), 'allow'],
  ['architect', W('.github/workflows/x.yml'), 'deny'],
  ['', W('.github/workflows/x.yml'), 'allow'],
  ['architect', E('.specify/specs/001-x/plan.md', '- Overall Sign-Off: [ ] APPROVED', '- Overall Sign-Off: [x] APPROVED'), 'deny'],
  ['', E('.specify/specs/001-x/plan.md', '- Overall Sign-Off: [ ] APPROVED', '- Overall Sign-Off: [x] APPROVED'), 'deny'],
  ['architect', E('.specify/specs/001-x/plan.md', '## Architect Sign-Off', '## Architect Sign-Off (pending)'), 'allow'],
  ['', R('server.key'), 'deny'],
  ['', R('.env.local'), 'deny'],
  ['', R('force-app/main/default/classes/Foo.cls'), 'allow'],
  // v3: PRs. Architects never create PRs; the Developer's Claude opens draft PRs only; Testers commit to the story PR.
  ['architect', B('gh pr create --draft --base main --title "ACME-12 Shipping rates" --body x'), 'deny'],
  ['architect', B('git status && gh pr create --title "ACME-12 x" --body x'), 'deny'],
  ['architect', B('gh api -X POST repos/acme-org/acme-shipping/pulls -f title=x -f head=feature/ACME-12-x -f base=main'), 'deny'],
  ['architect', B('gh api repos/acme-org/acme-shipping/pulls --jq ".[].title"'), 'allow'],
  ['architect', B('gh pr list --search "ACME-12 in:title"'), 'allow'],
  ['developer', B('gh pr create --draft --base main --head feature/ACME-12-shipping-rates --title "ACME-12 Shipping rates" --body-file .ai/pr.md'), 'allow'],
  ['developer', B('gh pr create -d --title "ACME-12 x" --body x'), 'allow'],
  ['developer', B('gh pr create --base main --title "ACME-12 x" --body x'), 'deny'],
  ['developer', B('gh api -X POST repos/acme-org/acme-shipping/pulls -f title=x -f draft=true'), 'allow'],
  ['tester', B('gh pr create --draft --title "ACME-12 tests" --body x'), 'deny'],
  ['', B('gh pr create --title "ACME-12 x" --body x'), 'allow'],
  // v3: files. tests/ (tc index) belongs to the Tester; docs/plans to the Developer.
  ['tester', W('tests/ACME-12.tc.json'), 'allow'],
  ['tester', W('test-cases/ACME-12.sf-tests.yaml'), 'allow'],
  ['tester', W('docs/plans/ACME-12/PLAN.md'), 'deny'],
  ['developer', W('tests/ACME-12.tc.json'), 'deny'],
  ['developer', W('test-cases/ACME-12.sf-tests.yaml'), 'deny'],
  ['architect', W('tests/ACME-12.tc.json'), 'deny'],
  ['architect', W('docs/plans/ACME-12/PLAN.md'), 'deny'],
  ['architect', W('.specify/specs/001-shipping-rates/spec.md'), 'allow'],
  // v3: no stored credentials
  ['', B('gh secret set CLAUDE_CODE_OAUTH_TOKEN -R acme-org/acme-shipping'), 'deny'],
  ['', B('gh secret set JIRA_API_TOKEN < token.txt'), 'deny'],
  ['', B('gh secret set SF_JWT_KEY < server.key'), 'deny'],
  ['', B('gh variable set MAX_AI_ATTEMPTS --body 3'), 'allow'],
  ['', B('claude setup-token'), 'deny'],
  ['', B('export ANTHROPIC_API_KEY=sk-ant-x'), 'deny'],
  ['', B('echo sk-ant-x | acli jira auth login --site acme.atlassian.net --email demo.user@example.com --token'), 'deny'],
  ['', B('acli jira auth login --web'), 'allow'],
  ['architect', B('acli jira auth login --web'), 'deny'],
  ['architect', B('acli jira auth status'), 'allow'],
  ['architect', B('acli jira workitem search --jql "project = ACME AND labels = cref-001-02" --json'), 'allow'],
  // v3: G1 and G2 stay human, also through MCP tools and acli
  ['architect', { tool_name: 'mcp__atlassian__setConfluenceContentStatus', tool_input: { contentId: '123', status: 'Approved' } }, 'deny'],
  ['architect', { tool_name: 'mcp__claude_ai_Atlassian__setConfluenceContentStatus', tool_input: { contentId: '123', status: 'Approved' } }, 'deny'],
  ['architect', { tool_name: 'mcp__atlassian__setConfluenceContentStatus', tool_input: { contentId: '123', status: 'Ready for review' } }, 'allow'],
  ['architect', { tool_name: 'mcp__atlassian__updateConfluenceContent', tool_input: { contentId: '123', body: 'Decisions' } }, 'allow'],
  ['tester', { tool_name: 'mcp__atlassian__editJiraIssue', tool_input: { issueIdOrKey: 'ACME-12', fields: { labels: ['ai-ready'] } } }, 'deny'],
  ['tester', { tool_name: 'mcp__atlassian__addOrEditJiraIssueComment', tool_input: { issueIdOrKey: 'ACME-12', body: 'Testability looks fine' } }, 'allow'],
  ['tester', B('acli jira workitem edit --key ACME-12 --labels ai-ready --yes'), 'deny'],
  ['developer', { tool_name: 'mcp__slack__slack_send_message', tool_input: { channel: 'review-room', text: 'Review room for ACME-12' } }, 'allow'],
  // v3 review fixes: PR creation aliases, GraphQL and true draft flags
  ['architect', B('gh pr new --title x --body y'), 'deny'],
  ['tester', B('gh pr new --draft --title x --body y'), 'deny'],
  ['architect', B(`gh api graphql -f query='mutation{createPullRequest(input:{repositoryId:"R_1",baseRefName:"main",headRefName:"feature/ACME-12-x",title:"x"}){pullRequest{number}}}'`), 'deny'],
  ['developer', B(`gh api graphql -f query='mutation{createPullRequest(input:{repositoryId:"R_1",baseRefName:"main",headRefName:"feature/ACME-12-x",title:"x",draft:true}){pullRequest{number}}}'`), 'allow'],
  ['developer', B(`gh api graphql -f query='mutation{createPullRequest(input:{repositoryId:"R_1",baseRefName:"main",headRefName:"feature/ACME-12-x",title:"x"}){pullRequest{number}}}'`), 'deny'],
  ['developer', B('gh pr create --draft=false --title "ACME-12 x" --body x'), 'deny'],
  ['developer', B('gh pr create -d=false --title "ACME-12 x" --body x'), 'deny'],
  ['developer', B('gh pr create --draft=true --title "ACME-12 x" --body x'), 'allow'],
  ['developer', B('gh pr new --draft --title "ACME-12 x" --body x'), 'allow'],
  ['developer', B('gh pr new --title "ACME-12 x" --body x'), 'deny'],
  ['developer', B('gh api -X POST repos/acme-org/acme-shipping/pulls -f title=x -F draft=false'), 'deny'],
  ['developer', B('gh api -X POST repos/acme-org/acme-shipping/pulls -f title=x -f head=feature/ACME-12-x'), 'deny'],
  // ready for review is the human Developer's step
  ['developer', B('gh pr ready 12'), 'deny'],
  ['developer', B('gh pr ready 12 --undo'), 'allow'],
  ['', B('gh pr ready 12'), 'allow'],
  ['developer', B(`gh api graphql -f query='mutation{markPullRequestReadyForReview(input:{pullRequestId:"PR_x"}){clientMutationId}}'`), 'deny'],
  ['developer', B('gh api -X PATCH repos/acme-org/acme-shipping/pulls/12 -F draft=false'), 'deny'],
  ['developer', B('gh api -X PATCH repos/acme-org/acme-shipping/pulls/12 -f title="ACME-12 better title"'), 'allow'],
  // approvals and merges through GraphQL / other REST routes
  ['architect', B(`gh api graphql -f query='mutation{addPullRequestReview(input:{pullRequestId:"PR_x",event:APPROVE}){clientMutationId}}'`), 'deny'],
  ['developer', B(`gh api graphql -f query='mutation{submitPullRequestReview(input:{pullRequestReviewId:"PRR_x",event:APPROVE}){clientMutationId}}'`), 'deny'],
  ['developer', B(`gh api graphql -f query='mutation{addPullRequestReview(input:{pullRequestId:"PR_x",event:COMMENT,body:"nit"}){clientMutationId}}'`), 'allow'],
  ['architect', B(`gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:"PR_x"}){clientMutationId}}'`), 'deny'],
  ['', B(`gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{pullRequestId:"PR_x"}){clientMutationId}}'`), 'deny'],
  ['architect', B('gh api graphql -F query=@mutation.graphql'), 'deny'],
  ['architect', B('gh api -X POST repos/acme-org/acme-shipping/merges -f base=main -f head=feature/ACME-12-x'), 'deny'],
  ['architect', B(`gh api graphql -f query='query{repository(owner:"acme-org",name:"acme-shipping"){pullRequest(number:12){reviewDecision}}}'`), 'allow'],
  ['architect', B('gh api -X POST repos/acme-org/acme-shipping/pulls/12/reviews -f event=APPROVE'), 'deny'],
  // gate labels G3/G4 through any gh route
  ['developer', B('gh issue edit 42 --add-label plan-approved'), 'deny'],
  ['tester', B('gh api repos/acme-org/acme-shipping/issues/12/labels -f "labels[]=testplan-approved"'), 'deny'],
  ['tester', B('gh api -X POST repos/acme-org/acme-shipping/issues/12/labels --input labels.json -f x=testplan-approved'), 'deny'],
  ['developer', B('gh label create plan-approved --color 0e8a16'), 'deny'],
  ['developer', B(`gh api graphql -f query='mutation{addLabelsToLabelable(input:{labelableId:"PR_x",labelIds:["LA_1"]}){clientMutationId}}'`), 'deny'],
  ['developer', B('gh pr edit 12 --add-label needs-human'), 'allow'],
  ['developer', B('gh pr list --label plan-approved'), 'allow'],
  ['developer', B('gh api repos/acme-org/acme-shipping/issues/12/labels --jq ".[].name"'), 'allow'],
  // G1 in Jira: the Approve design transition and the epic's Approved design version stay human
  ['architect', { tool_name: 'mcp__atlassian__transitionJiraIssue', tool_input: { issueIdOrKey: 'ACME-1', transition: { name: 'Approve design' }, fields: { customfield_10050: '4' } } }, 'deny'],
  ['architect', { tool_name: 'mcp__atlassian__transitionJiraIssue', tool_input: { issueIdOrKey: 'ACME-1', transition: { id: '31' } } }, 'deny'],
  ['architect', { tool_name: 'mcp__claude_ai_Atlassian__transitionJiraIssue', tool_input: { issueIdOrKey: 'ACME-1', transition: { name: 'approve_design' } } }, 'deny'],
  ['architect', { tool_name: 'mcp__atlassian__transitionJiraIssue', tool_input: { issueIdOrKey: 'ACME-9', transition: { id: '21' }, fields: { customfield_10050: 4 } } }, 'deny'],
  ['architect', { tool_name: 'mcp__atlassian__transitionJiraIssue', tool_input: { issueIdOrKey: 'ACME-1', transition: { id: '11', name: 'Design Review' } } }, 'allow'],
  ['architect', { tool_name: 'mcp__atlassian__editJiraIssue', tool_input: { issueIdOrKey: 'ACME-1', fields: { customfield_10050: 4 } } }, 'deny'],
  ['architect', { tool_name: 'mcp__atlassian__editJiraIssue', tool_input: { issueIdOrKey: 'ACME-77', fields: { issuetype: { name: 'Epic' }, 'Approved design version': 4 } } }, 'deny'],
  ['architect', { tool_name: 'mcp__atlassian__createJiraIssue', tool_input: { projectKey: 'ACME', issueTypeName: 'Epic', summary: '[001] Shipping rates', additional_fields: { customfield_10050: 3 } } }, 'deny'],
  ['architect', { tool_name: 'mcp__atlassian__createJiraIssue', tool_input: { projectKey: 'ACME', issueTypeName: 'Epic', summary: '[001] Shipping rates' } }, 'allow'],
  ['architect', { tool_name: 'mcp__atlassian__editJiraIssue', tool_input: { issueIdOrKey: 'ACME-2', fields: { customfield_10050: 3 } } }, 'allow'],
  ['architect', { tool_name: 'mcp__atlassian__createJiraIssue', tool_input: { projectKey: 'ACME', issueTypeName: 'Story', summary: '[001-S02] x', additional_fields: { customfield_10050: 3 } } }, 'allow'],
  // A version message never stands in for G1
  ['developer', { tool_name: 'mcp__atlassian__updateConfluencePage', tool_input: { pageId: '123456', body: 'x', versionMessage: 'Approved v5' } }, 'deny'],
  ['architect', { tool_name: 'mcp__claude_ai_Atlassian__updateConfluencePage', tool_input: { pageId: '123456', body: 'x', version: { message: 'approved by arch' } } }, 'deny'],
  ['architect', { tool_name: 'mcp__atlassian__updateConfluencePage', tool_input: { pageId: '123456', body: 'Decision: approved vendor list', versionMessage: 'Decisions D4' } }, 'allow'],
  ['architect', { tool_name: 'mcp__atlassian__getConfluenceContentState', tool_input: { contentId: '123456', note: 'approved?' } }, 'allow'],
  // Shell writes follow the file rules: the Developer cannot write tests/; nobody writes scripts/ or .github/
  ['developer', B('echo x > tests/ACME-12.tc.json'), 'deny'],
  ['developer', B("cat > tests/ACME-12.tc.json <<'EOF'\n{}\nEOF"), 'deny'],
  ['developer', B('echo cases | tee test-cases/ACME-12.sf-tests.yaml'), 'deny'],
  ['developer', B('cp /tmp/x.yaml test-cases/ACME-12.sf-tests.yaml'), 'deny'],
  ['developer', B("sed -i 's/a/b/' tests/ACME-12.tc.json"), 'deny'],
  ['developer', B('git checkout origin/qa -- tests/ACME-12.tc.json'), 'deny'],
  ['developer', { tool_name: 'PowerShell', tool_input: { command: 'Set-Content -Path tests/ACME-12.tc.json -Value "{}"' } }, 'deny'],
  ['developer', B('echo "process.exit(0)" > scripts/ci/design-gate.mjs'), 'deny'],
  ['architect', B('printf "" > scripts/ci/protected-paths.txt'), 'deny'],
  ['tester', B('echo x >> .github/workflows/pr-checks.yml'), 'deny'],
  ['developer', W('scripts/ci/design-gate.mjs'), 'deny'],
  ['tester', B('echo x > tests/ACME-12.tc.json'), 'allow'],
  ['developer', B('echo x > force-app/main/default/classes/Foo.cls'), 'allow'],
  ['developer', B('sf project deploy validate --target-org dev 2>&1 > .ai/validate.log'), 'allow'],
  ['developer', B('npm test > /dev/null 2>&1'), 'allow'],
  ['', B('echo x > tests/ACME-12.tc.json'), 'allow'],
];

let fail = 0;
for (const [persona, input, expected] of cases) {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ ...input, cwd: proj }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, CIRCUIT_PERSONA: persona },
    encoding: 'utf8',
  });
  const got = res.stdout.includes('"deny"') ? 'deny' : 'allow';
  const label = `${(persona || '-').padEnd(9)} ${input.tool_name.padEnd(5)} ${JSON.stringify(input.tool_input).slice(0, 90)}`;
  if (got !== expected || res.status !== 0) { fail++; console.log(`FAIL ${label}\n     expected ${expected}, got ${got} (exit ${res.status}) ${res.stderr}`); }
  else console.log(`ok   ${label}`);
}
// A command without --target-org is checked against the project's default org
const proj2 = mkdtempSync(join(tmpdir(), 'circuit-guard-default-'));
mkdirSync(join(proj2, '.sf'), { recursive: true });
writeFileSync(join(proj2, '.sf', 'config.json'), JSON.stringify({ 'target-org': 'salesOrgSDO' }));
const defaultCases = [
  [B('sf data query -q "select id from account"'), 'deny'],
  [B('sf project retrieve start -m ApexClass'), 'deny'],
  [B('sf data query -q "select id from account" --target-org dev'), 'allow'],
  [B('sf org list'), 'allow'],
  [B('sf config set target-org dev'), 'allow'],
];
for (const [input, expected] of defaultCases) {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ ...input, cwd: proj2 }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj2, CIRCUIT_PERSONA: '', CIRCUIT_PROD_ALIASES: 'salesOrgSDO', SF_TARGET_ORG: '' },
    encoding: 'utf8',
  });
  const got = res.stdout.includes('"deny"') ? 'deny' : 'allow';
  if (got !== expected) { fail++; console.log(`FAIL default-org ${input.tool_input.command}: expected ${expected}, got ${got}`); }
  else console.log(`ok   default-org ${input.tool_input.command}`);
}
cases.push(...defaultCases);

// v3: on a story branch the Tester commits only tests/ and test-cases/
const proj3 = mkdtempSync(join(tmpdir(), 'circuit-guard-story-'));
const g = (...args) => spawnSync('git', args, { cwd: proj3, encoding: 'utf8' });
g('init', '-q'); g('checkout', '-q', '-b', 'feature/ACME-12-shipping-rates');
for (const d of ['tests', 'test-cases', 'force-app']) mkdirSync(join(proj3, d), { recursive: true });
writeFileSync(join(proj3, 'tests', 'ACME-12.tc.json'), '{}');
writeFileSync(join(proj3, 'test-cases', 'ACME-12.sf-tests.yaml'), 'cases: []');
writeFileSync(join(proj3, 'force-app', 'Foo.cls'), 'class Foo {}');
const storyCases = [];
const check = (name, persona, input, expected) => {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ ...input, cwd: proj3 }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj3, CIRCUIT_PERSONA: persona }, encoding: 'utf8',
  });
  const got = res.stdout.includes('"deny"') ? 'deny' : 'allow';
  storyCases.push(name);
  if (got !== expected) { fail++; console.log(`FAIL story-branch ${name}: expected ${expected}, got ${got} ${res.stdout}`); }
  else console.log(`ok   story-branch ${name}`);
};
g('add', 'tests', 'test-cases');
check('tester commits tests/ + test-cases/', 'tester', B('git commit -m "ACME-12 tests: suite and tc index"'), 'allow');
check('tester commits with pathspec force-app', 'tester', B('git commit -m x -- force-app/Foo.cls'), 'deny');
check('tester commits -a with untracked force-app only', 'tester', B('git commit -am "ACME-12 tests"'), 'allow');
g('add', 'force-app');
check('tester commits staged force-app', 'tester', B('git add tests && git commit -m "ACME-12 tests"'), 'deny');
check('developer commits staged force-app', 'developer', B('git commit -m "ACME-12 build"'), 'allow');
g('reset', '-q');
g('add', 'tests');
check('tester commits tests only', 'tester', B('git commit -m "ACME-12 tests"'), 'allow');
g('checkout', '-q', '-b', 'qa/notes');
g('add', 'force-app');
check('tester commit off a story branch is not restricted here', 'tester', B('git commit -m notes'), 'allow');
cases.push(...storyCases);

// Plugin mode steps aside when the project ships its own guard
mkdirSync(join(proj, '.claude', 'hooks'), { recursive: true });
writeFileSync(join(proj, '.claude', 'hooks', 'circuit-guard.mjs'), '// project copy');
const pm = spawnSync(process.execPath, [GUARD, '--plugin'], {
  input: JSON.stringify({ ...B('gh pr merge 1'), cwd: proj }),
  env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, encoding: 'utf8',
});
if (pm.stdout.includes('deny')) { fail++; console.log('FAIL plugin mode did not step aside'); } else console.log('ok   plugin mode steps aside for project guard');

// The hook matchers must send MCP tool calls to the guard, or the G1 / G2 MCP rules above never run.
let extra = 0;
for (const rel of [['hooks', 'hooks.json'], ['templates', 'repo', '.claude', 'settings.json']]) {
  extra++;
  const cfg = JSON.parse(readFileSync(join(here, '..', ...rel), 'utf8'));
  const matchers = (cfg.hooks?.PreToolUse ?? []).map((h) => h.matcher);
  const re = matchers.length ? new RegExp(`^(?:${matchers.join('|')})$`) : null;
  const ok = !!re && ['Bash', 'Write', 'Read', 'mcp__atlassian__setConfluenceContentStatus', 'mcp__claude_ai_Atlassian__editJiraIssue'].every((t) => re.test(t));
  if (!ok) { fail++; console.log(`FAIL ${rel.join('/')} PreToolUse matcher does not cover Bash/Write/Read and mcp__ tools: ${matchers.join(', ')}`); }
  else console.log(`ok   ${rel.join('/')} matcher covers MCP tools`);
}

console.log(`\n${cases.length + 1 + extra - fail}/${cases.length + 1 + extra} passed`);
process.exit(fail ? 1 : 0);
