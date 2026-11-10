#!/usr/bin/env node
// check-tc-coverage: deterministic test-case checks for the delivery circuit.
//
//   --design-only <specDir>                 ids well-formed and unique; every ui TC has a case in its SF AI Tester suite
//   --testplan <TESTPLAN.md> <specDir> [--story NN]
//                                           every TC of the story is listed in TESTPLAN.md with its level
//   --code <specDir> --story NN             every unit TC is referenced by a test ("TC: Sxx-TC-yy"); every ui TC has a suite case
//
// Exit 0 = pass, 1 = fail. Prints one line per problem.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : null; };
const mode = args.includes('--design-only') ? 'design' : args.includes('--testplan') ? 'testplan' : args.includes('--code') ? 'code' : null;
const specDir = mode === 'testplan' ? args[args.indexOf('--testplan') + 2] : opt(mode === 'design' ? 'design-only' : 'code');
if (!mode || !specDir || !existsSync(specDir)) {
  console.error('Usage: check-tc-coverage.mjs --design-only <specDir> | --testplan <TESTPLAN.md> <specDir> [--story NN] | --code <specDir> --story NN');
  process.exit(2);
}
const feature = basename(specDir.replace(/[\\/]+$/, ''));
const problems = [];
const LEVELS = new Set(['ui', 'unit', 'manual']);

function loadIndex(story) {
  const f = join(specDir, 'tests', `story_${story}.tc.json`);
  if (!existsSync(f)) { problems.push(`missing ${f}`); return null; }
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { problems.push(`${f}: invalid JSON (${e.message})`); return null; }
}
function suiteIds(story) {
  const f = join('test-cases', `${feature}-story-${story}.sf-tests.yaml`);
  if (!existsSync(f)) return { file: f, ids: null };
  const ids = [...readFileSync(f, 'utf8').matchAll(/^\s*-?\s*id:\s*["']?([A-Za-z0-9_-]+)/gm)].map(m => m[1]);
  return { file: f, ids: new Set(ids) };
}
function stories() {
  const dir = join(specDir, 'tests');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map(f => f.match(/^story_(\d+)\.tc\.json$/)?.[1]).filter(Boolean).sort();
}
function checkIndex(story, idx) {
  const seen = new Set();
  for (const c of idx.cases || []) {
    if (!new RegExp(`^S${story}-TC-\\d{2,3}$`).test(c.id || '')) problems.push(`story ${story}: bad TC id "${c.id}" (expected S${story}-TC-nn)`);
    if (seen.has(c.id)) problems.push(`story ${story}: duplicate TC id ${c.id}`);
    seen.add(c.id);
    if (!LEVELS.has(c.level)) problems.push(`${c.id}: level must be ui|unit|manual, got "${c.level}"`);
    if (!c.ac) problems.push(`${c.id}: missing "ac" (acceptance criterion id)`);
  }
  if (!(idx.cases || []).length) problems.push(`story ${story}: no test cases`);
}
function checkUi(story, idx) {
  const ui = (idx.cases || []).filter(c => c.level === 'ui');
  if (!ui.length) return;
  const { file, ids } = suiteIds(story);
  if (!ids) { problems.push(`story ${story}: ${ui.length} ui TC(s) but no suite ${file}`); return; }
  for (const c of ui) if (!ids.has(c.id)) problems.push(`${c.id}: ui TC has no case in ${file}`);
  const tcIds = new Set((idx.cases || []).map(c => c.id));
  for (const id of ids) if (!tcIds.has(id)) problems.push(`${file}: case ${id} is not in story_${story}.tc.json`);
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

if (mode === 'design') {
  const list = stories();
  if (!list.length) problems.push(`no tests/story_NN.tc.json files in ${specDir}`);
  for (const s of list) { const idx = loadIndex(s); if (idx) { checkIndex(s, idx); checkUi(s, idx); } }
}

if (mode === 'testplan') {
  const tpFile = opt('testplan');
  if (!existsSync(tpFile)) { console.error(`missing ${tpFile}`); process.exit(1); }
  const tp = readFileSync(tpFile, 'utf8');
  let story = opt('story');
  if (!story) {
    const counts = {};
    for (const m of tp.matchAll(/\bS(\d+)-TC-\d+/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
    story = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!story) { console.error('TESTPLAN.md names no TC ids; pass --story NN'); process.exit(1); }
  }
  const idx = loadIndex(story);
  if (idx) {
    const lines = tp.split('\n');
    for (const c of idx.cases || []) {
      const hit = lines.filter(l => l.includes(c.id));
      if (!hit.length) problems.push(`${c.id} (${c.level}) is missing from ${tpFile}`);
      else if (!hit.some(l => new RegExp(`\\b${c.level}\\b`, 'i').test(l))) problems.push(`${c.id}: listed in ${tpFile} but not at level "${c.level}"`);
    }
  }
}

if (mode === 'code') {
  const story = opt('story');
  if (!story) { console.error('--code needs --story NN'); process.exit(2); }
  const idx = loadIndex(story);
  if (idx) {
    checkIndex(story, idx); checkUi(story, idx);
    const files = [...walk('force-app')];
    const corpus = files.map(f => readFileSync(f, 'utf8')).join('\n');
    for (const c of (idx.cases || []).filter(c => c.level === 'unit' && c.automated !== false)) {
      if (!new RegExp(`TC:\\s*${c.id}\\b`).test(corpus)) problems.push(`${c.id}: unit TC not referenced by any test ("// TC: ${c.id}") under force-app/`);
    }
  }
}

for (const p of problems) console.log(`FAIL ${p}`);
console.log(problems.length ? `${problems.length} problem(s)` : `OK (${mode})`);
process.exit(problems.length ? 1 : 0);
