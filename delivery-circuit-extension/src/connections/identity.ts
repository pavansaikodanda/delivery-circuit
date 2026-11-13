// IdentityService: GitHub login, roles (team membership), admin rights; the active role per workspace.
import * as vscode from "vscode";
import { DEFAULT_TEAMS, isRole, roleChoices, type Identity, type IdentityService, type Role } from "../core/contracts";
import { gitRemote, type ModuleBase } from "../core/util";
import type { GitHubClient } from "./github";
import { pickActive, resolveIdentity } from "./identityCore";

export const GITHUB_SCOPES = ["repo", "read:org", "workflow"];
const ACTIVE_KEY = "deliveryCircuit.activeRole";
const CACHE_KEY = "deliveryCircuit.identity";
const REFRESH_MS = 10 * 60_000;

export interface IdentityInternals extends IdentityService {
  /** Last notice (sign in, no team, team unreadable). */
  notice(): string | undefined;
}

export function createIdentity(base: ModuleBase, gh: GitHubClient, fallbackRepo: () => { owner?: string; repo?: string }): IdentityInternals {
  const ev = new vscode.EventEmitter<Identity | null>();
  const cachedId = base.ctx.workspaceState.get<Identity>(CACHE_KEY);
  let current: Identity | null = cachedId && Array.isArray(cachedId.roles) ? cachedId : null;
  let notice: string | undefined;
  let inflight: Promise<Identity | null> | undefined;

  const set = (id: Identity | null) => {
    const changed = JSON.stringify(id) !== JSON.stringify(current);
    current = id;
    void base.ctx.workspaceState.update(CACHE_KEY, id ?? undefined);
    if (changed) ev.fire(id);
  };

  async function doRefresh(): Promise<Identity | null> {
    const session = await vscode.authentication.getSession("github", GITHUB_SCOPES, { createIfNone: false });
    if (!session) { notice = "Sign in to GitHub."; set(null); return null; }
    const remote = await gitRemote(base.root);
    const fb = fallbackRepo();
    const owner = remote?.owner ?? fb.owner; const repo = remote?.repo ?? fb.repo;
    const previous = base.ctx.workspaceState.get<Role>(ACTIVE_KEY) ?? null;
    if (!owner || !repo) {
      notice = "This folder has no GitHub remote \"origin\".";
      set({ login: session.account.label, roles: [], active: pickActive([], previous), isAdmin: false, owner: "", repo: "", orgOwned: false, notice });
      return current;
    }
    const teams = { ...DEFAULT_TEAMS, ...vscode.workspace.getConfiguration("deliveryCircuit").get<Partial<Record<Role, string>>>("githubTeams", {}) };
    const user = await gh.request<{ login: string }>("GET", "/user");
    const r = await resolveIdentity({ login: user.login, owner, repo, teams, previousActive: previous, get: (p) => gh.request("GET", p) });
    notice = r.notice;
    if (r.notice) base.log(`identity: ${r.notice}`);
    const resolved: Identity = r.notice ? { ...r.identity, notice: r.notice } : r.identity;
    set(resolved);
    return resolved;
  }

  const refresh = (): Promise<Identity | null> => {
    inflight ??= doRefresh().catch((e) => {
      notice = `Could not load your GitHub identity: ${e?.message ?? e}`;
      base.log(`identity: ${notice}`);
      return current; // keep the cached identity when offline
    }).finally(() => { inflight = undefined; });
    return inflight;
  };

  const timer = setInterval(() => { void refresh(); }, REFRESH_MS);
  base.ctx.subscriptions.push({ dispose: () => clearInterval(timer) }, ev);
  base.ctx.subscriptions.push(vscode.authentication.onDidChangeSessions((e) => { if (e.provider.id === "github") void refresh(); }));
  base.ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("deliveryCircuit.githubTeams")) void refresh();
  }));

  const service: IdentityInternals = {
    get: () => current,
    refresh,
    async setActive(r: Role) {
      if (!isRole(r)) throw new Error(`Unknown role: ${r}`);
      if (!current) throw new Error("Sign in to GitHub first.");
      if (!roleChoices(current).includes(r)) throw new Error(`You are not in the ${r} team.`);
      await base.ctx.workspaceState.update(ACTIVE_KEY, r);
      set({ ...current, active: r });
    },
    onDidChange: ev.event,
    notice: () => notice,
  };
  return service;
}
