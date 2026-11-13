// Resolves who the person is in this repo: roles from GitHub team membership (architects, developers, testers,
// leads), admin rights, org vs personal repo. No vscode import; the GitHub request function is injected.
import { ROLES, type Identity, type Role } from "../core/contracts";

export type Requester = <T = any>(path: string) => Promise<T>;

export interface IdentityResult { identity: Identity; notice?: string }

export interface ResolveInput {
  login: string;
  owner: string;
  repo: string;
  /** deliveryCircuit.githubTeams: role -> team slug */
  teams: Partial<Record<Role, string>>;
  /** previously chosen role (workspaceState) */
  previousActive?: Role | null;
  get: Requester;
}

const isStatus = (e: unknown, s: number) => (e as any)?.status === s;
const enc = encodeURIComponent;

export async function resolveIdentity(i: ResolveInput): Promise<IdentityResult> {
  const repoInfo = await i.get<any>(`/repos/${enc(i.owner)}/${enc(i.repo)}`);
  const orgOwned = repoInfo?.owner?.type === "Organization";
  const repoAdmin = !!repoInfo?.permissions?.admin;
  const notices: string[] = [];
  const roles: Role[] = [];
  let orgAdmin = false;

  if (orgOwned) {
    try {
      const m = await i.get<any>(`/user/memberships/orgs/${enc(i.owner)}`);
      orgAdmin = m?.state === "active" && m?.role === "admin";
    } catch (e) { if (!isStatus(e, 404) && !isStatus(e, 403)) throw e; }
    const unreadable: string[] = [];
    for (const r of ROLES) {
      const slug = i.teams[r];
      if (!slug) continue;
      try {
        const m = await i.get<any>(`/orgs/${enc(i.owner)}/teams/${enc(slug)}/memberships/${enc(i.login)}`);
        if (m?.state === "active") roles.push(r);
      } catch (e) {
        if (isStatus(e, 404)) continue; // not a member, or the team does not exist
        if (isStatus(e, 403)) { unreadable.push(slug); continue; }
        throw e;
      }
    }
    if (unreadable.length) notices.push(`Could not read the ${unreadable.join(", ")} team (the org may need to approve VS Code's GitHub access).`);
    if (!roles.length) notices.push(`You are not in a circuit team of ${i.owner}. Pick a role with the chip; ask an org admin to add you to a team.`);
  }

  return {
    identity: { login: i.login, roles, active: pickActive(roles, i.previousActive ?? null), isAdmin: orgAdmin || repoAdmin, owner: i.owner, repo: i.repo, orgOwned },
    notice: notices.join(" ") || undefined,
  };
}

/** Keep the previous choice if still offered; otherwise the first team role (any role when no team says). */
export function pickActive(roles: Role[], previous: Role | null): Role | null {
  const offered = roles.length ? roles : ROLES;
  if (previous && offered.includes(previous)) return previous;
  return roles[0] ?? "developer";
}
