// Run: node --test sf-delivery-circuit/tests/ci.test.mjs
// v3 CI pieces: design-gate decision (G1 + C5), resolve-story branch parsing, installer self-check and dry run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(here, '..');
const CI = join(PLUGIN, 'templates', 'repo', 'scripts', 'ci');
const INSTALL = join(PLUGIN, 'skills', 'circuit-bootstrap', 'scripts', 'install.mjs');
const gate = await import(pathToFileURL(join(CI, 'design-gate.mjs')).href);
const inst = await import(pathToFileURL(INSTALL).href);

const F = { approvedVersion: 'customfield_10051', designPage: 'customfield_10050' };
const PAGE = 'https://acme.atlassian.net/wiki/spaces/SD/pages/123';
const epic = (v, status = 'Design Approved', page = PAGE) => ({ key: 'ACME-1', fields: { status: { name: status }, [F.approvedVersion]: v, [F.designPage]: page } });
const story = (v, page = PAGE, parent = 'ACME-1') => ({ key: 'ACME-12', fields: { parent: parent ? { key: parent } : undefined, [F.approvedVersion]: v, [F.designPage]: page } });
const run = (s, e) => gate.evaluate({ key: 'ACME-12', story: s, epic: e, fieldIds: F });

test('versionOf accepts numbers, numeric strings and option objects only', () => {
  assert.equal(gate.versionOf(3), 3);
  assert.equal(gate.versionOf('3'), 3);
  assert.equal(gate.versionOf('v4'), 4);
  assert.equal(gate.versionOf('5.0'), 5);
  assert.equal(gate.versionOf({ value: '6' }), 6);
  for (const bad of [0, -1, 1.5, '', 'three', null, undefined, {}, '3; rm -rf /']) assert.equal(gate.versionOf(bad), null);
});

test('design-gate passes when story and epic carry the same approved version', () => {
  const r = run(story(3), epic(3));
  assert.equal(r.ok, true, r.lines.join('\n'));
});

test('G1 fails without an approved version or while the epic is in a design status', () => {
  assert.equal(run(story(3), epic(null)).ok, false);
  const back = run(story(3), epic(3, 'Design Review'));
  assert.equal(back.ok, false);
  assert.match(back.lines.join('\n'), /not approved/);
});

test('C5 fails with the contract message when the design changed after planning', () => {
  const r = run(story(2), epic(3));
  assert.equal(r.ok, false);
  assert.ok(r.lines.some(l => l.includes(gate.C5_MESSAGE)));
  assert.equal(gate.C5_MESSAGE, 'Design changed since this story was planned: re-plan or re-approve');
});

test('design-gate fails for a newer story version, a missing story version, no epic, or a different design page', () => {
  assert.equal(run(story(4), epic(3)).ok, false);
  assert.equal(run(story(null), epic(3)).ok, false);
  assert.equal(run(story(3, PAGE, null), null).ok, false);
  assert.equal(run(story(3, 'https://acme.atlassian.net/wiki/x'), epic(3)).ok, false);
});

test('design-gate fails closed when the field id is unknown', () => {
  const r = gate.evaluate({ key: 'ACME-12', story: story(3), epic: epic(3), fieldIds: {} });
  assert.equal(r.ok, false);
});

test('fieldIdsFrom reads jira-config.json and lets env override', () => {
  const cfg = JSON.stringify({ fields: { 'Approved design version': { id: 'customfield_1' }, 'Design page': { id: 'customfield_2' } } });
  assert.deepEqual(gate.fieldIdsFrom(cfg, {}), { approvedVersion: 'customfield_1', designPage: 'customfield_2' });
  assert.equal(gate.fieldIdsFrom(cfg, { JIRA_FIELD_APPROVED_DESIGN_VERSION: 'customfield_9' }).approvedVersion, 'customfield_9');
  assert.deepEqual(gate.fieldIdsFrom('not json', {}), { approvedVersion: null, designPage: null });
});

test('design-gate CLI works offline with --story/--epic files', () => {
  const d = mkdtempSync(join(tmpdir(), 'dg-'));
  writeFileSync(join(d, 's.json'), JSON.stringify(story(2)));
  writeFileSync(join(d, 'e.json'), JSON.stringify(epic(3)));
  const env = { ...process.env, JIRA_FIELD_APPROVED_DESIGN_VERSION: F.approvedVersion, JIRA_FIELD_DESIGN_PAGE: F.designPage };
  const r = spawnSync(process.execPath, [join(CI, 'design-gate.mjs'), '--key', 'ACME-12', '--story', join(d, 's.json'), '--epic', join(d, 'e.json'), '--config', join(d, 'none.json')], { encoding: 'utf8', env });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Design changed since this story was planned/);
  const bad = spawnSync(process.execPath, [join(CI, 'design-gate.mjs'), '--key', 'acme-12'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  rmSync(d, { recursive: true, force: true });
});

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
test('resolve-story.sh maps only feature/<KEY>-* branches', { skip: !hasBash && 'bash not available' }, () => {
  const rs = (...a) => spawnSync('bash', [join(CI, 'resolve-story.sh'), ...a], { encoding: 'utf8' });
  const ok = rs('--branch', 'feature/ACME-12-case-escalation');
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^KEY=ACME-12$/m);
  assert.match(ok.stdout, /^SUITE=test-cases\/ACME-12\.sf-tests\.yaml$/m);
  assert.match(rs('--branch', 'feature/ACME-12').stdout, /^KEY=ACME-12$/m);
  for (const b of ['main', 'feature/acme-12-x', 'feature/ACME-12x', 'fix/ACME-12-x', 'xfeature/ACME-12-a', 'feature/$(id)-1']) {
    const r = rs('--branch', b);
    assert.equal(r.stdout, '', `branch ${b}`);
  }
  assert.notEqual(rs('acme-12').status, 0);
  // Jira project keys may hold '_': the branch parser and the key check agree, so such a branch is a story branch.
  const us = rs('--branch', 'feature/ACME_X-12-rates');
  assert.equal(us.status, 0, us.stderr);
  assert.match(us.stdout, /^KEY=ACME_X-12$/m);
});

test('design-gate.mjs accepts the same keys as resolve-story (underscores included)', () => {
  const d = mkdtempSync(join(tmpdir(), 'dg-'));
  const s2 = { ...story(3), key: 'ACME_X-12' };
  writeFileSync(join(d, 's.json'), JSON.stringify(s2));
  writeFileSync(join(d, 'e.json'), JSON.stringify(epic(3)));
  const env = { ...process.env, JIRA_FIELD_APPROVED_DESIGN_VERSION: F.approvedVersion, JIRA_FIELD_DESIGN_PAGE: F.designPage };
  const r = spawnSync(process.execPath, [join(CI, 'design-gate.mjs'), '--key', 'ACME_X-12', '--story', join(d, 's.json'), '--epic', join(d, 'e.json'), '--config', join(d, 'none.json')], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  rmSync(d, { recursive: true, force: true });
});

const WF = join(PLUGIN, 'templates', 'workflows');
const jobsOf = text => text.split(/\n  (?=[a-z][a-z0-9-]*:\n)/).slice(1);

test('gate and guard scripts run from the base commit, never from the PR being checked', () => {
  for (const w of ['pr-checks.yml', 'design-gate.yml', 'persona-gates.yml', 'fix-router.yml']) {
    const text = readFileSync(join(WF, w), 'utf8');
    for (const j of jobsOf(text)) {
      const name = j.split('\n')[0];
      // A job that runs scripts/ci from the workspace root must have checked the root out at the base commit.
      if (/(bash|node) scripts\/ci\//.test(j)) {
        assert.match(j, /ref: "?\$\{\{ github\.event\.pull_request\.base\.sha/, `${w} ${name} runs scripts/ci from an unpinned checkout`);
        assert.doesNotMatch(j, /fetch-depth: 0/, `${w} ${name}: a full PR checkout must not be where scripts/ci runs from`);
      }
      // A job that checks the PR out as data runs its scripts from .circuit-trusted, checked out at the base commit.
      if (/\.circuit-trusted\/scripts\/ci/.test(j)) {
        assert.match(j, /path: \.circuit-trusted/, `${w} ${name}`);
        assert.match(j, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\n\s+path: \.circuit-trusted/, `${w} ${name}`);
      }
    }
  }
});

test('resolve-story failures are fatal wherever its output is eval-ed', () => {
  for (const w of readdirSync(WF)) {
    const text = readFileSync(join(WF, w), 'utf8');
    assert.doesNotMatch(text, /eval "\$\(bash [^)]*resolve-story/, `${w}: eval "$(...)" swallows a resolve-story failure`);
    for (const m of text.matchAll(/out=\$\(bash \S*resolve-story\.sh[^\n]*/g)) assert.match(m[0], /\|\| exit 1$/, `${w}: ${m[0]}`);
  }
});

test('a PR that changes force-app/ must be on a story branch (design-gate and guard)', () => {
  const dg = readFileSync(join(WF, 'design-gate.yml'), 'utf8');
  assert.match(dg, /pulls\/\$PR\/files/);
  assert.match(dg, /grep -q '\^force-app\/'[^\n]*\n[^\n]*::error::/);
  assert.match(dg, /pull-requests: read/);
  const guard = jobsOf(readFileSync(join(WF, 'pr-checks.yml'), 'utf8')).find(j => j.startsWith('guard:'));
  assert.match(guard, /if grep -q '\^force-app\/' "\$RUNNER_TEMP\/changed\.txt"; then\n\s+echo "::error::/);
});

test('CODEOWNERS gives tests/ and test-cases/ to the testers', () => {
  const co = readFileSync(join(PLUGIN, 'templates', 'repo', '.github', 'CODEOWNERS'), 'utf8');
  assert.match(co, /^\/tests\/\s+@ORG\/testers\s*$/m);
  assert.match(co, /^\/test-cases\/\s+@ORG\/testers\s*$/m);
});

test('no template workflow or CI script reads a stored credential', () => {
  const files = [
    ...readdirSync(join(PLUGIN, 'templates', 'workflows')).map(f => join(PLUGIN, 'templates', 'workflows', f)),
    ...readdirSync(CI).map(f => join(CI, f)),
  ];
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), inst.FORBIDDEN, f);
  assert.match('env: { T: "${{ secrets.X }}" }', inst.FORBIDDEN);
  assert.match('CLAUDE_CODE_OAUTH_TOKEN', inst.FORBIDDEN);
  assert.ok(!existsSync(join(CI, 'sf-login.sh')), 'sf-login.sh is removed in v3');
});

test('templates/workflows holds exactly the v3 set; self-hosted jobs skip fork PRs', () => {
  const have = readdirSync(join(PLUGIN, 'templates', 'workflows')).filter(f => f.endsWith('.yml')).sort();
  assert.deepEqual(have, [...inst.WORKFLOWS].sort());
  for (const w of inst.STALE_WORKFLOWS) assert.ok(!have.includes(w), w);
  for (const w of have) {
    const text = readFileSync(join(PLUGIN, 'templates', 'workflows', w), 'utf8');
    assert.doesNotMatch(text, /claude-code-action|anthropics\//, `${w} must not run AI through an action`);
    // Every job block that targets a self-hosted runner carries a same-repository condition (or is push/dispatch only).
    const jobs = text.split(/\n  (?=[a-z][a-z0-9-]*:\n)/).slice(1);
    for (const j of jobs) {
      if (!/runs-on: \[self-hosted/.test(j)) continue;
      if (w === 'deploy-prod.yml') { assert.doesNotMatch(text, /pull_request/); assert.match(j, /circuit-release/); continue; }
      assert.match(j, /head\.repo\.full_name == github\.repository|head_repository\.full_name == github\.repository/, `${w}: ${j.split('\n')[0]}`);
    }
  }
  assert.doesNotMatch(readFileSync(join(PLUGIN, 'templates', 'workflows', 'deploy-prod.yml'), 'utf8'), /\bclaude\b/);
});

test('rulesets require design-gate, not spec-gate', () => {
  const rs = JSON.parse(readFileSync(join(PLUGIN, 'templates', 'github', 'ruleset-main.json'), 'utf8'));
  const checks = rs.rules.find(r => r.type === 'required_status_checks').parameters.required_status_checks.map(c => c.context);
  assert.ok(checks.includes('design-gate'));
  assert.ok(!checks.includes('spec-gate'));
  for (const c of ['guard', 'static', 'code-analyzer', 'qa', 'gate/developer', 'gate/tester', 'gate/architect']) assert.ok(checks.includes(c), c);
});

test('install.mjs --dry-run on a temp git repo writes nothing and reports v2 leftovers', () => {
  const d = mkdtempSync(join(tmpdir(), 'circuit-install-'));
  spawnSync('git', ['init', '-q', d]);
  mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(d, '.github', 'workflows', 'ai-fix-loop.yml'), 'name: old\n');
  const r = spawnSync(process.execPath, [INSTALL, '--repo', d, '--org', 'acme-org', '--project-name', 'Acme Shipping', '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ADD {4}\.github\/workflows\/design-gate\.yml/);
  assert.match(r.stdout, /STALE {2}\.github\/workflows\/ai-fix-loop\.yml/);
  assert.match(r.stdout, /No secrets to set/);
  assert.ok(!existsSync(join(d, 'CLAUDE.md')) && !existsSync(join(d, '.claude')), 'dry run must not write');
  const bad = spawnSync(process.execPath, [INSTALL, '--repo', d, '--org', 'bad org!'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  rmSync(d, { recursive: true, force: true });
});

test('every v3 skill named by the installer exists in the plugin', () => {
  for (const s of inst.SKILLS) assert.ok(existsSync(join(PLUGIN, 'skills', s, 'SKILL.md')), s);
});
