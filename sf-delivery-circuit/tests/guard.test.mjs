// Run: node sf-delivery-circuit/tests/guard.test.mjs
// Table-driven tests for circuit-guard. Each case: persona, tool, input, expected (deny|allow).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

const B = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const W = (file_path, content = 'x') => ({ tool_name: 'Write', tool_input: { file_path, content } });
const E = (file_path, old_string, new_string) => ({ tool_name: 'Edit', tool_input: { file_path, old_string, new_string } });
const R = (file_path) => ({ tool_name: 'Read', tool_input: { file_path } });

const cases = [
  // production and deploys
  ['', B('sf project deploy start --source-dir force-app --target-org prod'), 'deny'],
  ['', B('sf data query -q "select id from account" --target-org client-live'), 'deny'],
  ['', B('sf org login jwt --client-id x --username u --jwt-key-file k --instance-url https://login.salesforce.com --alias ci'), 'deny'],
  ['', B('sf org login jwt --client-id x --username u --jwt-key-file k --instance-url https://test.salesforce.com --alias ci-dev-test'), 'allow'],
  ['', B('sf org login web --alias qa --instance-url https://acme--qa.sandbox.my.salesforce.com'), 'allow'],
  ['', B('sf org login web --alias x --instance-url https://acme.my.salesforce.com'), 'deny'],
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

// Plugin mode steps aside when the project ships its own guard
mkdirSync(join(proj, '.claude', 'hooks'), { recursive: true });
writeFileSync(join(proj, '.claude', 'hooks', 'circuit-guard.mjs'), '// project copy');
const pm = spawnSync(process.execPath, [GUARD, '--plugin'], {
  input: JSON.stringify({ ...B('gh pr merge 1'), cwd: proj }),
  env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, encoding: 'utf8',
});
if (pm.stdout.includes('deny')) { fail++; console.log('FAIL plugin mode did not step aside'); } else console.log('ok   plugin mode steps aside for project guard');

console.log(`\n${cases.length + 1 - fail}/${cases.length + 1} passed`);
process.exit(fail ? 1 : 0);
