// Validation of messages coming from the webviews. A webview is untrusted input: only well-formed links and
// actions pass, and file links must stay inside the workspace. No "vscode" import (unit-tested).
import { PERSONAS, type ActionRef, type DeepLink, type Persona } from "../core/contracts";

const LINK_KINDS: DeepLink["kind"][] = ["github", "jira", "salesforce", "slack", "confluence", "lucid", "fireflies", "coderabbit", "file", "report", "url"];
const ACTION_KINDS: ActionRef["kind"][] = ["ai", "gate", "nav"];

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** A workspace-relative path with no traversal, drive letter or leading slash. */
export function safeRelativePath(p: string): boolean {
  if (!p || p.length > 500) return false;
  if (/^[a-zA-Z]:/.test(p) || p.startsWith("/") || p.startsWith("\\")) return false;
  if (/[\0<>|"?*]/.test(p)) return false;
  return !p.split(/[\\/]+/).some((seg) => seg === "..");
}

export function sanitizeLink(x: unknown): DeepLink | undefined {
  if (!isObj(x)) return undefined;
  const { kind, label, target } = x;
  if (typeof kind !== "string" || !LINK_KINDS.includes(kind as DeepLink["kind"])) return undefined;
  if (typeof target !== "string") return undefined;
  if (kind === "file" || kind === "report") {
    if (!safeRelativePath(target)) return undefined;
  } else if (!/^https:\/\/[^\s]+$/.test(target)) {
    return undefined;
  }
  return { kind: kind as DeepLink["kind"], label: typeof label === "string" ? label.slice(0, 200) : "", target };
}

export function sanitizeAction(x: unknown): ActionRef | undefined {
  if (!isObj(x)) return undefined;
  const { id, label, persona, kind, args } = x;
  if (typeof id !== "string" || !id || id.length > 200) return undefined;
  if (typeof persona !== "string" || !PERSONAS.includes(persona as Persona)) return undefined;
  if (typeof kind !== "string" || !ACTION_KINDS.includes(kind as ActionRef["kind"])) return undefined;
  const out: ActionRef = { id, label: typeof label === "string" ? label.slice(0, 200) : id, persona: persona as Persona, kind: kind as ActionRef["kind"] };
  if (args !== undefined) {
    if (!isObj(args)) return undefined;
    const clean: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(args)) {
      if (!/^[\w-]{1,40}$/.test(k)) return undefined;
      if (typeof v === "number" && Number.isFinite(v)) clean[k] = v;
      else if (typeof v === "string" && v.length <= 500) clean[k] = v;
      else return undefined;
    }
    out.args = clean;
  }
  return out;
}

export function sanitizePersona(x: unknown): Persona | undefined {
  return typeof x === "string" && PERSONAS.includes(x as Persona) ? (x as Persona) : undefined;
}

/** Feature ids are "001" or slugs "001-case-escalation". */
export function sanitizeFeatureId(x: unknown): string | undefined {
  return typeof x === "string" && /^\d{3}(-[\w-]{1,80})?$/.test(x) ? x : undefined;
}

export function sanitizeSourceId(x: unknown): string | undefined {
  return typeof x === "string" && /^(fireflies|upload):[\w-]{1,100}$/.test(x) ? x : undefined;
}
