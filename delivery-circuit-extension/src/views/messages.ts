// Validation of webview messages. A webview is untrusted input: everything is checked before anything runs, and a
// row's action is looked up by id on the extension side (the webview never sends a command or a URL to run).
import { isRole, type Role } from "../core/contracts";
import { isConnectionId } from "../connections/catalog";
import type { ConnectionId } from "../core/contracts";

const ROW_ID = /^[a-z]+(?::[A-Za-z0-9_./-]{1,120})?$/;
const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export type HomeMessage =
  | { type: "ready" | "refresh" | "connectGithub" }
  | { type: "switchRole"; role: Role }
  | { type: "run"; id: string }
  | { type: "connect" | "check"; id: ConnectionId }
  | { type: "openStory"; key: string };

export type StoryMessage = { type: "ready" | "refresh" } | { type: "openLink"; target: string };

export function parseHomeMessage(m: unknown): HomeMessage | undefined {
  const x = m as any;
  switch (x?.type) {
    case "ready": case "refresh": case "connectGithub": return { type: x.type };
    case "switchRole": return isRole(x.role) ? { type: "switchRole", role: x.role } : undefined;
    case "run": return typeof x.id === "string" && ROW_ID.test(x.id) ? { type: "run", id: x.id } : undefined;
    case "connect": case "check": return isConnectionId(x.id) ? { type: x.type, id: x.id } : undefined;
    case "openStory": return typeof x.key === "string" && KEY.test(x.key) ? { type: "openStory", key: x.key } : undefined;
    default: return undefined;
  }
}

export function parseStoryMessage(m: unknown): StoryMessage | undefined {
  const x = m as any;
  if (x?.type === "ready" || x?.type === "refresh") return { type: x.type };
  if (x?.type === "openLink" && typeof x.target === "string" && /^https:\/\/\S{1,2000}$/.test(x.target)) return { type: "openLink", target: x.target };
  return undefined;
}

export const isStoryKey = (k: unknown): k is string => typeof k === "string" && KEY.test(k);
