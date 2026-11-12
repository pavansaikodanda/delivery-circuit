// Run: node sf-delivery-circuit/tests/jira-sync.test.mjs
// jira-sync v3: acli backend against a fake acli (idempotent, dry run writes nothing, labels people add survive),
// MCP backend ops + resolve/record, and no API-token code paths.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'skills', 'arch-jira-push', 'scripts', 'jira-sync.mjs');
const FAKE = join(here, 'fixtures', 'fake-acli.mjs');
const lib = await import(pathToFileURL(SCRIPT).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`ok   ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } };

const dir = mkdtempSync(join(tmpdir(), 'jira-sync-'));
const planPath = join(dir, 'jira-plan.json');
const statePath = join(dir, 'acli-state.json');
const mapPath = join(dir, 'jira-map.json');
const plan = {
  project: 'ACME', feature: '001-shipping-rates', labels: ['circuit', 'feature-001'],
  design: { pageId: '123456', url: 'https://acme.atlassian.net/wiki/spaces/ACME/pages/123456', approvedVersion: 7 },
  issues: [
    { ref: 'epic', type: 'Epic', summary: '[001] Shipping rates', description: 'Acme Shipping rate cards.' },
    { ref: '00', type: 'Story', parent: 'epic', summary: '[001-S00] Foundation: objects, fields, permission sets',
      description: 'Rate__c object and permission set.', acceptanceCriteria: 'Given an admin When deployed Then Rate__c exists',
      fields: { 'Story type': 'foundation' } },
    { ref: '02', type: 'Story', parent: 'epic', summary: '[001-S02] Agent sees the shipping rate',
      acceptanceCriteria: 'Given an Order When opened Then the rate shows', links: [{ type: 'Blocks', from: '00' }] },
  ],
};
writeFileSync(planPath, JSON.stringify(plan));

const run = (argv, env = {}) => spawnSync(process.execPath, [SCRIPT, ...argv], {
  encoding: 'utf8', env: { ...process.env, CIRCUIT_ACLI: FAKE, FAKE_ACLI_STATE: statePath, ...env },
});
const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
const writes = () => state().calls.filter(c => ['create', 'edit', 'link create'].includes(c)).length;

// --- pure helpers
ok('cref label', lib.crefLabel('001-shipping-rates', 'S02-TC-01') === 'cref-001-S02-TC-01');
const d00 = lib.desiredItem(plan, plan.issues[1]);
ok('story gets design fields', d00.fields['Design page'] === plan.design.url && d00.fields['Approved design version'] === 7 && /Given an admin/.test(d00.fields['Acceptance criteria']));
ok('description footer carries the approved version', /Approved design version: 7/.test(d00.description) && /Circuit ref: cref-001-00/.test(d00.description));
const dEpic = lib.desiredItem(plan, plan.issues[0]);
ok('epic gets the design link but never the approved version (G1 is human)', dEpic.fields['Design page'] === plan.design.url && !('Approved design version' in dEpic.fields));
ok('parser handles nested and flat shapes', lib.parseIssues({ data: [{ key: 'ACME-1', labels: 'a,b' }, { key: 'ACME-2', fields: { labels: ['c'] } }] }).length === 2);
let dup = false; try { lib.indexByCref([{ key: 'ACME-1', labels: ['cref-001-02'] }, { key: 'ACME-2', labels: ['cref-001-02'] }]); } catch { dup = true; }
ok('duplicate cref labels are refused', dup);
ok('lookup JQL lists every cref', lib.lookupJql(plan) === 'project = "ACME" AND labels in ("cref-001-epic", "cref-001-00", "cref-001-02")');

// --- acli backend
let r = run(['status']);
ok('status reports acli login', r.status === 0 && /"logged-in"/.test(r.stdout), r.stderr);
r = run(['push', '--plan', planPath]);
ok('dry run (auto -> acli) plans 3 creates', r.status === 0 && /DRY RUN \(acli\)/.test(r.stdout) && /creates: 3/.test(r.stdout), r.stdout + r.stderr);
ok('dry run writes nothing', writes() === 0 && !existsSync(mapPath));
const opsPath = join(dir, 'ops.json');
r = run(['push', '--plan', planPath, '--apply', '--ops', opsPath]);
ok('apply creates 3 work items and the link', r.status === 0 && state().issues.length === 3 && state().links.length === 1, r.stdout + r.stderr);
const s1 = state();
ok('children get the epic as parent', s1.issues.filter(i => i.parent === 'ACME-1').length === 2);
ok('link reads 00 blocks 02', s1.links[0].out === 'ACME-2' && s1.links[0].in === 'ACME-3' && s1.links[0].type === 'Blocks');
const ops = JSON.parse(readFileSync(opsPath, 'utf8')).ops;
ok('design fields become MCP editJiraIssue ops', ops.some(o => o.tool === 'editJiraIssue' && o.args.issueIdOrKey === 'ACME-3' && o.args.fields['Approved design version'] === 7));
const writesAfterApply = writes();
r = run(['push', '--plan', planPath, '--apply']);
ok('re-run is idempotent: 0 creates, 3 unchanged, no writes', /creates: 0, updates: 0, unchanged: 3/.test(r.stdout) && writes() === writesAfterApply && /link Blocks \(exists\)/.test(r.stdout), r.stdout + r.stderr);

// A person adds ai-ready (G2); a changed summary must update without dropping it.
const st = state(); st.issues.find(i => i.key === 'ACME-3').labels.push('ai-ready'); writeFileSync(statePath, JSON.stringify(st));
plan.issues[2].summary = '[001-S02] Agent sees the shipping rate on the Order'; writeFileSync(planPath, JSON.stringify(plan));
r = run(['push', '--plan', planPath, '--apply']);
const s3 = state().issues.find(i => i.key === 'ACME-3');
ok('changed story is updated, not duplicated', /creates: 0, updates: 1/.test(r.stdout) && state().issues.length === 3 && /on the Order/.test(s3.summary), r.stdout);
ok('labels people added survive an update', s3.labels.includes('ai-ready'));

// Lost local map (new laptop): items are found by label, never duplicated.
writeFileSync(mapPath, '{}');
r = run(['push', '--plan', planPath, '--apply']);
ok('lost map: found by cref label, 0 creates', /creates: 0/.test(r.stdout) && state().issues.length === 3, r.stdout);

// Test cases (qa-push-tests): the parent / link target is an existing story key, not a plan ref.
const tPlanPath = join(dir, 'jira-tests-ACME-3.json');
writeFileSync(tPlanPath, JSON.stringify({ project: 'ACME', feature: '001-shipping-rates', labels: ['circuit', 'test-case'], issues: [
  { ref: 'ACME-3-TC-01', type: 'Test Case', parent: 'ACME-3', summary: '[001-ACME-3-TC-01] Agent sees the rate', fields: { 'Test level': 'ui' } },
  { ref: 'ACME-3-TC-02', type: 'Test', summary: '[001-ACME-3-TC-02] Bulk 201 Orders', links: [{ type: 'Tests', to: 'ACME-3' }] },
] }));
r = run(['push', '--plan', tPlanPath, '--apply']);
const tcs = state().issues.filter(i => /TC-0/.test(i.summary));
ok('test case under an existing story key', r.status === 0 && tcs.length === 2 && tcs[0].parent === 'ACME-3', r.stdout + r.stderr);
ok('test case links "tests" the story key', state().links.some(l => l.type === 'Tests' && l.in === 'ACME-3'));
ok('test cases get no design fields', !('Design page' in lib.desiredItem({ ...plan }, { ref: 'x', type: 'Test Case', summary: 's' }).fields));
r = run(['push', '--plan', tPlanPath, '--apply']);
ok('test cases re-run: 0 creates', /creates: 0/.test(r.stdout) && state().issues.filter(i => /TC-0/.test(i.summary)).length === 2, r.stdout);

// --- MCP backend
const mdir = mkdtempSync(join(tmpdir(), 'jira-sync-mcp-'));
const mplan = join(mdir, 'jira-plan.json'); writeFileSync(mplan, JSON.stringify(plan));
r = run(['push', '--plan', mplan], { FAKE_ACLI_LOGGED_OUT: '1' });
ok('auto falls back to MCP and asks for the lookup first', r.status === 3 && /searchJiraIssuesUsingJql/.test(r.stderr), r.stdout + r.stderr);
const search = join(mdir, 'search.json');
writeFileSync(search, JSON.stringify({ issues: [{ key: 'ACME-1', fields: { summary: '[001] Shipping rates', labels: ['cref-001-epic'] } }] }));
r = run(['resolve', '--plan', mplan, '--search-result', search]);
ok('resolve records keys found by label', r.status === 0 && /resolved 1\/3/.test(r.stdout), r.stdout + r.stderr);
const mops = join(mdir, 'ops.json');
r = run(['push', '--plan', mplan, '--backend', 'mcp', '--ops', mops]);
const mo = JSON.parse(readFileSync(mops, 'utf8')).ops;
ok('MCP ops: 2 creates with parent, epic update, link', r.status === 0 && mo.filter(o => o.tool === 'createJiraIssue').length === 2
  && mo.find(o => o.tool === 'createJiraIssue').args.parent === 'ACME-1' && mo.some(o => o.tool === 'createJiraIssueLink'), r.stdout + r.stderr);
// Claude runs each op, then records it (the epic edit too, so its content hash is stored).
for (const [ref, key] of [['epic', 'ACME-1'], ['00', 'ACME-2'], ['02', 'ACME-3']]) run(['record', '--plan', mplan, '--ref', ref, '--key', key]);
r = run(['push', '--plan', mplan, '--backend', 'mcp', '--ops', mops]);
ok('MCP re-run after record: 0 creates', /creates: 0, updates: 0, unchanged: 3/.test(r.stdout), r.stdout + r.stderr);
r = run(['record', '--plan', mplan, '--ref', '99', '--key', 'ACME-9']);
ok('record refuses unknown refs', r.status === 1);

// --- no stored credentials
const src = readFileSync(SCRIPT, 'utf8');
ok('no API-token code path', !/JIRA_API_TOKEN|JIRA_EMAIL|Authorization|Basic /.test(src));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
