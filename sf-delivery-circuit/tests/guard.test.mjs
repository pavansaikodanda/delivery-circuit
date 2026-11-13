// Run: node --test sf-delivery-circuit/tests/guard.test.mjs   (or: node sf-delivery-circuit/tests/guard.test.mjs)
// Table-driven tests for circuit-guard v4 (CIRCUIT-V4 section 6). Each case: tool input, expected (deny|allow).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, '..', 'templates', 'repo', '.claude', 'hooks', 'circuit-guard.mjs');

// A project whose DEV alias is "acme-dev" and whose production alias is "client-live" (build.config.yml).
const proj = mkdtempSync(join(tmpdir(), 'circuit-guard-'));
writeFileSync(join(proj, 'build.config.yml'), [
  'github:', '  org: acme-org', 'salesforce:', '  dev_alias: acme-dev      # your own DEV sandbox', '  prod_alias: client-live',
  'environments:', '  - { branch: "sprint/*", environment: qa, test_level: RunLocalTests }', '',
].join('\n'));
writeFileSync(join(proj, 'mutation.graphql'), 'mutation { mergePullRequest(input: { pullRequestId: "PR_x" }) { clientMutationId } }');

const B = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const PS = (command) => ({ tool_name: 'PowerShell', tool_input: { command } });
const W = (file_path, content = 'x') => ({ tool_name: 'Write', tool_input: { file_path, content } });
const R = (file_path) => ({ tool_name: 'Read', tool_input: { file_path } });
const M = (name, tool_input) => ({ tool_name: `mcp__${name}`, tool_input });

const cases = [
  // production is off limits; deploys and validates go to the DEV alias only
  [B('sf project deploy start --source-dir force-app --target-org prod'), 'deny'],
  [B('sf data query -q "select id from account" --target-org client-live'), 'deny'],
  [B('sf org login web --alias prod --instance-url https://acme.my.salesforce.com'), 'deny'],
  [B('sf org login web --alias qa --instance-url https://acme--qa.sandbox.my.salesforce.com'), 'allow'],
  [B('sf project deploy start --source-dir force-app --target-org acme-dev'), 'allow'],
  [B('sf project deploy validate --source-dir force-app --target-org acme-dev --test-level RunSpecifiedTests --tests FooTest'), 'allow'],
  [B('sf project deploy start --dry-run --source-dir force-app --target-org acme-dev'), 'allow'],
  [B('sf project deploy start --source-dir force-app --target-org qa'), 'deny'],
  [B('sf project deploy validate --source-dir force-app --target-org uat'), 'deny'],
  [B('sf project deploy start --dry-run --source-dir force-app -o sit'), 'deny'],
  [B('sf project deploy quick --job-id 0Af000000000001 --target-org qa'), 'deny'],
  [B('sf project deploy start --source-dir force-app'), 'deny'],
  [B('sfdx force:source:deploy -p force-app -u qa'), 'deny'],
  [B('sf project delete source -m ApexClass:Foo --target-org qa'), 'deny'],
  [B('sf sobject describe --sobject Case --target-org acme-dev'), 'allow'],
  [B('sf data query -q "SELECT ApiName FROM FlowDefinitionView" --target-org acme-dev'), 'allow'],
  [B('sf data query -q "SELECT Id FROM Case" --target-org qa'), 'allow'],
  [B('sf apex run test --target-org acme-dev --tests FooTest'), 'allow'],
  [PS('sf project deploy start --source-dir force-app --target-org qa'), 'deny'],
  // secrets: SFDX_AUTH_URL, sf org display --verbose, gh secret set, key and session files
  [B('sf org display --target-org acme-dev --verbose'), 'deny'],
  [B('sf org display --target-org acme-dev --verbose --json | jq -r .result.sfdxAuthUrl'), 'deny'],
  [B('sf org display --target-org acme-dev'), 'allow'],
  [B('echo $SFDX_AUTH_URL'), 'deny'],
  [PS('Write-Output $env:SFDX_AUTH_URL'), 'deny'],
  [B('gh secret set SFDX_AUTH_URL --env qa --body "force://PlatformCLI::abc@acme--qa.sandbox.my.salesforce.com"'), 'deny'],
  [B('gh secret set SFDX_AUTH_URL --env qa < auth.txt'), 'deny'],
  [B('gh secret set SFDX_AUTH_URL --env qa'), 'deny'],
  [B('gh secret list --env qa'), 'allow'],
  [B('sf org login sfdx-url --sfdx-url-file auth.txt --alias qa'), 'allow'],
  [B('cat ~/.sfkeys/dev.key'), 'deny'],
  [B('cat .env'), 'deny'],
  [R('server.key'), 'deny'],
  [R('.env.local'), 'deny'],
  [R('force-app/main/default/classes/Foo.cls'), 'allow'],
  // environment branches change only through PRs
  [B('git push origin main'), 'deny'],
  [B('git push origin HEAD:main'), 'deny'],
  [B('git push origin feature/ACME-12-x:refs/heads/dev'), 'deny'],
  [B('git push origin sprint/2026-11'), 'deny'],
  [B('git push --force origin uat'), 'deny'],
  [B('git push origin +sit'), 'deny'],
  [B('git push origin --delete sprint/2026-11'), 'deny'],
  [B('git push origin :dev'), 'deny'],
  [B('git push --all origin'), 'deny'],
  [B('git push -u origin feature/ACME-12-case-escalation'), 'allow'],
  [B('git push --force-with-lease origin feature/ACME-12-case-escalation'), 'allow'],
  [B('git push origin --delete feature/ACME-12-old'), 'allow'],
  [B('gh api -X DELETE repos/acme-org/acme-sf/git/refs/heads/dev'), 'deny'],
  [B('gh api -X PATCH repos/acme-org/acme-sf/git/refs/heads/main -f sha=abc -F force=true'), 'deny'],
  [B('gh api repos/acme-org/acme-sf/git/refs/heads/main'), 'allow'],
  [B('gh api -X PUT repos/acme-org/acme-sf/contents/README.md -f message=x -f content=eA== -f branch=main'), 'deny'],
  // approvals and merges stay with people; auto-merge on a feature PR is allowed
  [B('gh pr merge 12 --squash'), 'deny'],
  [B('gh pr merge 12 --auto --squash'), 'allow'],
  [B('gh pr merge feature/ACME-12-case-escalation --auto --squash'), 'allow'],
  [B('gh pr merge sprint/2026-11 --auto --merge'), 'deny'],
  [B('gh pr merge 12 --auto --admin --squash'), 'deny'],
  [B('gh pr merge 12 --disable-auto'), 'allow'],
  [B('gh pr review 12 --approve'), 'deny'],
  [B('gh pr review 12 --comment -b "looks fine"'), 'allow'],
  [B('gh pr create --base sprint/2026-11 --head feature/ACME-12-x --title "ACME-12 x" --body-file .ai/pr.md'), 'allow'],
  [B('gh pr create --draft --base sprint/2026-11 --title "ACME-12 x" --body x'), 'allow'],
  [B('gh api -X PUT repos/acme-org/acme-sf/pulls/12/merge'), 'deny'],
  [B('gh api -X POST repos/acme-org/acme-sf/merges -f base=main -f head=feature/ACME-12-x'), 'deny'],
  [B('gh api -X POST repos/acme-org/acme-sf/pulls/12/reviews -f event=APPROVE'), 'deny'],
  [B(`gh api graphql -f query='mutation{addPullRequestReview(input:{pullRequestId:"PR_x",event:APPROVE}){clientMutationId}}'`), 'deny'],
  [B(`gh api graphql -f query='mutation{addPullRequestReview(input:{pullRequestId:"PR_x",event:COMMENT,body:"nit"}){clientMutationId}}'`), 'allow'],
  [B(`gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:"PR_x"}){clientMutationId}}'`), 'deny'],
  [B('gh api graphql -F query=@mutation.graphql'), 'deny'],
  [B(`gh api graphql -f query='query{repository(owner:"acme-org",name:"acme-sf"){pullRequest(number:12){reviewDecision}}}'`), 'allow'],
  [B('gh workflow run deploy.yml --ref uat'), 'deny'],
  [B('gh pr edit 12 --add-label needs-human'), 'allow'],
  [B('echo hello && git status'), 'allow'],
  // people approve the design and move stories
  [M('atlassian__setConfluenceContentStatus', { contentId: '123', status: 'Approved' }), 'deny'],
  [M('claude_ai_Atlassian__setConfluenceContentStatus', { contentId: '123', status: 'Approved' }), 'deny'],
  [M('atlassian__setConfluenceContentStatus', { contentId: '123', status: 'Ready for review' }), 'allow'],
  [M('atlassian__getConfluenceContentState', { contentId: '123' }), 'allow'],
  [M('atlassian__updateConfluencePage', { pageId: '123', body: 'Decisions: approved vendor list' }), 'allow'],
  [M('atlassian__transitionJiraIssue', { issueIdOrKey: 'ACME-12', transition: { name: 'Ready for Dev' } }), 'deny'],
  [M('claude_ai_Atlassian__transitionJiraIssue', { issueIdOrKey: 'ACME-12', transition: { name: 'Done' } }), 'deny'],
  [M('atlassian__transitionJiraIssue', { issueIdOrKey: 'ACME-12', transition: { name: 'In Progress' } }), 'allow'],
  [M('atlassian__editJiraIssue', { issueIdOrKey: 'ACME-12', fields: { status: { name: 'Done' } } }), 'deny'],
  [M('atlassian__createJiraIssue', { projectKey: 'ACME', issueTypeName: 'Story', summary: 'Escalate a case', additional_fields: { labels: ['circuit', 'feature-case-escalation'] } }), 'allow'],
  [M('atlassian__addCommentToJiraIssue', { issueIdOrKey: 'ACME-12', commentBody: 'QA: done with manual cases, 2 failed' }), 'allow'],
  [B('acli jira workitem transition --key ACME-12 --status "Done" --yes'), 'deny'],
  [M('slack__slack_send_message', { channel: 'acme-dev', text: 'CodeRabbit review summary for ACME-12' }), 'allow'],
  // v3 rules are gone: no persona PR rules, gate labels or file separation
  [W('force-app/main/default/classes/Foo.cls'), 'allow'],
  [W('test-cases/ACME-12.sf-tests.yaml'), 'allow'],
];

function run(input, cwd, env = {}) {
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ ...input, cwd }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, CIRCUIT_DEV_ALIAS: '', CIRCUIT_PROD_ALIASES: '', SF_TARGET_ORG: '', ...env },
    encoding: 'utf8',
  });
}
let fail = 0;
let total = 0;
const expect = (label, res, expected) => {
  total++;
  const got = res.stdout.includes('"deny"') ? 'deny' : 'allow';
  if (got !== expected || res.status !== 0) { fail++; console.log(`FAIL ${label}\n     expected ${expected}, got ${got} (exit ${res.status}) ${res.stderr}`); }
  else console.log(`ok   ${label}`);
};
for (const [input, expected] of cases) {
  expect(`${input.tool_name.padEnd(10)} ${JSON.stringify(input.tool_input).slice(0, 100)}`, run(input, proj), expected);
}

// Without build.config.yml the DEV alias is "dev"; a command without --target-org uses the project's default org.
const proj2 = mkdtempSync(join(tmpdir(), 'circuit-guard-default-'));
mkdirSync(join(proj2, '.sf'), { recursive: true });
writeFileSync(join(proj2, '.sf', 'config.json'), JSON.stringify({ 'target-org': 'salesOrgSDO' }));
for (const [input, expected] of [
  [B('sf data query -q "select id from account"'), 'deny'],
  [B('sf project retrieve start -m ApexClass'), 'deny'],
  [B('sf data query -q "select id from account" --target-org dev'), 'allow'],
  [B('sf project deploy start --source-dir force-app --target-org dev'), 'allow'],
  [B('sf project deploy start --source-dir force-app --target-org acme-dev'), 'deny'],
  [B('sf org list'), 'allow'],
  [B('sf config set target-org dev'), 'allow'],
]) expect(`default-org ${input.tool_input.command}`, run(input, proj2, { CIRCUIT_PROD_ALIASES: 'salesOrgSDO' }), expected);

// The default org is the DEV alias: a deploy without --target-org goes to DEV and is allowed.
const proj2b = mkdtempSync(join(tmpdir(), 'circuit-guard-devdefault-'));
mkdirSync(join(proj2b, '.sf'), { recursive: true });
writeFileSync(join(proj2b, '.sf', 'config.json'), JSON.stringify({ 'target-org': 'dev' }));
expect('dev-default sf project deploy start (no --target-org)', run(B('sf project deploy start --source-dir force-app'), proj2b), 'allow');

// Pushes and auto-merge without a branch name use the current branch.
const proj3 = mkdtempSync(join(tmpdir(), 'circuit-guard-branch-'));
const g = (...args) => spawnSync('git', args, { cwd: proj3, encoding: 'utf8' });
g('init', '-q');
g('checkout', '-q', '-b', 'sprint/2026-11');
expect('on sprint/2026-11: git push', run(B('git push'), proj3), 'deny');
expect('on sprint/2026-11: git push -u origin HEAD', run(B('git push -u origin HEAD'), proj3), 'deny');
expect('on sprint/2026-11: gh pr merge --auto --squash', run(B('gh pr merge --auto --squash'), proj3), 'deny');
g('checkout', '-q', '-b', 'feature/ACME-12-case-escalation');
expect('on feature/ACME-12: git push', run(B('git push'), proj3), 'allow');
expect('on feature/ACME-12: git push -u origin HEAD', run(B('git push -u origin HEAD'), proj3), 'allow');
expect('on feature/ACME-12: gh pr merge --auto --squash', run(B('gh pr merge --auto --squash'), proj3), 'allow');
expect('on feature/ACME-12: gh pr merge --auto --squash --subject "ACME-12 x"', run(B('gh pr merge --auto --squash --subject "ACME-12 x"'), proj3), 'allow');
expect('on feature/ACME-12: gh pr merge --squash', run(B('gh pr merge --squash'), proj3), 'deny');

// Plugin mode steps aside when the project ships its own guard
mkdirSync(join(proj, '.claude', 'hooks'), { recursive: true });
writeFileSync(join(proj, '.claude', 'hooks', 'circuit-guard.mjs'), '// project copy');
total++;
const pm = spawnSync(process.execPath, [GUARD, '--plugin'], {
  input: JSON.stringify({ ...B('gh pr merge 1'), cwd: proj }),
  env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, encoding: 'utf8',
});
if (pm.stdout.includes('deny')) { fail++; console.log('FAIL plugin mode did not step aside'); } else console.log('ok   plugin mode steps aside for project guard');

// The hook matchers must send Bash, Read and MCP tool calls to the guard, or the rules above never run.
for (const rel of [['hooks', 'hooks.json'], ['templates', 'repo', '.claude', 'settings.json']]) {
  total++;
  const cfg = JSON.parse(readFileSync(join(here, '..', ...rel), 'utf8'));
  const matchers = (cfg.hooks?.PreToolUse ?? []).map((h) => h.matcher);
  const re = matchers.length ? new RegExp(`^(?:${matchers.join('|')})$`) : null;
  const ok = !!re && ['Bash', 'PowerShell', 'Read', 'mcp__atlassian__setConfluenceContentStatus', 'mcp__claude_ai_Atlassian__transitionJiraIssue'].every((t) => re.test(t));
  if (!ok) { fail++; console.log(`FAIL ${rel.join('/')} PreToolUse matcher does not cover Bash/PowerShell/Read and mcp__ tools: ${matchers.join(', ')}`); }
  else console.log(`ok   ${rel.join('/')} matcher covers Bash, Read and MCP tools`);
}

// settings.json must not deny `gh pr merge` outright: that would block `gh pr merge --auto`.
total++;
const settings = JSON.parse(readFileSync(join(here, '..', 'templates', 'repo', '.claude', 'settings.json'), 'utf8'));
if ((settings.permissions?.deny ?? []).some((d) => /gh pr merge/.test(d))) { fail++; console.log('FAIL settings.json denies gh pr merge (blocks auto-merge)'); }
else console.log('ok   settings.json leaves gh pr merge to the guard');

console.log(`\n${total - fail}/${total} passed`);
process.exit(fail ? 1 : 0);
