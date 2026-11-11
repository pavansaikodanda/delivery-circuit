// Expiry tracking for tokens and certificates. No vscode import.
import type { ConnectionState } from "../core/contracts";

export const EXPIRY_WINDOW_DAYS = 30;
const DAY = 86_400_000;

export type ExpiryState = "ok" | "expiring" | "expired" | "unknown";

export function expiryState(expiresAt: string | undefined, now: Date = new Date(), windowDays = EXPIRY_WINDOW_DAYS): ExpiryState {
  if (!expiresAt) return "unknown";
  const t = new Date(expiresAt).getTime();
  if (isNaN(t)) return "unknown";
  if (t <= now.getTime()) return "expired";
  return t - now.getTime() <= windowDays * DAY ? "expiring" : "ok";
}

export function daysLeft(expiresAt: string, now: Date = new Date()): number {
  return Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / DAY);
}

/** A `claude setup-token` token lasts one year from when it was created. */
export function claudeTokenExpiry(setAtIso: string): string {
  const d = new Date(setAtIso);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString();
}

/** Combine a connected/disconnected state with a known expiry: connected + within window -> expiring; past -> error. */
export function applyExpiry(state: ConnectionState, expiresAt: string | undefined, now: Date = new Date()): ConnectionState {
  if (state !== "connected" && state !== "expiring") return state;
  const e = expiryState(expiresAt, now);
  if (e === "expired") return "error";
  if (e === "expiring") return "expiring";
  return state;
}

/** Earliest of several optional ISO dates. */
export function earliest(...dates: (string | undefined)[]): string | undefined {
  const ok = dates.filter((d): d is string => !!d && !isNaN(new Date(d).getTime()));
  return ok.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
}

export function expiryText(expiresAt: string | undefined, now: Date = new Date()): string | undefined {
  if (!expiresAt) return undefined;
  const e = expiryState(expiresAt, now);
  const day = new Date(expiresAt).toISOString().slice(0, 10);
  if (e === "expired") return `expired ${day}`;
  const n = daysLeft(expiresAt, now);
  return e === "expiring" ? `expires in ${n} day${n === 1 ? "" : "s"} (${day})` : `expires ${day}`;
}
