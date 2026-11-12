#!/usr/bin/env node
// Fake Atlassian CLI for jira-sync tests. Keeps a tiny Jira in FAKE_ACLI_STATE (JSON) and logs every call.
// Supports: jira auth status | workitem search/create/edit | workitem link list/create.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const statePath = process.env.FAKE_ACLI_STATE;
const s = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { next: 1, issues: [], links: [], calls: [] };
const a = process.argv.slice(2);
const opt = n => { const i = a.indexOf(`--${n}`); return i > -1 ? a[i + 1] : undefined; };
s.calls.push(a[2] === 'link' ? `link ${a[3]}` : a[2]);
const save = () => writeFileSync(statePath, JSON.stringify(s, null, 2));
const out = x => process.stdout.write(JSON.stringify(x));

if (a[0] === 'jira' && a[1] === 'auth' && a[2] === 'status') {
  save();
  if (process.env.FAKE_ACLI_LOGGED_OUT) { process.stderr.write('not logged in'); process.exit(1); }
  process.stdout.write('Logged in to acme.atlassian.net as demo.user@example.com');
  process.exit(0);
}
if (a[1] === 'workitem' && a[2] === 'search') {
  const wanted = [...(opt('jql') || '').matchAll(/"(cref-[^"]+)"/g)].map(m => m[1]);
  save();
  // Shape deliberately nested to exercise the defensive parser.
  out({ issues: s.issues.filter(i => i.labels.some(l => wanted.includes(l))).map(i => ({ key: i.key, fields: { summary: i.summary, labels: i.labels } })) });
  process.exit(0);
}
if (a[1] === 'workitem' && a[2] === 'create') {
  const key = `ACME-${s.next++}`;
  s.issues.push({ key, type: opt('type'), summary: opt('summary'), labels: (opt('label') || '').split(','), parent: opt('parent') || null,
    description: readFileSync(opt('description-file'), 'utf8') });
  save(); out({ key, self: `https://acme.atlassian.net/rest/api/3/issue/${key}` }); process.exit(0);
}
if (a[1] === 'workitem' && a[2] === 'edit') {
  const i = s.issues.find(x => x.key === opt('key'));
  if (!i) { save(); process.stderr.write('not found'); process.exit(1); }
  if (opt('summary')) i.summary = opt('summary');
  if (opt('labels')) i.labels = opt('labels').split(',');
  if (opt('description-file')) i.description = readFileSync(opt('description-file'), 'utf8');
  save(); out({ key: i.key }); process.exit(0);
}
if (a[1] === 'workitem' && a[2] === 'link' && a[3] === 'list') {
  const k = opt('key');
  save();
  out(s.links.filter(l => l.in === k || l.out === k).map(l => ({ type: { name: l.type }, outwardIssue: { key: l.out }, inwardIssue: { key: l.in } })));
  process.exit(0);
}
if (a[1] === 'workitem' && a[2] === 'link' && a[3] === 'create') {
  s.links.push({ out: opt('out'), in: opt('in'), type: opt('type') });
  save(); process.exit(0);
}
save();
process.stderr.write(`fake acli: unsupported ${a.join(' ')}`);
process.exit(2);
