// The work model behind the Work and Missing tabs and the story panel (docs/CIRCUIT-V4.md section 7). Pure functions
// (no vscode import), unit-tested: next steps per role, the story status mapping, missing items and story details.
import {
  type ConnectionStatus, type DeepLink, type MissingItem, type Role, type SprintRow, type StoryDetail, type StoryPrState, type StoryStatus,
  type WorkRow,
} from "../core/contracts";
import { isApprovedStatus } from "./design";
import { acceptanceCriteriaOf, designPageOf, storyTitleOf, testCasesOf } from "./jira";
import type { DeployRun, DesignPage, Feature, JiraIssue, PrInfo, WorkData } from "./model";

export const MAX_NEXT = 5;
const DAY = 86_400_000;
/** Promotion ladder after the sprint branch (section 3). */
export const LADDER = ["dev", "sit", "uat", "main"];

const isSprint = (b: string) => /^sprint\//.test(b);
const isFeature = (b: string) => /^feature\//.test(b);
const t = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

// ---------- stories ----------

/** The PR of a story: the open one, else the newest merged one. Closed PRs never count. */
export function storyPr(prs: PrInfo[], key: string): PrInfo | undefined {
  const mine = prs.filter((p) => p.storyKey === key && p.state !== "closed");
  return mine.find((p) => p.state === "open")
    ?? mine.filter((p) => p.state === "merged").sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""))[0];
}

const isReady = (issue: JiraIssue, readyStatus: string) => issue.status.trim().toLowerCase() === readyStatus.trim().toLowerCase();
const inQaStatus = (issue: JiraIssue) => /\b(qa|in test|testing|verify|verification)\b/i.test(issue.status);

/** Design · Ready · Building · In PR · QA · Done. Jira says Done and QA statuses; GitHub says In PR and merged (QA). */
export function storyStatus(issue: JiraIssue, pr: PrInfo | undefined, readyStatus: string): StoryStatus {
  if (issue.statusCategory === "done") return "done";
  if (pr?.state === "merged" || inQaStatus(issue)) return "qa";
  if (pr?.state === "open") return "in-pr";
  if (isReady(issue, readyStatus)) return "ready";
  if (issue.statusCategory === "indeterminate") return "building";
  return "design";
}

/** A successful deploy.yml run on the branch after the time given (the merge). */
export function deployedAfter(deploys: DeployRun[], branch: string, since: string | undefined): boolean {
  const s = t(since);
  return deploys.some((d) => d.branch === branch && d.status === "completed" && d.conclusion === "success" && (Number.isNaN(s) || t(d.createdAt) >= s));
}

/** The design page of a story: the story's own link, else its epic's. */
export function pageOfStory(story: JiraIssue, data: WorkData): DesignPage | undefined {
  const feature = data.features.find((f) => f.epic?.key === story.parentKey);
  const own = designPageOf(story, data.fields);
  const fromList = own ? data.features.find((f) => f.page?.id === own.id)?.page : undefined;
  return fromList ?? feature?.page;
}

export const jiraUrl = (data: WorkData, key: string) => (data.site ? `${data.site}/browse/${key}` : undefined);

export function sprintRows(data: WorkData): SprintRow[] {
  return data.stories.map((s) => {
    const row: SprintRow = { key: s.key, title: storyTitleOf(s.summary), status: storyStatus(s, storyPr(data.prs, s.key), data.readyStatus) };
    const url = jiraUrl(data, s.key);
    if (url) row.url = url;
    return row;
  });
}

// ---------- next steps ----------

const skill = (role: Role, command: string, arg?: string) => ({ kind: "skill" as const, role, command, ...(arg ? { arg } : {}) });
const url = (u: string) => ({ kind: "url" as const, url: u });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const featureArg = (f: Feature) => f.slug ?? f.page?.slug ?? f.page?.url ?? f.epic?.key ?? f.id;

/** Open PRs into a sprint branch from a feature branch. */
const storyPrs = (data: WorkData) => data.prs.filter((p) => p.state === "open" && isSprint(p.base) && isFeature(p.head));

function architectSteps(data: WorkData): WorkRow[] {
  const rows: WorkRow[] = [{ id: "intake", title: "New design from transcript", detail: "Paste, a file or Fireflies", button: "Start", run: { kind: "intake" } }];
  for (const f of data.features) {
    const p = f.page;
    if (!p || isApprovedStatus(p.status) || p.openQuestions <= 0) continue;
    rows.push({ id: `design:${p.id}`, title: `Finish design ${f.title}`, detail: plural(p.openQuestions, "open question"), button: "Finish", run: skill("architect", "/arch-design", featureArg(f)) });
  }
  for (const f of data.features) {
    const p = f.page;
    if (!p || f.epic || !isApprovedStatus(p.status)) continue;
    rows.push({ id: `stories:${p.id}`, title: `Create stories for ${f.title}`, detail: "Design approved", button: "Create", run: skill("architect", "/arch-jira-push", featureArg(f)) });
  }
  return rows;
}

function developerSteps(data: WorkData, login: string | undefined): WorkRow[] {
  const rows: WorkRow[] = [];
  const open = storyPrs(data);
  for (const p of open) {
    if (login && p.author !== login) continue;
    const why = p.scan === "failure" ? "Scan failed" : p.coderabbit === "changes" ? "CodeRabbit asked for changes" : p.changesBy.length ? "Changes requested" : "";
    if (!why) continue;
    rows.push({ id: `fix:${p.number}`, title: `Fix ${p.storyKey ?? `PR #${p.number}`}`, detail: why, button: "Fix", run: skill("developer", "/dev-fix", p.storyKey ?? String(p.number)) });
  }
  for (const p of open) {
    if (!login || p.author === login || p.draft || p.approvedBy.length || p.scan === "failure") continue;
    rows.push({ id: `review:${p.number}`, title: `Review PR #${p.number}`, detail: [p.storyKey, `by ${p.author}`].filter(Boolean).join(" · "), button: "Open", run: url(p.url) });
  }
  for (const s of data.stories) {
    if (storyStatus(s, storyPr(data.prs, s.key), data.readyStatus) !== "ready") continue;
    rows.push({ id: `build:${s.key}`, title: `Build ${s.key}`, detail: storyTitleOf(s.summary), button: "Build", run: skill("developer", "/dev-start-story", s.key) });
  }
  return rows;
}

function testerSteps(data: WorkData): WorkRow[] {
  const rows: WorkRow[] = [];
  for (const s of data.stories) {
    const pr = storyPr(data.prs, s.key);
    if (storyStatus(s, pr, data.readyStatus) !== "qa" || !pr || pr.state !== "merged" || !deployedAfter(data.deploys, pr.base, pr.mergedAt)) continue;
    rows.push({ id: `qa:${s.key}`, title: `Test ${s.key} in QA`, detail: storyTitleOf(s.summary), button: "Test", run: skill("tester", "/qa-explore", s.key) });
  }
  for (const s of data.stories) {
    const st = storyStatus(s, storyPr(data.prs, s.key), data.readyStatus);
    if (st === "design" || st === "done" || testCasesOf(s, data.tests).length) continue;
    rows.push({ id: `tests:${s.key}`, title: `Write tests for ${s.key}`, detail: storyTitleOf(s.summary), button: "Write", run: skill("tester", "/qa-design-tests", s.key) });
  }
  return rows;
}

function leadSteps(data: WorkData): WorkRow[] {
  const rows: WorkRow[] = [];
  for (const d of data.deploys) {
    if (d.status !== "waiting") continue;
    rows.push({ id: `prod:${d.id}`, title: "Approve production deploy", detail: `${d.branch || "main"} · waiting`, button: "Open", run: url(d.url) });
  }
  const repo = data.repo;
  if (data.sprint) {
    const pr = data.prs.find((p) => p.state === "open" && p.head === data.sprint && p.base === "dev");
    const title = `Sprint review: promote ${data.sprint} → dev`;
    if (pr) rows.push({ id: `promote:${data.sprint}`, title, detail: `PR #${pr.number}${pr.approvedBy.length ? " · approved" : " · waits for a lead"}`, button: "Open", run: url(pr.url) });
    else if ((data.sprintAhead ?? 0) > 0 && repo) {
      rows.push({ id: `promote:${data.sprint}`, title, detail: plural(data.sprintAhead!, "new commit"), button: "Create",
        run: url(`https://github.com/${repo.owner}/${repo.repo}/compare/dev...${encodeURI(data.sprint)}?expand=1`) });
    }
  }
  for (let i = 0; i < LADDER.length - 1; i++) {
    const pr = data.prs.find((p) => p.state === "open" && p.head === LADDER[i] && p.base === LADDER[i + 1]);
    if (!pr) continue;
    rows.push({ id: `promote:${pr.head}`, title: `Promote ${pr.head} → ${pr.base}`, detail: `PR #${pr.number}${pr.approvedBy.length ? " · approved" : " · waits for a lead"}`, button: "Open", run: url(pr.url) });
  }
  return rows;
}

/** At most five rows, one button each, for the role. */
export function nextSteps(role: Role, data: WorkData, login?: string): WorkRow[] {
  const rows = role === "architect" ? architectSteps(data) : role === "developer" ? developerSteps(data, login)
    : role === "tester" ? testerSteps(data) : leadSteps(data);
  return rows.slice(0, MAX_NEXT);
}

// ---------- missing ----------

function connectionItems(role: Role, connections: ConnectionStatus[]): MissingItem[] {
  return connections
    .filter((c) => c.neededBy.includes(role) && !c.optional && (c.state === "disconnected" || c.state === "error"))
    .map((c) => ({ group: "connections" as const, id: `conn:${c.id}`, title: `${c.state === "error" ? "Fix" : "Connect"} ${c.label}`,
      detail: c.detail, button: c.state === "error" ? "Fix" : "Connect", run: { kind: "connect" as const, id: c.id } }));
}

function repoItems(role: Role, data: WorkData, connections: ConnectionStatus[], environments: { branch: string; environment: string }[]): MissingItem[] {
  const s = data.setup;
  const repo = data.repo;
  if (!s || !repo) return [];
  const gh = `https://github.com/${repo.owner}/${repo.repo}`;
  const out: MissingItem[] = [];
  const add = (id: string, title: string, page: string, detail?: string) =>
    out.push({ group: "repo", id: `repo:${id}`, title, ...(detail ? { detail } : {}), button: "Open", run: url(`${gh}${page}`) });
  for (const e of environments) {
    if (e.branch.includes("*")) { if (!s.sprintBranch) add("sprint", "No sprint branch", "/branches", "Create sprint/<name> from dev"); }
    else if (s.branches[e.branch] === false) add(`branch:${e.branch}`, `Branch ${e.branch} is missing`, "/branches");
  }
  for (const e of environments) {
    const env = s.environments[e.environment];
    if (!env) continue;
    if (!env.exists) add(`env:${e.environment}`, `Environment ${e.environment} is missing`, "/settings/environments");
    else if (env.authUrl === false) add(`secret:${e.environment}`, `${e.environment}: no SFDX_AUTH_URL secret`, "/settings/environments", "Checked by name only");
  }
  for (const [b, covered] of Object.entries(s.rulesets ?? {})) if (!covered) add(`rules:${b}`, `${b} has no ruleset`, "/settings/rules");
  if (s.autoMerge === false) add("automerge", "Auto-merge is off", "/settings", "Allow auto-merge in the repo settings");
  const rabbit = connections.find((c) => c.id === "coderabbit");
  if (rabbit && !rabbit.neededBy.includes(role) && rabbit.state === "disconnected") {
    out.push({ group: "repo", id: "repo:coderabbit", title: "CodeRabbit is not installed", button: "Open", run: url("https://github.com/apps/coderabbitai") });
  }
  if (out.length) out.unshift({ group: "repo", id: "repo:bootstrap", title: "Set up the repo", detail: "Runs /circuit-bootstrap", button: "Set up", run: { kind: "bootstrap" } });
  return out;
}

function storyItems(data: WorkData, now: number): MissingItem[] {
  const out: MissingItem[] = [];
  const add = (id: string, title: string, target: string | undefined, detail?: string) => {
    if (!target) return;
    out.push({ group: "stories", id, title, ...(detail ? { detail } : {}), button: "Open", run: url(target) });
  };
  for (const s of data.stories) {
    const pr = storyPr(data.prs, s.key);
    const st = storyStatus(s, pr, data.readyStatus);
    if (st === "done") continue;
    const jira = jiraUrl(data, s.key);
    const page = pageOfStory(s, data);
    if (data.designsRead && page && !isApprovedStatus(page.status)) add(`design:${s.key}`, `${s.key}: design not approved`, page.url ?? jira, page.status ? `Page status: ${page.status}` : undefined);
    if (!acceptanceCriteriaOf(s, data.fields)) add(`ac:${s.key}`, `${s.key}: no acceptance criteria`, jira);
    if (st !== "design" && !testCasesOf(s, data.tests).length) add(`tests:${s.key}`, `${s.key}: no test cases`, jira);
  }
  for (const p of storyPrs(data)) {
    const who = p.storyKey ?? `PR #${p.number}`;
    if (!p.storyKey) add(`nokey:${p.number}`, `PR #${p.number} has no Jira key`, p.url, "Name the branch feature/<KEY>-<slug>");
    if (p.scan === "failure") add(`scan:${p.number}`, `${who}: scan failing`, p.scanUrl ?? p.url);
    if (p.coderabbit === "changes") add(`rabbit:${p.number}`, `${who}: CodeRabbit asked for changes`, p.url);
    const age = now - t(p.createdAt);
    if (!p.draft && !p.approvedBy.length && age > DAY) add(`wait:${p.number}`, `PR #${p.number} waits for a review`, p.url, `${Math.floor(age / DAY)} d without an approval`);
  }
  return out;
}

/** Everything that blocks the flow: connections the role needs, repo setup, story gaps. */
export function missingItems(role: Role, data: WorkData, connections: ConnectionStatus[], environments: { branch: string; environment: string }[], now = Date.now()): MissingItem[] {
  return [...connectionItems(role, connections), ...repoItems(role, data, connections, environments), ...storyItems(data, now)];
}

// ---------- story panel ----------

export function prState(pr: PrInfo): StoryPrState {
  const s: StoryPrState = { number: pr.number, url: pr.url, state: pr.state, scan: pr.scan, coderabbit: pr.coderabbit, approvedBy: pr.approvedBy };
  if (pr.scanUrl) s.scanUrl = pr.scanUrl;
  if (pr.state === "open" && !pr.approvedBy.length) s.waitingSince = pr.createdAt;
  return s;
}

/** One story: status, the five-step line, PR state and links. inMain = the story's merge commit is on main. */
export function storyDetail(story: JiraIssue, data: WorkData, extra: { inMain?: boolean } = {}): StoryDetail {
  const pr = storyPr(data.prs, story.key);
  const status = storyStatus(story, pr, data.readyStatus);
  const page = pageOfStory(story, data);
  const designOpen = !!(data.designsRead && page && !isApprovedStatus(page.status));
  const order: StoryStatus[] = ["design", "ready", "building", "in-pr", "qa", "done"];
  const at = order.indexOf(status);
  const build = at >= order.indexOf("qa") ? "done" : at >= order.indexOf("ready") ? "active" : "todo";
  const qa = status === "done" ? "done" : status === "qa" ? "active" : "todo";
  const release = extra.inMain ? "done" : status === "done" ? "active" : "todo";
  const links: DeepLink[] = [];
  const jira = jiraUrl(data, story.key);
  if (jira) links.push({ kind: "jira", label: "Jira", target: jira });
  if (page?.url) links.push({ kind: "confluence", label: "Design page", target: page.url });
  if (page?.diagramUrl) links.push({ kind: "lucid", label: "Diagram", target: page.diagramUrl });
  if (pr) links.push({ kind: "github", label: `PR #${pr.number}`, target: pr.url });
  const d: StoryDetail = {
    key: story.key, title: storyTitleOf(story.summary), status,
    steps: [
      { id: "design", label: "Design", state: designOpen ? "active" : "done" },
      { id: "stories", label: "Stories", state: "done" },
      { id: "build", label: "Build", state: build },
      { id: "qa", label: "QA", state: qa },
      { id: "release", label: "Release", state: release },
    ],
    links,
  };
  if (pr) d.pr = prState(pr);
  return d;
}
