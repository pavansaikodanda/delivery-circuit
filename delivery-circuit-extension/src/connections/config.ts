// Reads build.config.yml (the client repo's bootstrap config, no secrets). No vscode import.
import { parse as parseYaml } from "yaml";

export interface CircuitConfig {
  githubOrg?: string;
  githubRepo?: string;
  jiraSite?: string;
  jiraProjectKey?: string;
  confluenceSpace?: string;
  sf: {
    devUrl?: string;
    qaUrl?: string;
    prodUrl?: string;
    devAlias: string;
    qaAlias: string;
    /** salesforce.prod_alias: the org the project names as production (AI never works there) */
    prodAlias?: string;
    /** The config says dev/qa is a trial / Developer Edition / demo org (so a my.salesforce.com URL is expected). */
    devIsTrial: boolean;
    qaIsTrial: boolean;
  };
  slackWorkspace?: string;
  slackChannels: Record<string, string>;
  transcriptsSource?: string;
}

/** "<site>", "<name>", "", "none", "VERIFY: ..." are placeholders, not values. */
export function isPlaceholder(v: unknown): boolean {
  if (typeof v !== "string") return true;
  const s = v.trim();
  return !s || /^none$/i.test(s) || /<[^>]*>/.test(s) || /^VERIFY\b/i.test(s);
}

const val = (v: unknown): string | undefined => (isPlaceholder(v) ? undefined : String(v).trim());
const ALIAS = /^[A-Za-z0-9_.-]{1,64}$/;

/** True when the comment on `key:` (or a trial/org_type key) declares a trial / dev edition / demo org. */
function declaredTrial(text: string, key: string, explicit: unknown): boolean {
  if (typeof explicit === "boolean") return explicit;
  if (typeof explicit === "string" && /^(trial|dev|developer|developer-edition|demo|sdo|scratch)$/i.test(explicit.trim())) return true;
  const line = text.split(/\r?\n/).find((l) => new RegExp(`^\\s*${key}\\s*:`).test(l));
  const comment = line && line.includes("#") ? line.slice(line.indexOf("#", line.indexOf(":"))) : "";
  return /\b(trial|developer edition|dev edition|demo org|sdo)\b/i.test(comment);
}

export function parseBuildConfig(text: string): CircuitConfig {
  let y: any = {};
  try { y = parseYaml(text) ?? {}; } catch { y = {}; }
  const sf = y.salesforce ?? {};
  const devAlias = typeof sf.dev_alias === "string" && ALIAS.test(sf.dev_alias) ? sf.dev_alias : "dev";
  const qaAlias = typeof sf.qa_alias === "string" && ALIAS.test(sf.qa_alias) ? sf.qa_alias : "qa";
  const channels: Record<string, string> = {};
  for (const [k, v] of Object.entries(y.slack?.channels ?? {})) if (!isPlaceholder(v)) channels[k] = String(v);
  return {
    githubOrg: val(y.github?.org),
    githubRepo: val(y.github?.repo),
    jiraSite: normalizeSite(val(y.jira?.site)),
    jiraProjectKey: val(y.jira?.project_key),
    confluenceSpace: val(y.confluence?.space_key),
    sf: {
      devUrl: val(sf.dev_sandbox_url),
      qaUrl: val(sf.qa_sandbox_url),
      prodUrl: val(sf.prod_url),
      devAlias, qaAlias,
      ...(typeof sf.prod_alias === "string" && ALIAS.test(sf.prod_alias) ? { prodAlias: sf.prod_alias } : {}),
      devIsTrial: declaredTrial(text, "dev_sandbox_url", sf.dev_org_type ?? sf.trial),
      qaIsTrial: declaredTrial(text, "qa_sandbox_url", sf.qa_org_type ?? sf.trial),
    },
    slackWorkspace: val(y.slack?.workspace),
    slackChannels: channels,
    transcriptsSource: val(y.transcripts?.source),
  };
}

export const EMPTY_CONFIG: CircuitConfig = parseBuildConfig("");

/** https://x.atlassian.net/ -> https://x.atlassian.net ; rejects non-https. */
export function normalizeSite(site: string | undefined): string | undefined {
  if (!site) return undefined;
  let s = site.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return undefined;
    return `https://${u.hostname.toLowerCase()}`;
  } catch { return undefined; }
}

/** Slack workspace "acme" or "acme.slack.com" -> https://acme.slack.com */
export function slackWorkspaceUrl(ws: string | undefined): string | undefined {
  if (!ws) return undefined;
  const name = ws.trim().replace(/^https?:\/\//, "").replace(/\.slack\.com.*$/, "").replace(/\/.*$/, "");
  return /^[a-z0-9-]{1,63}$/i.test(name) ? `https://${name.toLowerCase()}.slack.com` : undefined;
}

export interface Reminder { label: string; date: string /* ISO yyyy-mm-dd */ }

/** "## Reminders" bullets of build-state.md: "- <label> expires: <date>". Placeholder dates are skipped. */
export function parseReminders(md: string): Reminder[] {
  const out: Reminder[] = [];
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s*Reminders\s*$/i.test(l.trim()));
  if (start < 0) return out;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,6}\s/.test(l.trim())) break;
    const m = l.match(/^\s*[-*]\s*(.+?)\s+expires?\s*(?:on)?\s*:\s*(.+?)\s*$/i);
    if (!m) continue;
    const d = parseDate(m[2]);
    if (d) out.push({ label: m[1].trim(), date: d });
  }
  return out;
}

/** Accepts yyyy-mm-dd (optionally with time) or "12 Nov 2027"-style dates; returns yyyy-mm-dd or undefined. */
export function parseDate(s: string): string | undefined {
  const t = s.trim();
  if (isPlaceholder(t)) return undefined;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    return isNaN(d.getTime()) || d.getUTCMonth() !== +iso[2] - 1 ? undefined : d.toISOString().slice(0, 10);
  }
  if (!/[a-z]/i.test(t) || !/\d{4}/.test(t)) return undefined;
  const d = new Date(t + " UTC");
  return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}
