// Builds the Connections page state from statuses + identity. No vscode import.
import type { ConnectionId, ConnectionStatus, DeepLink, Identity } from "../core/contracts";
import { actionable, CONNECTIONS, GROUP_TITLES, groupOf, visibleRows, type ConnectionGroup } from "./catalog";
import { expiryState, expiryText } from "./expiry";
import type { Reminder } from "./config";
import { secretKind } from "./secrets";

export interface PanelRow extends ConnectionStatus {
  group: ConnectionGroup;
  actionable: boolean;
  /** Why the buttons are disabled (shown as a tooltip). */
  reason?: string;
  canDisconnect: boolean;
  connectLabel: string;
  expiryText?: string;
  links: DeepLink[];
}

export interface SecretRow {
  name: string;
  present: boolean;
  /** True when the secret list could not be read (not an admin): presence is unknown. */
  unknown?: boolean;
  env?: string;
  kind: string;
  expiryText?: string;
  expiring?: boolean;
}

export interface ProjectInfo {
  secrets: SecretRow[];
  webhooks: SecretRow[];
  environments: string[];
  reminders: (Reminder & { state: string; text?: string })[];
  error?: string;
  repoUrl?: string;
}

export interface PanelState {
  identity: Identity | null;
  notice?: string;
  signedIn: boolean;
  isArchitect: boolean;
  groups: { id: ConnectionGroup; title: string; rows: PanelRow[] }[];
  project?: ProjectInfo;
  hiddenCount: number;
  checkedAt: string;
}

const DISCONNECTABLE = new Set<ConnectionId>(["sf-dev", "sf-qa", "jira", "confluence", "fireflies", "slack", "lucid", "claude"]);
const CONNECT_LABEL: Partial<Record<ConnectionId, string>> = {
  "testing-browsers": "Install", "code-analyzer": "Install", coderabbit: "Install app", "ai-reviewer": "Set token",
  "mcp-atlassian": "Sign in", "mcp-github": "Sign in", "mcp-salesforce": "Open", "mcp-slack": "Sign in", "mcp-lucid": "Sign in", "mcp-fireflies": "Sign in",
};

export function buildPanelState(args: {
  identity: Identity | null; notice?: string; statuses: ConnectionStatus[]; links: Partial<Record<ConnectionId, DeepLink[]>>;
  project?: ProjectInfo; now?: Date;
}): PanelState {
  const { identity, statuses, links } = args;
  const now = args.now ?? new Date();
  const isAdmin = !!identity?.isAdmin;
  const personas = identity?.personas ?? [];
  const visible = visibleRows(statuses, personas, identity?.active ?? null);
  const order = new Map(CONNECTIONS.map((c, i) => [c.id, i]));
  const rows: PanelRow[] = visible.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).map((s) => {
    const act = actionable(s, isAdmin);
    return {
      ...s, group: groupOf(s.id), actionable: act,
      reason: act ? undefined : "Project connections are managed by a repo or org admin.",
      canDisconnect: act && DISCONNECTABLE.has(s.id) && (s.state === "connected" || s.state === "expiring" || s.state === "error"),
      connectLabel: CONNECT_LABEL[s.id] ?? (s.state === "connected" || s.state === "expiring" ? "Reconnect" : "Connect"),
      expiryText: expiryText(s.expiresAt, now),
      links: links[s.id] ?? (s.manageUrl ? [{ kind: "url", label: "Manage", target: s.manageUrl }] : []),
    };
  });
  const groups = (["personal", "mcp", "review"] as ConnectionGroup[]).map((g) => ({ id: g, title: GROUP_TITLES[g], rows: rows.filter((r) => r.group === g) }))
    .filter((g) => g.rows.length);
  return {
    identity, notice: args.notice, signedIn: !!identity, isArchitect: personas.includes("architect"),
    groups, project: args.project, hiddenCount: statuses.length - visible.length, checkedAt: now.toISOString(),
  };
}

/** Project secrets: which the workflows need, which exist (repo or environment), with reminder expiry attached. */
export function buildProjectInfo(args: {
  needed: string[]; envOf: Record<string, string>; environments: string[];
  repoSecrets: string[]; envSecrets: Record<string, string[]>; reminders: Reminder[]; claudeTokenExpiresAt?: string; now?: Date; repoUrl?: string; error?: string;
}): ProjectInfo {
  const now = args.now ?? new Date();
  const reminderFor = (name: string): string | undefined => {
    if (name === "CLAUDE_CODE_OAUTH_TOKEN" && args.claudeTokenExpiresAt) return args.claudeTokenExpiresAt;
    const k = secretKind(name);
    const r = args.reminders.find((x) =>
      (k === "claude" && /claude/i.test(x.label)) || (k === "jira" && /TOKEN/.test(name) && /jira/i.test(x.label)) ||
      (k === "salesforce" && /JWT_KEY/.test(name) && /jwt|cert/i.test(x.label)));
    return r?.date;
  };
  const rows: SecretRow[] = args.needed.map((name) => {
    const env = args.envOf[name];
    const present = args.repoSecrets.includes(name) || (env ? (args.envSecrets[env] ?? []).includes(name) : Object.values(args.envSecrets).some((l) => l.includes(name)));
    const exp = reminderFor(name);
    const st = expiryState(exp, now);
    return { name, present, unknown: !!args.error || undefined, env, kind: secretKind(name), expiryText: present ? expiryText(exp, now) : undefined, expiring: present && (st === "expiring" || st === "expired") };
  });
  return {
    secrets: rows.filter((r) => r.kind !== "slack-webhook"), webhooks: rows.filter((r) => r.kind === "slack-webhook"),
    environments: args.environments, repoUrl: args.repoUrl, error: args.error,
    reminders: args.reminders.map((r) => ({ ...r, state: expiryState(r.date, now), text: expiryText(r.date, now) })),
  };
}
