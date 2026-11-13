#!/usr/bin/env node
// env-for-branch.mjs: map a branch to its GitHub Environment and Apex test level (Delivery Circuit v4, section 3).
//   node scripts/ci/env-for-branch.mjs <branch> [--config build.config.yml]
// Reads the `environments:` list in build.config.yml, e.g.
//   environments:
//     - { branch: "sprint/*", environment: qa, test_level: RunLocalTests }
//     - { branch: main,       environment: production, test_level: RunLocalTests }
// (block-style entries `- branch: dev` + indented keys work too). The first entry whose pattern matches wins.
// Patterns use GitHub's filter globs: `*` matches any characters except `/`, `**` matches anything, `?` one character.
// Prints `environment=<env>` and `test_level=<level>` lines (append them to $GITHUB_OUTPUT). Exit 1 if nothing
// matches or the config is unusable, exit 2 on bad usage. No dependencies.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_LEVELS = ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'];
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;  // safe for $GITHUB_OUTPUT and for GitHub Environment names

const unquote = v => {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) return s.slice(1, -1);
  return s;
};
// Remove a trailing ` # comment` that is not inside quotes.
const stripComment = line => {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
};
const pairs = text => {
  const out = {};
  for (const part of text.split(',')) {
    const m = part.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
};

/** Parse the `environments:` list out of build.config.yml text. Returns [{branch, environment, test_level}]. */
export function parseEnvironments(yaml) {
  const lines = yaml.split(/\r?\n/).map(stripComment);
  const start = lines.findIndex(l => /^environments\s*:\s*$/.test(l));
  if (start < 0) throw new Error('build.config.yml has no top-level "environments:" list');
  const entries = [];
  let cur = null;
  for (const raw of lines.slice(start + 1)) {
    if (!raw.trim()) continue;
    if (!/^\s/.test(raw)) break;                        // next top-level key ends the list
    const item = raw.match(/^\s*-\s*(.*)$/);
    if (item) {
      const body = item[1].trim();
      const flow = body.match(/^\{(.*)\}$/);
      cur = flow ? pairs(flow[1]) : pairs(body);
      entries.push(cur);
    } else if (cur) {
      Object.assign(cur, pairs(raw));                   // block-style continuation line
    }
  }
  return entries;
}

/** GitHub-style branch glob: `**` any characters, `*` any except '/', `?` one character except '/'. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Resolve a branch. Returns {environment, test_level} or throws with a message for the log. */
export function resolveBranch(branch, entries) {
  const b = String(branch || '').replace(/^refs\/heads\//, '');
  if (!b) throw new Error('no branch given');
  for (const e of entries) {
    if (!e.branch) continue;
    if (!globToRegExp(e.branch).test(b)) continue;
    const environment = e.environment;
    const test_level = e.test_level || 'RunLocalTests';
    if (!environment || !SAFE.test(environment)) throw new Error(`entry for "${e.branch}" has an invalid environment "${environment ?? ''}"`);
    if (!TEST_LEVELS.includes(test_level)) throw new Error(`entry for "${e.branch}" has test_level "${test_level}"; use one of ${TEST_LEVELS.join(', ')}`);
    return { environment, test_level };
  }
  const known = entries.map(e => e.branch).filter(Boolean).join(', ') || 'none';
  throw new Error(`branch "${b}" matches no entry in build.config.yml environments (patterns: ${known}). Add it there, or use a circuit branch.`);
}

function main(argv) {
  const args = [...argv];
  let config = 'build.config.yml';
  const ci = args.indexOf('--config');
  if (ci > -1) { config = args[ci + 1]; args.splice(ci, 2); }
  if (args.length !== 1 || !config) { console.error('Usage: env-for-branch.mjs <branch> [--config build.config.yml]'); return 2; }
  try {
    const r = resolveBranch(args[0], parseEnvironments(readFileSync(config, 'utf8')));
    console.log(`environment=${r.environment}`);
    console.log(`test_level=${r.test_level}`);
    return 0;
  } catch (e) {
    console.error(`env-for-branch: ${e.code === 'ENOENT' ? `${config} not found` : e.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
