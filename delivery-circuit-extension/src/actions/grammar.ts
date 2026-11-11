// Action id grammar shared with the project module, plus the permission matrix and the confirmation texts.
// No vscode import: unit-tested in test/unit/actions.test.ts.
//
//   ai:<skill>        args {command?, arg?}           -> Claude session as action.persona with "<command> <arg>"
//   gate:label        args {pr, label}  (or id "gate:label:<label>")  label in plan-approved | testplan-approved | ai-ready
//   gate:review       args {pr, event: APPROVE | REQUEST_CHANGES, sha?}   sha = head commit the person reviewed
//   gate:merge        args {pr, sha?}
//   gate:signoff      args {featureId}
//   gate:deploy       args {runId}
//   nav:feature       args {featureId}
//   nav:testing       args {suite?}
//   nav:connections   (no args)
import { canAct, canView, GATES, type ActionRef, type GateId, type Identity, type Persona } from "../core/contracts";

export type ParsedAction =
  | { type: "ai"; skill: string; prompt: string }
  | { type: "label"; pr: number; label: GateLabel; gate: GateId }
  | { type: "review"; pr: number; event: ReviewEvent; gate: GateId; sha?: string }
  | { type: "merge"; pr: number; gate: GateId; sha?: string }
  | { type: "signoff"; featureId: string; gate: GateId }
  | { type: "deploy"; runId: number; gate: GateId }
  | { type: "nav-feature"; featureId?: string }
  | { type: "nav-testing"; suite?: string }
  | { type: "nav-connections" };

export type GateLabel = "plan-approved" | "testplan-approved" | "ai-ready";
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES";

/** Labels a person may add through the extension, and the gate each one is evidence for. */
export const LABEL_GATES: Record<GateLabel, GateId> = {
  "plan-approved": "G3",
  "testplan-approved": "G4",
  "ai-ready": "G2",
};

/** PR review gate per persona: Developer G5, Tester G6, Architect G7. */
export const REVIEW_GATES: Record<Persona, GateId> = { developer: "G5", tester: "G6", architect: "G7" };

export class ActionError extends Error {}

const num = (v: unknown, what: string): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new ActionError(`${what} must be a positive number`);
  return n;
};
/** Optional head commit SHA (40 hex). */
const sha = (v: unknown): string | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(s)) throw new ActionError("Commit SHA must be 40 hex characters");
  return s;
};
const str = (v: unknown): string | undefined => (v === undefined || v === null || String(v).trim() === "" ? undefined : String(v).trim());

/** Parse an ActionRef into a typed action. Throws ActionError for anything outside the grammar. */
export function parseAction(a: ActionRef): ParsedAction {
  const id = String(a.id || "");
  const args = a.args ?? {};
  const colon = id.indexOf(":");
  const prefix = colon > 0 ? id.slice(0, colon) : id;
  const rest = colon > 0 ? id.slice(colon + 1) : "";
  if (prefix !== a.kind) throw new ActionError(`Action ${id} does not match its kind ${a.kind}`);

  if (prefix === "ai") {
    const skill = rest.trim();
    if (!skill) throw new ActionError("AI action needs a skill, e.g. ai:/dev-review-plan");
    const command = str(args.command) ?? (skill.startsWith("/") ? skill : `/${skill}`);
    const arg = str(args.arg);
    return { type: "ai", skill, prompt: arg ? `${command} ${arg}` : command };
  }

  if (prefix === "gate") {
    const [verb, extra] = splitOnce(rest);
    switch (verb) {
      case "label": {
        const label = str(args.label) ?? str(extra);
        if (!label || !(label in LABEL_GATES)) throw new ActionError(`Only the labels ${Object.keys(LABEL_GATES).join(", ")} can be added here`);
        return { type: "label", pr: num(args.pr, "PR number"), label: label as GateLabel, gate: LABEL_GATES[label as GateLabel] };
      }
      case "review": {
        const event = (str(args.event) ?? str(extra) ?? "").toUpperCase().replace(/-/g, "_");
        if (event !== "APPROVE" && event !== "REQUEST_CHANGES") throw new ActionError("Review event must be APPROVE or REQUEST_CHANGES");
        const head = sha(args.sha);
        return { type: "review", pr: num(args.pr, "PR number"), event, gate: REVIEW_GATES[a.persona], ...(head ? { sha: head } : {}) };
      }
      case "merge": {
        const head = sha(args.sha);
        return { type: "merge", pr: num(args.pr, "PR number"), gate: "G8", ...(head ? { sha: head } : {}) };
      }
      case "signoff": {
        const featureId = str(args.featureId) ?? str(extra);
        if (!featureId || !/^[\w.-]+$/.test(featureId)) throw new ActionError("Sign-off needs a feature id");
        return { type: "signoff", featureId, gate: "G1" };
      }
      case "deploy":
        return { type: "deploy", runId: num(args.runId, "Run id"), gate: "G9" };
      default:
        throw new ActionError(`Unknown gate action ${id}`);
    }
  }

  if (prefix === "nav") {
    if (rest === "feature") return { type: "nav-feature", featureId: str(args.featureId) };
    if (rest === "testing") return { type: "nav-testing", suite: str(args.suite) };
    if (rest === "connections") return { type: "nav-connections" };
    throw new ActionError(`Unknown navigation ${id}`);
  }
  throw new ActionError(`Unknown action ${id}`);
}

function splitOnce(s: string): [string, string | undefined] {
  const i = s.indexOf(":");
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}

/** Gate a parsed action belongs to (undefined for AI and navigation). */
export function gateOf(p: ParsedAction): GateId | undefined {
  return "gate" in p ? p.gate : undefined;
}

/** Why an identity may not run an action, or null when it may. */
export function denyReason(id: Identity | null, a: ActionRef): string | null {
  if (!id || !id.login) return "Sign in to GitHub first";
  let p: ParsedAction;
  try { p = parseAction(a); } catch (e) { return (e as Error).message; }
  if (p.type === "nav-connections") return null; // everyone signed in may open Connections
  if (p.type === "nav-feature" || p.type === "nav-testing") {
    return canView(id, a.persona) ? null : `Only visible to the ${a.persona} persona`;
  }
  if (!id.personas.includes(a.persona)) return `Only the ${a.persona} persona can do this`;
  if (!canAct(id, a.persona)) return `Switch to the ${a.persona} persona to do this (you are acting as ${id.active ?? "no persona"})`;
  const gate = gateOf(p);
  if (gate && GATES[gate].owner !== a.persona) return `${gate} (${GATES[gate].label}) belongs to the ${GATES[gate].owner}`;
  return null;
}

export function isAllowed(id: Identity | null, a: ActionRef): boolean {
  return denyReason(id, a) === null;
}

export interface ConfirmContext {
  login: string;
  owner: string;
  repo: string;
  /** merge: chosen method */
  mergeMethod?: string;
  /** signoff: plan.md path, branch and the git identity that will author the commit */
  planPath?: string;
  branch?: string;
  gitName?: string;
  gitEmail?: string;
  /** review / merge: the head commit the action is pinned to */
  headSha?: string;
  /** deploy: environment names that will be approved */
  environments?: string[];
}

const at = (c: ConfirmContext) => (c.headSha ? ` at commit ${c.headSha.slice(0, 7)}` : "");

/**
 * The head commit a review or merge is pinned to. `seen` is the head the person was shown (the action's sha arg);
 * `current` is the PR's head now. Refuses when the PR moved on, so nobody approves or merges commits they never saw.
 */
export function pinnedHead(pr: number, seen: string | undefined, current: string | undefined): string {
  const now = (current ?? "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(now)) throw new ActionError(`Could not read the head commit of PR #${pr}`);
  if (seen && seen !== now) {
    throw new ActionError(`PR #${pr} has new commits since this view was loaded (${seen.slice(0, 7)} -> ${now.slice(0, 7)}). Refresh, look at the new commits and try again.`);
  }
  return now;
}

/** The exact effect, shown in the modal confirmation and written to the log. */
export function confirmText(p: ParsedAction, c: ConfirmContext): string {
  const repo = `${c.owner}/${c.repo}`;
  switch (p.type) {
    case "label": return `Add label ${p.label} to PR #${p.pr} in ${repo} as ${c.login} (${p.gate}: ${GATES[p.gate].label}).`;
    case "review": return p.event === "APPROVE"
      ? `Approve PR #${p.pr}${at(c)} in ${repo} as ${c.login} (${p.gate}: ${GATES[p.gate].label}).`
      : `Request changes on PR #${p.pr}${at(c)} in ${repo} as ${c.login}.`;
    case "merge": return `Merge PR #${p.pr}${at(c)} in ${repo} with the ${c.mergeMethod ?? "repository default"} method as ${c.login} (G8).`;
    case "signoff": return `Tick the Architect Sign-Off in ${c.planPath ?? "plan.md"}, commit "${signoffMessage(p.featureId)}" as ${c.gitName ?? "?"} <${c.gitEmail ?? "?"}> on branch ${c.branch ?? "?"} and push it (G1).`;
    case "deploy": return `Approve the deployment of workflow run #${p.runId} in ${repo} to ${(c.environments ?? ["production"]).join(", ")} as ${c.login} (G9).`;
    case "ai": return `Start Claude with "${p.prompt}".`;
    case "nav-feature": return `Open feature ${p.featureId ?? ""}`.trim();
    case "nav-testing": return "Open Testing";
    case "nav-connections": return "Open Connections";
  }
}

export function signoffMessage(feature: string): string {
  return `Architect sign-off for ${feature}`;
}

/** Merge methods the repository allows, in preference order (squash, merge, rebase). */
export function mergeMethods(repo: { allow_squash_merge?: boolean; allow_merge_commit?: boolean; allow_rebase_merge?: boolean }): ("squash" | "merge" | "rebase")[] {
  const out: ("squash" | "merge" | "rebase")[] = [];
  if (repo.allow_squash_merge !== false) out.push("squash");
  if (repo.allow_merge_commit !== false) out.push("merge");
  if (repo.allow_rebase_merge !== false) out.push("rebase");
  return out;
}

/** Pending deployments a person may approve: production environments only (production, production-dryrun). */
export function approvableEnvironments(pending: { environment?: { id?: number; name?: string }; current_user_can_approve?: boolean }[]):
  { approvable: { id: number; name: string }[]; blocked: string[] } {
  const approvable: { id: number; name: string }[] = [];
  const blocked: string[] = [];
  for (const p of pending ?? []) {
    const name = p.environment?.name ?? "";
    const id = p.environment?.id;
    if (!/^production(\b|-)/.test(name) || typeof id !== "number") continue;
    if (p.current_user_can_approve) approvable.push({ id, name }); else blocked.push(name);
  }
  return { approvable, blocked };
}

/** Branches on which the sign-off commit must never be made. */
export function isProtectedBranch(branch: string, defaultBranch = "main"): boolean {
  const b = branch.trim();
  return !b || b === "HEAD" || b === defaultBranch || b === "main" || b === "master";
}
