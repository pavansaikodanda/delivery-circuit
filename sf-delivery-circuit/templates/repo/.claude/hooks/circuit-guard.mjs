#!/usr/bin/env node
// circuit-guard: PreToolUse hook for the Delivery Circuit v4 (docs/CIRCUIT-V4.md section 6).
// What AI may never do, whatever the persona, skill or prompt:
//   - push to, force-push or delete sprint/*, dev, sit, uat, main (master)
//   - approve or merge a PR (gh pr review --approve, gh pr merge without --auto, the gh api equivalents);
//     `gh pr merge --auto` on the Developer's own feature/* PR is allowed: the rulesets still decide
//   - deploy anywhere except the developer's DEV alias (build.config.yml salesforce.dev_alias, default "dev");
//     validate / --dry-run is allowed against DEV only; any command against the production alias is refused
//   - set a Confluence page to Approved, or move a Jira story to Ready for Dev / Done
//   - read, print or set SFDX_AUTH_URL values or any other secret (sf org display --verbose, sfdxAuthUrl,
//     gh secret set, key / .env / Salesforce session files)
// Input: hook JSON on stdin. Output: a deny decision as JSON, or nothing (= no opinion, normal permissions apply).
// Mode "--plugin": used by the plugin copy; it steps aside when the project ships its own registered guard.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

const PLUGIN_MODE = process.argv.includes('--plugin');

function readStdin() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

const input = readStdin();
const tool = input.tool_name || '';
const ti = input.tool_input || {};
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

if (PLUGIN_MODE && existsSync(join(projectDir, '.claude', 'hooks', 'circuit-guard.mjs'))) {
  // The project has its own guard registered in .claude/settings.json; avoid double evaluation.
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `circuit-guard: ${reason}`,
    },
  }));
  process.exit(0);
}

// ---------- configuration (build.config.yml, no YAML dependency) ----------
/** Value of `<section>:` → `<key>:` in build.config.yml (two-level, simple scalars only). */
function buildConfig(section, key) {
  let text;
  try { text = readFileSync(join(projectDir, 'build.config.yml'), 'utf8'); } catch { return null; }
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) { inSection = new RegExp(`^${section}:\\s*(#.*)?$`).test(line); continue; }
    if (!inSection) continue;
    const m = line.match(new RegExp(`^\\s+${key}:\\s*["']?([^"'\\s#]+)`));
    if (m) return m[1];
  }
  return null;
}
const lc = s => String(s || '').toLowerCase();
const DEV_ALIAS = lc(process.env.CIRCUIT_DEV_ALIAS || buildConfig('salesforce', 'dev_alias') || 'dev');
function prodAliases() {
  const set = new Set(['prod', 'production', 'live', 'prd']);
  for (const a of (process.env.CIRCUIT_PROD_ALIASES || '').split(',')) if (a.trim()) set.add(lc(a.trim()));
  const p = buildConfig('salesforce', 'prod_alias');
  if (p && lc(p) !== 'none') set.add(lc(p));
  const cfg = join(projectDir, '.specify', 'extensions', 'sf', 'sf-config.yml');
  if (existsSync(cfg)) {
    const m = readFileSync(cfg, 'utf8').match(/^\s*prod:\s*["']?([^"'\s#]+)/m);
    if (m && lc(m[1]) !== 'none') set.add(lc(m[1]));
  }
  set.delete(DEV_ALIAS);
  return set;
}
const PROD = prodAliases();
const isProdLike = a => !!a && (PROD.has(lc(a)) || (lc(a) !== DEV_ALIAS && /(^|[-_.])(prod|production|live)([-_.]|$)/i.test(a)));
// The org an sf command uses when it names none: SF_TARGET_ORG, else the project's .sf/config.json target-org.
function defaultTargetOrg() {
  if (process.env.SF_TARGET_ORG) return process.env.SF_TARGET_ORG;
  for (const dir of new Set([input.cwd, projectDir].filter(Boolean))) {
    try { const t = JSON.parse(readFileSync(join(dir, '.sf', 'config.json'), 'utf8'))['target-org']; if (t) return t; } catch { /* none */ }
  }
  return null;
}

// ---------- helpers ----------
function segments(cmd) {
  // Split on shell control operators. Good enough for policy checks; errs on the side of checking more.
  return cmd.split(/\s*(?:&&|\|\||;|\||\n|`|\$\()\s*/).map(s => s.trim()).filter(Boolean);
}
function flag(seg, names) {
  for (const n of names) {
    const m = seg.match(new RegExp(`(?:^|\\s)${n}(?:=|\\s+)("[^"]*"|'[^']*'|\\S+)`));
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}
const unq = a => a.replace(/^["']|["']$/g, '');
const words = seg => (seg.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(unq);
const gitCwd = input.cwd || projectDir;
function currentBranch() {
  const git = args => { try { return execFileSync('git', args, { cwd: gitCwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return null; } };
  return (git(['symbolic-ref', '--short', '-q', 'HEAD']) ?? git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? '').trim();
}
const branchName = b => String(b || '').replace(/^\+/, '').replace(/^refs\/heads\//, '');
// Environment branches (CIRCUIT-V4 section 3): only PRs change them.
const PROTECTED = b => /^(sprint\/.+|dev|sit|uat|main|master)$/.test(branchName(b));
const WRITE_API = /-X\s*(POST|PUT|PATCH|DELETE)|--method\s+(POST|PUT|PATCH|DELETE)|\s-f\s|\s-F\s|--field\b|--raw-field\b|--input\b/;

/** Text a `gh api` call sends: the segment, the whole command (heredocs, --input -) and any @file / --input file. */
function ghApiBody(seg, cmd) {
  let text = `${seg}\n${cmd}`;
  const files = [...seg.matchAll(/(?:=@|--input\s+)("[^"]+"|'[^']+'|[^\s"']+)/g)].map(m => unq(m[1]));
  for (const f of files) {
    if (f === '-') continue;
    try { text += '\n' + readFileSync(isAbsolute(f) ? f : resolve(gitCwd, f), 'utf8').slice(0, 1 << 20); } catch { /* unreadable */ }
  }
  return text;
}

// ---------- git: environment branches change only through PRs ----------
function checkGitPush(seg) {
  const w = words(seg).slice(2); // after "git push"
  const valueFlags = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
  const pos = [];
  let all = false;
  for (let i = 0; i < w.length; i++) {
    const a = w[i];
    if (valueFlags.has(a)) { i++; continue; }
    if (/^--(all|mirror|branches)$/.test(a)) all = true;
    if (!a.startsWith('-')) pos.push(a);
  }
  if (all) deny('`git push --all/--mirror` would push the environment branches (sprint/*, dev, sit, uat, main). Push your feature branch by name.');
  const refspecs = pos.slice(1);
  if (!refspecs.length) {
    const cur = currentBranch();
    if (PROTECTED(cur)) deny(`you are on ${cur}, an environment branch; it changes only through a PR. Create feature/<KEY>-<slug> first.`);
    return;
  }
  for (const r of refspecs) {
    const src = r.includes(':') ? r.slice(0, r.indexOf(':')) : r;
    let dst = r.includes(':') ? r.slice(r.indexOf(':') + 1) : r;
    if (!r.includes(':') && branchName(src) === 'HEAD') dst = currentBranch();
    if (PROTECTED(dst)) deny(`pushing to, force-pushing or deleting ${branchName(dst)} is not allowed: environment branches change only through a reviewed PR.`);
  }
}

// ---------- GitHub: approvals and merges stay human ----------
const GQL_APPROVE = /\b(addPullRequestReview|submitPullRequestReview)\b/;
const GQL_MERGE = /\b(mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch)\b/;

function checkGh(seg, cmd) {
  if (/^gh\s+pr\s+merge\b/.test(seg)) {
    const s = seg + ' ';
    if (/\s--disable-auto(\s|$)/.test(s)) return;
    if (/\s--admin(\s|$)/.test(s)) deny('`gh pr merge --admin` bypasses the rulesets; merging is for people and auto-merge.');
    if (!/\s--auto(\s|$)/.test(s)) deny('AI never merges a PR. Turn on auto-merge for your own feature PR (`gh pr merge --auto --squash`); the rulesets decide.');
    // --auto: only for a feature/* PR. A number or URL is left to the rulesets; a branch name (or none) is checked here.
    const valueFlags = /^(-t|--subject|-b|--body|-F|--body-file|-A|--author-email|--match-head-commit|-R|--repo)$/;
    const w = words(seg).slice(3);
    let target;
    for (let i = 0; i < w.length; i++) {
      if (valueFlags.test(w[i])) { i++; continue; }
      if (!w[i].startsWith('-')) { target = w[i]; break; }
    }
    const head = target ?? currentBranch();
    if (!/^\d+$/.test(head) && !/^https?:\/\//.test(head) && !/^feature\//.test(head)) {
      deny(`auto-merge is allowed only on the Developer's own feature/* PR (got "${head}"). Promotion PRs are merged by the leads.`);
    }
  }
  if (/^gh\s+pr\s+review\b/.test(seg) && /(\s--approve|\s-a)(\s|=|$)/.test(seg + ' ')) deny('AI never approves a PR. CodeRabbit or a person approves.');
  if (/^gh\s+secret\s+set\b/.test(seg)) {
    deny('AI never sets secrets. A person runs `gh secret set SFDX_AUTH_URL --env <environment>` in their own terminal and pastes the value at the prompt.');
  }
  if (/^gh\s+workflow\s+run\b/.test(seg) && /deploy/i.test(seg)) deny('deploys happen only by merging into an environment branch (deploy.yml); nobody runs them by hand.');
  if (/^gh\s+api\b/.test(seg)) {
    const body = ghApiBody(seg, cmd);
    const writes = WRITE_API.test(seg + ' ');
    if (/\/pulls\/\d+\/merge\b|\/merges\b/.test(seg)) deny('merging through the API is not allowed. Use `gh pr merge --auto` on your feature PR.');
    if (/\/reviews\b/.test(seg) && /APPROVE/i.test(body)) deny('approving through the API is not allowed.');
    if (/\bgraphql\b/.test(seg)) {
      if (GQL_APPROVE.test(body) && /\bAPPROVE\b/.test(body)) deny('approving a PR through GraphQL is not allowed.');
      if (GQL_MERGE.test(body)) deny('merging (or auto-merge / merge queue) through GraphQL is not allowed. Use `gh pr merge --auto` on your feature PR.');
    }
    const ref = seg.match(/\/git\/refs\/heads\/(\S+?)(["'\s]|$)/);
    if (ref && writes && PROTECTED(ref[1])) deny(`changing or deleting ${ref[1]} through the API is not allowed: environment branches change only through PRs.`);
    if (/\/contents\//.test(seg) && writes) {
      const br = (body.match(/\bbranch=([^\s"']+)/) || [])[1];
      if (!br || PROTECTED(br)) deny('committing through the contents API to an environment branch is not allowed. Commit on a feature branch.');
    }
  }
}

// ---------- Salesforce CLI ----------
const DEPLOY = /\bproject\s+deploy\s+(start|quick|resume|validate)\b|\bdeploy\s+metadata\b|force:source:deploy|force:mdapi:deploy|force:source:push|\bproject\s+delete\s+source\b|\bproject\s+deploy\s+pipeline\b/;
function checkSf(seg) {
  const target = flag(seg, ['--target-org', '-o', '--targetusername', '-u', '--alias', '-a']);
  if (isProdLike(target)) deny(`the production org "${target}" is off limits to AI. Production is deployed by deploy.yml after the leads approve.`);
  const usesOrg = !/\borg\s+(login|list|logout)\b|\b(config|alias|plugins|version|update|help|which|doctor)\b|--help\b/.test(seg);
  const org = target || (usesOrg ? defaultTargetOrg() : null);
  if (!target && usesOrg && isProdLike(org)) {
    deny(`this command names no --target-org, so it would run against the project default "${org}", which is production. Name your DEV org: --target-org ${DEV_ALIAS}.`);
  }
  if (/^(sf|sfdx)\s+org\s+display\b/.test(seg) && /--verbose\b/.test(seg)) deny('`sf org display --verbose` prints the access token and sfdxAuthUrl. Use it without --verbose.');
  if (DEPLOY.test(seg)) {
    if (!org) deny(`deploys must name the DEV org: --target-org ${DEV_ALIAS}.`);
    if (lc(org) !== DEV_ALIAS) deny(`AI deploys and validates only against your DEV org "${DEV_ALIAS}" (build.config.yml salesforce.dev_alias), not "${org}". Other sandboxes are deployed by merging into their branch.`);
  }
}

// ---------- Bash / PowerShell ----------
const SECRET_PATH = /(\.key\b|\.pem\b|\.p12\b|(^|[\s\\/'"])\.env(\.\w+)?\b|[\\/]\.sf[\\/]|[\\/]\.sfdx[\\/]|\.sfkeys)/i;
function checkBash(cmd) {
  if (/\bsfdxAuthUrl\b/i.test(cmd) || /\$\{?SFDX_AUTH_URL\b|\$env:SFDX_AUTH_URL|printenv\s+SFDX_AUTH_URL/i.test(cmd)) {
    deny('SFDX_AUTH_URL / sfdxAuthUrl values are never read or printed by AI.');
  }
  if (/force:\/\/\S+@/i.test(cmd)) deny('an sfdx auth URL never goes on a command line.');
  for (const s of segments(cmd)) {
    const seg = s.replace(/^(sudo|env\s+\S+=\S+|time)\s+/, '');
    if (/^(cat|type|less|more|head|tail|bat|Get-Content|gc|cp|scp|base64|xxd)\b/i.test(seg) && SECRET_PATH.test(seg)) {
      deny('reading key, .env or Salesforce session files is not allowed.');
    }
    if (/^(sf|sfdx)\s/.test(seg)) checkSf(seg);
    if (/^git\s+push\b/.test(seg)) checkGitPush(seg);
    if (/^gh\s/.test(seg)) checkGh(seg, cmd);
    if (/^acli(\.exe)?\s/.test(seg) && /\btransition\b/.test(seg) && /ready\s*for\s*dev|\bdone\b/i.test(seg)) {
      deny('moving a story to Ready for Dev or Done is a person\'s decision in Jira.');
    }
  }
}

// ---------- files ----------
const SECRET_FILES = [/\.(key|pem|p12)$/i, /(^|\/)\.env(\.|$)/, /(^|\/)\.sfkeys\//];
function checkRead() {
  const fp = ti.file_path || ti.notebook_path || ti.path || '';
  if (!fp) return;
  const abs = isAbsolute(fp) ? resolve(fp) : resolve(projectDir, fp);
  const r = relative(projectDir, abs).split('\\').join('/');
  const home = resolve(homedir());
  if (SECRET_FILES.some(p => p.test(r)) || abs.startsWith(join(home, '.sf')) || abs.startsWith(join(home, '.sfdx'))) {
    deny('reading keys, .env or Salesforce session files is not allowed.');
  }
}

// ---------- MCP tools (Atlassian) ----------
// Tool names: mcp__<server>__<tool> (persona config) or mcp__claude_ai_<Connector>__<tool> (claude.ai connectors).
// The hook matcher in settings.json must include mcp__.* for these rules to run.
const HUMAN_STATUS = /ready[\s_-]*for[\s_-]*dev|"done"|\bdone\b/i;
function checkMcp() {
  const m = tool.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return;
  const [, server, name] = m;
  if (!/atlassian|confluence|jira/i.test(server)) return;
  const body = JSON.stringify(ti);
  if (/(ContentStatus|ContentState|PageStatus)/i.test(name) && !/^(get|list|search)/i.test(name) && /approved/i.test(body)) {
    deny('setting a design page to Approved is the Architect\'s decision in Confluence. Use "Ready for review".');
  }
  if (/^transitionJiraIssue$/i.test(name)) {
    const tr = ti.transition ?? ti.transitionId ?? ti.status ?? {};
    const text = typeof tr === 'object' ? JSON.stringify(tr) : String(tr);
    if (HUMAN_STATUS.test(text) || HUMAN_STATUS.test(String(ti.transitionName ?? ''))) {
      deny('moving a story to Ready for Dev or Done is a person\'s decision in Jira (refinement / QA).');
    }
  }
  if (/^editJiraIssue$/i.test(name)) {
    const status = ti.fields?.status ?? ti.additional_fields?.status;
    if (status && HUMAN_STATUS.test(JSON.stringify(status))) deny('moving a story to Ready for Dev or Done is a person\'s decision in Jira.');
  }
}

switch (tool) {
  case 'Bash':
  case 'PowerShell':
    checkBash(String(ti.command || ''));
    break;
  case 'Read':
    checkRead();
    break;
  default:
    if (tool.startsWith('mcp__')) checkMcp();
    break;
}
process.exit(0);
