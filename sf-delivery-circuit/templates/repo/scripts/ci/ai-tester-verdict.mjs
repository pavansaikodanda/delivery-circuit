#!/usr/bin/env node
// ai-tester-verdict: turn SF AI Tester run output into a deterministic route for the fix loop.
//   node scripts/ci/ai-tester-verdict.mjs [.sf-ai-tester/runs] > verdict.json
// route: pass | dev (a case failed = defect) | qa (blocked = suite/data/permission) | infra (nothing ran, or agent error)
// VERIFY: the results.json shape against a real SF AI Tester run and adjust readCases(). Unknown shapes fail loudly.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? '.sf-ai-tester/runs';
const runs = existsSync(root) ? readdirSync(root).filter(d => existsSync(join(root, d, 'results.json'))) : [];

function readCases(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.results ?? raw.cases;
  if (!Array.isArray(list)) throw new Error(`Unknown results.json shape in ${file}`);
  return list.map(c => ({ id: c.id ?? c.caseId, mode: c.mode, status: String(c.status ?? c.verdict ?? '').toLowerCase() }));
}

const cases = runs.flatMap(d => readCases(join(root, d, 'results.json')).map(c => ({ ...c, run: d })));
const by = s => cases.filter(c => c.status === s).map(c => c.id);
const failed = by('failed'), blocked = by('blocked'), error = by('error');

let route = 'pass';
if (cases.length === 0) route = 'infra';
else if (failed.length) route = 'dev';
else if (error.length) route = 'infra';
else if (blocked.length) route = 'qa';

console.log(JSON.stringify({ route, total: cases.length, passed: by('passed').length, failed, blocked, error, runs }, null, 2));
