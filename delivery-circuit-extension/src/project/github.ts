// GitHub side of the work model (docs/CIRCUIT-V4.md sections 3-4): one GraphQL query for the sprint branches, the
// environment branches, auto-merge and the PRs (scan check, CodeRabbit and human reviews), plus REST mappers for
// deploy.yml runs, environments, environment secret names and rulesets. Secret values are never requested.
// No vscode import: unit-tested with recorded-shape fixtures.
import type { CheckState, DeployRun, PrInfo } from "./model";

export const CODERABBIT_LOGIN = "coderabbitai";
export const SCAN_CHECK = "scan";
export const AUTH_SECRET = "SFDX_AUTH_URL";

const PR_FIELDS = `
  number url title headRefName baseRefName isDraft state createdAt updatedAt mergedAt
  mergeCommit { oid }
  author { login }
  autoMergeRequest { enabledAt }
  reviews(last: 50) { nodes { author { login } state submittedAt } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
    __typename
    ... on CheckRun { name status conclusion detailsUrl }
    ... on StatusContext { context state targetUrl }
  } } } } } }`;

const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]{1,100}$/;

/** The one GraphQL query of a refresh. Environment branches are looked up by name (null = missing). */
export function workQuery(branches: string[]): string {
  const fixed = branches.filter((b) => BRANCH_NAME_RE.test(b) && !b.includes("*"));
  const refs = fixed.map((b, i) => `b${i}: ref(qualifiedName: ${JSON.stringify(`refs/heads/${b}`)}) { name }`).join("\n    ");
  return `query CircuitWork($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    autoMergeAllowed
    ${refs}
    sprints: refs(refPrefix: "refs/heads/sprint/", first: 20, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name } }
    open: pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
    merged: pullRequests(states: MERGED, first: 40, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
  }
}`;
}

/** feature/ABC-12-some-slug -> ABC-12 */
export function storyKeyFromBranch(branch: string): string | undefined {
  return /^feature\/([A-Z][A-Z0-9_]+-\d+)(?:[-_/]|$)/.exec(branch)?.[1];
}
/** PR titles start with the story key: "ABC-12 Escalation queue". */
export function storyKeyFromTitle(title: string): string | undefined {
  return /^\s*\[?([A-Z][A-Z0-9_]+-\d+)\]?(?=[\s:]|$)/.exec(title)?.[1];
}

export function checkRunState(status: string | undefined, conclusion: string | null | undefined): CheckState {
  if ((status ?? "").toUpperCase() !== "COMPLETED") return "pending";
  switch ((conclusion ?? "").toUpperCase()) {
    case "SUCCESS": case "NEUTRAL": case "SKIPPED": return "success";
    default: return "failure";
  }
}
export function statusContextState(state: string | undefined): CheckState {
  switch ((state ?? "").toUpperCase()) {
    case "SUCCESS": return "success";
    case "PENDING": case "EXPECTED": return "pending";
    case "FAILURE": case "ERROR": return "failure";
    default: return "missing";
  }
}

const isScan = (name: string) => name === SCAN_CHECK || name.endsWith(` / ${SCAN_CHECK}`);
const isBot = (login: string) => /\[bot\]$/i.test(login) || /^(github-actions|dependabot|renovate|coderabbitai)$/i.test(login);

/** The scan check of the head commit: failure anywhere wins, then pending, then success. */
function scanOf(node: any): { state: CheckState; url?: string } {
  const rank: Record<CheckState, number> = { failure: 3, pending: 2, success: 1, missing: 0 };
  let best: { state: CheckState; url?: string } = { state: "missing" };
  for (const n of node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []) {
    if (!n) continue;
    const name = String(n.name ?? n.context ?? "");
    if (!isScan(name)) continue;
    const state = n.context && !n.name ? statusContextState(n.state) : checkRunState(n.status, n.conclusion);
    if (rank[state] > rank[best.state]) best = { state, url: n.detailsUrl ?? n.targetUrl ?? undefined };
  }
  return best;
}

/** Latest APPROVED / CHANGES_REQUESTED review per author (a later plain comment does not undo it; DISMISSED does). */
function latestReviews(node: any): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of node?.reviews?.nodes ?? []) {
    const login = String(r?.author?.login ?? "").replace(/\[bot\]$/i, "");
    if (!login) continue;
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED") out.set(login, r.state);
    else if (r.state === "COMMENTED" && !out.has(login)) out.set(login, "COMMENTED");
  }
  return out;
}

export function mapPr(node: any): PrInfo {
  const head: string = node?.headRefName ?? "";
  const reviews = latestReviews(node);
  const rabbit = reviews.get(CODERABBIT_LOGIN);
  const scan = scanOf(node);
  const people = [...reviews].filter(([login]) => !isBot(login));
  const pr: PrInfo = {
    number: node.number,
    url: node.url,
    title: node.title ?? "",
    author: node.author?.login ?? "ghost",
    head,
    base: node.baseRefName ?? "",
    draft: !!node.isDraft,
    state: node.state === "MERGED" ? "merged" : node.state === "CLOSED" ? "closed" : "open",
    createdAt: node.createdAt ?? "",
    updatedAt: node.updatedAt ?? "",
    scan: scan.state,
    coderabbit: rabbit === "APPROVED" ? "approved" : rabbit === "CHANGES_REQUESTED" ? "changes" : "pending",
    approvedBy: people.filter(([, s]) => s === "APPROVED").map(([l]) => l).sort(),
    changesBy: people.filter(([, s]) => s === "CHANGES_REQUESTED").map(([l]) => l).sort(),
    autoMerge: !!node.autoMergeRequest,
  };
  if (scan.url) pr.scanUrl = scan.url;
  if (node.mergedAt) pr.mergedAt = node.mergedAt;
  if (node.mergeCommit?.oid) pr.mergeSha = node.mergeCommit.oid;
  const key = storyKeyFromBranch(head) ?? (/^feature\//.test(head) ? storyKeyFromTitle(pr.title) : undefined);
  if (key) pr.storyKey = key;
  return pr;
}

export interface WorkGithub {
  prs: PrInfo[];
  /** sprint/* branches, newest commit first */
  sprints: string[];
  /** environment branch -> exists (fixed names only) */
  branches: Record<string, boolean>;
  autoMerge?: boolean;
}

/** Map the GraphQL response. Accepts the raw `data` object or a wrapper with `data`. */
export function mapWorkResponse(resp: any, branches: string[]): WorkGithub {
  const repo = (resp?.data ?? resp)?.repository;
  if (!repo) return { prs: [], sprints: [], branches: {} };
  const seen = new Set<number>();
  const prs: PrInfo[] = [];
  for (const n of [...(repo.open?.nodes ?? []), ...(repo.merged?.nodes ?? [])]) {
    if (!n?.number || seen.has(n.number)) continue;
    seen.add(n.number);
    prs.push(mapPr(n));
  }
  const fixed = branches.filter((b) => BRANCH_NAME_RE.test(b) && !b.includes("*"));
  const out: WorkGithub = {
    prs,
    sprints: (repo.sprints?.nodes ?? []).map((n: any) => (n?.name ? `sprint/${n.name}` : "")).filter(Boolean),
    branches: Object.fromEntries(fixed.map((b, i) => [b, !!repo[`b${i}`]])),
  };
  if (typeof repo.autoMergeAllowed === "boolean") out.autoMerge = repo.autoMergeAllowed;
  return out;
}

/** REST /actions/workflows/deploy.yml/runs -> DeployRun[] */
export function mapDeployRuns(resp: any): DeployRun[] {
  return (resp?.workflow_runs ?? []).filter((r: any) => r && typeof r.id === "number").map((r: any) => ({
    id: r.id, branch: String(r.head_branch ?? ""), status: String(r.status ?? ""), conclusion: r.conclusion ?? null,
    url: String(r.html_url ?? ""), createdAt: String(r.created_at ?? ""),
  }));
}

/** REST /environments -> names */
export function environmentNames(resp: any): string[] {
  return (resp?.environments ?? []).map((e: any) => (typeof e?.name === "string" ? e.name : "")).filter(Boolean);
}

/** REST /environments/{env}/secrets -> whether a secret named SFDX_AUTH_URL exists (names only). */
export function hasAuthSecret(resp: any): boolean {
  return (resp?.secrets ?? []).some((s: any) => s?.name === AUTH_SECRET);
}

/** Ruleset ref pattern (refs/heads/sprint/*, ~DEFAULT_BRANCH, ~ALL) against a branch. `*` does not match "/", `**` does. */
export function refMatches(pattern: string, branch: string, defaultBranch?: string): boolean {
  if (pattern === "~ALL") return true;
  if (pattern === "~DEFAULT_BRANCH") return !!defaultBranch && branch === defaultBranch;
  const p = pattern.replace(/^refs\/heads\//, "");
  const re = new RegExp("^" + p.split(/(\*\*|\*)/).map((x) => (x === "**" ? ".*" : x === "*" ? "[^/]*" : x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))).join("") + "$");
  return re.test(branch);
}

/** REST /rulesets/{id} details -> branch -> covered by an active branch ruleset. */
export function rulesetCoverage(rulesets: any[], branches: string[], defaultBranch?: string): Record<string, boolean> {
  const active = rulesets.filter((r) => r && r.enforcement === "active" && (r.target ?? "branch") === "branch");
  return Object.fromEntries(branches.map((b) => [b, active.some((r) => {
    const inc: string[] = r.conditions?.ref_name?.include ?? [];
    const exc: string[] = r.conditions?.ref_name?.exclude ?? [];
    return inc.some((p) => refMatches(p, b, defaultBranch)) && !exc.some((p) => refMatches(p, b, defaultBranch));
  })]));
}

/** A concrete branch name for a pattern ("sprint/*" -> the current sprint branch, or a sample). */
export function sampleBranch(pattern: string, sprint?: string): string {
  return pattern.includes("*") ? (sprint ?? pattern.replace(/\*+/g, "sample")) : pattern;
}

