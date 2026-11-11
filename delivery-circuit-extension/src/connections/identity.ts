// IdentityService: GitHub login, personas (team membership), admin rights; active persona per workspace.
import * as vscode from "vscode";
import { PERSONAS, type Identity, type IdentityService, type Persona } from "../core/contracts";
import { gitRemote, type ModuleBase } from "../core/util";
import type { GitHubClient } from "./github";
import { pickActive, resolveIdentity } from "./identityCore";

export const GITHUB_SCOPES = ["repo", "read:org", "workflow"];
const ACTIVE_KEY = "deliveryCircuit.activePersona";
const CACHE_KEY = "deliveryCircuit.identityCache";
const REFRESH_MS = 10 * 60_000;

export interface IdentityInternals extends IdentityService {
  /** Last notice (no persona, team access problems, ...), shown on the Connections page. */
  notice(): string | undefined;
}

export function createIdentity(base: ModuleBase, gh: GitHubClient, fallbackRepo: () => { owner?: string; repo?: string }): IdentityInternals {
  const ev = new vscode.EventEmitter<Identity | null>();
  let current: Identity | null = base.ctx.workspaceState.get<Identity>(CACHE_KEY) ?? null;
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
    if (!session) { notice = "Sign in to GitHub to load your personas."; set(null); return null; }
    const remote = await gitRemote(base.root);
    const fb = fallbackRepo();
    const owner = remote?.owner ?? fb.owner; const repo = remote?.repo ?? fb.repo;
    if (!owner || !repo) {
      notice = "This workspace has no GitHub remote \"origin\" (and build.config.yml names no github.org/repo).";
      set({ login: session.account.label, personas: [], active: null, isAdmin: false, owner: "", repo: "", orgOwned: false, notice });
      return current;
    }
    const cfg = vscode.workspace.getConfiguration("deliveryCircuit");
    const teams = cfg.get<Partial<Record<Persona, string>>>("githubTeams", { architect: "architects", developer: "developers", tester: "testers" });
    const override = cfg.get<string>("personaOverride", "") ?? "";
    // the session's account label is the GitHub login for the built-in provider; confirm via /user
    const user = await gh.request<{ login: string }>("GET", "/user");
    const r = await resolveIdentity({
      login: user.login, owner, repo, teams, override,
      previousActive: base.ctx.workspaceState.get<Persona>(ACTIVE_KEY) ?? null,
      get: (p) => gh.request("GET", p),
    });
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
    if (e.affectsConfiguration("deliveryCircuit.githubTeams") || e.affectsConfiguration("deliveryCircuit.personaOverride")) void refresh();
  }));

  const service: IdentityInternals = {
    get: () => current,
    refresh,
    async setActive(p: Persona) {
      if (!PERSONAS.includes(p)) throw new Error(`Unknown persona: ${p}`);
      if (!current || !current.personas.includes(p)) throw new Error(`You are not in the ${p} team, so you cannot act as ${p}.`);
      await base.ctx.workspaceState.update(ACTIVE_KEY, p);
      set({ ...current, active: pickActive(current.personas, p) });
    },
    onDidChange: ev.event,
    notice: () => notice,
  };

  base.ctx.subscriptions.push(vscode.commands.registerCommand("deliveryCircuit.switchPersona", async () => {
    const id = current ?? await refresh();
    if (!id) { void vscode.window.showWarningMessage("Sign in to GitHub first (Delivery Circuit: Connections)."); return; }
    if (!id.personas.length) { void vscode.window.showWarningMessage(notice ?? "You have no persona in this repo."); return; }
    const pick = await vscode.window.showQuickPick(id.personas.map((p) => ({
      label: cap(p), description: p === id.active ? "current" : undefined, persona: p,
    })), { title: "Act as", placeHolder: "Choose the persona you act as in this workspace" });
    if (pick) await service.setActive(pick.persona);
  }));

  return service;
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
