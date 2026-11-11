// What is waiting on each persona now. Pure function over features, PRs and deploy runs (no vscode import).
// Action ids follow the grammar the actions module implements:
//   ai:<skill> {command, arg} | gate:label {pr,label} | gate:review {pr,event} | gate:merge {pr}
//   gate:signoff {featureId} | gate:deploy {runId} | nav:feature {featureId} | nav:testing {suite}
import type { ActionRef, DeepLink, Feature, Persona, QueueItem } from "../core/contracts";
import { ghBlobUrl } from "./gates";
import type { DeployInfo, PrInfo, RepoRef } from "./model";
import { suitePath } from "./parse";

export interface QueueEnv {
  /** GitHub login of the person (their own PRs are not offered for their own review) */
  login?: string;
  repo?: RepoRef;
  /** Jira labels known (Jira connected) */
  jiraConnected: boolean;
  /** G2 label per story key when Jira is connected */
  jiraBrowseUrl?: (key: string) => string | undefined;
  /** GitHub could not be read: PR-based items are missing */
  githubError?: string;
}

export interface QueueInput {
  features: Feature[];
  prs: PrInfo[];
  deploy?: DeployInfo;
  env: QueueEnv;
}

const ai = (persona: Persona, command: string, arg: string | number, label: string): ActionRef =>
  ({ id: `ai:${command}`, label, persona, kind: "ai", args: { command, arg: String(arg) } });
const gateLabel = (persona: Persona, pr: number, label: string): ActionRef =>
  ({ id: "gate:label", label: `Add ${label}`, persona, kind: "gate", args: { pr, label } });
const gateReview = (persona: Persona, pr: number, event: "APPROVE" | "REQUEST_CHANGES"): ActionRef =>
  ({ id: "gate:review", label: event === "APPROVE" ? "Approve" : "Request changes", persona, kind: "gate", args: { pr, event } });
const navFeature = (persona: Persona, featureId: string): ActionRef =>
  ({ id: "nav:feature", label: "Open feature", persona, kind: "nav", args: { featureId } });
const navTesting = (persona: Persona, suite: string): ActionRef =>
  ({ id: "nav:testing", label: "Open in Testing", persona, kind: "nav", args: { suite } });

function featureLinks(f: Feature, files: string[]): DeepLink[] {
  const fl = f.links.filter((l) => l.kind === "file" && files.some((x) => l.target.endsWith(x)));
  return [...fl, ...f.links.filter((l) => l.kind !== "file")];
}

function prLinks(pr: PrInfo, f: Feature | undefined, env: QueueEnv, extraFiles: string[] = []): DeepLink[] {
  const links: DeepLink[] = [{ kind: "github", label: `PR #${pr.number}`, target: pr.url }];
  if (pr.storyKey) {
    const u = env.jiraBrowseUrl?.(pr.storyKey);
    if (u) links.push({ kind: "jira", label: pr.storyKey, target: u });
  }
  if (env.repo && pr.storyKey) {
    for (const file of extraFiles) links.push({ kind: "github", label: file, target: ghBlobUrl(env.repo, pr.branch, `docs/plans/${pr.storyKey}/${file}`) });
  }
  const rabbit = [...pr.reviews].reverse().find((r) => r.source === "coderabbit" && r.url);
  if (rabbit?.url) links.push({ kind: "coderabbit", label: "CodeRabbit review", target: rabbit.url });
  const story = f && pr.storyNum ? f.stories.find((s) => s.num === pr.storyNum) : undefined;
  if (story) links.push({ kind: "file", label: `task_story_${story.num}.md`, target: story.file });
  return links;
}

const isStoryPr = (pr: PrInfo) => !!pr.storyKey;
const isAi = (pr: PrInfo) => pr.labels.includes("ai-generated");
const has = (pr: PrInfo, l: string) => pr.labels.includes(l);
const gateOk = (pr: PrInfo, ctx: string) => pr.checks[ctx] === "success";
const failing = (pr: PrInfo) => Object.entries(pr.checks).filter(([k, v]) => v === "failure" && !k.startsWith("gate/")).map(([k]) => k);
const pending = (pr: PrInfo) => Object.entries(pr.checks).filter(([k, v]) => v === "pending" && !k.startsWith("gate/")).map(([k]) => k);

function prItemBase(persona: Persona, kind: QueueItem["kind"], pr: PrInfo, f: Feature | undefined): Omit<QueueItem, "title" | "links" | "actions"> {
  const base: Omit<QueueItem, "title" | "links" | "actions"> = { id: `${persona}:${kind}:pr-${pr.number}`, persona, kind, prNumber: pr.number, since: pr.updatedAt };
  if (pr.storyKey) base.storyKey = pr.storyKey;
  if (f) base.featureId = f.id;
  return base;
}

export function buildQueue(persona: Persona, input: QueueInput): QueueItem[] {
  const { features, env } = input;
  const open = input.prs.filter((p) => p.state === "open");
  const fById = new Map(features.map((f) => [f.id, f]));
  const featureOf = (pr: PrInfo) => (pr.featureId ? fById.get(pr.featureId) : undefined);
  const items: QueueItem[] = [];

  if (env.githubError) {
    items.push({ id: `${persona}:connect:github`, persona, kind: "connect", title: "Connect GitHub to see pull requests and gates",
      detail: env.githubError, links: [], actions: [] });
  }

  if (persona === "architect") {
    for (const f of features) {
      if (f.openQuestions > 0) {
        items.push({ id: `architect:clarify:${f.id}`, persona, kind: "clarify", featureId: f.id,
          title: `${f.slug}: ${f.openQuestions} open question${f.openQuestions === 1 ? "" : "s"}`,
          detail: "Answer from the client or decide, then plan (arch-design).",
          links: [...f.links.filter((l) => l.kind === "file" && (l.target.endsWith("/spec.md") || /clarif/i.test(l.target))), ...featureLinks(f, [])],
          actions: [ai(persona, "/arch-design", f.slug, "Answer with AI (arch-design)"), navFeature(persona, f.id)] });
      }
      if (f.gates.G1 === "waiting") {
        items.push({ id: `architect:sign-off:${f.id}`, persona, kind: "sign-off", gate: "G1", featureId: f.id,
          title: `${f.slug}: sign off plan.md`,
          detail: f.openQuestions > 0 ? "Open questions remain; resolve them before signing." : "Review plan.md and data-model.md, then tick Overall Sign-Off.",
          links: featureLinks(f, ["plan.md", "data-model.md"]),
          actions: [{ id: "gate:signoff", label: "Sign off plan", persona, kind: "gate", args: { featureId: f.id } },
            ai(persona, "/arch-design", f.slug, "Revise with AI (arch-design)"), navFeature(persona, f.id)] });
      }
    }
    for (const pr of open) {
      const f = featureOf(pr);
      if (isStoryPr(pr) && !pr.draft && !gateOk(pr, "gate/architect") && !has(pr, "needs-human")) {
        items.push({ ...prItemBase(persona, "review-pr", pr, f), gate: "G7",
          title: `#${pr.number} ${pr.title}`, detail: "Schema and design review (G7)",
          links: prLinks(pr, f, env),
          actions: [ai(persona, "/arch-review-pr", pr.number, "Review with AI (arch-review-pr)"),
            gateReview(persona, pr.number, "APPROVE"), gateReview(persona, pr.number, "REQUEST_CHANGES")] });
      }
      const allGates = ["gate/developer", "gate/tester", "gate/architect"].every((c) => gateOk(pr, c));
      const green = failing(pr).length === 0 && pending(pr).length === 0;
      const specReady = !isStoryPr(pr) && !!f && f.signedOff && f.openQuestions === 0;
      if (!pr.draft && green && ((isStoryPr(pr) && allGates) || specReady)) {
        items.push({ ...prItemBase(persona, "merge", pr, f), gate: "G8",
          title: `#${pr.number} ${pr.title}`, detail: isStoryPr(pr) ? "All gates and checks green: ready to merge" : "Spec PR signed off and green: ready to merge",
          links: prLinks(pr, f, env),
          actions: [{ id: "gate:merge", label: "Merge", persona, kind: "gate", args: { pr: pr.number } }] });
      }
    }
    for (const r of input.deploy?.runs ?? []) {
      if (r.status !== "waiting") continue;
      items.push({ id: `architect:deploy-approval:${r.id}`, persona, kind: "deploy-approval", gate: "G9",
        title: `Production deployment waiting for approval`, detail: `deploy-prod run ${r.id} (${r.headSha.slice(0, 8)})`, since: r.createdAt,
        links: [{ kind: "github", label: `Run ${r.id}`, target: r.url }],
        actions: [{ id: "gate:deploy", label: "Review deployment", persona, kind: "gate", args: { runId: r.id } }] });
    }
  }

  if (persona === "developer") {
    for (const f of features) {
      const inJira = f.stories.some((s) => !!s.jiraKey);
      if (f.signedOff && f.stories.length > 0 && !inJira) {
        items.push({ id: `developer:review-stories:${f.id}`, persona, kind: "review-stories", featureId: f.id,
          title: `${f.slug}: review ${f.stories.length} stor${f.stories.length === 1 ? "y" : "ies"} before Jira`,
          links: [...f.stories.map((s): DeepLink => ({ kind: "file", label: `task_story_${s.num}.md`, target: s.file })), ...featureLinks(f, ["plan.md"])],
          actions: [ai(persona, "/dev-review-stories", f.slug, "Review with AI (dev-review-stories)"), navFeature(persona, f.id)] });
      }
    }
    for (const pr of open) {
      const f = featureOf(pr);
      if (!isStoryPr(pr)) continue;
      if (has(pr, "needs-human")) {
        items.push({ ...prItemBase(persona, "needs-human", pr, f), title: `#${pr.number} ${pr.title}`,
          detail: `AI stopped${pr.aiAttempt ? ` after attempt ${pr.aiAttempt}` : ""}: a developer takes over`,
          links: prLinks(pr, f, env, ["PLAN.md"]),
          actions: [ai(persona, "/dev-review-pr", pr.number, "Review with AI (dev-review-pr)")] });
        continue;
      }
      if (pr.draft && isAi(pr) && !has(pr, "plan-approved")) {
        items.push({ ...prItemBase(persona, "approve-plan", pr, f), gate: "G3", title: `#${pr.number} ${pr.title}`,
          detail: "Review the AI plan (PLAN.md), then add plan-approved",
          links: prLinks(pr, f, env, ["PLAN.md"]),
          actions: [ai(persona, "/dev-review-plan", pr.number, "Review with AI (dev-review-plan)"), gateLabel(persona, pr.number, "plan-approved")] });
        continue;
      }
      if (!pr.draft && !gateOk(pr, "gate/developer") && pr.author !== env.login) {
        const fails = failing(pr);
        items.push({ ...prItemBase(persona, "review-pr", pr, f), gate: "G5", title: `#${pr.number} ${pr.title}`,
          detail: fails.length ? `Code review (G5). Failing: ${fails.join(", ")}` : "Code review (G5)",
          links: prLinks(pr, f, env, ["PLAN.md"]),
          actions: [ai(persona, "/dev-review-pr", pr.number, "Review with AI (dev-review-pr)"),
            gateReview(persona, pr.number, "APPROVE"), gateReview(persona, pr.number, "REQUEST_CHANGES")] });
      }
    }
  }

  if (persona === "tester") {
    const prStoryKeys = new Set(input.prs.filter((p) => p.state !== "closed").map((p) => p.storyKey).filter(Boolean));
    for (const f of features) {
      const missing = f.stories.filter((s) => s.testCases.length === 0);
      if (f.signedOff && f.stories.length > 0 && missing.length > 0) {
        items.push({ id: `tester:design-tests:${f.id}`, persona, kind: "design-tests", featureId: f.id,
          title: `${f.slug}: design tests for ${missing.length} stor${missing.length === 1 ? "y" : "ies"}`,
          detail: `Stories without a test-case index: ${missing.map((s) => s.num).join(", ")}`,
          links: missing.map((s): DeepLink => ({ kind: "file", label: `task_story_${s.num}.md`, target: s.file })),
          actions: [ai(persona, "/qa-design-tests", f.slug, "Design with AI (qa-design-tests)"), navFeature(persona, f.id)] });
      }
      const keyed = f.stories.filter((s) => !!s.jiraKey);
      const notStarted = keyed.filter((s) => !prStoryKeys.has(s.jiraKey));
      if (keyed.length > 0 && notStarted.length > 0 && f.gates.G2 !== "done") {
        const links: DeepLink[] = [];
        for (const s of notStarted) {
          const u = env.jiraBrowseUrl?.(s.jiraKey!);
          if (u) links.push({ kind: "jira", label: s.jiraKey!, target: u });
        }
        items.push({ id: `tester:testability:${f.id}`, persona, kind: "testability", gate: "G2", featureId: f.id,
          title: `${f.slug}: confirm testability (ai-ready)`,
          detail: env.jiraConnected ? `${notStarted.length} stor${notStarted.length === 1 ? "y" : "ies"} without ai-ready` : "Jira not connected: status unknown, check in Jira",
          links: [...links, ...featureLinks(f, [])],
          actions: [ai(persona, "/qa-push-tests", f.slug, "Push tests with AI (qa-push-tests)"), navFeature(persona, f.id)] });
      }
    }
    for (const pr of open) {
      const f = featureOf(pr);
      if (!isStoryPr(pr)) continue;
      const suite = f && pr.storyNum ? suitePath(f.slug, pr.storyNum) : undefined;
      const testing = suite ? [navTesting(persona, suite)] : [];
      if (has(pr, "needs-qa")) {
        items.push({ ...prItemBase(persona, "needs-qa", pr, f), title: `#${pr.number} ${pr.title}`,
          detail: "SF AI Tester reported blocked cases: fix the suite or test data",
          links: prLinks(pr, f, env, ["TESTPLAN.md"]),
          actions: [ai(persona, "/qa-explore", pr.number, "Explore with AI (qa-explore)"), ...testing] });
        continue;
      }
      if (pr.draft && isAi(pr) && !has(pr, "testplan-approved")) {
        items.push({ ...prItemBase(persona, "approve-testplan", pr, f), gate: "G4", title: `#${pr.number} ${pr.title}`,
          detail: "Review the AI test plan (TESTPLAN.md), then add testplan-approved",
          links: prLinks(pr, f, env, ["TESTPLAN.md"]),
          actions: [ai(persona, "/qa-review-testplan", pr.number, "Review with AI (qa-review-testplan)"), gateLabel(persona, pr.number, "testplan-approved")] });
        continue;
      }
      if (!pr.draft && !gateOk(pr, "gate/tester") && !has(pr, "needs-human") && pr.author !== env.login) {
        items.push({ ...prItemBase(persona, "qa-pr", pr, f), gate: "G6", title: `#${pr.number} ${pr.title}`,
          detail: pr.checks.qa === "success" ? "QA checks green: explore and approve (G6)" : `QA on sandbox (G6); qa check ${pr.checks.qa ?? "missing"}`,
          links: prLinks(pr, f, env, ["TESTPLAN.md"]),
          actions: [ai(persona, "/qa-explore", pr.number, "Explore with AI (qa-explore)"),
            gateReview(persona, pr.number, "APPROVE"), gateReview(persona, pr.number, "REQUEST_CHANGES"), ...testing] });
      }
    }
  }
  return items;
}
