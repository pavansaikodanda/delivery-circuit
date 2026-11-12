#!/usr/bin/env node
// jira-sync: deterministic, idempotent Jira writer for the delivery circuit (v3, no API tokens).
//
// Two backends, both using the person's own login:
//   acli  the Atlassian CLI, logged in with `acli jira auth login --web` (browser OAuth). The script runs it.
//   mcp   the Atlassian Remote MCP server (OAuth in Claude Code /mcp). A script cannot call MCP tools, so the
//         script emits the exact tool calls (ops JSON); Claude runs them and records the keys back.
//
//   node jira-sync.mjs status
//   node jira-sync.mjs push    --plan <jira-plan.json> [--backend auto|acli|mcp] [--map <map.json>]
//                               [--config <jira-config.json>] [--ops <ops.json>] [--apply]
//   node jira-sync.mjs lookup  --plan <jira-plan.json>                       (prints the JQL that finds existing items)
//   node jira-sync.mjs resolve --plan <jira-plan.json> --search-result <file> [--map <map.json>]
//   node jira-sync.mjs record  --plan <jira-plan.json> --ref <ref> --key <KEY> [--map <map.json>]
//
// Idempotency: every work item carries the label  cref-<NNN>-<ref>  (e.g. cref-001-02, cref-001-S02-TC-01) and is
// found by it, so re-running updates instead of duplicating. The local map (default: jira-map.json next to the plan,
// under the gitignored .specify/specs/) is only a cache of ref -> key plus a content hash per item; Jira is the truth.
// Without --apply nothing is written anywhere (dry run).
//
// acli facts used (developer.atlassian.com/cloud/acli/reference/commands/):
//   workitem search --jql Q --json --fields F --paginate | create --project --type --summary --description-file
//   --label a,b --parent K --json | edit --key K --summary --description-file --labels --yes --json |
//   link list --key K --json | link create --out A --in B --type Blocks --yes.
// The JSON output shape of acli is not documented, so every parser below is defensive.
// Custom fields (Design page, Approved design version, Acceptance criteria, ...) have no documented acli flag:
// they are written as MCP editJiraIssue ops (--ops) and also stamped in the description footer.

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 && args[i + 1] !== undefined ? args[i + 1] : d; };
const has = n => args.includes(`--${n}`);

// Fields the circuit sets on stories, from the plan's design block (v3 section 2).
export const DESIGN_FIELDS = ['Design page', 'Approved design version', 'Acceptance criteria'];
const KEY_RE = /\b[A-Z][A-Z0-9_]+-\d+\b/;
const FULL_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
/** Jira key for a plan ref: from the map, or the ref itself when it already is a key (e.g. a test case's story). */
export const keyOf = (map, ref) => map.refs[ref] || (FULL_KEY.test(String(ref)) ? String(ref) : null);

// ---------- pure helpers (exported for tests) ----------
export function featureNum(feature) { return String(feature || '').match(/^\d{3}/)?.[0] || '000'; }
export function crefLabel(feature, ref) { return `cref-${featureNum(feature)}-${String(ref).replace(/[^A-Za-z0-9-]/g, '-')}`; }
const isStoryLike = it => !/^(epic|test|test case|sub-task|subtask)$/i.test(it.type || '');

/** The Jira writes one plan item needs: core fields (acli or MCP) and circuit fields (MCP / description footer). */
export function desiredItem(plan, it) {
  const cref = crefLabel(plan.feature, it.ref);
  const labels = [...new Set([...(plan.labels || []), ...(it.labels || []), cref])];
  const fields = { ...(it.fields || {}) };
  const design = plan.design || {};
  const isEpic = /^epic$/i.test(it.type || '');
  if ((isEpic || isStoryLike(it)) && design.url) fields['Design page'] = design.url;
  // The story records the version it was planned against. The epic's "Approved design version" is G1: an architect
  // sets it in Jira (restricted transition) after approving the page, so this script never writes it on the epic.
  if (isStoryLike(it)) {
    if (design.approvedVersion !== undefined && design.approvedVersion !== null) fields['Approved design version'] = Number(design.approvedVersion);
    if (it.acceptanceCriteria) fields['Acceptance criteria'] = it.acceptanceCriteria;
  }
  const footer = ['---', 'Delivery Circuit (written by jira-sync; edit the design page, not this block)'];
  if (fields['Design page']) footer.push(`Design page: ${design.url}`);
  if (isStoryLike(it) && fields['Approved design version'] !== undefined) footer.push(`Approved design version: ${fields['Approved design version']}`);
  footer.push(`Circuit ref: ${cref}`);
  const parts = [it.description || ''];
  if (it.acceptanceCriteria) parts.push(`Acceptance criteria\n${it.acceptanceCriteria}`);
  parts.push(footer.join('\n'));
  const description = parts.filter(Boolean).join('\n\n');
  const hash = createHash('sha256').update(JSON.stringify({ t: it.type, s: it.summary, d: description, l: labels, f: fields, p: it.parent || null })).digest('hex').slice(0, 16);
  return { ref: it.ref, cref, type: it.type, summary: it.summary, description, labels, fields, parent: it.parent || null, links: it.links || [], hash };
}

/** Pull work items out of whatever JSON acli or the MCP search returned: [{key, summary, labels}]. */
export function parseIssues(json) {
  const out = [];
  const visit = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(visit); return; }
    if (typeof x.key === 'string' && KEY_RE.test(x.key) && (x.fields || x.labels || x.summary)) {
      const f = x.fields || {};
      const labels = f.labels ?? x.labels ?? [];
      out.push({ key: x.key, summary: f.summary ?? x.summary ?? '', labels: Array.isArray(labels) ? labels.map(String) : String(labels).split(/[,\s]+/).filter(Boolean) });
      return;
    }
    for (const v of Object.values(x)) visit(v);
  };
  visit(json);
  return out;
}

/** Map cref label -> issue, refusing duplicates (two items with one cref label means an earlier partial run). */
export function indexByCref(issues) {
  const by = new Map();
  for (const i of issues) for (const l of i.labels) if (/^cref-/.test(l)) {
    if (by.has(l) && by.get(l).key !== i.key) throw new Error(`More than one work item carries ${l} (${by.get(l).key}, ${i.key}); fix duplicates first.`);
    by.set(l, i);
  }
  return by;
}

export function lookupJql(plan) {
  const labels = plan.issues.map(it => `"${crefLabel(plan.feature, it.ref)}"`).join(', ');
  return `project = "${plan.project}" AND labels in (${labels})`;
}

/** Does a link list (acli or MCP JSON) already hold "<from> <type> <to>"? */
export function linkExists(json, type, otherKey) {
  const entries = [];
  const visit = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(visit); return; }
    const s = JSON.stringify(x);
    if ((x.type || x.linkType || x.inwardIssue || x.outwardIssue) && s.includes(otherKey)) { entries.push(s); return; }
    for (const v of Object.values(x)) visit(v);
  };
  visit(json);
  const t = String(type).toLowerCase();
  return entries.some(s => s.toLowerCase().includes(t) || s.toLowerCase().includes(t.replace(/s$/, '')));
}

// ---------- io ----------
function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }
function loadMap(p) {
  const m = existsSync(p) ? readJson(p) : {};
  m.refs ||= {}; m.hashes ||= {};
  return m;
}
function saveMap(p, map) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(map, null, 2) + '\n'); }
function planPaths() {
  const planPath = opt('plan');
  if (!planPath) throw new Error('--plan is required');
  const plan = readJson(planPath);
  if (!plan.project || !plan.feature || !Array.isArray(plan.issues)) throw new Error('plan needs project, feature and issues[]');
  return { plan, planPath, mapPath: opt('map', join(dirname(planPath), 'jira-map.json')) };
}

// acli runner: array arguments only, never a shell string. CIRCUIT_ACLI points at another binary (tests use a .mjs).
function acliCmd() {
  const bin = process.env.CIRCUIT_ACLI || 'acli';
  return /\.(mjs|cjs|js)$/.test(bin) ? [process.execPath, [bin]] : [bin, []];
}
function acli(argv, { allowFail = false } = {}) {
  const [bin, pre] = acliCmd();
  const r = spawnSync(bin, [...pre, ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`could not run acli (${r.error.code || r.error.message}). Install it: https://developer.atlassian.com/cloud/acli/guides/install-acli/`);
  if (r.status !== 0 && !allowFail) throw new Error(`acli ${argv.slice(0, 3).join(' ')} -> exit ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`);
  return r;
}
const parseOut = (text) => { try { return JSON.parse(text); } catch { return text; } };
function acliLoggedIn() {
  try { return acli(['jira', 'auth', 'status'], { allowFail: true }).status === 0; } catch { return false; }
}

// ---------- commands ----------
function status() {
  let ok = false, detail = '';
  try {
    const r = acli(['jira', 'auth', 'status'], { allowFail: true });
    ok = r.status === 0; detail = (r.stdout || r.stderr || '').trim().split('\n')[0];
  } catch (e) { detail = e.message; }
  console.log(JSON.stringify({ acli: ok ? 'logged-in' : 'unavailable', detail, fallback: 'mcp' }));
}

function writeOps(path, ops, plan) {
  const doc = {
    note: 'Run these with the Atlassian Remote MCP tools, in order. Argument names follow the tool schema in your session; map them by meaning. After each createJiraIssue run: node jira-sync.mjs record --plan <plan> --ref <ref> --key <KEY>.',
    project: plan.project, feature: plan.feature, ops,
  };
  if (path) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(doc, null, 2) + '\n'); console.log(`Wrote ${path} (${ops.length} MCP ops)`); }
  else if (ops.length) console.log(JSON.stringify(doc, null, 2));
}

function fieldOps(plan, d, key, config) {
  const names = Object.keys(d.fields);
  if (!names.length) return [];
  const fields = {}, unmapped = [];
  for (const n of names) {
    const id = config?.fields?.[n]?.id;
    if (id) fields[id] = d.fields[n]; else { fields[n] = d.fields[n]; unmapped.push(n); }
  }
  return [{ tool: 'editJiraIssue', ref: d.ref, args: { issueIdOrKey: key ?? `<key of ${d.ref}>`, fields },
    ...(unmapped.length ? { resolveFieldIds: unmapped, hint: 'find ids with getJiraIssueTypeMetaWithFields' } : {}) }];
}

function pushAcli(plan, map, apply, config) {
  const actions = [], ops = [];
  const search = acli(['jira', 'workitem', 'search', '--jql', lookupJql(plan), '--json', '--fields', 'key,summary,labels', '--paginate']);
  const found = indexByCref(parseIssues(parseOut(search.stdout)));
  const tmp = mkdtempSync(join(tmpdir(), 'jira-sync-'));
  try {
    for (const it of plan.issues) {
      const d = desiredItem(plan, it);
      const existing = found.get(d.cref);
      const descFile = join(tmp, `${d.cref}.txt`);
      writeFileSync(descFile, d.description);
      if (existing) {
        map.refs[d.ref] = existing.key;
        const missing = d.labels.filter(l => !existing.labels.includes(l));
        const changed = map.hashes[d.ref] !== d.hash || missing.length > 0;
        actions.push({ ref: d.ref, action: changed ? 'update' : 'unchanged', key: existing.key, summary: d.summary });
        if (changed && apply) {
          const argv = ['jira', 'workitem', 'edit', '--key', existing.key, '--summary', d.summary, '--description-file', descFile, '--yes', '--json'];
          // Pass existing + desired so labels set by people (ai-ready, ...) survive whether --labels adds or replaces.
          if (missing.length) argv.push('--labels', [...new Set([...existing.labels, ...d.labels])].join(','));
          acli(argv);
        }
        if (changed) ops.push(...fieldOps(plan, d, existing.key, config));
        if (apply) map.hashes[d.ref] = d.hash;
      } else {
        actions.push({ ref: d.ref, action: 'create', key: '(new)', summary: d.summary });
        let parentKey = null;
        if (d.parent) {
          parentKey = keyOf(map, d.parent);
          if (!parentKey && apply) throw new Error(`Parent ref ${d.parent} of ${d.ref} has no Jira key yet (list parents first).`);
        }
        if (apply) {
          const argv = ['jira', 'workitem', 'create', '--project', plan.project, '--type', d.type, '--summary', d.summary,
            '--description-file', descFile, '--label', d.labels.join(','), '--json'];
          if (parentKey) argv.push('--parent', parentKey);
          const out = acli(argv).stdout;
          const key = (parseIssues(parseOut(out))[0]?.key) || String(out).match(KEY_RE)?.[0];
          if (!key) throw new Error(`acli create for ${d.ref} returned no key: ${String(out).slice(0, 200)}`);
          map.refs[d.ref] = key; map.hashes[d.ref] = d.hash;
          actions[actions.length - 1].key = key;
        }
        ops.push(...fieldOps(plan, d, map.refs[d.ref], config));
      }
    }
    // Links, read as "<from> <outward verb> <to>":  { type: "Blocks", from: "00" } on "02"  ->  00 blocks 02
    //                                              { type: "Tests", to: "02" } on "S02-TC-01" -> S02-TC-01 tests 02
    for (const it of plan.issues) for (const l of it.links || []) {
      const fromRef = l.to ? it.ref : l.from, toRef = l.to ? l.to : it.ref;
      const from = keyOf(map, fromRef), to = keyOf(map, toRef);
      if (!from || !to) { actions.push({ ref: it.ref, action: `link ${fromRef} ${l.type} ${toRef}`, key: '(after create)' }); continue; }
      const list = acli(['jira', 'workitem', 'link', 'list', '--key', to, '--json'], { allowFail: true });
      const exists = list.status === 0 && linkExists(parseOut(list.stdout), l.type, from);
      actions.push({ ref: it.ref, action: exists ? `link ${l.type} (exists)` : `link ${from} ${l.type} ${to}`, key: to });
      if (!exists && apply) acli(['jira', 'workitem', 'link', 'create', '--out', from, '--in', to, '--type', l.type, '--yes']);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return { actions, ops };
}

function pushMcp(plan, map, config) {
  if (!map.resolvedAt) {
    throw Object.assign(new Error(`run the lookup first: searchJiraIssuesUsingJql with\n  ${lookupJql(plan)}\nsave the result to a file, then: node jira-sync.mjs resolve --plan <plan> --search-result <file>`), { code: 3 });
  }
  const actions = [], ops = [];
  for (const it of plan.issues) {
    const d = desiredItem(plan, it);
    const key = map.refs[d.ref];
    if (key) {
      const changed = map.hashes[d.ref] !== d.hash;
      actions.push({ ref: d.ref, action: changed ? 'update' : 'unchanged', key, summary: d.summary });
      if (changed) ops.push({ tool: 'editJiraIssue', ref: d.ref, hash: d.hash,
        args: { issueIdOrKey: key, fields: { summary: d.summary, description: d.description, labels: d.labels } },
        note: 'keep labels people added (read them first; never remove ai-ready)' }, ...fieldOps(plan, d, key, config));
    } else {
      actions.push({ ref: d.ref, action: 'create', key: '(new)', summary: d.summary });
      ops.push({ tool: 'createJiraIssue', ref: d.ref, hash: d.hash, recordAs: d.ref,
        args: { projectKey: plan.project, issueTypeName: d.type, summary: d.summary, description: d.description,
          ...(d.parent ? { parent: keyOf(map, d.parent) ?? `<key of ${d.parent}>` } : {}), additional_fields: { labels: d.labels } } },
        ...fieldOps(plan, d, null, config));
    }
  }
  for (const it of plan.issues) for (const l of it.links || []) {
    const fromRef = l.to ? it.ref : l.from, toRef = l.to ? l.to : it.ref;
    actions.push({ ref: it.ref, action: `link ${fromRef} ${l.type} ${toRef}`, key: keyOf(map, toRef) || '(after create)' });
    ops.push({ tool: 'createJiraIssueLink', ref: it.ref, skipIfExists: true,
      args: { type: l.type, outwardIssue: keyOf(map, fromRef) ?? `<key of ${fromRef}>`, inwardIssue: keyOf(map, toRef) ?? `<key of ${toRef}>` },
      note: `${fromRef} ${l.type.toLowerCase()} ${toRef}; check getJiraIssue issuelinks first` });
  }
  return { actions, ops };
}

function push() {
  const { plan, mapPath } = planPaths();
  const map = loadMap(mapPath);
  const apply = has('apply');
  const configPath = opt('config');
  const config = configPath && existsSync(configPath) ? readJson(configPath) : null;
  let backend = opt('backend', 'auto');
  if (backend === 'auto') backend = acliLoggedIn() ? 'acli' : 'mcp';
  const { actions, ops } = backend === 'acli' ? pushAcli(plan, map, apply, config) : pushMcp(plan, map, config);

  console.log(`${backend === 'mcp' ? 'MCP OPS' : apply ? 'APPLIED' : 'DRY RUN'} (${backend}) for ${plan.feature} in ${plan.project}`);
  for (const a of actions) console.log(`${a.action.padEnd(30)} ${String(a.key).padEnd(12)} ${String(a.ref).padEnd(12)} ${a.summary || ''}`);
  const count = t => actions.filter(a => a.action === t).length;
  console.log(`creates: ${count('create')}, updates: ${count('update')}, unchanged: ${count('unchanged')}`);
  if (backend === 'acli' && apply) { saveMap(mapPath, map); console.log(`Wrote ${mapPath}`); }
  if (backend === 'mcp' || ops.length) writeOps(opt('ops'), ops, plan);
  if (backend === 'acli' && ops.length && !opt('ops')) console.log('Circuit fields above need the Atlassian MCP (editJiraIssue): pass --ops <file> to save them.');
}

function lookup() { const { plan } = planPaths(); console.log(lookupJql(plan)); }

function resolve() {
  const { plan, mapPath } = planPaths();
  const file = opt('search-result');
  if (!file) throw new Error('--search-result is required');
  const map = loadMap(mapPath);
  const found = indexByCref(parseIssues(parseOut(readFileSync(file, 'utf8'))));
  let n = 0;
  for (const it of plan.issues) {
    const hit = found.get(crefLabel(plan.feature, it.ref));
    if (hit) { map.refs[it.ref] = hit.key; n++; }
  }
  map.resolvedAt = new Date().toISOString();
  saveMap(mapPath, map);
  console.log(`resolved ${n}/${plan.issues.length} refs; wrote ${mapPath}`);
}

function record() {
  const { plan, mapPath } = planPaths();
  const ref = opt('ref'), key = opt('key');
  if (!ref || !key || !KEY_RE.test(key)) throw new Error('--ref and a Jira --key (e.g. ACME-12) are required');
  const it = plan.issues.find(i => String(i.ref) === String(ref));
  if (!it) throw new Error(`ref ${ref} is not in the plan`);
  const map = loadMap(mapPath);
  map.refs[ref] = key;
  map.hashes[ref] = desiredItem(plan, it).hash;
  saveMap(mapPath, map);
  console.log(`recorded ${ref} = ${key}`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (isMain) {
  try {
    if (cmd === 'status') status();
    else if (cmd === 'push') push();
    else if (cmd === 'lookup') lookup();
    else if (cmd === 'resolve') resolve();
    else if (cmd === 'record') record();
    else { console.error('Usage: jira-sync.mjs status|push|lookup|resolve|record ... (see the header)'); process.exit(2); }
  } catch (e) { console.error(`jira-sync: ${e.message}`); process.exit(e.code === 3 ? 3 : 1); }
}
