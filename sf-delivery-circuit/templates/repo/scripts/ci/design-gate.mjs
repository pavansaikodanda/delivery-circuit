#!/usr/bin/env node
// design-gate: G1 (design approved by an architect) and C5 (re-sign on change) for one story PR, from Jira.
//
//   node scripts/ci/design-gate.mjs --key ACME-12                  reads Jira with the runner's acli login
//   node scripts/ci/design-gate.mjs --key ACME-12 --story s.json --epic e.json   offline (tests, debugging)
//
// Source of truth (CIRCUIT-V3 sections 3-4), all in Jira so the check needs no Confluence credential:
//   - the story's parent epic carries "Approved design version" = the Confluence design page version an architect
//     approved. Jira's workflow lets only the `architects` group make the transition that sets it (G1), so the
//     epic must also be past the design statuses (DESIGN_PENDING_STATUSES, default "Backlog,Design Review").
//   - the story carries "Approved design version" = the version it was planned against (written by arch-jira-push).
//   - C5: story version must equal the epic's current approved version, else
//     "Design changed since this story was planned: re-plan or re-approve".
// Field ids come from .specify/extensions/jira/jira-config.json (fields["Approved design version"].id, fields["Design
// page"].id, built once with the Atlassian MCP per arch-jira-push) or the env JIRA_FIELD_APPROVED_DESIGN_VERSION / JIRA_FIELD_DESIGN_PAGE.
// Exit 0 = pass, 1 = gate failed, 2 = usage or Jira unreachable.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const C5_MESSAGE = 'Design changed since this story was planned: re-plan or re-approve';
const KEY_RE = /^[A-Z][A-Z0-9_]+-[0-9]+$/;

const fieldsOf = item => (item && typeof item.fields === 'object' && item.fields) ? item.fields : (item || {});

/** A version field may be a number, "3", "v3", {value:"3"} or an ADF-free string; returns a positive int or null. */
export function versionOf(raw) {
  let v = raw;
  if (v && typeof v === 'object') v = v.value ?? v.name ?? v.text ?? null;
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^v?(\d{1,6})(?:\.0+)?$/i);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}
const textOf = raw => (raw && typeof raw === 'object') ? String(raw.value ?? raw.url ?? '') : String(raw ?? '');
const statusOf = item => { const s = fieldsOf(item).status; return String((s && typeof s === 'object') ? s.name ?? '' : s ?? ''); };
export function parentKeyOf(item) {
  const p = fieldsOf(item).parent ?? item?.parent;
  const k = typeof p === 'string' ? p : p?.key;
  return KEY_RE.test(k || '') ? k : null;
}

/**
 * Pure gate decision.
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function evaluate({ key, story, epic, fieldIds, pendingStatuses = ['Backlog', 'Design Review'] }) {
  const lines = []; let ok = true;
  const fail = m => { ok = false; lines.push(`FAIL ${m}`); };
  const pass = m => lines.push(`ok   ${m}`);
  const vId = fieldIds?.approvedVersion, pId = fieldIds?.designPage;
  if (!vId) { fail('field id for "Approved design version" is unknown (add it to .specify/extensions/jira/jira-config.json per arch-jira-push, or set vars.JIRA_FIELD_APPROVED_DESIGN_VERSION)'); return { ok, lines }; }
  const sf = fieldsOf(story);
  const epicKey = parentKeyOf(story);
  if (!epic || !epicKey) { fail(`${key} has no parent epic in Jira, so there is no approved design to check (G1)`); return { ok, lines }; }
  const ef = fieldsOf(epic);

  // G1
  const epicStatus = statusOf(epic);
  const pending = pendingStatuses.map(s => s.trim().toLowerCase()).filter(Boolean);
  const epicVersion = versionOf(ef[vId]);
  if (!epicVersion) fail(`G1: epic ${epicKey} has no "Approved design version": an architect has not approved the design`);
  else if (pending.includes(epicStatus.trim().toLowerCase())) fail(`G1: epic ${epicKey} is in "${epicStatus}": the design is not approved (or is back in review)`);
  else pass(`G1: epic ${epicKey} design approved at version ${epicVersion} (status "${epicStatus}")`);

  // C5
  const storyVersion = versionOf(sf[vId]);
  if (!storyVersion) fail(`C5: story ${key} has no "Approved design version": it was not planned against an approved design`);
  else if (epicVersion && storyVersion < epicVersion) fail(`C5: ${C5_MESSAGE} (story planned at v${storyVersion}, approved design is v${epicVersion})`);
  else if (epicVersion && storyVersion > epicVersion) fail(`C5: story ${key} names design v${storyVersion}, newer than the approved v${epicVersion}: re-approve the design`);
  else if (epicVersion) pass(`C5: story ${key} planned against the approved design v${storyVersion}`);

  if (pId) {
    const sp = textOf(sf[pId]).trim(), ep = textOf(ef[pId]).trim();
    if (!sp) lines.push(`warn story ${key} has no "Design page" link`);
    else if (ep && sp !== ep) fail(`story ${key} links a different design page than its epic ${epicKey}`);
  }
  return { ok, lines };
}

export function fieldIdsFrom(configText, env = {}) {
  let cfg = {};
  try { cfg = configText ? JSON.parse(configText) : {}; } catch { cfg = {}; }
  const f = cfg.fields || {};
  const id = v => (v && typeof v === 'object' ? v.id : v) || null;
  return {
    approvedVersion: env.JIRA_FIELD_APPROVED_DESIGN_VERSION || id(f['Approved design version']),
    designPage: env.JIRA_FIELD_DESIGN_PAGE || id(f['Design page']),
  };
}

function acliView(key) {
  const r = spawnSync('acli', ['jira', 'workitem', 'view', key, '--json', '--fields', '*all'], { encoding: 'utf8', maxBuffer: 32 << 20 });
  if (r.error || r.status !== 0) throw new Error(`acli could not read ${key} (is the runner signed in? acli jira auth login --web)`);
  return JSON.parse(r.stdout);
}

function main(argv) {
  const opt = n => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : undefined; };
  const key = opt('key');
  if (!KEY_RE.test(key || '')) { console.error('Usage: design-gate.mjs --key <KEY> [--story file --epic file] [--config jira-config.json]'); return 2; }
  const cfgPath = opt('config') || '.specify/extensions/jira/jira-config.json';
  const fieldIds = fieldIdsFrom(existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '', process.env);
  const pendingStatuses = (process.env.DESIGN_PENDING_STATUSES || 'Backlog,Design Review').split(',');
  let story, epic;
  try {
    story = opt('story') ? JSON.parse(readFileSync(opt('story'), 'utf8')) : acliView(key);
    const ek = parentKeyOf(story);
    epic = opt('epic') ? JSON.parse(readFileSync(opt('epic'), 'utf8')) : (ek ? acliView(ek) : null);
  } catch (e) { console.error(`design-gate: ${e.message}`); return 2; }
  const { ok, lines } = evaluate({ key, story, epic, fieldIds, pendingStatuses });
  for (const l of lines) console.log(l);
  console.log(ok ? `design-gate: pass (${key})` : `design-gate: FAILED (${key})`);
  return ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
