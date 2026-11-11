// Connection catalogue: which connections exist, who needs them, how they are grouped and where they are managed.
// No vscode import: unit-tested in test/unit/connections.catalog.test.ts.
import type { ConnectionId, ConnectionScope, ConnectionStatus, DeepLink, Persona } from "../core/contracts";

export type ConnectionGroup = "personal" | "mcp" | "review" | "project";

export interface ConnectionDef {
  id: ConnectionId;
  label: string;
  scope: ConnectionScope;
  group: ConnectionGroup;
  /** Personas that need it. Project-scope rows are visible to everyone regardless. */
  neededBy: Persona[];
  /** Static vendor page; some rows compute a better one from config at check time. */
  manageUrl?: string;
  linkKind: DeepLink["kind"];
}

const A: Persona = "architect", D: Persona = "developer", T: Persona = "tester";

export const CONNECTIONS: ConnectionDef[] = [
  // personal
  { id: "github", label: "GitHub", scope: "personal", group: "personal", neededBy: [A, D, T], manageUrl: "https://github.com/settings/applications", linkKind: "github" },
  { id: "claude", label: "Claude (subscription)", scope: "personal", group: "personal", neededBy: [A, D, T], manageUrl: "https://claude.ai/settings/account", linkKind: "url" },
  { id: "sf-dev", label: "Salesforce dev org", scope: "personal", group: "personal", neededBy: [A, D, T], linkKind: "salesforce" },
  { id: "sf-qa", label: "Salesforce QA org", scope: "personal", group: "personal", neededBy: [T], linkKind: "salesforce" },
  { id: "jira", label: "Jira", scope: "personal", group: "personal", neededBy: [A, D, T], manageUrl: "https://id.atlassian.com/manage-profile/security/api-tokens", linkKind: "jira" },
  { id: "confluence", label: "Confluence", scope: "personal", group: "personal", neededBy: [A], manageUrl: "https://id.atlassian.com/manage-profile/security/api-tokens", linkKind: "confluence" },
  { id: "slack", label: "Slack", scope: "personal", group: "personal", neededBy: [A, D, T], manageUrl: "https://slack.com/signin", linkKind: "slack" },
  { id: "fireflies", label: "Fireflies", scope: "personal", group: "personal", neededBy: [A], manageUrl: "https://app.fireflies.ai/integrations/custom/fireflies", linkKind: "fireflies" },
  { id: "lucid", label: "Lucid", scope: "personal", group: "personal", neededBy: [A], manageUrl: "https://lucid.app/documents", linkKind: "lucid" },
  { id: "testing-browsers", label: "Test browsers (Chrome for Testing)", scope: "personal", group: "personal", neededBy: [T], manageUrl: "https://playwright.dev/docs/browsers", linkKind: "url" },
  // Claude MCP servers (sign-in happens in Claude Code's /mcp)
  { id: "mcp-atlassian", label: "Atlassian MCP", scope: "personal", group: "mcp", neededBy: [A, D, T], manageUrl: "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/", linkKind: "url" },
  { id: "mcp-github", label: "GitHub MCP", scope: "personal", group: "mcp", neededBy: [A, D], manageUrl: "https://github.com/github/github-mcp-server", linkKind: "github" },
  { id: "mcp-salesforce", label: "Salesforce DX MCP", scope: "personal", group: "mcp", neededBy: [A, D, T], manageUrl: "https://github.com/forcedotcom/sf-skills", linkKind: "url" },
  { id: "mcp-slack", label: "Slack MCP", scope: "personal", group: "mcp", neededBy: [], manageUrl: "https://docs.slack.dev/ai/slack-mcp-server", linkKind: "slack" },
  { id: "mcp-lucid", label: "Lucid MCP", scope: "personal", group: "mcp", neededBy: [A], manageUrl: "https://help.lucid.co/hc/en-us/articles/42578801807508", linkKind: "lucid" },
  { id: "mcp-fireflies", label: "Fireflies MCP", scope: "personal", group: "mcp", neededBy: [A], manageUrl: "https://docs.fireflies.ai/getting-started/mcp-configuration", linkKind: "fireflies" },
  // review tools (project: visible to all, actionable by admins)
  { id: "coderabbit", label: "CodeRabbit", scope: "project", group: "review", neededBy: [A, D, T], manageUrl: "https://app.coderabbit.ai/", linkKind: "coderabbit" },
  { id: "code-analyzer", label: "Salesforce Code Analyzer", scope: "project", group: "review", neededBy: [A, D, T], manageUrl: "https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/code-analyzer.html", linkKind: "url" },
  { id: "ai-reviewer", label: "AI Reviewer (CI)", scope: "project", group: "review", neededBy: [A, D, T], linkKind: "github" },
];

export function def(id: ConnectionId): ConnectionDef {
  const d = CONNECTIONS.find((c) => c.id === id);
  if (!d) throw new Error(`Unknown connection: ${id}`);
  return d;
}

export function isConnectionId(x: unknown): x is ConnectionId {
  return typeof x === "string" && CONNECTIONS.some((c) => c.id === x);
}

export function baseStatus(id: ConnectionId, extraNeededBy: Persona[] = []): ConnectionStatus {
  const d = def(id);
  const neededBy = [...new Set([...d.neededBy, ...extraNeededBy])];
  return { id, label: d.label, scope: d.scope, state: "unknown", neededBy, manageUrl: d.manageUrl };
}

/**
 * Rows a person sees: Architect (by membership) sees everything; others see project rows plus the personal rows their
 * active persona needs. Without any persona, show all personal rows so the person can still connect.
 */
export function visibleRows<T extends Pick<ConnectionStatus, "scope" | "neededBy">>(rows: T[], personas: Persona[], active: Persona | null): T[] {
  if (personas.includes("architect")) return rows;
  if (!active) return personas.length ? rows.filter((r) => r.scope === "project" || r.neededBy.some((p) => personas.includes(p))) : rows;
  return rows.filter((r) => r.scope === "project" || r.neededBy.includes(active));
}

/** Project rows are actionable only by admins; personal rows by the person themself. */
export function actionable(row: Pick<ConnectionStatus, "scope">, isAdmin: boolean): boolean {
  return row.scope === "personal" || isAdmin;
}

export function groupOf(id: ConnectionId): ConnectionGroup { return def(id).group; }

export const GROUP_TITLES: Record<ConnectionGroup, string> = {
  personal: "Personal",
  mcp: "Claude MCP",
  review: "Review tools",
  project: "Project (admin)",
};
