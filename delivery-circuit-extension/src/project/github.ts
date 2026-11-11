// One GitHub GraphQL query for every PR the circuit cares about, mapped to PrInfo + ReviewSignal[].
// No vscode import: unit-tested with recorded-shape fixtures.
import type { CheckState, ReviewSignal } from "../core/contracts";
import type { DeployInfo, DeployRun, PrInfo } from "./model";

const PR_FIELDS = `
  number url title headRefName isDraft state mergedAt updatedAt
  author { login }
  labels(first: 30) { nodes { name } }
  reviews(last: 30) { nodes { author { login } state body submittedAt url } }
  comments(last: 20) { nodes { author { login } body createdAt url } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion detailsUrl completedAt startedAt title }
    ... on StatusContext { context state targetUrl description createdAt }
  } } } } } }`;

export const PRS_QUERY = `query CircuitPrs($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    prodTag: ref(qualifiedName: "refs/tags/prod-deployed") {
      target { oid ... on Commit { committedDate } ... on Tag { target { oid ... on Commit { committedDate } } } }
    }
    open: pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
    merged: pullRequests(states: MERGED, first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
  }
}`;

export const CODERABBIT_LOGIN = "coderabbitai";
const BOT_RE = /\[bot\]$|^(github-actions|dependabot|renovate)$/i;

/** feature/ABC-12-some-slug -> ABC-12 */
export function storyKeyFromBranch(branch: string): string | undefined {
  return /^feature\/([A-Z][A-Z0-9]+-\d+)(?:[-_/]|$)/.exec(branch)?.[1];
}
/** spec/001-case-escalation -> 001 (spec PRs carry the feature id in the branch) */
export function featureIdFromBranch(branch: string, title = ""): string | undefined {
  return /^spec\/(\d{3})-/.exec(branch)?.[1] ?? /^Spec (\d{3})-/.exec(title)?.[1];
}
/** highest ai-attempt-N label */
export function aiAttemptFromLabels(labels: string[]): number | undefined {
  const n = labels.map((l) => /^ai-attempt-(\d+)$/.exec(l)?.[1]).filter(Boolean).map(Number);
  return n.length ? Math.max(...n) : undefined;
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

const firstLine = (s: string, max = 160) => {
  const l = s.split(/\r?\n/).map((x) => x.replace(/<[^>]+>/g, "").replace(/[*_`]+/g, "").replace(/^[#>\s-]+/, "").trim()).find((x) => x.length > 0) ?? "";
  return l.length > max ? l.slice(0, max - 1) + "…" : l;
};

/** "VERDICT: PASS" / "VERDICT: BLOCK" in the last lines of an AI Reviewer comment. */
export function reviewerVerdict(body: string): "pass" | "block" | undefined {
  const tail = body.trim().split(/\r?\n/).slice(-5).join("\n");
  const m = /^\s*\**VERDICT:\s*(PASS|BLOCK)\b/im.exec(tail);
  return m ? (m[1].toUpperCase() === "PASS" ? "pass" : "block") : undefined;
}

interface CheckEntry { name: string; state: CheckState; url?: string; at?: string; title?: string }

function checkEntries(pr: any): CheckEntry[] {
  const nodes = pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const out: CheckEntry[] = [];
  for (const n of nodes) {
    if (!n) continue;
    if (n.__typename === "CheckRun" || (n.name && !n.context)) {
      out.push({ name: n.name, state: checkRunState(n.status, n.conclusion), url: n.detailsUrl ?? undefined, at: n.completedAt ?? n.startedAt ?? undefined, title: n.title ?? undefined });
    } else if (n.context) {
      out.push({ name: n.context, state: statusContextState(n.state), url: n.targetUrl ?? undefined, at: n.createdAt ?? undefined, title: n.description ?? undefined });
    }
  }
  return out;
}

/** Merge entries by name: a failure anywhere wins, then pending, then success. */
function checksRecord(entries: CheckEntry[], isStoryPr: boolean): Record<string, CheckState> {
  const rank: Record<CheckState, number> = { failure: 3, pending: 2, success: 1, missing: 0 };
  const out: Record<string, CheckState> = {};
  for (const e of entries) if (!out[e.name] || rank[e.state] > rank[out[e.name]]) out[e.name] = e.state;
  if (isStoryPr) for (const g of ["gate/developer", "gate/tester", "gate/architect"]) out[g] ??= "missing";
  return out;
}

export function buildSignals(pr: any, labels: string[], entries: CheckEntry[]): ReviewSignal[] {
  const signals: ReviewSignal[] = [];
  const updated = pr.updatedAt ?? new Date(0).toISOString();
  // People and CodeRabbit: their latest review each (COMMENTED reviews only when they say something)
  const latest = new Map<string, any>();
  for (const r of pr?.reviews?.nodes ?? []) {
    const login: string = r?.author?.login ?? "ghost";
    if (r.state === "PENDING" || r.state === "DISMISSED") continue;
    if (r.state === "COMMENTED" && !String(r.body ?? "").trim()) continue;
    const prev = latest.get(login);
    // an APPROVED / CHANGES_REQUESTED review is not replaced by a later plain comment
    if (prev && prev.state !== "COMMENTED" && r.state === "COMMENTED") continue;
    latest.set(login, r);
  }
  for (const [login, r] of latest) {
    const isRabbit = login.replace(/\[bot\]$/, "") === CODERABBIT_LOGIN;
    if (!isRabbit && BOT_RE.test(login)) continue;
    const state: ReviewSignal["state"] = r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "changes-requested" : "commented";
    const summary = firstLine(String(r.body ?? "")) || (state === "approved" ? "Approved" : state === "changes-requested" ? "Changes requested" : "Commented");
    signals.push({ source: isRabbit ? "coderabbit" : "human", author: login, state, summary, url: r.url ?? undefined, at: r.submittedAt ?? updated });
  }
  // AI Reviewer: the latest comment that ends with a verdict
  const verdicts = (pr?.comments?.nodes ?? []).filter((c: any) => reviewerVerdict(String(c?.body ?? "")));
  const v = verdicts[verdicts.length - 1];
  if (v) {
    const verdict = reviewerVerdict(String(v.body))!;
    signals.push({ source: "ai-reviewer", author: v.author?.login ?? "reviewer", state: verdict,
      summary: firstLine(String(v.body)) || `VERDICT: ${verdict.toUpperCase()}`, url: v.url ?? undefined, at: v.createdAt ?? updated });
  }
  // Salesforce Code Analyzer: its own check run when present, else the "static" job that runs the quality gate
  const ca = entries.find((e) => /code[\s_-]?analyzer/i.test(e.name)) ?? entries.find((e) => e.name === "static");
  if (ca && ca.state !== "missing") {
    signals.push({ source: "code-analyzer", author: ca.name, state: ca.state === "success" ? "pass" : ca.state === "failure" ? "block" : "commented",
      summary: ca.state === "pending" ? "Running" : ca.title || (ca.state === "success" ? "No severity 1-2 violations" : "Quality gate failed (severity 1-2 violations or lint)"),
      url: ca.url, at: ca.at ?? updated });
  }
  // SF AI Tester: the "qa" job's acceptance step; needs-qa means blocked cases
  const qa = entries.find((e) => e.name === "qa");
  if (labels.includes("needs-qa")) {
    signals.push({ source: "sf-ai-tester", author: "qa", state: "block", summary: "Blocked test cases: Tester action needed (needs-qa)", url: qa?.url, at: qa?.at ?? updated });
  } else if (qa && qa.state !== "missing") {
    signals.push({ source: "sf-ai-tester", author: "qa", state: qa.state === "success" ? "pass" : qa.state === "failure" ? "block" : "commented",
      summary: qa.state === "pending" ? "QA deploy and acceptance tests running" : qa.state === "success" ? "QA deploy, Apex and acceptance tests passed" : "QA deploy or acceptance tests failed",
      url: qa.url, at: qa.at ?? updated });
  }
  return signals.sort((a, b) => a.at.localeCompare(b.at));
}

export function mapPr(node: any): PrInfo {
  const labels: string[] = (node?.labels?.nodes ?? []).map((l: any) => l?.name).filter(Boolean);
  const branch: string = node.headRefName ?? "";
  const storyKey = storyKeyFromBranch(branch);
  const entries = checkEntries(node);
  const pr: PrInfo = {
    number: node.number,
    url: node.url,
    title: node.title ?? "",
    branch,
    draft: !!node.isDraft,
    author: node.author?.login ?? "ghost",
    labels,
    checks: checksRecord(entries, !!storyKey),
    reviews: buildSignals(node, labels, entries),
    updatedAt: node.updatedAt ?? "",
    state: node.state === "MERGED" ? "merged" : node.state === "CLOSED" ? "closed" : "open",
    headSha: node.commits?.nodes?.[0]?.commit?.oid ?? "",
  };
  if (node.mergedAt) pr.mergedAt = node.mergedAt;
  if (storyKey) pr.storyKey = storyKey;
  const fid = featureIdFromBranch(branch, pr.title);
  if (fid) pr.featureId = fid;
  const attempt = aiAttemptFromLabels(labels);
  if (attempt !== undefined) pr.aiAttempt = attempt;
  return pr;
}

/** Map the GraphQL response. Accepts the raw `data` object or a wrapper with `data`. */
export function mapPrsResponse(resp: any): { prs: PrInfo[]; prodDeployedAt?: string; prodDeployedSha?: string } {
  const repo = (resp?.data ?? resp)?.repository;
  if (!repo) return { prs: [] };
  const seen = new Set<number>();
  const prs: PrInfo[] = [];
  for (const n of [...(repo.open?.nodes ?? []), ...(repo.merged?.nodes ?? [])]) {
    if (!n || seen.has(n.number)) continue;
    seen.add(n.number);
    prs.push(mapPr(n));
  }
  const t = repo.prodTag?.target;
  const commit = t?.committedDate ? t : t?.target;
  return { prs, prodDeployedAt: commit?.committedDate ?? undefined, prodDeployedSha: commit?.oid ?? undefined };
}

/** REST /actions/workflows/deploy-prod.yml/runs -> DeployRun[] */
export function mapDeployRuns(resp: any): DeployRun[] {
  return (resp?.workflow_runs ?? []).map((r: any) => ({
    id: r.id, status: r.status, conclusion: r.conclusion ?? null, url: r.html_url, createdAt: r.created_at, headSha: r.head_sha,
  }));
}

export function deployInfo(runs: DeployRun[], prodDeployedAt?: string, prodDeployedSha?: string): DeployInfo {
  const d: DeployInfo = { runs };
  if (prodDeployedAt) d.prodDeployedAt = prodDeployedAt;
  if (prodDeployedSha) d.prodDeployedSha = prodDeployedSha;
  return d;
}
