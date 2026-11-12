// What is waiting on each persona now (docs/CIRCUIT-V3.md sections 3 and 4). Pure function over v3 features, PRs
// and deploy runs (no vscode import).
//
// Action ids (the actions module implements them):
//   ai:<skill> {command, arg}                 gate:label {pr, label} | gate:review {pr, event, sha?} | gate:merge {pr, sha?}
//   gate:deploy {runId}                       nav:feature {featureId} | nav:testing {suite} | nav:connections
//   arch:approve-design {featureId, pageId, url}   opens the Confluence page; the person sets the status there (G1)
//   decision:record {featureId, pageId?}           Claude session: /record-decision <featureId> (C1)
//   dev:start-story {storyKey, featureId}          Claude session: /dev-start-story <KEY> (plan, branch, draft PR)
//   dev:fix {pr, checks, attempt}                  Claude session: /dev-fix <pr> with the failure prefilled
//   qa:add-tests {pr, storyKey, suite, tcIndex}    Claude session: /qa-add-tests <KEY> (commit suite + tc index to the PR)
//   review:open-room {pr}                          Claude session: /review-room open <pr> (Slack kick-off, C2/C8)
//   review:record-verdict {pr}                     Claude session: /review-room verdict <pr> (verdict to the PR, C3)
// Every new action also carries {command, arg}, so an "ai"-kind runner can start the skill as is.
import type { ActionRef, DeepLink, Persona, QueueItem } from "../core/contracts";
import { C5_MESSAGE, designSyncText } from "./design";
import { ghBlobUrl, storyPr, storyTestable } from "./gates";
import { STORIES_REVIEWED_LABEL } from "./jira";
import type { DeployInfo, FeatureInfo, PrInfo, RepoRef, StoryInfo } from "./model";

export interface QueueEnv {
  /** GitHub login of the person (own PRs: Fix, review room; others' PRs: code review) */
  login?: string;
  repo?: RepoRef;
  jiraBrowseUrl?: (key: string) => string | undefined;
  /** GitHub could not be read: PR-based items are missing */
  githubError?: string;
  /** Jira (acli) could not be read: feature items are missing */
  jiraError?: string;
  /** Fix with AI cap (ai.max_attempts) */
  maxAttempts?: number;
}

export interface QueueInput {
  features: FeatureInfo[];
  prs: PrInfo[];
  deploy?: DeployInfo;
  env: QueueEnv;
}

/** Queue kinds (the contract lists the v3 ones too). */
export type V3QueueKind = QueueItem["kind"];
export type V3QueueItem = QueueItem;

/** v3 action ids and the skill each starts; kind is the closest contract kind until ActionRef.kind gains these. */
export const V3_ACTIONS = {
  "arch:approve-design": { kind: "nav", command: undefined },
  "decision:record": { kind: "ai", command: "/record-decision" },
  "dev:start-story": { kind: "ai", command: "/dev-start-story" },
  "dev:fix": { kind: "ai", command: "/dev-fix" },
  "qa:add-tests": { kind: "ai", command: "/qa-add-tests" },
  "review:open-room": { kind: "ai", command: "/review-room" },
  "review:record-verdict": { kind: "ai", command: "/review-room" },
} as const satisfies Record<string, { kind: ActionRef["kind"]; command: string | undefined }>;
export type V3ActionId = keyof typeof V3_ACTIONS;

export const suitePath = (storyKey: string) => `test-cases/${storyKey}.sf-tests.yaml`;
export const tcIndexPath = (storyKey: string) => `tests/${storyKey}.tc.json`;
export const REVIEW_ROOM_LABEL = "review-room";
export const VERDICT_LABEL = "review-verdict";

/** The head commit shown with a review / merge button, so the action is pinned to what the person saw. */
const headArg = (sha: string | undefined): Record<string, string> => (sha && /^[0-9a-f]{40}$/i.test(sha) ? { sha } : {});
const ai = (persona: Persona, command: string, arg: string | number, label: string): ActionRef =>
  ({ id: `ai:${command}`, label, persona, kind: "ai", args: { command, arg: String(arg) } });
const gateLabel = (persona: Persona, pr: number, label: string): ActionRef =>
  ({ id: "gate:label", label: `Add ${label}`, persona, kind: "gate", args: { pr, label } });
const gateReview = (persona: Persona, pr: number, event: "APPROVE" | "REQUEST_CHANGES", sha?: string): ActionRef =>
  ({ id: "gate:review", label: event === "APPROVE" ? "Approve" : "Request changes", persona, kind: "gate", args: { pr, event, ...headArg(sha) } });
const navFeature = (persona: Persona, featureId: string): ActionRef =>
  ({ id: "nav:feature", label: "Open feature", persona, kind: "nav", args: { featureId } });
const navTesting = (persona: Persona, suite: string): ActionRef =>
  ({ id: "nav:testing", label: "Open in Testing", persona, kind: "nav", args: { suite } });

/** A v3 action: id from V3_ACTIONS, command + arg for the skill, plus the action's own args. */
export function v3Action(id: V3ActionId, persona: Persona, label: string, arg: string | number | undefined, args: Record<string, string | number> = {}): ActionRef {
  const def = V3_ACTIONS[id];
  const a: Record<string, string | number> = { ...args };
  if (def.command) { a.command = def.command; if (arg !== undefined) a.arg = String(arg); }
  return { id, label, persona, kind: def.kind, args: a };
}

const recordDecision = (persona: Persona, f: FeatureInfo): ActionRef =>
  v3Action("decision:record", persona, "Record a decision", f.id, { featureId: f.id, ...(f.design ? { pageId: f.design.pageId } : {}) });

function featureLinks(f: FeatureInfo): DeepLink[] { return [...f.links]; }

function storyLinks(f: FeatureInfo, stories: StoryInfo[]): DeepLink[] {
  const out: DeepLink[] = [];
  for (const s of stories) if (s.url) out.push({ kind: "jira", label: s.jiraKey!, target: s.url });
  return [...out, ...f.links.filter((l) => l.kind === "confluence")];
}

function prLinks(pr: PrInfo, f: FeatureInfo | undefined, env: QueueEnv, planFiles: string[] = []): DeepLink[] {
  const links: DeepLink[] = [{ kind: "github", label: `PR #${pr.number}`, target: pr.url }];
  if (pr.storyKey) {
    const u = env.jiraBrowseUrl?.(pr.storyKey);
    if (u) links.push({ kind: "jira", label: pr.storyKey, target: u });
  }
  if (f?.design?.url) links.push({ kind: "confluence", label: "Design page", target: f.design.url });
  if (env.repo && pr.storyKey) {
    for (const file of planFiles) links.push({ kind: "github", label: file, target: ghBlobUrl(env.repo, pr.branch, `docs/plans/${pr.storyKey}/${file}`) });
  }
  const rabbit = [...pr.reviews].reverse().find((r) => r.source === "coderabbit" && r.url);
  if (rabbit?.url) links.push({ kind: "coderabbit", label: "CodeRabbit review", target: rabbit.url });
  return links;
}

const isStoryPr = (pr: PrInfo) => !!pr.storyKey;
const has = (pr: PrInfo, l: string) => pr.labels.includes(l);
const gateOk = (pr: PrInfo, ctx: string) => pr.checks[ctx] === "success";
export const failingChecks = (pr: PrInfo) => Object.entries(pr.checks).filter(([k, v]) => v === "failure" && !k.startsWith("gate/")).map(([k]) => k).sort();
const pendingChecks = (pr: PrInfo) => Object.entries(pr.checks).filter(([k, v]) => v === "pending" && !k.startsWith("gate/")).map(([k]) => k);
const mine = (pr: PrInfo, env: QueueEnv) => !env.login || pr.author === env.login;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function prItemBase(persona: Persona, kind: V3QueueKind, pr: PrInfo, f: FeatureInfo | undefined): Omit<V3QueueItem, "title" | "links" | "actions"> {
  const base: Omit<V3QueueItem, "title" | "links" | "actions"> = { id: `${persona}:${kind}:pr-${pr.number}`, persona, kind, prNumber: pr.number, since: pr.updatedAt };
  if (pr.storyKey) base.storyKey = pr.storyKey;
  if (f) base.featureId = f.id;
  return base;
}

/** Why a story cannot start yet (Story 00 first, open blockers), or undefined when it can. */
export function startBlocker(f: FeatureInfo, s: StoryInfo, prs: PrInfo[]): string | undefined {
  const merged = (key: string) => storyPr(prs, key)?.state === "merged";
  const s00 = f.stories.find((x) => x.num === "00");
  if (s00 && s00 !== s && !merged(s00.jiraKey!) && s00.statusCategory !== "done") return `Story 00 (${s00.jiraKey}) goes first`;
  const open = s.blockedBy.filter((k) => {
    const other = f.stories.find((x) => x.jiraKey === k);
    return !(merged(k) || other?.statusCategory === "done");
  });
  return open.length ? `Blocked by ${open.join(", ")}` : undefined;
}

export function buildQueue(persona: Persona, input: QueueInput): QueueItem[] {
  const { features, env } = input;
  const prs = input.prs;
  const open = prs.filter((p) => p.state === "open");
  const fById = new Map(features.map((f) => [f.id, f]));
  const featureOf = (pr: PrInfo) => (pr.featureId ? fById.get(pr.featureId) : undefined);
  const storyOf = (pr: PrInfo) => featureOf(pr)?.stories.find((s) => s.jiraKey === pr.storyKey);
  const items: V3QueueItem[] = [];
  const max = env.maxAttempts ?? 3;

  // Not work waiting on the person: the views show these as notices and leave them out of the waiting counts.
  if (env.githubError) {
    const links: DeepLink[] = env.repo
      ? [{ kind: "github", label: `${env.repo.owner}/${env.repo.repo}`, target: `https://github.com/${encodeURIComponent(env.repo.owner)}/${encodeURIComponent(env.repo.repo)}/pulls` }]
      : [];
    items.push({ id: `${persona}:connect:github`, persona, kind: "connect", title: "Connect GitHub to see pull requests and gates",
      detail: env.githubError, links, actions: [{ id: "nav:connections", label: "Open Connections", persona, kind: "nav" }] });
  }
  if (env.jiraError) {
    items.push({ id: `${persona}:connect:jira`, persona, kind: "connect", title: "Connect Jira (Atlassian CLI) to see features and stories",
      detail: env.jiraError, links: [], actions: [{ id: "nav:connections", label: "Open Connections", persona, kind: "nav" }] });
  }

  if (persona === "architect") {
    for (const f of features) {
      if (!f.design) {
        items.push({ id: `architect:clarify:${f.id}:design`, persona, kind: "clarify", featureId: f.id,
          title: `${f.title}: no design page`, detail: "Link the Confluence design page on the epic (Design page field), or run intake.",
          links: featureLinks(f), actions: [ai(persona, "/arch-design", f.id, "Design with AI (arch-design)"), navFeature(persona, f.id)] });
        continue;
      }
      if (f.openQuestions > 0) {
        items.push({ id: `architect:clarify:${f.id}`, persona, kind: "clarify", featureId: f.id,
          title: `${f.title}: ${plural(f.openQuestions, "open question")}`,
          detail: "Answer from the client or decide; each answer is recorded as a decision on the design page.",
          links: featureLinks(f), actions: [ai(persona, "/arch-design", f.id, "Answer with AI (arch-design)"), recordDecision(persona, f), navFeature(persona, f.id)] });
      }
      const g1 = f.gates.G1;
      if (g1 === "waiting" || g1 === "blocked") {
        items.push({ id: `architect:sign-off:${f.id}`, persona, kind: "sign-off", gate: "G1", featureId: f.id,
          title: `${f.title}: approve design`,
          detail: f.openQuestions > 0 ? `Open questions remain. ${f.design.approval.detail}` : f.design.approval.detail,
          links: featureLinks(f),
          actions: [
            v3Action("arch:approve-design", persona, "Approve design", undefined, { featureId: f.id, pageId: f.design.pageId, ...(f.design.url ? { url: f.design.url } : {}) }),
            ai(persona, "/arch-design", f.id, "Revise with AI (arch-design)"), recordDecision(persona, f)] });
      }
      if (g1 === "done" && f.stories.length === 0) {
        items.push({ id: `architect:create-stories:${f.id}`, persona, kind: "create-stories", featureId: f.id,
          title: `${f.title}: create the epic's stories`, detail: `Design approved v${f.design.approval.approvedVersion ?? "?"}: write Story 00 first, then the rest, in Jira.`,
          links: featureLinks(f), actions: [ai(persona, "/arch-jira-push", f.id, "Create stories with AI (arch-jira-push)"), navFeature(persona, f.id)] });
      }
      if (g1 === "done") {
        const behind = f.stories.filter((s) => (s.designSync === "changed" || s.designSync === "missing") && storyPr(prs, s.jiraKey)?.state !== "merged");
        if (behind.length) {
          items.push({ id: `architect:design-changed:${f.id}`, persona, kind: "design-changed", featureId: f.id,
            title: `${f.title}: ${plural(behind.length, "story", "stories")} not on approved design v${f.design.approval.approvedVersion ?? "?"}`,
            detail: behind.map((s) => `${s.jiraKey}: ${designSyncText(s.designSync, s.approvedDesignVersion, f.design!.approval.approvedVersion)}`).join("; "),
            links: storyLinks(f, behind), actions: [ai(persona, "/arch-jira-push", f.id, "Update stories with AI (arch-jira-push)"), navFeature(persona, f.id)] });
        }
      }
    }
    for (const pr of open) {
      const f = featureOf(pr);
      if (isStoryPr(pr) && !pr.draft && !gateOk(pr, "gate/architect") && !has(pr, "needs-human")) {
        items.push({ ...prItemBase(persona, "review-pr", pr, f), gate: "G7",
          title: `#${pr.number} ${pr.title}`, detail: "Schema and design review against the approved design (G7)",
          links: prLinks(pr, f, env),
          actions: [ai(persona, "/arch-review-pr", pr.number, "Review with AI (arch-review-pr)"),
            gateReview(persona, pr.number, "APPROVE", pr.headSha), gateReview(persona, pr.number, "REQUEST_CHANGES", pr.headSha)] });
      }
      const allGates = ["gate/developer", "gate/tester", "gate/architect"].every((c) => gateOk(pr, c));
      const green = failingChecks(pr).length === 0 && pendingChecks(pr).length === 0;
      if (isStoryPr(pr) && !pr.draft && green && allGates) {
        items.push({ ...prItemBase(persona, "merge", pr, f), gate: "G8",
          title: `#${pr.number} ${pr.title}`, detail: "All gates and checks green: ready to merge (architects only)",
          links: prLinks(pr, f, env),
          actions: [{ id: "gate:merge", label: "Merge", persona, kind: "gate", args: { pr: pr.number, ...headArg(pr.headSha) } }] });
      }
    }
    for (const r of input.deploy?.runs ?? []) {
      if (r.status !== "waiting") continue;
      items.push({ id: `architect:deploy-approval:${r.id}`, persona, kind: "deploy-approval", gate: "G9",
        title: "Release: production deployment waiting for approval", detail: `deploy-prod run ${r.id} (${r.headSha.slice(0, 8)}), no AI`, since: r.createdAt,
        links: [{ kind: "github", label: `Run ${r.id}`, target: r.url }],
        actions: [{ id: "gate:deploy", label: "Review deployment", persona, kind: "gate", args: { runId: r.id } }] });
    }
  }

  if (persona === "developer") {
    for (const f of features) {
      if (f.gates.G1 !== "done" || f.stories.length === 0) continue;
      const started = f.stories.some((s) => !!storyPr(prs, s.jiraKey));
      const unreviewed = f.stories.filter((s) => !s.labels.includes(STORIES_REVIEWED_LABEL));
      if (!started && unreviewed.length > 0) {
        items.push({ id: `developer:review-stories:${f.id}`, persona, kind: "review-stories", featureId: f.id,
          title: `${f.title}: story review (${plural(unreviewed.length, "story", "stories")})`,
          detail: "Buildability, estimates and dependencies, as Jira comments",
          links: storyLinks(f, unreviewed),
          actions: [ai(persona, "/dev-review-stories", f.id, "Review with AI (dev-review-stories)"), recordDecision(persona, f), navFeature(persona, f.id)] });
      }
      for (const s of f.stories) {
        if (!storyTestable(s) || storyPr(prs, s.jiraKey) || s.statusCategory === "done") continue;
        if (s.designSync === "changed" || s.designSync === "ahead") continue; // the Architect's design-changed item
        if (startBlocker(f, s, prs)) continue;
        const links: DeepLink[] = [...(s.url ? [{ kind: "jira" as const, label: s.jiraKey!, target: s.url }] : []), ...f.links.filter((l) => l.kind === "confluence")];
        items.push({ id: `developer:start-story:${s.jiraKey}`, persona, kind: "start-story", featureId: f.id, storyKey: s.jiraKey,
          title: `${s.jiraKey} ${s.title}`,
          detail: `Ready (ai-ready). Plans on approved design v${s.approvedDesignVersion ?? f.design?.approval.approvedVersion ?? "?"}, creates feature/${s.jiraKey}-… and a draft PR`,
          links, actions: [v3Action("dev:start-story", persona, "Start story", s.jiraKey, { storyKey: s.jiraKey!, featureId: f.id })] });
      }
    }
    for (const pr of open) {
      if (!isStoryPr(pr)) continue;
      const f = featureOf(pr);
      const story = storyOf(pr);
      if (story?.designSync === "changed") {
        items.push({ ...prItemBase(persona, "design-changed", pr, f), title: `#${pr.number} ${pr.title}`,
          detail: designSyncText("changed", story.approvedDesignVersion, f?.design?.approval.approvedVersion),
          links: prLinks(pr, f, env, ["PLAN.md"]),
          actions: [v3Action("dev:start-story", persona, "Re-plan with AI", pr.storyKey, { storyKey: pr.storyKey!, ...(f ? { featureId: f.id } : {}), pr: pr.number, replan: "yes" })] });
      }
      if (has(pr, "needs-human")) {
        items.push({ ...prItemBase(persona, "needs-human", pr, f), title: `#${pr.number} ${pr.title}`,
          detail: `AI stopped${pr.aiAttempt ? ` after attempt ${pr.aiAttempt}` : ""}: a developer takes over`,
          links: prLinks(pr, f, env, ["PLAN.md"]),
          actions: [ai(persona, "/dev-review-pr", pr.number, "Review with AI (dev-review-pr)")] });
        continue;
      }
      const fails = failingChecks(pr);
      if (fails.length && mine(pr, env)) {
        const attempt = pr.aiAttempt ?? 0;
        if (attempt < max) {
          items.push({ ...prItemBase(persona, "fix", pr, f), title: `#${pr.number} ${pr.title}`,
            detail: `Failing: ${fails.join(", ")} (AI attempt ${attempt + 1} of ${max})`,
            links: prLinks(pr, f, env, ["PLAN.md"]),
            actions: [v3Action("dev:fix", persona, "Fix with AI", pr.number, { pr: pr.number, checks: fails.join(","), attempt: attempt + 1 })] });
        }
      }
      if (!has(pr, "plan-approved")) {
        items.push({ ...prItemBase(persona, "approve-plan", pr, f), gate: "G3", title: `#${pr.number} ${pr.title}`,
          detail: "Review the plan (PLAN.md), then add plan-approved",
          links: prLinks(pr, f, env, ["PLAN.md"]),
          actions: [ai(persona, "/dev-review-plan", pr.number, "Review with AI (dev-review-plan)"), gateLabel(persona, pr.number, "plan-approved")] });
        continue;
      }
      const green = fails.length === 0 && pendingChecks(pr).length === 0;
      if (mine(pr, env) && !pr.draft && green && !has(pr, REVIEW_ROOM_LABEL)) {
        items.push({ ...prItemBase(persona, "review-room", pr, f), title: `#${pr.number} ${pr.title}`,
          detail: "Checks green: open the review room in Slack (CodeRabbit and Claude debate the PR)",
          links: prLinks(pr, f, env),
          actions: [v3Action("review:open-room", persona, "Open review room", `open ${pr.number}`, { pr: pr.number })] });
      }
      if (mine(pr, env) && has(pr, REVIEW_ROOM_LABEL) && !has(pr, VERDICT_LABEL)) {
        items.push({ ...prItemBase(persona, "record-verdict", pr, f), title: `#${pr.number} ${pr.title}`,
          detail: "Copy the review-room verdict (Must fix / Disputed / Dropped) to the PR",
          links: prLinks(pr, f, env),
          actions: [v3Action("review:record-verdict", persona, "Record verdict", `verdict ${pr.number}`, { pr: pr.number })] });
      }
      if (!pr.draft && !gateOk(pr, "gate/developer") && pr.author !== env.login) {
        items.push({ ...prItemBase(persona, "review-pr", pr, f), gate: "G5", title: `#${pr.number} ${pr.title}`,
          detail: fails.length ? `Code review (G5). Failing: ${fails.join(", ")}` : "Code review (G5)",
          links: prLinks(pr, f, env, ["PLAN.md"]),
          actions: [ai(persona, "/dev-review-pr", pr.number, "Review with AI (dev-review-pr)"),
            gateReview(persona, pr.number, "APPROVE", pr.headSha), gateReview(persona, pr.number, "REQUEST_CHANGES", pr.headSha)] });
      }
    }
  }

  if (persona === "tester") {
    for (const f of features) {
      if (f.gates.G1 !== "done" || f.stories.length === 0) continue;
      const missing = f.stories.filter((s) => s.testCases.length === 0 && !storyPr(prs, s.jiraKey));
      if (missing.length > 0) {
        items.push({ id: `tester:design-tests:${f.id}`, persona, kind: "design-tests", featureId: f.id,
          title: `${f.title}: design tests for ${plural(missing.length, "story", "stories")}`,
          detail: `No Jira test cases yet: ${missing.map((s) => s.jiraKey).join(", ")}`,
          links: storyLinks(f, missing),
          actions: [ai(persona, "/qa-design-tests", f.id, "Design with AI (qa-design-tests)"), navFeature(persona, f.id)] });
      }
      const todo = f.stories.filter((s) => s.testCases.length > 0 && !storyTestable(s) && !storyPr(prs, s.jiraKey));
      if (todo.length > 0) {
        items.push({ id: `tester:testability:${f.id}`, persona, kind: "testability", gate: "G2", featureId: f.id,
          title: `${f.title}: confirm testability (ai-ready)`,
          detail: `${plural(todo.length, "story", "stories")} without Testability confirmed + ai-ready: ${todo.map((s) => s.jiraKey).join(", ")}`,
          links: storyLinks(f, todo),
          actions: [ai(persona, "/qa-push-tests", f.id, "Push tests with AI (qa-push-tests)"), navFeature(persona, f.id)] });
      }
    }
    for (const pr of open) {
      if (!isStoryPr(pr)) continue;
      const f = featureOf(pr);
      const key = pr.storyKey!;
      const testing = [navTesting(persona, suitePath(key))];
      if (has(pr, "needs-qa")) {
        items.push({ ...prItemBase(persona, "needs-qa", pr, f), title: `#${pr.number} ${pr.title}`,
          detail: "SF AI Tester reported blocked cases: fix the suite or test data",
          links: prLinks(pr, f, env, ["TESTPLAN.md"]),
          actions: [ai(persona, "/qa-explore", pr.number, "Explore with AI (qa-explore)"), ...testing] });
        continue;
      }
      // files(first: 100): a longer list may simply not show the tests, so only a short list proves they are missing.
      const testsOnPr = pr.files && (pr.files.length < 100 || (pr.files.includes(tcIndexPath(key)) && pr.files.includes(suitePath(key))))
        ? pr.files.includes(tcIndexPath(key)) && pr.files.includes(suitePath(key)) : undefined;
      if (testsOnPr === false) {
        items.push({ ...prItemBase(persona, "add-tests", pr, f), title: `Add tests to ${key}`,
          detail: `Commit ${suitePath(key)} and ${tcIndexPath(key)} to PR #${pr.number}`,
          links: prLinks(pr, f, env, ["TESTPLAN.md"]),
          actions: [v3Action("qa:add-tests", persona, `Add tests to ${key}`, key, { pr: pr.number, storyKey: key, suite: suitePath(key), tcIndex: tcIndexPath(key) })] });
      }
      if (!has(pr, "testplan-approved")) {
        items.push({ ...prItemBase(persona, "approve-testplan", pr, f), gate: "G4", title: `#${pr.number} ${pr.title}`,
          detail: "Review the test plan (TESTPLAN.md), then add testplan-approved",
          links: prLinks(pr, f, env, ["TESTPLAN.md"]),
          actions: [ai(persona, "/qa-review-testplan", pr.number, "Review with AI (qa-review-testplan)"), gateLabel(persona, pr.number, "testplan-approved")] });
        continue;
      }
      if (!pr.draft && !gateOk(pr, "gate/tester") && !has(pr, "needs-human") && pr.author !== env.login) {
        items.push({ ...prItemBase(persona, "qa-pr", pr, f), gate: "G6", title: `#${pr.number} ${pr.title}`,
          detail: pr.checks.qa === "success" ? "QA checks green: explore on QA and approve (G6)" : `QA on the QA org (G6); qa check ${pr.checks.qa ?? "missing"}`,
          links: prLinks(pr, f, env, ["TESTPLAN.md"]),
          actions: [ai(persona, "/qa-explore", pr.number, "Explore with AI (qa-explore)"),
            gateReview(persona, pr.number, "APPROVE", pr.headSha), gateReview(persona, pr.number, "REQUEST_CHANGES", pr.headSha), ...testing] });
      }
    }
  }
  return items;
}

export { C5_MESSAGE };
