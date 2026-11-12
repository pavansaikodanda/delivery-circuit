// Connection catalogue: which connections exist, who needs them, how they are grouped and where they are managed.
// No vscode import: unit-tested in test/unit/connections.catalog.test.ts.
import type { ConnectionId, ConnectionScope, ConnectionStatus, DeepLink, Persona } from "../core/contracts";

export type ConnectionGroup = "personal" | "mcp" | "review" | "project";

/** Every row id this module knows (the contract's ConnectionId, which now lists the v3 rows). */
export type RowId = ConnectionId;

export interface ConnectionDef {
  id: RowId;
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

/** v3 catalogue (docs/CIRCUIT-V3.md section 6): every connection is a login; nothing here asks for a token. */
export const CONNECTIONS: ConnectionDef[] = [
  // personal logins
  { id: "github", label: "GitHub", scope: "personal", group: "personal", neededBy: [A, D, T], manageUrl: "https://github.com/settings/applications", linkKind: "github" },
  { id: "claude", label: "Claude (subscription)", scope: "personal", group: "personal", neededBy: [A, D, T], manageUrl: "https://claude.ai/settings/account", linkKind: "url" },
  { id: "sf-dev", label: "Salesforce dev org", scope: "personal", group: "personal", neededBy: [A, D, T], linkKind: "salesforce" },
  { id: "sf-qa", label: "Salesforce QA org", scope: "personal", group: "personal", neededBy: [T], linkKind: "salesforce" },
  { id: "acli", label: "Atlassian CLI (acli)", scope: "personal", group: "personal", neededBy: [A, D, T], manageUrl: "https://developer.atlassian.com/cloud/acli/guides/how-to-get-started/", linkKind: "jira" },
  { id: "slack", label: "Slack", scope: "personal", group: "personal", neededBy: [A, D, T], manageUrl: "https://slack.com/signin", linkKind: "slack" },
  { id: "lucid", label: "Lucid", scope: "personal", group: "personal", neededBy: [A], manageUrl: "https://lucid.app/documents", linkKind: "lucid" },
  { id: "testing-browsers", label: "Test browsers (Chrome for Testing)", scope: "personal", group: "personal", neededBy: [T], manageUrl: "https://playwright.dev/docs/browsers", linkKind: "url" },
  // Claude MCP servers (OAuth sign-in happens in Claude Code's /mcp or as a claude.ai connector)
  { id: "mcp-atlassian", label: "Atlassian MCP", scope: "personal", group: "mcp", neededBy: [A, D, T], manageUrl: "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/", linkKind: "url" },
  { id: "mcp-github", label: "GitHub MCP", scope: "personal", group: "mcp", neededBy: [A, D], manageUrl: "https://github.com/github/github-mcp-server", linkKind: "github" },
  { id: "mcp-salesforce", label: "Salesforce DX MCP", scope: "personal", group: "mcp", neededBy: [A, D, T], manageUrl: "https://github.com/forcedotcom/sf-skills", linkKind: "url" },
  { id: "mcp-slack", label: "Slack MCP", scope: "personal", group: "mcp", neededBy: [A, D], manageUrl: "https://docs.slack.dev/ai/slack-mcp-server", linkKind: "slack" },
  { id: "mcp-lucid", label: "Lucid MCP", scope: "personal", group: "mcp", neededBy: [A], manageUrl: "https://help.lucid.co/hc/en-us/articles/42578801807508", linkKind: "lucid" },
  { id: "mcp-fireflies", label: "Fireflies MCP", scope: "personal", group: "mcp", neededBy: [A], manageUrl: "https://docs.fireflies.ai/getting-started/mcp-configuration", linkKind: "fireflies" },
  // review tools (project: visible to all, actionable by admins)
  { id: "code-analyzer", label: "Salesforce Code Analyzer", scope: "project", group: "review", neededBy: [A, D, T], manageUrl: "https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/code-analyzer.html", linkKind: "url" },
  { id: "ai-reviewer", label: "AI Reviewer (CI)", scope: "project", group: "review", neededBy: [A, D, T], linkKind: "github" },
  // project: the self-hosted runner, the GitHub apps on the repo
  { id: "runner", label: "Self-hosted runner", scope: "project", group: "project", neededBy: [A, D, T], manageUrl: "https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/adding-self-hosted-runners", linkKind: "github" },
  { id: "github-jira", label: "GitHub for Jira app", scope: "project", group: "project", neededBy: [A, D, T], manageUrl: "https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/", linkKind: "jira" },
  { id: "coderabbit", label: "CodeRabbit", scope: "project", group: "project", neededBy: [A, D, T], manageUrl: "https://app.coderabbit.ai/", linkKind: "coderabbit" },
];

export function def(id: RowId): ConnectionDef {
  const d = CONNECTIONS.find((c) => c.id === id);
  if (!d) throw new Error(`Unknown connection: ${id}`);
  return d;
}

export function isConnectionId(x: unknown): x is RowId {
  return typeof x === "string" && CONNECTIONS.some((c) => c.id === x);
}

/** A row status (same shape as the contract's ConnectionStatus). */
export type RowStatus = Omit<ConnectionStatus, "id"> & { id: RowId };
export const asContract = (s: RowStatus): ConnectionStatus => s as ConnectionStatus;

export function baseStatus(id: RowId, extraNeededBy: Persona[] = []): RowStatus {
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

export function groupOf(id: RowId): ConnectionGroup { return def(id).group; }

export const GROUP_TITLES: Record<ConnectionGroup, string> = {
  personal: "Personal",
  mcp: "Claude MCP",
  review: "Review tools",
  project: "Project",
};
