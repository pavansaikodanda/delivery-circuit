// Builds .claude/personas/<agent>.local.mcp.json for a Claude session: the tracked vendor servers of
// .claude/personas/<agent>.mcp.json plus, for the Architect, the "circuit" HTTP server (transcript_get) with this VS Code
// session's bearer token. The file can hold a token, so it is gitignored and written owner-only. No vscode import.
import { promises as fs } from "fs";
import * as path from "path";
import type { McpEndpoint } from "../core/contracts";

export const LOCAL_CONFIG_GLOB = ".claude/personas/*.local.mcp.json";

/** Remote MCP URLs verified against vendor docs; used when a template still holds a "VERIFY:" placeholder. */
export const KNOWN_REMOTE_URLS: Record<string, string> = {
  atlassian: "https://mcp.atlassian.com/v2/mcp",
  github: "https://api.githubcopilot.com/mcp/",
  lucid: "https://mcp.lucid.app/mcp",
  fireflies: "https://api.fireflies.ai/mcp",
  slack: "https://mcp.slack.com/mcp",
};

export const personaFile = (root: string, agent: string) => path.join(root, ".claude", "personas", `${agent}.mcp.json`);
export const localPersonaFile = (root: string, agent: string) => path.join(root, ".claude", "personas", `${agent}.local.mcp.json`);

const isHttps = (u: unknown) => { try { return typeof u === "string" && new URL(u).protocol === "https:"; } catch { return false; } };

export interface BuildResult { config: { mcpServers: Record<string, any> }; fixed: string[]; dropped: string[] }

/** Merge vendor servers with the circuit entry (when an endpoint is given). Remote entries with placeholder URLs are fixed from KNOWN_REMOTE_URLS or dropped. */
export function buildPersonaConfig(vendor: unknown, ep?: McpEndpoint): BuildResult {
  const src = (vendor as any)?.mcpServers && typeof (vendor as any).mcpServers === "object" ? (vendor as any).mcpServers : {};
  const out: Record<string, any> = {};
  const fixed: string[] = [], dropped: string[] = [];
  for (const [name, raw] of Object.entries<any>(src)) {
    if (name === "circuit" || !raw || typeof raw !== "object") continue;
    const entry = { ...raw };
    const remote = entry.url !== undefined || entry.type === "http" || entry.type === "sse" || entry.type === "streamable-http";
    if (remote) {
      if (entry.url === "https://mcp.atlassian.com/v1/mcp" || entry.url === "https://mcp.atlassian.com/v1/sse") {
        entry.url = KNOWN_REMOTE_URLS.atlassian; entry.type = "http"; fixed.push(name);
      } else if (!isHttps(entry.url)) {
        const known = KNOWN_REMOTE_URLS[name];
        if (!known) { dropped.push(name); continue; }
        entry.url = known; fixed.push(name);
      }
      entry.type ??= "http";
    } else if (typeof entry.command !== "string") {
      dropped.push(name);
      continue;
    }
    out[name] = entry;
  }
  if (ep) out.circuit = { type: "http", url: ep.url, headers: { Authorization: `Bearer ${ep.token}` } };
  return { config: { mcpServers: out }, fixed, dropped };
}

/** Make sure the repo .gitignore ignores the local persona configs. Returns true when it changed the file. */
export async function ensureGitignored(root: string, pattern = LOCAL_CONFIG_GLOB): Promise<boolean> {
  const file = path.join(root, ".gitignore");
  let text = "";
  try { text = await fs.readFile(file, "utf8"); } catch { /* new file */ }
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(pattern) || lines.includes("/" + pattern)) return false;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const prefix = text.length && !text.endsWith("\n") ? eol : "";
  await fs.writeFile(file, `${text}${prefix}# Delivery Circuit: per-session MCP config with a local bearer token${eol}${pattern}${eol}`, "utf8");
  return true;
}

export async function writePersonaConfigFile(root: string, agent: string, ep?: McpEndpoint): Promise<{ file: string; fixed: string[]; dropped: string[] }> {
  let vendor: unknown = {};
  try { vendor = JSON.parse(await fs.readFile(personaFile(root, agent), "utf8")); } catch { vendor = {}; }
  const { config, fixed, dropped } = buildPersonaConfig(vendor, ep);
  await ensureGitignored(root);
  const file = localPersonaFile(root, agent);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
  return { file, fixed, dropped };
}
