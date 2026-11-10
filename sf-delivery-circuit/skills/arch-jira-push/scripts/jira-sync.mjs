#!/usr/bin/env node
// jira-sync: deterministic, idempotent Jira writer for the delivery circuit.
//
//   node jira-sync.mjs discover --project ABC --out .specify/extensions/jira/jira-config.json
//   node jira-sync.mjs push --plan <jira-plan.json> --config <jira-config.json> [--map <jira-map.json>] [--apply]
//
// Credentials come from the environment only: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN. Nothing is printed.
// Idempotency: every issue gets the label  cref-<NNN>-<ref>  (e.g. cref-001-02, cref-001-S02-TC-01) and is found by it.
// Refs not in the plan (e.g. stories referenced by a test plan) are resolved from the existing jira-map.json.
// Jira REST v3 (verify against current Atlassian docs: /rest/api/3/search/jql, /rest/api/3/issueLink).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CIRCUIT_FIELDS = ['Spec file', 'Feature', 'Story type', 'Schema change', 'Persona', 'Test level', 'AC id',
  'Testability confirmed', 'Acceptance criteria'];

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const has = n => args.includes(`--${n}`);

const BASE = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const AUTH = 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL || ''}:${process.env.JIRA_API_TOKEN || ''}`).toString('base64');
if (!BASE || !process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
  console.error('Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in the environment.'); process.exit(2);
}

async function jira(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

const adf = (text) => ({
  type: 'doc', version: 1,
  content: String(text ?? '').split(/\n{2,}/).map(p => ({
    type: 'paragraph',
    content: p.split('\n').flatMap((line, i, all) => [
      ...(line ? [{ type: 'text', text: line }] : []),
      ...(i < all.length - 1 ? [{ type: 'hardBreak' }] : []),
    ]),
  })),
});

async function discover() {
  const project = opt('project');
  const out = opt('out', '.specify/extensions/jira/jira-config.json');
  if (!project) throw new Error('--project is required');
  const fields = await jira('GET', '/rest/api/3/field');
  const byName = new Map(fields.map(f => [f.name.toLowerCase(), f]));
  const mapped = {};
  for (const name of CIRCUIT_FIELDS) {
    const f = byName.get(name.toLowerCase());
    mapped[name] = f ? { id: f.id, type: f.schema?.type ?? null, custom: f.schema?.custom ?? null } : null;
  }
  let types = [];
  try {
    const meta = await jira('GET', `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`);
    types = (meta.issueTypes || meta.values || []).map(t => t.name);
  } catch (e) { types = [`(could not read issue types: ${e.message.slice(0, 80)})`]; }
  let linkTypes = [];
  try { linkTypes = (await jira('GET', '/rest/api/3/issueLinkType')).issueLinkTypes.map(l => `${l.name} (${l.outward} / ${l.inward})`); } catch {}
  const config = { project, fields: mapped, issueTypes: types, linkTypes };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
  console.log(`Wrote ${out}`);
  for (const [n, v] of Object.entries(mapped)) console.log(`${n.padEnd(22)} ${v ? v.id + '  ' + (v.custom || v.type) : 'MISSING - create it in Jira'}`);
  console.log(`Issue types: ${types.join(', ')}`);
  console.log(`Link types:  ${linkTypes.join(', ')}`);
}

function fieldValue(meta, value) {
  if (value === undefined || value === null) return undefined;
  const custom = meta.custom || '';
  if (/textarea/.test(custom)) return adf(value);
  if (/(select|radiobuttons)$/.test(custom)) return { value: String(value) };
  if (/multicheckboxes|multiselect/.test(custom)) return (Array.isArray(value) ? value : [value]).map(v => ({ value: String(v) }));
  if (meta.type === 'number') return Number(value);
  return String(value);
}

async function push() {
  const plan = JSON.parse(readFileSync(opt('plan'), 'utf8'));
  const config = JSON.parse(readFileSync(opt('config', '.specify/extensions/jira/jira-config.json'), 'utf8'));
  const mapPath = opt('map', join(dirname(opt('plan')), 'jira-map.json'));
  const map = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, 'utf8')) : { refs: {} };
  map.refs ||= {};
  const apply = has('apply');
  const num = (plan.feature || '').match(/^\d{3}/)?.[0] || '000';
  const cref = ref => `cref-${num}-${String(ref).replace(/[^A-Za-z0-9-]/g, '-')}`;
  const actions = [];

  async function findByLabel(ref) {
    const jql = `project = "${plan.project}" AND labels = "${cref(ref)}"`;
    const r = await jira('GET', `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,issuelinks&maxResults=2`);
    if ((r.issues || []).length > 1) throw new Error(`More than one issue carries ${cref(ref)}; fix duplicates first.`);
    return r.issues?.[0] || null;
  }

  // Issues in dependency order: parents first (plan order is respected; parent refs must appear earlier or in the map).
  for (const it of plan.issues) {
    const existing = await findByLabel(it.ref);
    const fields = {
      project: { key: plan.project },
      issuetype: { name: it.type },
      summary: it.summary,
      labels: [...new Set([...(plan.labels || []), ...(it.labels || []), cref(it.ref)])],
    };
    if (it.description) fields.description = adf(it.description);
    if (it.parent) {
      const pk = map.refs[it.parent];
      if (pk) fields.parent = { key: pk };
      else if (apply) throw new Error(`Parent ref ${it.parent} of ${it.ref} has no Jira key yet.`);
    }
    for (const [name, value] of Object.entries(it.fields || {})) {
      const meta = config.fields?.[name];
      if (!meta) throw new Error(`Field "${name}" is not in jira-config.json (run discover).`);
      fields[meta.id] = fieldValue(meta, value);
    }
    if (existing) {
      map.refs[it.ref] = existing.key;
      actions.push({ ref: it.ref, action: 'update', key: existing.key, summary: it.summary });
      if (apply) {
        const { project, issuetype, ...upd } = fields;
        await jira('PUT', `/rest/api/3/issue/${existing.key}`, { fields: upd });
      }
    } else {
      actions.push({ ref: it.ref, action: 'create', key: '(new)', summary: it.summary });
      if (apply) {
        const created = await jira('POST', '/rest/api/3/issue', { fields });
        map.refs[it.ref] = created.key;
        actions[actions.length - 1].key = created.key;
      }
    }
  }

  // Links, read as "<from> <outward verb> <to>":
  //   { type: "Blocks", from: "00" } on issue "02"  ->  00 blocks 02
  //   { type: "Tests",  to: "02" } on issue "S02-TC-01"  ->  S02-TC-01 tests 02
  for (const it of plan.issues) {
    for (const l of it.links || []) {
      const fromRef = l.to ? it.ref : l.from, toRef = l.to ? l.to : it.ref;
      const to = map.refs[toRef], from = map.refs[fromRef];
      if (!to || !from) { actions.push({ ref: it.ref, action: `link ${fromRef} ${l.type} ${toRef}`, key: '(after create)' }); continue; }
      const issue = await jira('GET', `/rest/api/3/issue/${to}?fields=issuelinks`);
      const exists = (issue.fields.issuelinks || []).some(x => x.type?.name === l.type && (x.inwardIssue?.key === from || x.outwardIssue?.key === from));
      actions.push({ ref: it.ref, action: exists ? `link ${l.type} (exists)` : `link ${l.type} from ${from}`, key: to });
      // Jira semantics: the issue in "inwardIssue" shows the outward description ("blocks").  verify on first run
      if (!exists && apply) await jira('POST', '/rest/api/3/issueLink', { type: { name: l.type }, inwardIssue: { key: from }, outwardIssue: { key: to } });
    }
  }

  console.log(`${apply ? 'APPLIED' : 'DRY RUN'} for ${plan.feature} in ${plan.project}`);
  for (const a of actions) console.log(`${a.action.padEnd(28)} ${String(a.key).padEnd(10)} ${a.ref.padEnd(12)} ${a.summary || ''}`);
  const creates = actions.filter(a => a.action === 'create').length;
  console.log(`creates: ${creates}, updates: ${actions.filter(a => a.action === 'update').length}`);
  if (apply) { writeFileSync(mapPath, JSON.stringify(map, null, 2) + '\n'); console.log(`Wrote ${mapPath}`); }
}

try {
  if (cmd === 'discover') await discover();
  else if (cmd === 'push') await push();
  else { console.error('Usage: jira-sync.mjs discover|push ...'); process.exit(2); }
} catch (e) { console.error(`jira-sync: ${e.message}`); process.exit(1); }
