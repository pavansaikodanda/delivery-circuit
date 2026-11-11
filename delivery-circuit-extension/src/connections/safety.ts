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
 * Decide whether "sf org login web --instance-url <url>" may run. Production-looking URLs (login.salesforce.com or a
 * non-sandbox my.salesforce.com) are refused unless build.config.yml declares the org a trial / dev org; then the
 * login is allowed with a warning.
 */
export function checkLoginUrl(url: string | undefined, declaredTrial: boolean): LoginUrlDecision {
  const target = url && url.trim() ? url.trim().replace(/\/+$/, "") : "https://test.salesforce.com";
  const kind = classifySfUrl(target);
  switch (kind) {
    case "sandbox": case "test-login": case "scratch": return { allowed: true, url: target };
    case "dev-edition": return { allowed: true, url: target, warning: "This is a Developer Edition / trial org, not a sandbox." };
    case "invalid": return { allowed: false, url: target, warning: `Not a Salesforce https URL: ${target}` };
    case "production-like":
      return declaredTrial
        ? { allowed: true, url: target, warning: `${target} looks like a production org. build.config.yml says it is a trial/dev org, so the login is allowed. Never deploy to production from here.` }
        : { allowed: false, url: target, warning: `${target} looks like a production org. The circuit only logs in to sandboxes. If this really is a trial or Developer Edition org, say so in build.config.yml (comment "trial org" on the URL line or salesforce.dev_org_type: trial).` };
  }
}

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

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

/** A path relative to the workspace root that is safe for terminalCommand (forward slashes). */
export function safeRelPath(p: string): string | undefined {
  const s = p.replace(/\\/g, "/");
  return SAFE_ARG.test(s) && !s.split("/").includes("..") && !/^[a-z]:|^\//i.test(s) ? s : undefined;
}
