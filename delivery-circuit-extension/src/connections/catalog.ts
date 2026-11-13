// The Connections tab rows (docs/CIRCUIT-V4.md section 7): about seven logins, no tokens, no secrets, no webhooks.
// No vscode import.
import type { ConnectionId, ConnectionStatus, Role } from "../core/contracts";

export interface ConnectionDef {
  id: ConnectionId;
  label: string;
  /** roles that see the row */
  neededBy: Role[];
  optional?: boolean;
}

const A: Role = "architect", D: Role = "developer", Q: Role = "tester", L: Role = "lead";

export const CONNECTIONS: ConnectionDef[] = [
  { id: "github", label: "GitHub", neededBy: [A, D, Q, L] },
  { id: "claude", label: "Claude", neededBy: [A, D, Q] },
  { id: "sf-dev", label: "Salesforce DEV org", neededBy: [A, D] },
  { id: "sf-qa", label: "Salesforce QA org", neededBy: [Q] },
  { id: "atlassian", label: "Atlassian", neededBy: [A, D, Q, L] },
  { id: "lucid", label: "Lucid", neededBy: [A] },
  { id: "coderabbit", label: "CodeRabbit", neededBy: [D, L] },
  { id: "fireflies", label: "Fireflies", neededBy: [A], optional: true },
];

export function def(id: ConnectionId): ConnectionDef {
  const d = CONNECTIONS.find((c) => c.id === id);
  if (!d) throw new Error(`Unknown connection: ${id}`);
  return d;
}

export const isConnectionId = (x: unknown): x is ConnectionId => typeof x === "string" && CONNECTIONS.some((c) => c.id === x);

export function baseStatus(id: ConnectionId): ConnectionStatus {
  const d = def(id);
  const s: ConnectionStatus = { id, label: d.label, state: "unknown", neededBy: [...d.neededBy] };
  if (d.optional) s.optional = true;
  return s;
}

/** Rows the role sees. No role yet: every row, so the person can still connect. */
export function rowsFor<T extends Pick<ConnectionStatus, "neededBy">>(rows: T[], role: Role | null): T[] {
  return role ? rows.filter((r) => r.neededBy.includes(role)) : rows;
}

/** The one button of a row. */
export function buttonFor(s: Pick<ConnectionStatus, "state">): "Connect" | "Fix" | "Check" {
  if (s.state === "connected" || s.state === "checking") return "Check";
  if (s.state === "error") return "Fix";
  return "Connect";
}
