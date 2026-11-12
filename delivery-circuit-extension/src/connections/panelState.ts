// Builds the Connections page state from statuses + identity. No vscode import.
// v3: no secrets section. The Project section holds the project connections (self-hosted runner, GitHub for Jira,
// CodeRabbit) plus read-only repo settings the circuit relies on (rulesets, the production environment, workflows that
// must not read stored credentials).
import type { ConnectionState, DeepLink, Identity } from "../core/contracts";
import { actionable, CONNECTIONS, GROUP_TITLES, groupOf, visibleRows, type ConnectionGroup, type RowId, type RowStatus } from "./catalog";
import { expiryState, expiryText } from "./expiry";
import type { Reminder } from "./config";
import type { EnvironmentInfo, RulesetInfo } from "./parse";

export interface PanelRow extends RowStatus {
  group: ConnectionGroup;
  actionable: boolean;
  /** Why the buttons are disabled (shown as a tooltip). */
  reason?: string;
  canDisconnect: boolean;
  /** null = the row has no primary action (status only). */
  connectLabel: string | null;
  expiryText?: string;
  links: DeepLink[];
}

/** A read-only repo setting the circuit relies on. */
export interface SettingRow {
  key: "rulesets" | "environment" | "workflows";
  title: string;
  state: ConnectionState;
  detail: string;
  links: DeepLink[];
}

export interface ProjectInfo {
  settings: SettingRow[];
  reminders: (Reminder & { state: string; text?: string })[];
  error?: string;
  repoUrl?: string;
}

export interface PanelState {
  identity: Identity | null;
  notice?: string;
  signedIn: boolean;
  isArchitect: boolean;
  /** personal, mcp and review groups; project rows are in `projectRows` (rendered in the Project section). */
  groups: { id: ConnectionGroup; title: string; rows: PanelRow[] }[];
  projectRows: PanelRow[];
  project?: ProjectInfo;
  hiddenCount: number;
  checkedAt: string;
  /** True while "Check all" runs (the section action shows a spinner). */
  refreshing: boolean;
}

const DISCONNECTABLE = new Set<RowId>(["sf-dev", "sf-qa", "acli", "slack", "lucid", "claude"]);
const CONNECT_LABEL: Partial<Record<RowId, string | null>> = {
  "testing-browsers": "Install", "code-analyzer": "Install", coderabbit: "Install app", "ai-reviewer": null,
  runner: "Add runner", "github-jira": "Install app",
  "mcp-atlassian": "Sign in", "mcp-github": "Sign in", "mcp-salesforce": "Open", "mcp-slack": "Sign in", "mcp-lucid": "Sign in", "mcp-fireflies": "Sign in",
};

/** One action per row: installs offer Update once present; sign-ins and apps need no action once connected (Check and
 *  Manage stay in the row strip), except CodeRabbit, whose repository access is managed on GitHub. */
function connectLabel(id: RowId, state: ConnectionState, fixed: string | null | undefined): string | null {
  const ok = state === "connected";
  if (ok && (id === "testing-browsers" || id === "code-analyzer")) return "Update";
  if (ok && id === "coderabbit") return "Repo access";
  if (fixed !== undefined) return ok ? null : fixed;
  return ok || state === "expiring" ? "Reconnect" : "Connect";
}

export function buildPanelState(args: {
  identity: Identity | null; notice?: string; statuses: RowStatus[]; links: Partial<Record<RowId, DeepLink[]>>;
  project?: ProjectInfo; now?: Date;
  /** Rows whose check the person started and which has not finished yet: shown as "Checking" with the controls busy. */
  checking?: Iterable<RowId>;
  refreshing?: boolean;
}): PanelState {
  const { identity, statuses, links } = args;
  const now = args.now ?? new Date();
  const isAdmin = !!identity?.isAdmin;
  const personas = identity?.personas ?? [];
  const known = statuses.filter((s) => CONNECTIONS.some((c) => c.id === s.id));
  const visible = visibleRows(known, personas, identity?.active ?? null);
  const order = new Map(CONNECTIONS.map((c, i) => [c.id, i]));
  const checking = new Set(args.checking ?? []);
  const rows: PanelRow[] = [...visible].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).map((s0) => {
    const s: RowStatus = checking.has(s0.id) && s0.state !== "checking" ? { ...s0, state: "checking" } : s0;
    const act = actionable(s, isAdmin);
    const fixed = Object.prototype.hasOwnProperty.call(CONNECT_LABEL, s.id) ? CONNECT_LABEL[s.id] : undefined;
    return {
      ...s, group: groupOf(s.id), actionable: act,
      reason: act ? undefined : "Project connections are managed by a repo or org admin.",
      canDisconnect: act && DISCONNECTABLE.has(s.id) && (s0.state === "connected" || s0.state === "expiring" || s0.state === "error"),
      connectLabel: connectLabel(s.id, s0.state, fixed),
      expiryText: expiryText(s.expiresAt, now),
      links: links[s.id] ?? (s.manageUrl ? [{ kind: "url", label: "Manage", target: s.manageUrl }] : []),
    };
  });
  const groups = (["personal", "mcp", "review"] as ConnectionGroup[]).map((g) => ({ id: g, title: GROUP_TITLES[g], rows: rows.filter((r) => r.group === g) }))
    .filter((g) => g.rows.length);
  return {
    identity, notice: args.notice, signedIn: !!identity, isArchitect: personas.includes("architect"),
    groups, projectRows: rows.filter((r) => r.group === "project"), project: args.project,
    hiddenCount: known.length - visible.length, checkedAt: now.toISOString(), refreshing: !!args.refreshing,
  };
}

/** The repo settings v3 relies on, from what the GitHub API returned (undefined = could not read it). */
export function buildProjectInfo(args: {
  repoUrl?: string; defaultBranch?: string;
  rulesets?: RulesetInfo[]; environments?: EnvironmentInfo[];
  /** Workflow files that still read a stored credential (bannedSecretRefs). */
  bannedRefs: { file: string; names: string[] }[];
  workflowCount: number;
  reminders: Reminder[]; now?: Date; error?: string;
}): ProjectInfo {
  const now = args.now ?? new Date();
  const repo = args.repoUrl;
  const settings: SettingRow[] = [];

  const active = (args.rulesets ?? []).filter((r) => r.enforcement === "active" && r.target === "branch");
  settings.push({
    key: "rulesets", title: "Branch rulesets",
    state: args.rulesets === undefined ? "unknown" : active.length ? "connected" : "disconnected",
    detail: args.rulesets === undefined ? "Could not read the repo's rulesets."
      : active.length ? `${active.length} active: ${active.map((r) => r.name).join(", ")}. Merging is for the architects team only (G8).`
        : `No active branch ruleset on ${args.defaultBranch ?? "the default branch"}. G8 needs one that lets only architects merge.`,
    links: repo ? [{ kind: "github", label: "Rulesets", target: `${repo}/settings/rules` }] : [],
  });

  const prod = (args.environments ?? []).find((e) => /^(production|prod)$/i.test(e.name));
  settings.push({
    key: "environment", title: "Production environment",
    state: args.environments === undefined ? "unknown" : !prod ? "disconnected" : prod.reviewers.length ? "connected" : "error",
    detail: args.environments === undefined ? "Could not read the repo's environments."
      : !prod ? "No production environment. deploy-prod (G9) waits on its required reviewers."
        : prod.reviewers.length ? `${prod.name} · reviewers: ${prod.reviewers.join(", ")}${prod.waitMinutes ? ` · wait ${prod.waitMinutes} min` : ""}`
          : `${prod.name} has no required reviewers, so G9 does not stop a release.`,
    links: repo ? [{ kind: "github", label: "Environments", target: `${repo}/settings/environments` }] : [],
  });

  const bad = args.bannedRefs;
  settings.push({
    key: "workflows", title: "Workflows without stored credentials",
    state: bad.length ? "error" : args.workflowCount ? "connected" : "unknown",
    detail: bad.length ? bad.map((b) => `${b.file} reads ${b.names.join(", ")}`).join("; ") + ". v3 runs these on the self-hosted runner with its own logins."
      : args.workflowCount ? `${args.workflowCount} workflow file${args.workflowCount === 1 ? "" : "s"}; none reads a stored token or key.`
        : "No .github/workflows in this repo yet.",
    links: bad.map((b) => ({ kind: "file" as const, label: b.file.split("/").pop() ?? b.file, target: b.file })),
  });

  return {
    settings, repoUrl: repo, error: args.error,
    reminders: args.reminders.map((r) => ({ ...r, state: expiryState(r.date, now), text: expiryText(r.date, now) })),
  };
}
