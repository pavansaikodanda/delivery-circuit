#!/usr/bin/env node
// ai-tester-verdict: turn SF AI Tester run output into a deterministic route for the fix loop.
//   node scripts/ci/ai-tester-verdict.mjs [.sf-ai-tester/runs] [--expect <number of suites run>] > verdict.json
// route: pass | dev (a case failed = defect) | qa (blocked = suite/data/permission) | infra (nothing ran, a suite
// produced no results, or agent error)
//
// Input: SF AI Tester (github.com/pavansaikodanda/sf-ai-tester, src/core/runner.ts writeRun) writes one folder per
// suite run: .sf-ai-tester/runs/<timestamp>/results.json = { suite, org, results: CaseResult[] }, where each
// CaseResult has id, title, mode (manual|automation), status (passed|failed|blocked|error), summary, defects[].
// The CLI exits 1 whenever any case did not pass, so CI ignores its exit code and uses this route instead.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const ei = args.indexOf('--expect');
const expect = ei > -1 ? Number(args[ei + 1]) : null;
const root = args.find((a, i) => !a.startsWith('--') && !(ei > -1 && i === ei + 1)) ?? '.sf-ai-tester/runs';
const runs = existsSync(root) ? readdirSync(root).filter(d => existsSync(join(root, d, 'results.json'))).sort() : [];

function readCases(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (!raw || !Array.isArray(raw.results)) throw new Error(`Unexpected results.json shape in ${file} (no results array)`);
  return raw.results.map(c => ({
    suite: raw.suite,
    id: c.id,
    mode: c.mode,
    status: String(c.status || '').toLowerCase(),
    summary: String(c.summary || '').slice(0, 300),
    defects: (c.defects || []).map(d => `[${d.severity}] ${d.title}`).slice(0, 5),
  }));
}

const cases = runs.flatMap(d => readCases(join(root, d, 'results.json')).map(c => ({ ...c, run: d })));
const pick = s => cases.filter(c => c.status === s);
const brief = c => ({ suite: c.suite, id: c.id, mode: c.mode, summary: c.summary, defects: c.defects });
const failed = pick('failed'), blocked = pick('blocked'), error = pick('error');
const missingRuns = expect != null && runs.length < expect ? expect - runs.length : 0;

let route = 'pass';
if (cases.length === 0 || missingRuns) route = 'infra';
else if (failed.length) route = 'dev';
else if (error.length) route = 'infra';
else if (blocked.length) route = 'qa';

console.log(JSON.stringify({
  route,
  total: cases.length,
  passed: pick('passed').length,
  failed: failed.map(brief),
  blocked: blocked.map(brief),
  error: error.map(brief),
  missing_runs: missingRuns,
  runs,
}, null, 2));
