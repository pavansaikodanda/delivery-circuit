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

export interface SfPlugin { name: string; version?: string }
export function parseSfPlugins(stdout: string): SfPlugin[] {
  try {
    const j = JSON.parse(stdout.slice(Math.max(0, stdout.indexOf("["))));
    const arr = Array.isArray(j) ? j : Array.isArray(j?.result) ? j.result : [];
    return arr.filter((p: any) => p && typeof p.name === "string").map((p: any) => ({ name: p.name, version: str(p.version) }));
  } catch { return []; }
}
export function findCodeAnalyzer(plugins: SfPlugin[]): SfPlugin | undefined {
  return plugins.find((p) => p.name === "@salesforce/plugin-code-analyzer") ?? plugins.find((p) => p.name === "@salesforce/sfdx-scanner");
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

export type McpRowId = "mcp-atlassian" | "mcp-github" | "mcp-salesforce" | "mcp-slack" | "mcp-lucid" | "mcp-fireflies";

/** Documented server URLs (see docs facts); used to spot the right entry and to fill placeholders. */
export const MCP_KNOWN: Record<McpRowId, { names: string[]; hosts: string[]; url?: string; stdioPackage?: string }> = {
  "mcp-atlassian": { names: ["atlassian", "jira", "confluence"], hosts: ["mcp.atlassian.com"], url: "https://mcp.atlassian.com/v2/mcp" },
  "mcp-github": { names: ["github"], hosts: ["api.githubcopilot.com"], url: "https://api.githubcopilot.com/mcp/" },
  "mcp-salesforce": { names: ["salesforce", "sf"], hosts: [], stdioPackage: "@salesforce/mcp" },
  "mcp-slack": { names: ["slack"], hosts: ["mcp.slack.com"], url: "https://mcp.slack.com/mcp" },
  "mcp-lucid": { names: ["lucid", "lucidchart"], hosts: ["mcp.lucid.app"], url: "https://mcp.lucid.app/mcp" },
  "mcp-fireflies": { names: ["fireflies"], hosts: ["api.fireflies.ai"], url: "https://api.fireflies.ai/mcp" },
};

export function findServerFor(id: McpRowId, servers: McpServerEntry[]): McpServerEntry | undefined {
  const k = MCP_KNOWN[id];
  return servers.find((s) => s.url && k.hosts.includes(hostOf(s.url) ?? ""))
    ?? servers.find((s) => s.type === "stdio" && k.stdioPackage && (s.args ?? []).some((a) => a === k.stdioPackage || a.startsWith(k.stdioPackage + "@")))
    ?? servers.find((s) => k.names.includes(s.name.toLowerCase()));
}

/** Best sign-in state Claude Code reports for servers on the same host (any scope, including claude.ai connectors). */
export function mcpListStateFor(id: McpRowId, entry: McpServerEntry | undefined, list: McpListEntry[]): McpListEntry | undefined {
  const k = MCP_KNOWN[id];
  const hosts = new Set(k.hosts); const h = entry?.url ? hostOf(entry.url) : undefined; if (h) hosts.add(h);
  const matches = list.filter((e) => { const eh = hostOf(e.target); return eh ? hosts.has(eh) : false; });
  const rank: McpListState[] = ["connected", "needs-auth", "pending", "failed", "not-configured", "unknown"];
  return matches.sort((a, b) => rank.indexOf(a.state) - rank.indexOf(b.state))[0];
}

export function hostOf(url: string): string | undefined {
  try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; }
}

/** Playwright's browsers.json -> revisions the bundled Playwright needs for Chrome for Testing + headless shell. */
export function requiredBrowsers(browsersJson: string): { name: string; revision: string; title?: string }[] {
  try {
    const j = JSON.parse(browsersJson);
    return (j.browsers ?? []).filter((b: any) => b.name === "chromium" || b.name === "chromium-headless-shell")
      .map((b: any) => ({ name: String(b.name), revision: String(b.revision), title: str(b.title) }));
  } catch { return []; }
}

/** Folder name Playwright installs a browser revision into, e.g. chromium-1246, chromium_headless_shell-1246. */
export function browserDir(name: string, revision: string): string { return `${name.replace(/-/g, "_")}-${revision}`; }

function str(v: unknown): string | undefined { return typeof v === "string" && v ? v : undefined; }
