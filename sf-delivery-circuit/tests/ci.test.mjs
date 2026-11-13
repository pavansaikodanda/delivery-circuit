// Run: node --test sf-delivery-circuit/tests/ci.test.mjs
// v4 CI pieces: env-for-branch (branch -> environment), the two workflows, rulesets, installer self-check and dry run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(here, '..');
const T = join(PLUGIN, 'templates');
const CI = join(T, 'repo', 'scripts', 'ci');
const WF = join(T, 'workflows');
const CONFIG = join(T, 'bootstrap', 'build.config.yml');
const EFB = join(CI, 'env-for-branch.mjs');
const INSTALL = join(PLUGIN, 'skills', 'circuit-bootstrap', 'scripts', 'install.mjs');
const efb = await import(pathToFileURL(EFB).href);
const inst = await import(pathToFileURL(INSTALL).href);

const cli = (...a) => spawnSync(process.execPath, [EFB, ...a], { encoding: 'utf8' });
const wf = name => readFileSync(join(WF, name), 'utf8');
const jobsOf = text => Object.fromEntries(text.split(/\n  (?=[a-z][a-z0-9-]*:\n)/).slice(1).map(j => [j.split(':')[0], j]));

// ---- env-for-branch ----------------------------------------------------------------------------------------------

test('template build.config.yml maps the v4 ladder', () => {
  const envs = efb.parseEnvironments(readFileSync(CONFIG, 'utf8'));
  assert.deepEqual(envs.map(e => [e.branch, e.environment, e.test_level]), [
    ['sprint/*', 'qa', 'RunLocalTests'], ['dev', 'dev', 'RunLocalTests'], ['sit', 'sit', 'RunLocalTests'],
    ['uat', 'uat', 'RunLocalTests'], ['main', 'production', 'RunLocalTests'],
  ]);
});

test('env-for-branch CLI: sprint -> qa, main -> production, promotion branches -> their sandbox', () => {
  for (const [branch, env] of [['sprint/2026-S1', 'qa'], ['main', 'production'], ['dev', 'dev'], ['sit', 'sit'], ['uat', 'uat'], ['refs/heads/sprint/x', 'qa']]) {
    const r = cli(branch, '--config', CONFIG);
    assert.equal(r.status, 0, `${branch}: ${r.stderr}`);
    assert.equal(r.stdout, `environment=${env}\ntest_level=RunLocalTests\n`, branch);
  }
});

test('env-for-branch CLI: unknown branches exit 1 with a clear message', () => {
  for (const b of ['feature/ACME-12-x', 'sprint/a/b', 'mainx', 'xmain', 'release/1']) {
    const r = cli(b, '--config', CONFIG);
    assert.equal(r.status, 1, b);
    assert.equal(r.stdout, '', b);
    assert.match(r.stderr, /matches no entry in build\.config\.yml environments/, b);
  }
  assert.equal(cli('main', '--config', join(tmpdir(), 'no-such-config.yml')).status, 1);
  assert.equal(cli().status, 2);
});

test('env-for-branch parses flow and block entries, quotes and comments; first match wins', () => {
  const yaml = [
    'github: { org: acme-org }',
    'environments:   # the ladder',
    '  - { branch: "hotfix/**", environment: uat, test_level: RunSpecifiedTests }  # comment',
    "  - { branch: 'sprint/*', environment: qa }",
    '  - branch: dev',
    '    environment: "dev"',
    '    test_level: NoTestRun',
    '  - { branch: "*", environment: catchall, test_level: RunLocalTests }',
    'slack: { channel: x }',
    '  - { branch: main, environment: ignored }',
  ].join('\n');
  const envs = efb.parseEnvironments(yaml);
  assert.equal(envs.length, 4);
  assert.deepEqual(efb.resolveBranch('hotfix/a/b', envs), { environment: 'uat', test_level: 'RunSpecifiedTests' });
  assert.deepEqual(efb.resolveBranch('sprint/S2', envs), { environment: 'qa', test_level: 'RunLocalTests' });
  assert.deepEqual(efb.resolveBranch('dev', envs), { environment: 'dev', test_level: 'NoTestRun' });
  assert.deepEqual(efb.resolveBranch('main', envs), { environment: 'catchall', test_level: 'RunLocalTests' });
  assert.throws(() => efb.resolveBranch('a/b', envs), /matches no entry/);
});

test('env-for-branch rejects unsafe environment names and unknown test levels', () => {
  assert.throws(() => efb.resolveBranch('dev', [{ branch: 'dev', environment: 'qa\nenvironment=production' }]), /invalid environment/);
  assert.throws(() => efb.resolveBranch('dev', [{ branch: 'dev', environment: '' }]), /invalid environment/);
  assert.throws(() => efb.resolveBranch('dev', [{ branch: 'dev', environment: 'dev', test_level: 'RunEverything' }]), /test_level/);
  assert.throws(() => efb.parseEnvironments('github: {}\n'), /no top-level "environments:"/);
  assert.ok(efb.globToRegExp('sprint/*').test('sprint/2026-S1'));
  assert.ok(!efb.globToRegExp('sprint/*').test('sprint/a/b'));
  assert.ok(efb.globToRegExp('sprint/**').test('sprint/a/b'));
  assert.ok(!efb.globToRegExp('a.b').test('axb'));
});

// ---- workflows ---------------------------------------------------------------------------------------------------

test('templates/workflows holds exactly pr-checks.yml and deploy.yml; no v2/v3 workflow or script remains', () => {
  const have = readdirSync(WF).filter(f => f.endsWith('.yml')).sort();
  assert.deepEqual(have, ['deploy.yml', 'pr-checks.yml']);
  assert.deepEqual([...inst.WORKFLOWS].sort(), have);
  for (const w of ['design-gate.yml', 'persona-gates.yml', 'fix-router.yml', 'deploy-prod.yml']) assert.ok(inst.STALE_WORKFLOWS.includes(w), w);
  assert.deepEqual(readdirSync(CI), ['env-for-branch.mjs']);
  for (const s of inst.STALE_SCRIPTS) assert.ok(!existsSync(join(T, 'repo', s)), s);
});

test('workflows read no secret but SFDX_AUTH_URL, run on GitHub-hosted runners and call no AI, Jira or Slack', () => {
  for (const w of inst.WORKFLOWS) {
    const text = wf(w);
    assert.doesNotMatch(text, inst.FORBIDDEN, w);
    assert.doesNotMatch(text, /self-hosted/, w);
    for (const m of text.matchAll(/runs-on:\s*(\S+)/g)) assert.equal(m[1], 'ubuntu-latest', w);
    assert.doesNotMatch(text, /claude-code-action|anthropics\/|\bclaude -p\b|\bacli\b|slack\.com|jira\.sh/i, w);
    for (const m of text.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /^[\w.-]+\/[\w.-]+@v\d+$/, `${w}: pin actions to a major (${m[1]})`);
    // The auth URL never appears on a command line or in the log: only piped from printf into --sfdx-url-stdin.
    for (const line of text.split('\n').filter(l => l.includes('$SFDX_AUTH_URL'))) {
      assert.ok(/printf '%s' "\$SFDX_AUTH_URL" \| sf org login sfdx-url --sfdx-url-stdin/.test(line) || /\[ -z "\$SFDX_AUTH_URL" \]/.test(line), `${w}: ${line.trim()}`);
    }
    assert.doesNotMatch(text, /echo[^\n]*\$\{?SFDX_AUTH_URL/, w);
    assert.match(text, /env-for-branch\.mjs/, `${w} resolves the environment with env-for-branch.mjs`);
  }
});

test('FORBIDDEN allows exactly secrets.SFDX_AUTH_URL', () => {
  const F = inst.FORBIDDEN;
  assert.doesNotMatch('SFDX_AUTH_URL: ${{ secrets.SFDX_AUTH_URL }}', F);
  for (const bad of ['${{ secrets.OTHER }}', '${{ secrets.SFDX_AUTH_URL_PROD }}', '${{ secrets.SFDX_AUTH_URL || secrets.X }}',
    "${{ secrets['SFDX_AUTH_URL'] }}", '${{ toJSON(secrets) }}', 'secrets: inherit', '${{ secrets.GITHUB_TOKEN }}',
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'SF_JWT_KEY', 'JIRA_API_TOKEN']) assert.match(bad, F, bad);
});

test('pr-checks: triggers, fork handling, base-commit map, scan steps', () => {
  const text = wf('pr-checks.yml');
  const jobs = jobsOf(text);
  assert.match(text, /pull_request:\n\s+branches: \["sprint\/\*\*", dev, sit, uat, main\]/);
  assert.deepEqual(Object.keys(jobs), ['resolve', 'scan', 'coderabbit']);
  // resolve: env map from the base commit, from the base branch, no environment.
  assert.match(jobs.resolve, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(jobs.resolve, /env-for-branch\.mjs "\$BASE_REF"/);
  assert.match(jobs.resolve, /BASE_REF: \$\{\{ github\.base_ref \}\}/);
  assert.doesNotMatch(jobs.resolve, /^    environment:|secrets\./m);
  // scan: environment only for same-repo PRs, always reports (never skipped), fails forks before anything else.
  assert.match(jobs.scan, /if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(jobs.scan, /environment: \$\{\{ needs\.resolve\.outputs\.same_repo == 'true' && needs\.resolve\.outputs\.environment \|\| '' \}\}/);
  const steps = jobs.scan.split('\n      - ').slice(1);
  assert.match(steps[0], /Same-repository PRs only/);
  assert.match(steps[0], /\$HEAD_REPO" != "\$GITHUB_REPOSITORY"[\s\S]*exit 1/);
  assert.match(steps[0], /\$RESOLVED" != success[\s\S]*exit 1/);
  const order = ['Same-repository', 'code-analyzer run', 'LWC Jest', 'sfdx-url-stdin', 'sf project deploy validate --source-dir force-app'];
  const pos = order.map(s => jobs.scan.indexOf(s));
  assert.ok(pos.every(p => p > -1), `scan steps: ${pos}`);
  assert.deepEqual([...pos].sort((a, b) => a - b), pos, 'scan step order');
  assert.match(jobs.scan, /--severity-threshold 2/);
  assert.match(jobs.scan, /--test-level "\$TEST_LEVEL"/);
  assert.match(jobs.scan, /persist-credentials: false/);
});

test('pr-checks: coderabbit job needs scan, feature/* only, once per head SHA, pull-requests: write', () => {
  const j = jobsOf(wf('pr-checks.yml')).coderabbit;
  assert.match(j, /needs: scan/);
  assert.match(j, /startsWith\(github\.head_ref, 'feature\/'\)/);
  assert.match(j, /head\.repo\.full_name == github\.repository/);
  assert.match(j, /permissions:\n\s+pull-requests: write/);
  assert.doesNotMatch(j, /contents: write|environment:/);
  assert.match(j, /SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(j, /MARKER="<!-- circuit:coderabbit-review:\$SHA -->"/);
  assert.match(j, /grep -qF "\$MARKER"[\s\S]*exit 0[\s\S]*@coderabbitai review/);
  assert.match(wf('pr-checks.yml'), /^permissions:\n  contents: read$/m);
});

test('deploy: push to the ladder, environment from env-for-branch, concurrency per environment, job summary', () => {
  const text = wf('deploy.yml');
  const jobs = jobsOf(text);
  assert.match(text, /push:\n\s+branches: \["sprint\/\*\*", dev, sit, uat, main\]/);
  assert.doesNotMatch(text, /pull_request/);
  assert.match(jobs.resolve, /env-for-branch\.mjs "\$GITHUB_REF_NAME"/);
  assert.match(jobs.deploy, /environment: \$\{\{ needs\.resolve\.outputs\.environment \}\}/);
  assert.match(jobs.deploy, /concurrency:\n\s+group: deploy-\$\{\{ needs\.resolve\.outputs\.environment \}\}\n\s+cancel-in-progress: false/);
  assert.match(jobs.deploy, /sf project deploy start --source-dir force-app --target-org circuit-target --test-level "\$TEST_LEVEL"/);
  assert.match(jobs.deploy, /GITHUB_STEP_SUMMARY/);
  assert.match(jobs.deploy, /sf org logout/);
  assert.match(text, /^permissions:\n  contents: read$/m);
});

// ---- rulesets, CodeRabbit, config ----------------------------------------------------------------------------------

test('rulesets: sprint/* and dev/sit/uat/main require scan and a PR; no force-push or deletion', () => {
  const sprint = JSON.parse(readFileSync(join(T, 'github', 'ruleset-sprint.json'), 'utf8'));
  const promo = JSON.parse(readFileSync(join(T, 'github', 'ruleset-promotion.json'), 'utf8'));
  assert.deepEqual(sprint.conditions.ref_name.include, ['refs/heads/sprint/*']);
  assert.deepEqual(promo.conditions.ref_name.include, ['refs/heads/dev', 'refs/heads/sit', 'refs/heads/uat', 'refs/heads/main']);
  for (const rs of [sprint, promo]) {
    const types = rs.rules.map(r => r.type);
    for (const t of ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']) assert.ok(types.includes(t), `${rs.name}: ${t}`);
    assert.ok(!types.includes('required_linear_history'), rs.name);
    assert.deepEqual(rs.bypass_actors, []);
    const checks = rs.rules.find(r => r.type === 'required_status_checks').parameters.required_status_checks.map(c => c.context);
    assert.deepEqual(checks, ['scan']);
    assert.equal(rs.rules.find(r => r.type === 'pull_request').parameters.required_approving_review_count, 1);
  }
  const env = JSON.parse(readFileSync(join(T, 'github', 'environment-production.json'), 'utf8'));
  assert.equal(env.prevent_self_review, true);
  assert.equal(env.reviewers[0].type, 'Team');
});

test('.coderabbit.yaml: no auto review, request-changes workflow, no v3 references', () => {
  const y = readFileSync(join(T, 'repo', '.coderabbit.yaml'), 'utf8');
  assert.match(y, /auto_review:\n\s+enabled: false/);
  assert.match(y, /request_changes_workflow: true/);
  assert.doesNotMatch(y, /\.tc\.json|docs\/plans|approved design version|PLAN\.md/i);
});

test('build.config.yml: v4 shape, no v3 sections, no secrets', () => {
  const y = readFileSync(CONFIG, 'utf8');
  for (const k of ['github', 'people', 'jira', 'confluence', 'salesforce', 'environments', 'slack', 'transcripts']) assert.match(y, new RegExp(`^${k}:`, 'm'), k);
  for (const k of ['runners', 'ai', 'gates', 'acli']) assert.doesNotMatch(y, new RegExp(`^${k}:`, 'm'), k);
  assert.match(y, /leads:/);
  assert.match(y, /ready_status: "Ready for Dev"/);
  assert.match(y, /SFDX_AUTH_URL/);
  assert.doesNotMatch(y, /force:\/\/|sk-ant-|ghp_/);
});

// ---- installer -------------------------------------------------------------------------------------------------------

test('install.mjs self-check passes: --dry-run on a temp git repo writes nothing and reports v2/v3 leftovers', () => {
  const d = mkdtempSync(join(tmpdir(), 'circuit-install-'));
  spawnSync('git', ['init', '-q', d]);
  mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(d, 'scripts', 'ci'), { recursive: true });
  writeFileSync(join(d, '.github', 'workflows', 'ai-fix-loop.yml'), 'name: old\n');
  writeFileSync(join(d, '.github', 'workflows', 'fix-router.yml'), 'name: old\n');
  writeFileSync(join(d, 'scripts', 'ci', 'runner-check.sh'), 'echo old\n');
  const r = spawnSync(process.execPath, [INSTALL, '--repo', d, '--org', 'acme-org', '--project-name', 'Acme Shipping', '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /ERROR/);
  assert.match(r.stdout, /delivery circuit v4/);
  assert.match(r.stdout, /ADD {4}\.github\/workflows\/pr-checks\.yml/);
  assert.match(r.stdout, /ADD {4}\.github\/workflows\/deploy\.yml/);
  assert.match(r.stdout, /ADD {4}scripts\/ci\/env-for-branch\.mjs/);
  assert.match(r.stdout, /STALE {2}\.github\/workflows\/ai-fix-loop\.yml/);
  assert.match(r.stdout, /STALE {2}\.github\/workflows\/fix-router\.yml/);
  assert.match(r.stdout, /STALE {2}scripts\/ci\/runner-check\.sh/);
  assert.match(r.stdout, /Labels to create: ai-generated needs-fix/);
  assert.match(r.stdout, /SFDX_AUTH_URL per GitHub Environment/);
  assert.ok(!existsSync(join(d, 'CLAUDE.md')) && !existsSync(join(d, '.claude')), 'dry run must not write');
  const bad = spawnSync(process.execPath, [INSTALL, '--repo', d, '--org', 'bad org!'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  rmSync(d, { recursive: true, force: true });
});

test('installer lists the v4 skills', () => {
  assert.deepEqual([...inst.SKILLS].sort(), ['arch-design', 'arch-jira-push', 'circuit', 'circuit-bootstrap', 'circuit-intake',
    'dev-fix', 'dev-review-plan', 'dev-review-pr', 'dev-review-stories', 'dev-start-story', 'qa-add-tests', 'qa-design-tests',
    'qa-explore', 'record-decision', 'review-room']);
  for (const s of ['arch-approve-design', 'arch-review-pr', 'qa-push-tests', 'qa-review-testplan']) assert.ok(!inst.SKILLS.includes(s), s);
  for (const s of inst.SKILLS) assert.ok(existsSync(join(PLUGIN, 'skills', s, 'SKILL.md')), s);
});
