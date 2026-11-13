// Safety checks for org logins and terminal commands. No vscode import.

export type SfUrlKind = "sandbox" | "test-login" | "scratch" | "dev-edition" | "production-like" | "invalid";

/** Classifies a Salesforce login / instance URL by its host. */
export function classifySfUrl(url: string | undefined): SfUrlKind {
  if (!url) return "invalid";
  let u: URL;
  try { u = new URL(url); } catch { return "invalid"; }
  if (u.protocol !== "https:" || u.username || u.password) return "invalid";
  const host = u.hostname.toLowerCase();
  if (!/(^|\.)(salesforce\.com|force\.com|salesforce-setup\.com)$/.test(host)) return "invalid";
  if (host === "test.salesforce.com") return "test-login";
  if (host === "login.salesforce.com") return "production-like";
  if (/\.sandbox\.(my\.salesforce\.com|lightning\.force\.com|my\.salesforce-setup\.com)$/.test(host)) return "sandbox";
  // legacy sandbox My Domain: <domain>--<sandbox>.my.salesforce.com, and cs*.salesforce.com instances
  if (/--[a-z0-9]+\.(my\.salesforce\.com|lightning\.force\.com)$/.test(host) || /^cs\d+\.salesforce\.com$/.test(host)) return "sandbox";
  if (/\.scratch\.(my\.salesforce\.com|lightning\.force\.com)$/.test(host)) return "scratch";
  if (/\.(develop|trailblaze)\.(my\.salesforce\.com|lightning\.force\.com)$/.test(host)) return "dev-edition";
  return "production-like";
}

export interface LoginUrlDecision {
  allowed: boolean;
  /** Shown to the person: why it was refused, or a warning they must accept. */
  warning?: string;
  url: string;
}

/**
 * Decide whether "sf org login web --instance-url <url>" may run. Any Salesforce https URL is allowed: the org type
 * (sandbox, scratch, Developer Edition, SDO or other production-edition demo org) is not checked, because demo and
 * SDO orgs are production orgs. Only non-https or non-Salesforce URLs are refused.
 * (`declaredTrial` is accepted for compatibility and ignored.)
 */
export function checkLoginUrl(url: string | undefined, _declaredTrial?: boolean): LoginUrlDecision {
  const target = url && url.trim() ? url.trim().replace(/\/+$/, "") : "https://login.salesforce.com";
  return classifySfUrl(target) === "invalid"
    ? { allowed: false, url: target, warning: `Not a Salesforce https URL: ${target}` }
    : { allowed: true, url: target };
}

// ---------- the org the project names as production (AI never works there) ----------
/** The fixed production names the guard (circuit-guard.mjs) also protects. */
export const FIXED_PROD_ALIASES = ["prod", "production", "live", "prd"];

/** Aliases the project names as production: the fixed names, CIRCUIT_PROD_ALIASES and the configured prod aliases. */
export function namedProdAliases(configured: Array<string | undefined> = [], env: string | undefined = process.env.CIRCUIT_PROD_ALIASES): Set<string> {
  const set = new Set(FIXED_PROD_ALIASES);
  for (const a of [...(env ?? "").split(","), ...configured]) if (a && a.trim()) set.add(a.trim().toLowerCase());
  return set;
}

/** Same rule as the guard's isProdLike: a named production alias, or an alias that is prod/production/live between
 *  separators (client-prod, live.org). The org type is never checked: SDO and demo orgs are valid DEV/QA orgs. */
export function isNamedProduction(alias: string | undefined, prod: Set<string> = namedProdAliases()): boolean {
  return !!alias && (prod.has(alias.toLowerCase()) || /(^|[-_.])(prod|production|live)([-_.]|$)/i.test(alias));
}

const SAFE_ARG =/^[A-Za-z0-9_@%+=:,./\\-]+$/;

/**
 * Builds a terminal command line from fixed program + arguments. Every argument must match a strict charset (no
 * spaces, quotes, ;, &, |, $, `), so nothing a person typed can change the command. Throws otherwise.
 */
export function terminalCommand(program: string, args: string[]): string {
  for (const a of [program, ...args]) {
    if (!SAFE_ARG.test(a)) throw new Error(`Refusing to put an unsafe argument in a terminal command: ${JSON.stringify(a)}`);
  }
  return [program, ...args].join(" ");
}
