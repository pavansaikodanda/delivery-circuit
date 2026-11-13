// Reads build.config.yml (the repo's circuit settings, no secrets) for the connection rows. No vscode import.
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
    devAlias: string;
    qaAlias: string;
    /** salesforce.prod_alias: the org the project names as production (AI never works there) */
    prodAlias?: string;
  };
}

/** "<site>", "<name>", "", "none", "VERIFY: ..." are placeholders, not values. */
export function isPlaceholder(v: unknown): boolean {
  if (typeof v !== "string") return true;
  const s = v.trim();
  return !s || /^none$/i.test(s) || /<[^>]*>/.test(s) || /^VERIFY\b/i.test(s);
}

const val = (v: unknown): string | undefined => (isPlaceholder(v) ? undefined : String(v).trim());
const ALIAS = /^[A-Za-z0-9_.-]{1,64}$/;

export function parseBuildConfig(text: string): CircuitConfig {
  let y: any = {};
  try { y = parseYaml(text) ?? {}; } catch { y = {}; }
  const sf = y.salesforce ?? {};
  const devAlias = typeof sf.dev_alias === "string" && ALIAS.test(sf.dev_alias) ? sf.dev_alias : "dev";
  const qaAlias = typeof sf.qa_alias === "string" && ALIAS.test(sf.qa_alias) ? sf.qa_alias : "qa";
  return {
    githubOrg: val(y.github?.org),
    githubRepo: val(y.github?.repo),
    jiraSite: normalizeSite(val(y.jira?.site)),
    jiraProjectKey: val(y.jira?.project_key),
    confluenceSpace: val(y.confluence?.space_key),
    sf: {
      devUrl: val(sf.dev_sandbox_url),
      qaUrl: val(sf.qa_sandbox_url),
      devAlias, qaAlias,
      ...(typeof sf.prod_alias === "string" && ALIAS.test(sf.prod_alias) ? { prodAlias: sf.prod_alias } : {}),
    },
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
