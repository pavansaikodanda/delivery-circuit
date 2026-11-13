// Parsers for CLI output and config files used by connection checks. No vscode import.
// Secrets in CLI output (sf accessToken, etc.) are dropped here and never leave these functions.

export interface ClaudeAuth {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  loginExpiresAt?: string;
}

/** `claude auth status` (JSON by default; the text form is accepted too). */
export function parseClaudeAuth(stdout: string): ClaudeAuth | undefined {
  const t = stdout.trim();
  if (!t) return undefined;
  try {
    const j = JSON.parse(t.slice(t.indexOf("{")));
    return {
      loggedIn: !!j.loggedIn, authMethod: str(j.authMethod), apiProvider: str(j.apiProvider), email: str(j.email),
      orgName: str(j.orgName), subscriptionType: str(j.subscriptionType), loginExpiresAt: str(j.loginExpiresAt),
    };
  } catch { /* text form */ }
  const field = (k: string) => t.match(new RegExp(`^${k}:\\s*(.+)$`, "mi"))?.[1].trim();
  const method = field("Login method");
  if (!method) return /not logged in|not signed in|logged out/i.test(t) ? { loggedIn: false } : undefined;
  const ends = field("Sign-in ends");
  const iso = ends?.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/)?.[0];
  return { loggedIn: true, authMethod: /claude/i.test(method) ? "claude.ai" : method, email: field("Email"), orgName: field("Organization"),
    subscriptionType: method.match(/Claude (\w+) account/i)?.[1]?.toLowerCase(), loginExpiresAt: iso };
}

/** Whether the login is a claude.ai subscription (the circuit's only allowed auth). */
export function isSubscriptionAuth(a: ClaudeAuth): boolean {
  return a.loggedIn && (a.authMethod === "claude.ai" || a.authMethod === "oauth_token") && (a.apiProvider ?? "firstParty") === "firstParty";
}

export interface SfOrg { username?: string; alias?: string; instanceUrl?: string; orgId?: string; connectedStatus?: string; expirationDate?: string }
export interface SfOrgResult { ok: boolean; org?: SfOrg; error?: string }

/** `sf org display --target-org <a> --json`. Only non-secret fields are kept (accessToken etc. are dropped). */
export function parseSfOrgDisplay(stdout: string): SfOrgResult {
  let j: any;
  try { j = JSON.parse(stdout.slice(Math.max(0, stdout.indexOf("{")))); } catch { return { ok: false, error: "sf returned no JSON (is the Salesforce CLI installed?)" }; }
  if (j.status !== 0 || !j.result) {
    const msg = str(j.message) ?? str(j.name) ?? "sf org display failed";
    return { ok: false, error: msg.replace(/[A-Za-z0-9!.]{40,}/g, "…") };
  }
  const r = j.result;
  const org: SfOrg = { username: str(r.username), alias: str(r.alias), instanceUrl: str(r.instanceUrl), orgId: str(r.id),
    connectedStatus: str(r.connectedStatus), expirationDate: str(r.expirationDate) };
  const cs = org.connectedStatus ?? "";
  const ok = !cs || /^connected$/i.test(cs) || /^unknown$/i.test(cs);
  return { ok, org, error: ok ? undefined : cs };
}

export type McpListState = "connected" | "needs-auth" | "failed" | "not-configured" | "pending" | "unknown";
export interface McpListEntry { name: string; target: string; transport?: string; state: McpListState; reason?: string }

/** `claude mcp list` lines: `<name>: <target> [(HTTP)] - <glyph> <status>[ — reason]` (glyphs differ by console code page). */
export function parseMcpList(stdout: string): McpListEntry[] {
  const out: McpListEntry[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^(.+?):\s(.*?)\s-\s(?:\S\s)?(Connected|Needs authentication|Failed to connect|Not configured|Pending approval)(.*)$/);
    if (!m) continue;
    let target = m[2].trim(); let transport: string | undefined;
    const t = target.match(/^(.*?)\s*\((HTTP|SSE|stdio)\)$/i); if (t) { target = t[1].trim(); transport = t[2].toUpperCase(); }
    const state: McpListState = ({ "Connected": "connected", "Needs authentication": "needs-auth", "Failed to connect": "failed",
      "Not configured": "not-configured", "Pending approval": "pending" } as const)[m[3] as "Connected"] ?? "unknown";
    const reason = m[4].replace(/^\s*[—-]+\s*/, "").trim() || undefined;
    out.push({ name: m[1].trim(), target, transport, state, reason });
  }
  return out;
}

export interface McpServerEntry { name: string; type: "http" | "sse" | "stdio"; url?: string; command?: string; args?: string[]; placeholder: boolean }

/** `.mcp.json` / `--mcp-config` file -> servers (later files override earlier ones by name). */
export function parseMcpConfigs(texts: string[]): McpServerEntry[] {
  const map = new Map<string, McpServerEntry>();
  for (const text of texts) {
    let j: any; try { j = JSON.parse(text); } catch { continue; }
    for (const [name, s] of Object.entries<any>(j?.mcpServers ?? {})) {
      if (!s || typeof s !== "object") continue;
      if (typeof s.url === "string" || s.type === "http" || s.type === "sse" || s.type === "streamable-http") {
        const url = typeof s.url === "string" ? s.url : undefined;
        map.set(name, { name, type: s.type === "sse" ? "sse" : "http", url, placeholder: !url || !/^https:\/\/[^\s]+$/.test(url) });
      } else if (typeof s.command === "string") {
        map.set(name, { name, type: "stdio", command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], placeholder: false });
      }
    }
  }
  return [...map.values()];
}

export type McpRowId = "atlassian" | "lucid" | "fireflies";

/** Documented remote MCP servers of the rows that sign in through Claude (/mcp or a claude.ai connector). */
export const MCP_KNOWN: Record<McpRowId, { names: string[]; hosts: string[]; url: string }> = {
  atlassian: { names: ["atlassian", "jira", "confluence"], hosts: ["mcp.atlassian.com"], url: "https://mcp.atlassian.com/v2/mcp" },
  lucid: { names: ["lucid", "lucidchart"], hosts: ["mcp.lucid.app"], url: "https://mcp.lucid.app/mcp" },
  fireflies: { names: ["fireflies"], hosts: ["api.fireflies.ai"], url: "https://api.fireflies.ai/mcp" },
};

export function findServerFor(id: McpRowId, servers: McpServerEntry[]): McpServerEntry | undefined {
  const k = MCP_KNOWN[id];
  return servers.find((s) => s.url && k.hosts.includes(hostOf(s.url) ?? ""))
    ?? servers.find((s) => k.names.includes(s.name.toLowerCase()));
}

/** Best sign-in state Claude Code reports for servers on the same host (any scope, including claude.ai connectors,
 *  which `claude mcp list` names like "claude.ai Fireflies"). With `byName`, entries whose name contains one of the
 *  server's known names count too (a connector whose target is not a URL). */
export function mcpListStateFor(id: McpRowId, entry: McpServerEntry | undefined, list: McpListEntry[], byName = false): McpListEntry | undefined {
  const k = MCP_KNOWN[id];
  const hosts = new Set(k.hosts); const h = entry?.url ? hostOf(entry.url) : undefined; if (h) hosts.add(h);
  const nameHit = (n: string) => byName && k.names.some((x) => new RegExp(`(^|[^a-z])${x}([^a-z]|$)`, "i").test(n));
  const matches = list.filter((e) => { const eh = hostOf(e.target); return (eh ? hosts.has(eh) : false) || nameHit(e.name); });
  const rank: McpListState[] = ["connected", "needs-auth", "pending", "failed", "not-configured", "unknown"];
  return matches.sort((a, b) => rank.indexOf(a.state) - rank.indexOf(b.state))[0];
}

export function hostOf(url: string): string | undefined {
  try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; }
}

function str(v: unknown): string | undefined { return typeof v === "string" && v ? v : undefined; }

// ---------- Atlassian CLI (acli) ----------
export type AcliAuthState = "logged-in" | "logged-out" | "missing" | "unknown";
export interface AcliAuth { state: AcliAuthState; site?: string; email?: string; note?: string }

const ACLI_MISSING = /ENOENT|is not recognized as|command not found|cannot find the (file|path)|no such file/i;
const ACLI_LOGGED_OUT = /not (currently )?(logged|signed) ?in|not authenticated|unauthori[sz]ed|no (active |authenticated )?(account|site|session|auth)|please (log|sign) ?in|(token|session|credentials?) (has |have )?expired|\b401\b/i;
const ACLI_LOGGED_IN = /authenticated|logged in|signed in|\bactive\b|✓|current (account|site)/i;

/**
 * `acli jira auth status`. Atlassian documents neither its output nor its exit code when logged out, so this reads
 * signals: the error text of a missing program, logged-out phrases, an *.atlassian.net site and an email. A clean exit
 * that names a site (or says authenticated) counts as logged in; a failing exit counts as logged out.
 */
export function parseAcliAuthStatus(r: { code: number; stdout: string; stderr: string }): AcliAuth {
  const all = `${r.stdout}\n${r.stderr}`.trim();
  if (r.code === 127 || r.code === 9009 || ACLI_MISSING.test(r.stderr) || (r.code !== 0 && !all)) return { state: "missing" };
  const site = all.match(/\b([a-z0-9][a-z0-9-]*\.atlassian\.net)\b/i)?.[1]?.toLowerCase();
  const email = all.match(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/)?.[0];
  // "Authenticated: false" / "Logged in: no" are logged out even though they contain a positive word
  if (ACLI_LOGGED_OUT.test(all) || /(auth\w*|logged in|signed in)\s*[:=]\s*(false|no)\b/i.test(all)) {
    return { state: "logged-out", site, note: firstLine(all) };
  }
  if (r.code === 0 && (site || ACLI_LOGGED_IN.test(all))) return { state: "logged-in", site, email };
  return { state: r.code === 0 ? "unknown" : "logged-out", site, email, note: firstLine(all) || `exit code ${r.code}` };
}

// ---------- GitHub apps ----------
export interface AppInstall { id: number; slug: string; selection: "all" | "selected"; url?: string; suspended: boolean }

/** GitHub App slug of CodeRabbit. */
export const CODERABBIT_SLUGS = ["coderabbitai"];

/** GET /orgs/{org}/installations -> the first installation of one of the slugs. */
export function findInstallation(json: unknown, slugs: string[]): AppInstall | undefined {
  const list = (json as any)?.installations;
  if (!Array.isArray(list)) return undefined;
  const i = list.find((x: any) => x && slugs.includes(String(x.app_slug ?? "").toLowerCase()));
  if (!i) return undefined;
  return { id: Number(i.id) || 0, slug: String(i.app_slug), selection: i.repository_selection === "all" ? "all" : "selected",
    url: str(i.html_url), suspended: !!i.suspended_at };
}

function firstLine(s: string): string { return (s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "").slice(0, 200); }
