#!/usr/bin/env node
// install.mjs: copy the delivery-circuit files into a Salesforce DX repo.
//   node install.mjs --repo <path> --org <github-org> [--project-name "Acme"] [--sf-ai-tester-skill <dir>] [--force] [--dry-run]
// - Never overwrites an existing file unless --force (prints SKIP instead).
// - Merges .claude/settings.json (permissions + hooks) instead of replacing it, so Spec Kit's own settings survive.
// - Appends the circuit block to .gitignore once.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
// A flag given without a value (end of args, or followed by another --flag) falls back to its default.
const opt = (n, d) => { const i = args.indexOf(`--${n}`); const v = i > -1 ? args[i + 1] : undefined; return v && !v.startsWith('--') ? v : d; };
const has = n => args.includes(`--${n}`);
const repo = opt('repo'); const org = opt('org');
if (!repo || !org) { console.error('Usage: install.mjs --repo <path> --org <github-org> [--project-name X] [--force] [--dry-run]'); process.exit(2); }
if (!existsSync(join(repo, '.git'))) { console.error(`${repo} is not a git repository`); process.exit(2); }
const FORCE = has('force'), DRY = has('dry-run');
const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const T = join(PLUGIN, 'templates');
const log = [];

function walk(dir) {
  return readdirSync(dir).flatMap(e => { const p = join(dir, e); return statSync(p).isDirectory() ? walk(p) : [p]; });
}
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
// 2. Workflows
for (const f of walk(join(T, 'workflows'))) put(`.github/workflows/${relative(join(T, 'workflows'), f)}`, readFileSync(f, 'utf8'));
// 3. Persona agents (repo-local so CI can use `claude --agent <name>` without the plugin)
for (const f of walk(join(PLUGIN, 'agents'))) put(`.claude/agents/${relative(join(PLUGIN, 'agents'), f)}`, readFileSync(f, 'utf8'));
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
  for (const k of ['allow', 'deny']) cur.permissions[k] = [...new Set([...(cur.permissions[k] || []), ...ours.permissions[k]])];
  cur.hooks ||= {}; cur.hooks.PreToolUse ||= [];
  const already = JSON.stringify(cur.hooks.PreToolUse).includes('circuit-guard.mjs');
  if (!already) cur.hooks.PreToolUse.push(...ours.hooks.PreToolUse);
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

console.log(`${DRY ? 'DRY RUN: ' : ''}delivery circuit -> ${repo} (org ${org})`);
for (const l of log) console.log('  ' + l);
