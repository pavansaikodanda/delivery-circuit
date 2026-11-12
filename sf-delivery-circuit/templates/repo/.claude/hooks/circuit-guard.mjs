#!/usr/bin/env node
// circuit-guard: PreToolUse hook for the AI + Human Salesforce delivery circuit.
// Enforces the hard rules no matter which persona, skill or prompt is active:
//   - nobody (AI) touches production, merges, approves, or pushes to main
//   - separation of duties by persona (CIRCUIT_PERSONA = architect | developer | tester)
//   - AI never ticks the Architect Sign-Off (G1)
//   - secrets and Salesforce session files are never read
// Input: hook JSON on stdin. Output: a deny decision as JSON, or nothing (= no opinion, normal permissions apply).
// Mode "--plugin": used by the plugin copy; it steps aside when the project ships its own registered guard.

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
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
const persona = (process.env.CIRCUIT_PERSONA || '').toLowerCase();

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

// ---------- configuration ----------
function prodAliases() {
  const set = new Set(['prod', 'production', 'live', 'prd']);
  for (const a of (process.env.CIRCUIT_PROD_ALIASES || '').split(',')) if (a.trim()) set.add(a.trim().toLowerCase());
  const cfg = join(projectDir, '.specify', 'extensions', 'sf', 'sf-config.yml');
  if (existsSync(cfg)) {
    const m = readFileSync(cfg, 'utf8').match(/^\s*prod:\s*["']?([^"'\s#]+)/m);
    if (m && m[1].toLowerCase() !== 'none') set.add(m[1].toLowerCase());
  }
  return set;
}
const PROD = prodAliases();
const DEPLOY_ORGS = new Set((process.env.CIRCUIT_DEPLOY_ORGS || 'qa').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const isProdLike = a => !!a && (PROD.has(a.toLowerCase()) || /(^|[-_.])(prod|production|live)([-_.]|$)/i.test(a));
// The org an sf command uses when it names none: SF_TARGET_ORG, else the project's .sf/config.json target-org.
function defaultTargetOrg() {
  if (process.env.SF_TARGET_ORG) return process.env.SF_TARGET_ORG;
  for (const dir of new Set([input.cwd, projectDir].filter(Boolean))) {
    const f = join(dir, '.sf', 'config.json');
    try { const t = JSON.parse(readFileSync(f, 'utf8'))['target-org']; if (t) return t; } catch { /* none */ }
  }
  return null;
}

// ---------- Bash ----------
function segments(cmd) {
  // Split on shell control operators. Good enough for policy checks; errs on the side of checking more.
  return cmd.split(/\s*(?:&&|\|\||;|\||\n|`|\$\()\s*/).map(s => s.trim()).filter(Boolean);
}
function flag(seg, names) {
  for (const n of names) {
    const re = new RegExp(`(?:^|\\s)${n}(?:=|\\s+)("[^"]*"|'[^']*'|\\S+)`);
    const m = seg.match(re);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}
function currentBranch() {
  try { return execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
}

function checkBash(cmd) {
  for (const s of segments(cmd)) {
    const seg = s.replace(/^(sudo|env\s+\S+=\S+|time)\s+/, '');

    // Secrets and Salesforce sessions
    if (/\b(cat|type|less|more|head|tail|bat|Get-Content|gc|cp|scp|curl\s+.*-T)\b/.test(seg) &&
        /(\.key\b|\.pem\b|\.p12\b|\.env\b|[\\/]\.sf[\\/]|[\\/]\.sfdx[\\/]|\.sfkeys)/i.test(seg)) {
      deny('reading key, .env or Salesforce session files is not allowed. Move secrets with `gh secret set NAME < file`.');
    }
    if (/^(sf|sfdx)\s+org\s+display\b/.test(seg) && /--verbose|\buser\b/.test(seg)) {
      deny('`sf org display --verbose` prints access tokens. Use `sf org display` without --verbose.');
    }

    // Salesforce CLI
    if (/^(sf|sfdx)\s/.test(seg)) {
      const target = flag(seg, ['--target-org', '-o', '--targetusername', '-u', '--alias', '-a']);
      const url = flag(seg, ['--instance-url', '-r', '--instanceurl']);
      if (isProdLike(target)) deny(`production org "${target}" is off limits to AI. Production is deployed only by deploy-prod.yml after human approval (G9).`);
      if (!target && !/\borg\s+(login|list|logout)\b|\b(config|alias|plugins|version|update|help|which)\b|--help\b/.test(seg)) {
        const def = defaultTargetOrg();
        if (isProdLike(def)) deny(`this command has no --target-org, so it would run against the project default "${def}", which is production. Name a sandbox with --target-org, or set the default to the DEV sandbox (\`sf config set target-org dev\`).`);
      }
      // Logins are not checked by org type: SDO and demo orgs are production-edition orgs and are used as DEV/QA.
      // What stays protected is the release org the project names as production (sf-config prod alias, prod/live).
      void url;
      const isRealDeploy = /\bproject\s+deploy\s+(start|quick|resume)\b|\bdeploy\s+metadata\b|force:source:deploy|force:mdapi:deploy|\bproject\s+delete\s+source\b/.test(seg) && !/--dry-run\b/.test(seg);
      if (isRealDeploy) {
        if (!target) deny('deploys must name an explicit --target-org.');
        if (persona === 'tester') {
          if (!DEPLOY_ORGS.has(target.toLowerCase())) deny(`the Tester may deploy only to: ${[...DEPLOY_ORGS].join(', ')} (CIRCUIT_DEPLOY_ORGS).`);
        } else if (persona) {
          deny(`the ${persona} persona may not deploy. Use a check-only deploy: \`sf project deploy validate --target-org dev ...\`.`);
        }
      }
      if (/\b(hotfix)\b/.test(seg)) deny('hotfix deploys go through a human-run release, not AI.');
    }

    // git
    if (/^git\s+push\b/.test(seg)) {
      if (persona && /\s(--force|-f|--force-with-lease)(\s|=|$)/.test(seg)) deny('force push is not allowed for personas.');
      const protectedRef = /(^|[\s:/+])(main|master)(\s|$)/;
      const args = seg.replace(/^git\s+push\s*/, '');
      if (protectedRef.test(args)) deny('pushing to main/master is not allowed. Push a feature/spec branch and open a PR.');
      const positional = args.split(/\s+/).filter(a => a && !a.startsWith('-'));
      if (positional.length <= 1 && ['main', 'master'].includes(currentBranch())) {
        deny('you are on main; pushing it is not allowed. Create a branch first.');
      }
    }

    // GitHub CLI
    if (/^gh\s/.test(seg)) {
      if (/^gh\s+pr\s+merge\b/.test(seg)) deny('merging is a human gate (G8, Architect).');
      if (/^gh\s+pr\s+review\b/.test(seg) && /(\s--approve|\s-a)(\s|$)/.test(seg)) deny('approving a PR is a human gate (G3-G7).');
      if (/^gh\s+api\b/.test(seg)) {
        if (/\/merge\b/.test(seg)) deny('merging through the API is a human gate (G8).');
        if (/\/reviews\b/.test(seg) && /APPROVE/i.test(seg)) deny('approving through the API is a human gate.');
        if (persona && /(rulesets|\/protection\b|\/environments\/)/.test(seg) && /-X\s+(POST|PUT|PATCH|DELETE)|--method\s+(POST|PUT|PATCH|DELETE)|\s-f\s|\s-F\s|--input/.test(seg)) {
          deny('personas may not change rulesets, branch protection or environments.');
        }
      }
      if (/^gh\s+workflow\s+run\s+.*deploy-prod/.test(seg)) deny('production deploys start only from a merge to main plus environment approval (G9).');
      if (persona && /^gh\s+pr\s+edit\b/.test(seg) && /(plan-approved|testplan-approved)/.test(seg)) {
        deny('gate labels plan-approved / testplan-approved are set by the human Developer / Tester (G3/G4).');
      }
    }

    // Spec Kit SF commands that deploy or push
    if (/speckit[.-]sf[.-](deploy|hotfix|pr)\b/.test(seg)) deny('spec-kit-sf deploy/hotfix/pr are disabled in the circuit. CI opens PRs; deploy-prod.yml deploys.');
  }
}

// ---------- files ----------
function rel(p) {
  if (!p) return '';
  const abs = isAbsolute(p) ? p : resolve(projectDir, p);
  return relative(projectDir, abs).split('\\').join('/');
}
const match = (r, pats) => pats.some(p => p.test(r));

const ALL_PERSONA_DENY = [/^\.github\//, /^\.claude\/settings(\.local)?\.json$/, /^\.claude\/hooks\//, /(^|\/)CODEOWNERS$/, /^\.specify\/extensions\//];
const PERSONA_DENY = {
  developer: [/^test-cases\//, /^\.specify\/specs\/[^/]+\/tests\//, /^\.specify\/memory\//,
              /^\.specify\/specs\/[^/]+\/(spec|plan|data-model)\.md$/, /^\.specify\/specs\/[^/]+\/task_story_\d+\.md$/],
  tester:    [/^force-app\//, /^\.specify\/memory\//, /^\.specify\/specs\/[^/]+\/(plan|data-model)\.md$/],
  architect: [/^force-app\//, /^test-cases\//, /^\.specify\/specs\/[^/]+\/tests\//],
};
const SECRET_FILES = [/\.(key|pem|p12)$/i, /(^|\/)\.env(\.|$)/, /(^|\/)\.sfkeys\//];

function checkSignOff(r, oldText, newText) {
  if (!/(^|\/)plan\.md$/.test(r)) return;
  const ticked = t => /\[x\]\s*APPROVED/i.test(t || '');
  if (ticked(newText) && !ticked(oldText)) deny('only the human Architect ticks the Architect Sign-Off in plan.md (G1).');
}

function checkFile(kind) {
  const fp = ti.file_path || ti.notebook_path || ti.path || '';
  const r = rel(fp);
  const absHome = resolve(homedir());
  const abs = isAbsolute(fp) ? resolve(fp) : resolve(projectDir, fp);

  if (kind === 'read') {
    if (match(r, SECRET_FILES) || abs.startsWith(join(absHome, '.sf')) || abs.startsWith(join(absHome, '.sfdx'))) {
      deny('reading keys, .env or Salesforce session files is not allowed.');
    }
    return;
  }
  if (persona && match(r, ALL_PERSONA_DENY)) deny(`${r} is pipeline configuration; change it through a human-reviewed PR outside a persona session.`);
  if (persona && PERSONA_DENY[persona] && match(r, PERSONA_DENY[persona])) {
    deny(`the ${persona} persona may not change ${r} (separation of duties).`);
  }
  if (tool === 'Edit') {
    checkSignOff(r, ti.old_string, ti.new_string);
  } else if (tool === 'MultiEdit') {
    for (const e of ti.edits || []) checkSignOff(r, e.old_string, e.new_string);
  } else if (tool === 'Write') {
    const before = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    checkSignOff(r, before, ti.content);
  }
}

switch (tool) {
  case 'Bash':
  case 'PowerShell':
    checkBash(String(ti.command || ''));
    break;
  case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
    checkFile('write');
    break;
  case 'Read':
    checkFile('read');
    break;
  default:
    break;
}
process.exit(0);
