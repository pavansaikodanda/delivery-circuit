// Action id grammar shared with the project module, plus the permission matrix and the confirmation texts.
// No vscode import: unit-tested in test/unit/actions.test.ts.
//
//   ai:<skill>        args {command?, arg?}           -> Claude session as action.persona with "<command> <arg>"
//   gate:label        args {pr, label}  (or id "gate:label:<label>")  label in plan-approved | testplan-approved | ai-ready
//   gate:review       args {pr, event: APPROVE | REQUEST_CHANGES, sha?}   sha = head commit the person reviewed
//   gate:merge        args {pr, sha?}
//   gate:ready        args {pr, sha?}   the human Developer takes their own story PR out of draft (AI never does)
//   gate:deploy       args {runId}
//   nav:feature       args {featureId}
//   nav:testing       args {suite?}
//   nav:connections   (no args)
//
// v3 named actions (docs/CIRCUIT-V3.md section 6). The id names the action; kind is "ai" for the Claude sessions and
// "gate" (or "nav") for the human design approval:
//   dev:start-story        args {storyKey | key | arg, phase?}    -> Developer session "/dev-start-story <KEY>" (phase build: "<KEY> build")
//   qa:add-tests           args {storyKey | key | arg, pr?}       -> Tester session "/qa-add-tests <KEY>"
//   dev:fix                args {pr | arg, checks?, attempt?, failure?} -> Developer session "/dev-fix <PR> <checks> failure: <context>"
//                          attempt is the AI attempt this run would be (1..MAX_AI_ATTEMPTS); beyond it a person takes over
//   review:open-room       args {pr | arg}                        -> Developer session "/review-room open <PR>"
//   review:record-verdict  args {pr | arg}                        -> Developer session "/review-room verdict <PR>"
//   decision:record        args {key | featureId | arg, text?}    -> session as the acting persona "/record-decision <KEY> <text>"
//   arch:approve-design    args {key | featureId | arg, url?}     -> opens the Confluence design page; a person approves (G1)
import { canAct, canView, GATES, type ActionRef, type GateId, type Identity, type Persona } from "../core/contracts";

export type ParsedAction =
  | { type: "ai"; skill: string; prompt: string; named?: NamedActionId }
  | { type: "label"; pr: number; label: GateLabel; gate: GateId }
  | { type: "review"; pr: number; event: ReviewEvent; gate: GateId; sha?: string }
  | { type: "merge"; pr: number; gate: GateId; sha?: string }
  | { type: "ready"; pr: number; sha?: string }
  | { type: "deploy"; runId: number; gate: GateId }
  | { type: "nav-feature"; featureId?: string }
  | { type: "nav-testing"; suite?: string }
  | { type: "nav-connections" }
  | { type: "approve-design"; key?: string; url?: string; gate: GateId };

/** v3 named actions: id -> owner persona (null = any persona acting as itself), skill, accepted kinds. */
export type NamedActionId = "dev:start-story" | "qa:add-tests" | "dev:fix" | "review:open-room" | "review:record-verdict" | "decision:record" | "arch:approve-design";
export interface NamedActionSpec { owner: Persona | null; label: string; kinds: ActionRef["kind"][]; skill?: string; gate?: GateId }
export const NAMED_ACTIONS: Record<NamedActionId, NamedActionSpec> = {
  "dev:start-story": { owner: "developer", label: "Start story", kinds: ["ai"], skill: "/dev-start-story" },
  "qa:add-tests": { owner: "tester", label: "Add tests", kinds: ["ai"], skill: "/qa-add-tests" },
  "dev:fix": { owner: "developer", label: "Fix with AI", kinds: ["ai"], skill: "/dev-fix" },
  "review:open-room": { owner: "developer", label: "Open review room", kinds: ["ai"], skill: "/review-room" },
  "review:record-verdict": { owner: "developer", label: "Record verdict", kinds: ["ai"], skill: "/review-room" },
  "decision:record": { owner: null, label: "Record decision", kinds: ["ai"], skill: "/record-decision" },
  "arch:approve-design": { owner: "architect", label: "Approve design", kinds: ["gate", "nav"], gate: "G1" },
};
export const isNamedAction = (id: string): id is NamedActionId => Object.prototype.hasOwnProperty.call(NAMED_ACTIONS, id);

/** AI fix attempts per PR before a person takes over (needs-human). */
export const MAX_AI_ATTEMPTS = 3;

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

/** Jira work item key, e.g. ACME-12. */
export const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;
const jiraKey = (v: unknown, what: string): string => {
  const s = str(v)?.toUpperCase();
  if (!s || !JIRA_KEY.test(s)) throw new ActionError(`${what} must be a Jira key like ACME-12`);
  return s;
};

/**
 * Free text that goes into a skill prompt (failure context, a decision): one line, at most `max` characters, without
 * the characters cmd.exe would interpret (the prompt may reach claude through a .cmd shim) or control characters.
 */
export function promptText(v: unknown, max = 400): string {
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f&|<>^%!"`]/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

function parseNamed(id: NamedActionId, a: ActionRef): ParsedAction {
  const spec = NAMED_ACTIONS[id];
  const args = a.args ?? {};
  if (!spec.kinds.includes(a.kind)) throw new ActionError(`Action ${id} must have kind ${spec.kinds.join(" or ")}, not ${a.kind}`);
  const ai = (prompt: string): ParsedAction => ({ type: "ai", skill: spec.skill!, prompt, named: id });
  switch (id) {
    case "dev:start-story": {
      const key = jiraKey(args.storyKey ?? args.key ?? args.arg, "Story");
      return ai(str(args.phase) === "build" ? `/dev-start-story ${key} build` : `/dev-start-story ${key}`);
    }
    case "qa:add-tests": return ai(`/qa-add-tests ${jiraKey(args.storyKey ?? args.key ?? args.arg, "Story")}`);
    case "dev:fix": {
      const pr = num(args.pr ?? args.arg, "PR number");
      // attempt = the AI attempt this run would be (1-based), as the queue sends it.
      const attempt = args.attempt === undefined || args.attempt === "" ? 1 : Number(args.attempt);
      if (!Number.isInteger(attempt) || attempt < 1) throw new ActionError("Attempt must be a whole number from 1");
      if (attempt > MAX_AI_ATTEMPTS) throw new ActionError(`PR #${pr} already had ${MAX_AI_ATTEMPTS} AI fix attempts. A person takes over now (needs-human).`);
      return ai(fixPrompt(pr, args.checks, args.failure));
    }
    case "review:open-room": return ai(`/review-room open ${num(args.pr ?? args.arg, "PR number")}`);
    case "review:record-verdict": return ai(`/review-room verdict ${num(args.pr ?? args.arg, "PR number")}`);
    case "decision:record": {
      const target = str(args.key ?? args.featureId ?? args.arg);
      if (!target || !(JIRA_KEY.test(target.toUpperCase()) || /^[\w.-]{1,80}$/.test(target))) throw new ActionError("Record decision needs the epic key (or feature) it belongs to");
      const key = JIRA_KEY.test(target.toUpperCase()) ? target.toUpperCase() : target;
      const text = promptText(args.text, 600);
      return ai(text ? `/record-decision ${key} ${text}` : `/record-decision ${key}`);
    }
    case "arch:approve-design": {
      // key: an epic key, a feature slug or a design page id (whatever the project module uses as feature id)
      const k = str(args.key ?? args.featureId ?? args.arg ?? args.pageId);
      if (k && !(JIRA_KEY.test(k.toUpperCase()) || /^[\w.-]{1,80}$/.test(k))) throw new ActionError("Approve design needs the epic key, feature or design page id");
      const url = str(args.url);
      if (url && !/^https:\/\/[^\s]+$/.test(url)) throw new ActionError("The design page link must be an https URL");
      if (!k && !url) throw new ActionError("Approve design needs the feature or its design page link");
      const key = k && JIRA_KEY.test(k.toUpperCase()) ? k.toUpperCase() : k;
      return { type: "approve-design", gate: "G1", ...(key ? { key } : {}), ...(url ? { url } : {}) };
    }
  }
}

/**
 * The /dev-fix prompt: PR number, the failing check names, then the failure context (one line, sanitised).
 * The skill reads the full check logs itself; the context only points it at what failed.
 */
export function fixPrompt(pr: number, checks: unknown, failure: unknown): string {
  const names = String(checks ?? "").split(",").map((s) => s.trim()).filter((s) => /^[\w./ -]{1,60}$/.test(s));
  const ctx = promptText(failure);
  let out = `/dev-fix ${pr}`;
  if (names.length) out += ` ${names.map((n) => n.replace(/\s+/g, "-")).join(",")}`;
  if (ctx) out += ` failure: ${ctx}`;
  return out;
}

/** One line of failure context from failed GitHub check runs (name: title or first summary line). */
export function failureContext(runs: { name?: string; conclusion?: string | null; output?: { title?: string | null; summary?: string | null } }[], max = 3): string {
  const bad = (runs ?? []).filter((r) => r && r.name && (r.conclusion === "failure" || r.conclusion === "timed_out" || r.conclusion === "action_required"));
  return bad.slice(0, max).map((r) => {
    const t = (r.output?.title || (r.output?.summary ?? "").split(/\r?\n/).find((l) => l.trim()) || r.conclusion || "").trim();
    return t ? `${r.name}: ${t}` : String(r.name);
  }).join("; ");
}

/** Parse an ActionRef into a typed action. Throws ActionError for anything outside the grammar. */
export function parseAction(a: ActionRef): ParsedAction {
  const id = String(a.id || "");
  if (isNamedAction(id)) return parseNamed(id, a);
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
      case "deploy":
        return { type: "deploy", runId: num(args.runId, "Run id"), gate: "G9" };
      case "ready": {
        const head = sha(args.sha);
        return { type: "ready", pr: num(args.pr, "PR number"), ...(head ? { sha: head } : {}) };
      }
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
  const named = isNamedAction(a.id) ? NAMED_ACTIONS[a.id] : undefined;
  if (named?.owner && a.persona !== named.owner) return `${named.label} is a ${named.owner} action`;
  if (p.type === "nav-feature" || p.type === "nav-testing") {
    return canView(id, a.persona) ? null : `Only visible to the ${a.persona} persona`;
  }
  if (!id.personas.includes(a.persona)) return `Only the ${a.persona} persona can do this`;
  if (!canAct(id, a.persona)) return `Switch to the ${a.persona} persona to do this (you are acting as ${id.active ?? "no persona"})`;
  if (p.type === "ready" && a.persona !== "developer") return "Marking a story PR ready for review is the Developer's step";
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
    case "ready": return `Mark PR #${p.pr}${at(c)} in ${repo} ready for review as ${c.login}. Code, QA and design reviews (G5-G7), the AI Reviewer and the merge path start from here.`;
    case "deploy": return `Approve the deployment of workflow run #${p.runId} in ${repo} to ${(c.environments ?? ["production"]).join(", ")} as ${c.login} (G9).`;
    case "ai": return `Start Claude with "${p.prompt}".`;
    case "approve-design": return `Open the design page${p.key ? ` of ${p.key}` : ""} in Confluence. An architect sets its status to Approved there; the circuit records that page version for the stories (G1). AI never approves.`;
    case "nav-feature": return `Open feature ${p.featureId ?? ""}`.trim();
    case "nav-testing": return "Open Testing";
    case "nav-connections": return "Open Connections";
  }
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

