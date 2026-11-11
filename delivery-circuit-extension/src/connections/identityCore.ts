// Resolves who the person is in this repo: personas from GitHub team membership, admin rights, org vs personal.
// No vscode import; the GitHub request function is injected.
import { PERSONAS, type Identity, type Persona } from "../core/contracts";

export type Requester = <T = any>(path: string) => Promise<T>;

export interface IdentityResult { identity: Identity; notice?: string }

export interface ResolveInput {
  login: string;
  owner: string;
  repo: string;
  /** deliveryCircuit.githubTeams: persona -> team slug */
  teams: Partial<Record<Persona, string>>;
  /** deliveryCircuit.personaOverride ("" when unset) */
  override: string;
  /** previously chosen active persona (workspaceState) */
  previousActive?: Persona | null;
  get: Requester;
}

const isStatus = (e: unknown, s: number) => (e as any)?.status === s;
const enc = encodeURIComponent;

export async function resolveIdentity(i: ResolveInput): Promise<IdentityResult> {
  const repoInfo = await i.get<any>(`/repos/${enc(i.owner)}/${enc(i.repo)}`);
  const orgOwned = repoInfo?.owner?.type === "Organization";
  const repoAdmin = !!repoInfo?.permissions?.admin;
  const notices: string[] = [];
  let personas: Persona[] = [];
  let orgAdmin = false;

  if (orgOwned) {
    try {
      const m = await i.get<any>(`/user/memberships/orgs/${enc(i.owner)}`);
      orgAdmin = m?.state === "active" && m?.role === "admin";
    } catch (e) { if (!isStatus(e, 404) && !isStatus(e, 403)) throw e; }
    const missing: string[] = [];
    for (const p of PERSONAS) {
      const slug = i.teams[p];
      if (!slug) continue;
      try {
        const m = await i.get<any>(`/orgs/${enc(i.owner)}/teams/${enc(slug)}/memberships/${enc(i.login)}`);
        if (m?.state === "active") personas.push(p);
      } catch (e) {
        if (isStatus(e, 404)) continue; // not a member (or team missing)
        if (isStatus(e, 403)) { missing.push(slug); continue; }
        throw e;
      }
    }
    if (missing.length) notices.push(`Could not read team membership for ${missing.join(", ")} (the org may need to approve VS Code's GitHub access, or your token lacks read:org).`);
    if (!personas.length) notices.push(`You are not in any persona team of ${i.owner} (${PERSONAS.map((p) => i.teams[p]).filter(Boolean).join(", ")}). Ask an org admin to add you.`);
    if (i.override) notices.push("deliveryCircuit.personaOverride is ignored: this repo belongs to an organisation, so personas come from GitHub teams.");
  } else {
    const o = i.override as Persona;
    if (PERSONAS.includes(o)) personas = [o];
    else notices.push("This repo belongs to a personal account, so there are no GitHub teams. Set deliveryCircuit.personaOverride to architect, developer or tester.");
  }

  return {
    identity: { login: i.login, personas, active: pickActive(personas, i.previousActive ?? null), isAdmin: orgAdmin || repoAdmin, owner: i.owner, repo: i.repo, orgOwned },
    notice: notices.join(" ") || undefined,
  };
}

/** Keep the previous choice if still allowed; otherwise Architect if present, else the first persona. */
export function pickActive(personas: Persona[], previous: Persona | null): Persona | null {
  if (previous && personas.includes(previous)) return previous;
  if (personas.includes("architect")) return "architect";
  return personas[0] ?? null;
}
