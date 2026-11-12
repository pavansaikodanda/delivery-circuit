#!/usr/bin/env node
// check-tc-coverage: deterministic test-case checks for the delivery circuit.
//
// v3 (one Jira story per PR; files on the story PR):
//   --key ACME-12 --design            tests/ACME-12.tc.json is well-formed (ids unique, level ui|unit|manual, ac set);
//                                     every ui TC has a case in test-cases/ACME-12.sf-tests.yaml and vice versa
//   --key ACME-12 --testplan [file]   every TC is listed in docs/plans/ACME-12/TESTPLAN.md (or [file]) with its level
//   --key ACME-12 --code              --design checks + every automated unit TC is referenced under force-app/
//                                     by a test comment "// TC: <id>"
//
// Legacy (v2 spec folders, kept for repos that still have them):
//   --design-only <specDir> | --testplan <TESTPLAN.md> <specDir> [--story NN] | --code <specDir> --story NN
//
// Exit 0 = pass, 1 = fail, 2 = usage. Prints one line per problem.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(`--${n}`); const v = i > -1 ? args[i + 1] : null; return v && !v.startsWith('--') ? v : null; };
const has = n => args.includes(`--${n}`);
const problems = [];
const LEVELS = new Set(['ui', 'unit', 'manual']);
const KEY_RE = /^[A-Z][A-Z0-9_]+-[0-9]+$/;
const TC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*-TC-\d{2,3}$/;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function usage(msg) {
  if (msg) console.error(msg);
  console.error('Usage: check-tc-coverage.mjs --key <KEY> --design|--testplan [file]|--code\n' +
    '   or (legacy) --design-only <specDir> | --testplan <TESTPLAN.md> <specDir> [--story NN] | --code <specDir> --story NN');
  process.exit(2);
}

function loadIndexFile(f, label) {
  if (!existsSync(f)) { problems.push(`missing ${f}`); return null; }
  try {
    const idx = JSON.parse(readFileSync(f, 'utf8'));
    if (!idx || !Array.isArray(idx.cases)) { problems.push(`${f}: expected { "cases": [...] }`); return null; }
    return idx;
  } catch (e) { problems.push(`${label || f}: invalid JSON (${e.message})`); return null; }
}
function suiteIdsFile(f) {
  if (!existsSync(f)) return null;
  return new Set([...readFileSync(f, 'utf8').matchAll(/^\s*-?\s*id:\s*["']?([A-Za-z0-9_.-]+)/gm)].map(m => m[1]));
}
function checkCases(label, idx, idOk, idHint) {
  const seen = new Set();
  for (const c of idx.cases) {
    if (!idOk(c.id || '')) problems.push(`${label}: bad TC id "${c.id}" (expected ${idHint})`);
    if (seen.has(c.id)) problems.push(`${label}: duplicate TC id ${c.id}`);
    seen.add(c.id);
    if (!LEVELS.has(c.level)) problems.push(`${c.id}: level must be ui|unit|manual, got "${c.level}"`);
    if (!c.ac) problems.push(`${c.id}: missing "ac" (acceptance criterion id)`);
  }
  if (!idx.cases.length) problems.push(`${label}: no test cases`);
}
function checkUiSuite(label, idx, suiteFile, indexName) {
  const ui = idx.cases.filter(c => c.level === 'ui');
  const ids = suiteIdsFile(suiteFile);
  if (!ui.length && !ids) return;
  if (!ids) { problems.push(`${label}: ${ui.length} ui TC(s) but no suite ${suiteFile}`); return; }
  for (const c of ui) if (!ids.has(c.id)) problems.push(`${c.id}: ui TC has no case in ${suiteFile}`);
  const tcIds = new Set(idx.cases.map(c => c.id));
  for (const id of ids) if (!tcIds.has(id)) problems.push(`${suiteFile}: case ${id} is not in ${indexName}`);
}
function checkTestplan(tpFile, idx) {
  if (!existsSync(tpFile)) { problems.push(`missing ${tpFile}`); return; }
  const lines = readFileSync(tpFile, 'utf8').split('\n');
  for (const c of idx.cases) {
    const hit = lines.filter(l => new RegExp(`(^|[^A-Za-z0-9_-])${esc(c.id)}([^A-Za-z0-9_-]|$)`).test(l));
    if (!hit.length) problems.push(`${c.id} (${c.level}) is missing from ${tpFile}`);
    else if (!hit.some(l => new RegExp(`\\b${c.level}\\b`, 'i').test(l))) problems.push(`${c.id}: listed in ${tpFile} but not at level "${c.level}"`);
  }
}
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(cls|js|ts)$/.test(e)) out.push(p);
  }
  return out;
}
function checkCodeRefs(idx) {
  const corpus = walk('force-app').map(f => readFileSync(f, 'utf8')).join('\n');
  for (const c of idx.cases.filter(c => c.level === 'unit' && c.automated !== false)) {
    if (!new RegExp(`TC:\\s*${esc(c.id)}(?![A-Za-z0-9_-])`).test(corpus)) problems.push(`${c.id}: unit TC not referenced by any test ("// TC: ${c.id}") under force-app/`);
  }
}

let modeLabel;
const key = opt('key');
if (has('key')) {
  // ---- v3: one story per PR
  if (!key || !KEY_RE.test(key)) usage(`--key needs a Jira key like ACME-12`);
  const sub = has('code') ? 'code' : has('testplan') ? 'testplan' : has('design') ? 'design' : null;
  if (!sub) usage('--key needs --design, --testplan or --code');
  modeLabel = `${sub} ${key}`;
  const indexFile = `tests/${key}.tc.json`;
  const suiteFile = `test-cases/${key}.sf-tests.yaml`;
  const idx = loadIndexFile(indexFile);
  if (idx) {
    if (sub === 'testplan') checkTestplan(opt('testplan') || `docs/plans/${key}/TESTPLAN.md`, idx);
    else {
      checkCases(key, idx, id => TC_ID_RE.test(id), '<prefix>-TC-nn, e.g. ACME-12-TC-01');
      checkUiSuite(key, idx, suiteFile, indexFile);
      if (sub === 'code') checkCodeRefs(idx);
    }
  } else if (sub !== 'design') {
    problems.push(`the Tester has not added ${indexFile} to this PR yet (qa-add-tests)`);
  }
} else {
  // ---- legacy spec folders
  const mode = has('design-only') ? 'design' : has('testplan') ? 'testplan' : has('code') ? 'code' : null;
  const specDir = mode === 'testplan' ? args[args.indexOf('--testplan') + 2] : opt(mode === 'design' ? 'design-only' : 'code');
  if (!mode || !specDir || !existsSync(specDir)) usage();
  modeLabel = mode;
  const feature = basename(specDir.replace(/[\\/]+$/, ''));
  const indexOf = story => join(specDir, 'tests', `story_${story}.tc.json`);
  const suiteOf = story => join('test-cases', `${feature}-story-${story}.sf-tests.yaml`);
  const storyIdOk = story => id => new RegExp(`^S${story}-TC-\\d{2,3}$`).test(id);
  const stories = () => {
    const dir = join(specDir, 'tests');
    return existsSync(dir) ? readdirSync(dir).map(f => f.match(/^story_(\d+)\.tc\.json$/)?.[1]).filter(Boolean).sort() : [];
  };
  if (mode === 'design') {
    const list = stories();
    if (!list.length) problems.push(`no tests/story_NN.tc.json files in ${specDir}`);
    for (const s of list) {
      const idx = loadIndexFile(indexOf(s));
      if (idx) { checkCases(`story ${s}`, idx, storyIdOk(s), `S${s}-TC-nn`); checkUiSuite(`story ${s}`, idx, suiteOf(s), `story_${s}.tc.json`); }
    }
  }
  if (mode === 'testplan') {
    const tpFile = opt('testplan');
    if (!existsSync(tpFile)) { console.error(`missing ${tpFile}`); process.exit(1); }
    let story = opt('story');
    if (!story) {
      const counts = {};
      for (const m of readFileSync(tpFile, 'utf8').matchAll(/\bS(\d+)-TC-\d+/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
      story = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!story) { console.error('TESTPLAN.md names no TC ids; pass --story NN'); process.exit(1); }
    }
    const idx = loadIndexFile(indexOf(story));
    if (idx) checkTestplan(tpFile, idx);
  }
  if (mode === 'code') {
    const story = opt('story');
    if (!story) usage('--code needs --story NN');
    const idx = loadIndexFile(indexOf(story));
    if (idx) { checkCases(`story ${story}`, idx, storyIdOk(story), `S${story}-TC-nn`); checkUiSuite(`story ${story}`, idx, suiteOf(story), `story_${story}.tc.json`); checkCodeRefs(idx); }
  }
}

for (const p of problems) console.log(`FAIL ${p}`);
console.log(problems.length ? `${problems.length} problem(s)` : `OK (${modeLabel})`);
process.exit(problems.length ? 1 : 0);
