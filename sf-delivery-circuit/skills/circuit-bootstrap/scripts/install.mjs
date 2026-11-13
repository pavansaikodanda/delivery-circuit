#!/usr/bin/env node
// install.mjs: copy the Delivery Circuit v4 files into a Salesforce DX repo.
//   node install.mjs --repo <path> --org <github-org> [--project-name "Acme"] [--sf-ai-tester-skill <dir>]
//                    [--force] [--prune] [--dry-run]
// - Never overwrites an existing file unless --force (prints SKIP instead).
// - Merges .claude/settings.json (permissions + hooks) instead of replacing it, so Spec Kit's own settings survive.
// - Appends the circuit block to .gitignore once.
// - v4 workflows only (WORKFLOWS). v2/v3 workflows and CI scripts still in the repo are reported as STALE; --prune
//   deletes them.
// - Refuses to install a workflow or CI script that reads any secret other than the environment's SFDX_AUTH_URL.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

/** The v4 workflow set (CIRCUIT-V4 section 4). templates/workflows must hold exactly these. */
export const WORKFLOWS = ['pr-checks.yml', 'deploy.yml'];
/** v3 and v2 workflows that v4 removes. */
export const STALE_WORKFLOWS = ['design-gate.yml', 'persona-gates.yml', 'fix-router.yml', 'deploy-prod.yml',
  'claude-plan.yml', 'claude-build.yml', 'ai-fix-loop.yml', 'spec-gate.yml'];
/** v2/v3 repo files (CI scripts, self-hosted runner config) that v4 removes. */
export const STALE_SCRIPTS = ['runner-check.sh', 'design-gate.mjs', 'slack.sh', 'team-member.sh', 'resolve-story.sh',
  'check-tc-coverage.mjs', 'ai-tester-verdict.mjs', 'check-protected-paths.sh', 'protected-paths.txt', 'jira.sh',
  'install-sf-ai-tester.sh', 'sf-login.sh'].map(f => `scripts/ci/${f}`).concat(['.github/actionlint.yaml']);
/** The v4 plugin skills (CIRCUIT-V4 section 5). Installed with the plugin, not copied into the repo. */
export const SKILLS = ['circuit', 'circuit-bootstrap', 'circuit-intake', 'arch-design', 'record-decision', 'arch-jira-push',
  'dev-review-stories', 'dev-start-story', 'dev-fix', 'dev-review-plan', 'dev-review-pr', 'qa-design-tests', 'qa-add-tests',
  'qa-explore', 'review-room'];
/** GitHub labels the v4 skills and the extension use (created by circuit-bootstrap). */
export const LABELS = ['ai-generated', 'needs-fix'];
/** The one secret CI may read, only as the whole expression ${{ secrets.SFDX_AUTH_URL }} (a GitHub Environment secret). */
export const ALLOWED_SECRET = 'SFDX_AUTH_URL';
/** Everything else no installed workflow or CI script may read: named credentials, any other secrets.* reference,
 *  secrets[...], toJSON(secrets) and `secrets: inherit`. */
export const FORBIDDEN = /\b(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|SF_JWT_[A-Z0-9_]*|JIRA_API_TOKEN|FIREFLIES_API_KEY|APP_PRIVATE_KEY|SLACK_WEBHOOK[A-Z_]*|SLACK_BOT_TOKEN)\b|\bsecrets\s*(?:\[|\.(?!SFDX_AUTH_URL\s*\}\}))|toJSON\(\s*secrets\s*\)|\bsecrets\s*:\s*inherit\b/;

const args = process.argv.slice(2);
// A flag given without a value (end of args, or followed by another --flag) falls back to its default.
const opt = (n, d) => { const i = args.indexOf(`--${n}`); const v = i > -1 ? args[i + 1] : undefined; return v && !v.startsWith('--') ? v : d; };
const has = n => args.includes(`--${n}`);

function walk(dir) {
  return readdirSync(dir).flatMap(e => { const p = join(dir, e); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

function main() {
  const repo = opt('repo'); const org = opt('org');
  if (!repo || !org) { console.error('Usage: install.mjs --repo <path> --org <github-org> [--project-name X] [--force] [--prune] [--dry-run]'); return 2; }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(org)) { console.error(`--org "${org}" is not a GitHub organisation name`); return 2; }
  if (!existsSync(join(repo, '.git'))) { console.error(`${repo} is not a git repository`); return 2; }
  const FORCE = has('force'), DRY = has('dry-run'), PRUNE = has('prune');
  const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const T = join(PLUGIN, 'templates');
  const log = [];
  const problems = [];

  // 0. Self-check of the templates: exactly the v4 workflows, no secret but SFDX_AUTH_URL anywhere in CI, and the
  //    environment resolver plus its map are present.
  const have = readdirSync(join(T, 'workflows')).filter(f => f.endsWith('.yml')).sort();
  const want = [...WORKFLOWS].sort();
  if (JSON.stringify(have) !== JSON.stringify(want)) problems.push(`templates/workflows has [${have.join(', ')}], expected [${want.join(', ')}]`);
  const ciFiles = [...walk(join(T, 'workflows')), ...walk(join(T, 'repo', 'scripts', 'ci'))];
  for (const f of ciFiles) {
    const m = readFileSync(f, 'utf8').match(FORBIDDEN);
    if (m) problems.push(`${relative(PLUGIN, f)} reads a stored credential (${m[0]}); v4 allows only secrets.${ALLOWED_SECRET}`);
  }
  if (!existsSync(join(T, 'repo', 'scripts', 'ci', 'env-for-branch.mjs'))) problems.push('templates/repo/scripts/ci/env-for-branch.mjs is missing');
  if (!/^environments\s*:/m.test(readFileSync(join(T, 'bootstrap', 'build.config.yml'), 'utf8'))) problems.push('templates/bootstrap/build.config.yml has no environments list');
  if (problems.length) { for (const p of problems) console.error(`ERROR  ${p}`); return 1; }

  function put(dest, content, { mode } = {}) {
    const abs = join(repo, dest);
    if (existsSync(abs) && !FORCE) { log.push(`SKIP   ${dest} (exists; use --force to replace)`); return; }
    log.push(`${existsSync(abs) ? 'UPDATE' : 'ADD   '} ${dest}`);
    if (DRY) return;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    if (mode) try { chmodSync(abs, mode); } catch {}
  }
  const subst = s => s.replaceAll('@ORG/', `@${org}/`).replaceAll('PROJECT_NAME', opt('project-name', org));

  // 1. Repo files
  for (const f of walk(join(T, 'repo'))) {
    const r = relative(join(T, 'repo'), f).split('\\').join('/');
    if (r === 'gitignore.circuit' || r === '.claude/settings.json') continue;
    put(r, subst(readFileSync(f, 'utf8')), { mode: /\.(sh|mjs)$/.test(r) ? 0o755 : undefined });
  }
  // 2. Workflows (v4 set) and stale v2/v3 files
  for (const w of WORKFLOWS) put(`.github/workflows/${w}`, readFileSync(join(T, 'workflows', w), 'utf8'));
  for (const stale of [...STALE_WORKFLOWS.map(w => `.github/workflows/${w}`), ...STALE_SCRIPTS]) {
    if (!existsSync(join(repo, stale))) continue;
    if (PRUNE) { log.push(`REMOVE ${stale} (pre-v4)`); if (!DRY) rmSync(join(repo, stale)); }
    else log.push(`STALE  ${stale} (pre-v4; v4 removed it: delete it or re-run with --prune)`);
  }
  // 3. Persona agents (repo-local copies, so a session without the plugin still has them)
  if (existsSync(join(PLUGIN, 'agents'))) for (const f of walk(join(PLUGIN, 'agents'))) put(`.claude/agents/${relative(join(PLUGIN, 'agents'), f)}`, readFileSync(f, 'utf8'));
  // 4. SF AI Tester suites skill (Tester persona + CI validator)
  const tsk = opt('sf-ai-tester-skill', join(homedir(), '.claude', 'skills', 'sf-ai-tester-suites'));
  if (existsSync(tsk)) for (const f of walk(tsk)) put(`.claude/skills/sf-ai-tester-suites/${relative(tsk, f).split('\\').join('/')}`, readFileSync(f));
  else log.push(`WARN   sf-ai-tester-suites skill not found at ${tsk}; copy it to .claude/skills/sf-ai-tester-suites/ yourself`);
  // 5. Merge .claude/settings.json
  {
    const dest = join(repo, '.claude', 'settings.json');
    const ours = JSON.parse(readFileSync(join(T, 'repo', '.claude', 'settings.json'), 'utf8'));
    const cur = existsSync(dest) ? JSON.parse(readFileSync(dest, 'utf8')) : {};
    cur.permissions ||= {};
    for (const k of ['allow', 'deny']) cur.permissions[k] = [...new Set([...(cur.permissions[k] || []), ...(ours.permissions?.[k] || [])])];
    cur.hooks ||= {}; cur.hooks.PreToolUse ||= [];
    const already = JSON.stringify(cur.hooks.PreToolUse).includes('circuit-guard.mjs');
    if (!already) cur.hooks.PreToolUse.push(...(ours.hooks?.PreToolUse || []));
    log.push(`MERGE  .claude/settings.json (${already ? 'guard already registered' : 'guard registered'})`);
    if (!DRY) { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, JSON.stringify(cur, null, 2) + '\n'); }
  }
  // 6. .gitignore
  {
    const gi = join(repo, '.gitignore');
    const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    if (cur.includes('delivery circuit')) log.push('SKIP   .gitignore (circuit block present)');
    else { log.push('APPEND .gitignore'); if (!DRY) writeFileSync(gi, cur + readFileSync(join(T, 'repo', 'gitignore.circuit'), 'utf8')); }
  }
  // 7. Bootstrap state files (not overwritten)
  for (const f of ['build.config.yml', 'build-state.md']) put(f, readFileSync(join(T, 'bootstrap', f), 'utf8'));
  // 8. Plugin skills present? (they come with the plugin; this only reports)
  const missing = SKILLS.filter(s => !existsSync(join(PLUGIN, 'skills', s, 'SKILL.md')));
  if (missing.length) log.push(`WARN   plugin skills missing: ${missing.join(', ')} (update the sf-delivery-circuit plugin)`);

  console.log(`${DRY ? 'DRY RUN: ' : ''}delivery circuit v4 -> ${repo} (org ${org})`);
  for (const l of log) console.log('  ' + l);
  console.log(`  Workflows: ${WORKFLOWS.join(', ')}`);
  console.log(`  Labels to create: ${LABELS.join(' ')}`);
  console.log('  Secrets: one SFDX_AUTH_URL per GitHub Environment (qa dev sit uat production), set by the admin with');
  console.log('  gh secret set SFDX_AUTH_URL --env <env>. Claude never sees or sets them. Nothing else is stored.');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main());
