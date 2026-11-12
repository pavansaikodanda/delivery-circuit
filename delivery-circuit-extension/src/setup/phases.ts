// Phases B0-B13 of skills/circuit-bootstrap/SKILL.md (v3) as wizard steps. No vscode import.
// v3 stores no credentials: there are no secret steps. Every connection is a login (gh, sf, acli, claude, MCP OAuth),
// and the self-hosted runners hold their own service-user logins.
// Step kinds:
//   check     automatic, read-only check (CLI or API)
//   run       safe automatic step; always confirmed in a modal first
//   terminal  opens a terminal running a fixed program with array arguments (interactive logins and tools)
//   human     HUMAN CHECKPOINT: the person does it (browser, runner machine); checklist + commands + Verify by API/CLI
//   form      edit build.config.yml
import { acliInstall, prodAliases, runnerGuide, runnerLogins } from "./commands";
import type { RunnerConfig } from "./config";

export type StepKind = "check" | "run" | "terminal" | "human" | "form";

export interface StepDef {
  id: string;
  kind: StepKind;
  title: string;
  detail: string;
  /** HC-n for human checkpoints */
  hc?: string;
  /** vendor pages to open (human steps) */
  urls?: { label: string; url: string }[];
  checklist?: string[];
  /** commands the person copies and runs (on a runner machine, or a terminal); never contain a credential */
  commands?: string[];
  /** short notes under the commands */
  notes?: string[];
  /** button label for run/terminal steps (and human steps that open a terminal or a Claude session) */
  action?: string;
  /** step has an automatic check / verify */
  verify?: boolean;
}

export interface PhaseDef { id: string; name: string; summary: string; steps: StepDef[] }

export interface PhaseCtx {
  owner: string;
  repo: string;
  /** GitHub org from build.config.yml (falls back to owner) */
  org: string;
  jiraSite: string;
  jiraKey: string;
  spaceKey: string;
  devAlias: string;
  qaAlias: string;
  prodAlias: string;
  runners: { circuit: RunnerConfig; release: RunnerConfig };
  /** process.platform of this machine, for install commands */
  platform: NodeJS.Platform;
  arch?: string;
}

const u = (label: string, url: string) => ({ label, url });

export function phases(c: PhaseCtx): PhaseDef[] {
  const gh = `https://github.com/${c.owner}/${c.repo}`;
  const org = `https://github.com/organizations/${c.org}`;
  const jira = /^https:\/\/[\w.-]+\.atlassian\.net/.test(c.jiraSite) ? c.jiraSite.replace(/\/$/, "") : "";
  const keep = (l: { label: string; url: string }[]) => l.filter((x) => /^https:\/\//.test(x.url));
  const circuit = runnerGuide(c.owner || "<org>", c.repo || "<repo>", c.runners.circuit, "circuit");
  const release = runnerGuide(c.owner || "<org>", c.repo || "<repo>", c.runners.release, "release");
  const aliases = { devAlias: c.devAlias, qaAlias: c.qaAlias, prodAlias: c.prodAlias };
  return [
    {
      id: "B0", name: "Preflight", summary: "Tools, GitHub CLI scopes, installer dry run, build.config.yml, browser sign-ins.",
      steps: [
        { id: "b0.tools", kind: "check", title: "Tool versions", detail: "git, gh, node, npm, sf (+ code-analyzer), claude, acli, jq, actionlint, shellcheck, specify. Recorded in build-state.md.", verify: true, action: "Record in build-state.md" },
        { id: "b0.gh", kind: "check", title: "GitHub CLI and your access", detail: "gh auth status needs scopes repo, admin:org, workflow; you need to be an org owner or repo admin.", verify: true },
        { id: "b0.dryrun", kind: "run", title: "Installer dry run", detail: "Shows what install.mjs would add, update or skip, and lists v2 files still in the repo as STALE. Changes nothing.", action: "Run dry run" },
        { id: "b0.config", kind: "form", title: "Fill build.config.yml", detail: "Org, repo, people per team, runners, Jira, Confluence, sf aliases, Slack. No secrets: the circuit stores none.", verify: true },
        { id: "b0.hc1", kind: "human", hc: "HC-1", title: "Sign in to every service in your browser", detail: "Sign in once so the later screens open directly.",
          urls: keep([u("GitHub", "https://github.com/login"), u("Atlassian", jira || "https://id.atlassian.com/login"), u("Slack", "https://slack.com/signin"), u("Claude", "https://claude.ai/login")]),
          checklist: ["Signed in to GitHub with an org owner account", "Signed in to Atlassian (Jira and Confluence)", "Signed in to the DEV and QA orgs", "Signed in to Slack and claude.ai"], verify: true },
      ],
    },
    {
      id: "B1", name: "GitHub repo, teams, labels", summary: "Teams, labels, Actions settings for self-hosted runners, variables; no secrets.",
      steps: [
        { id: "b1.teams", kind: "run", title: "Persona teams", detail: "Creates architects, developers, testers (closed), adds the people from build.config.yml, gives each team push on the repo. Teams must be disjoint.", action: "Create teams and members", verify: true },
        { id: "b1.labels", kind: "run", title: "Labels", detail: "plan-review, plan-approved, testplan-approved, ai-ready, ai-generated, ai-attempt-1..3, needs-fix, needs-human, needs-qa, review-room, review-verdict.", action: "Create missing labels", verify: true },
        { id: "b1.actions", kind: "human", title: "Actions settings for self-hosted runners", detail: "GitHub: self-hosted runners should almost never be used for public repositories. Keep the repo private, never run fork PR workflows, and give workflows read-only tokens by default.",
          urls: [u("Repository settings", `${gh}/settings`), u("Actions settings", `${gh}/settings/actions`)],
          checklist: ["Repository is private (or: public with \"Require approval for all external contributors\")", "Fork pull request workflows: \"Run workflows from fork pull requests\" is off", "Workflow permissions: \"Read repository contents and packages permissions\""], verify: true },
        { id: "b1.vars", kind: "run", title: "Repository variables", detail: "MAX_AI_ATTEMPTS, CIRCUIT_QA_ALIAS, CIRCUIT_PROD_ALIAS, CIRCUIT_RELEASE_ALIAS, DESIGN_PENDING_STATUSES, SLACK_CHANNEL_DEV/QA, CIRCUIT_SLACK_TRANSPORT, SF_AI_TESTER_* from build.config.yml. Names and flags only.", action: "Set variables", verify: true },
        { id: "b1.nosecrets", kind: "check", title: "No stored credentials", detail: "The repository and its environments hold no secrets: no CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, Salesforce JWT keys, Jira tokens or Slack webhooks. Leftovers from v2 can be deleted here.", action: "Delete leftover secrets", verify: true },
      ],
    },
    {
      id: "B2", name: "Self-hosted runners", summary: "Two runners with their own logins: circuit (PR checks) and circuit-release (deploy-prod).",
      steps: [
        { id: "b2.circuit", kind: "human", hc: "HC-2", title: "Register the circuit runner", detail: "On the circuit machine, as its service user: download the runner, register it with the labels below and install it as a service.",
          urls: [u("New self-hosted runner", `${gh}/settings/actions/runners/new`), u("Runners", `${gh}/settings/actions/runners`)],
          commands: circuit.commands, notes: circuit.notes,
          checklist: ["Runner downloaded from the repository's New self-hosted runner page", "Registered with labels self-hosted, circuit", "Installed and started as a service"], verify: true },
        { id: "b2.logins", kind: "human", hc: "HC-3", title: "Circuit runner logins", detail: "As the runner's service user, in a terminal on that machine, sign in once to each tool. Logins stay on the runner; nothing goes into GitHub secrets.",
          commands: runnerLogins(aliases, "circuit"),
          notes: ["Also install there: sf plugins install @salesforce/plugin-code-analyzer, Node 22, jq, and the SF AI Tester (scripts/ci/install-sf-ai-tester.sh).", "Re-run a login when it expires (org refresh, password change)."],
          checklist: ["gh signed in (repo, read:org)", "claude signed in with a Claude Team seat (and Slack via /mcp if transport is claude)", "acli jira auth login --web done", "sf logins for the DEV and QA aliases", "runner-check.sh prints ok"], verify: true },
        { id: "b2.release", kind: "human", hc: "HC-5", title: "Release runner and the production login", detail: "A second machine or service user for deploy-prod only. The person with production rights signs in to the production alias there. Claude and this extension never do.",
          urls: [u("New self-hosted runner", `${gh}/settings/actions/runners/new`)],
          commands: [...release.commands, ...runnerLogins(aliases, "release")], notes: release.notes,
          checklist: ["Registered with labels self-hosted, circuit-release", "Installed as a service", "Production alias signed in by a person, on this runner only", "runner-check.sh prints ok"], verify: true },
      ],
    },
    {
      id: "B3", name: "Salesforce logins", summary: "Each person logs in to DEV and QA with their own user; no integration users, no JWT keys.",
      steps: [
        { id: "b3.login", kind: "terminal", title: "Log in to DEV and QA", detail: `sf org login web --alias ${c.devAlias || "dev"} and --alias ${c.qaAlias || "qa"}. Any connected org may be DEV or QA (sandbox, scratch, Developer Edition, demo org).`, action: "Open terminal: sf org login web" },
        { id: "b3.orgs", kind: "check", title: "Org aliases", detail: `sf org display for ${c.devAlias || "dev"} and ${c.qaAlias || "qa"}, and no production alias (${prodAliases(c.prodAlias || "prod").join(", ")}) on this machine. Architects may hold it for manual work; AI is still blocked by the guard.`, verify: true },
      ],
    },
    {
      id: "B4", name: "Repo foundation", summary: "Installer on pipeline/foundation; persona MCP URLs; PR merged by a person.",
      steps: [
        { id: "b4.branch", kind: "run", title: "Branch pipeline/foundation", detail: "git switch -c pipeline/foundation (or switch to it).", action: "Switch branch", verify: true },
        { id: "b4.install", kind: "run", title: "Run the installer", detail: "install.mjs for real: CLAUDE.md, .claude/, CODEOWNERS, PR template, scripts/ci, .coderabbit.yaml, sf-config, build.config.yml, build-state.md. Existing files are skipped; workflows wait for B9.", action: "Install", verify: true },
        { id: "b4.mcp", kind: "run", title: "Persona MCP URLs", detail: "Replaces VERIFY placeholders in .claude/personas/*.mcp.json with the vendor URLs (Atlassian v2, Lucid, Fireflies, GitHub, Slack). Sign-in is OAuth in Claude (/mcp), never a key.", action: "Fill URLs", verify: true },
        { id: "b4.pr", kind: "human", title: "Commit, push and merge the foundation PR", detail: "Commit everything except .github/workflows/, push pipeline/foundation, open the PR. A person merges it.",
          urls: [u("Pull requests", `${gh}/pulls`)], checklist: ["Committed without .github/workflows/", "PR opened", "PR merged by a person"], verify: true },
      ],
    },
    {
      id: "B5", name: "Spec Kit", summary: "The Architect's local drafting scaffold: specify init + spec-kit-sf; .specify/specs stays out of git.",
      steps: [
        { id: "b5.init", kind: "terminal", title: "specify init", detail: "specify init --here --integration claude --integration-options=--no-model-invocation", action: "Open terminal: specify init" },
        { id: "b5.ext", kind: "terminal", title: "spec-kit-sf extension", detail: "specify extension add sf --from the v2.0.1 release archive (confirm the URL in the terminal).", action: "Open terminal: add extension" },
        { id: "b5.skills", kind: "run", title: "Remove deploy skills", detail: "Deletes .claude/skills/speckit-sf-deploy, -hotfix and -pr (the guard blocks them anyway).", action: "Remove", verify: true },
        { id: "b5.check", kind: "check", title: "Spec Kit state", detail: ".specify/, extension sf, .specify/specs/ gitignored (specs are published to Confluence and Jira), production alias named in sf-config.", verify: true },
        { id: "b5.constitution", kind: "human", title: "Constitution", detail: "An Architect runs /speckit-sf-constitution against dev and appends the house rules as Article X; the Architect reviews and merges the PR.",
          action: "Start Architect session", checklist: ["Constitution generated", "Article X added", "PR merged by the Architect"], verify: true },
      ],
    },
    {
      id: "B6", name: "Jira and acli", summary: "Atlassian CLI web login, Jira groups/fields/workflows, GitHub for Atlassian.",
      steps: [
        { id: "b6.acli", kind: "terminal", title: "Atlassian CLI login", detail: "acli covers Jira (the official reference has no Confluence commands). Sign in with the browser: acli jira auth login --web, then pick the site. Never the --token form. Each acli version is supported for 6 months: keep it updated.",
          commands: [...acliInstall(c.platform, c.arch), "acli jira auth login --web", "acli jira auth status"],
          urls: [u("Install acli", "https://developer.atlassian.com/cloud/acli/guides/install-acli/")], action: "Open terminal: acli jira auth login --web", verify: true },
        { id: "b6.hc6", kind: "human", hc: "HC-6", title: "Groups, fields and workflows", detail: "Jira admin, in the browser: groups architects/developers/testers; company-managed project; fields; epic workflow with Approve design restricted to architects; story workflow with Ready for Dev restricted to testers (G2).",
          urls: keep([u("Groups", "https://admin.atlassian.com/"), u("Custom fields", jira ? `${jira}/secure/admin/ViewCustomFields.jspa` : ""), u("Project settings", jira && c.jiraKey ? `${jira}/plugins/servlet/project-config/${c.jiraKey}/summary` : "")]),
          checklist: ["Groups match the GitHub teams", "Fields: Design page, Approved design version, Acceptance criteria, Story type, Schema change, Persona, Test level, AC id, Testability confirmed",
            "Epic: Backlog > Design Review > Approve design (architects only, sets Approved design version) > Design Approved", "Story: Backlog > Ready for Dev (testers only, Testability confirmed, label ai-ready) > In Build > Code Review > QA > Done",
            "No Jira automation calls GitHub and no PAT in any rule"], verify: true },
        { id: "b6.app", kind: "human", title: "GitHub for Atlassian", detail: "Jira > Apps > Explore more apps > GitHub for Atlassian > Get app; a Jira site admin and a GitHub org owner connect the org. Branches feature/<KEY>-<slug> and PR titles \"<KEY> ...\" then link to the work item.",
          urls: keep([u("Jira apps", jira ? `${jira}/jira/marketplace` : "https://marketplace.atlassian.com/"), u("Org installed apps", `${org}/settings/installations`)]),
          checklist: ["App installed in Jira", "GitHub org connected", "A test branch with an uppercase key shows in the work item's Development panel"], verify: true },
        { id: "b6.config", kind: "check", title: "Jira field ids", detail: ".specify/extensions/jira/jira-config.json (field ids for Design page and Approved design version), built once by arch-jira-push and committed; design-gate reads it on the runner.", verify: true },
      ],
    },
    {
      id: "B7", name: "Confluence and MCP sign-ins", summary: "Approved page status, edit restriction for architects, Lucid; Atlassian, Lucid and Fireflies MCP via /mcp.",
      steps: [
        { id: "b7.space", kind: "human", hc: "HC-7", title: "Design space and Approved status", detail: "A space admin adds Approved as a suggested content status. Confluence cannot limit status changes to a group, so restrict edit of approved design pages to the architects group; the circuit checks who set Approved from the page history.",
          urls: keep([u("Space settings", jira && c.spaceKey ? `${jira}/wiki/spaces/${c.spaceKey}/settings` : ""), u("Lucid for Confluence", "https://marketplace.atlassian.com/search?query=lucid")]),
          checklist: ["Space exists (confluence.space_key)", "Approved is a suggested content status", "Approved design pages: edit restricted to architects", "Lucid for Confluence installed"], verify: true },
        { id: "b7.mcp", kind: "human", title: "MCP sign-ins (Atlassian, Lucid, Fireflies)", detail: "Each person, in an interactive Claude session: /mcp and sign in to atlassian (Rovo MCP, OAuth). Architects also sign in to lucid and fireflies. claude -p cannot run the OAuth flow, so this happens interactively first. No API-token auth.",
          urls: [u("Atlassian Rovo MCP", "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/"), u("Fireflies MCP", "https://docs.fireflies.ai/getting-started/mcp-configuration")],
          action: "Open Claude: /mcp", checklist: ["atlassian signed in", "lucid signed in (Architects)", "fireflies signed in (Architects)"], verify: true },
      ],
    },
    {
      id: "B8", name: "Slack and the review room", summary: "Gate channels, #review-room, Claude Slack connector, GitHub app for Slack; no webhooks.",
      steps: [
        { id: "b8.hc8", kind: "human", hc: "HC-8", title: "Slack workspace", detail: "A Slack admin approves the Claude Slack connector (claude.ai > Connectors > Slack), installs the GitHub app for Slack, and invites CodeRabbit and Claude to the review room. No incoming webhook, no bot token.",
          urls: [u("Slack MCP server", "https://docs.slack.dev/ai/slack-mcp-server"), u("Claude connectors", "https://claude.ai/settings/connectors")],
          commands: [`/github subscribe ${c.owner || "<org>"}/${c.repo || "<repo>"} deployments    # in #arch-gate`, `/github subscribe ${c.owner || "<org>"}/${c.repo || "<repo>"} pulls    # in #dev-gate`],
          checklist: ["Channels #arch-gate, #dev-gate, #qa-gate, #review-room exist", "Claude Slack connector approved for the workspace", "GitHub app for Slack subscribed", "CodeRabbit and Claude invited to #review-room"], verify: true },
        { id: "b8.signin", kind: "human", title: "Slack MCP sign-in", detail: "Each person (and the circuit runner's service user when transport is claude) signs in to Slack once in an interactive Claude session (/mcp).",
          action: "Open Claude: /mcp", checklist: ["Signed in to Slack in Claude", "A test message posted and read in #review-room"], verify: true },
      ],
    },
    {
      id: "B9", name: "Workflows and CodeRabbit", summary: "The five v3 workflows on pipeline/workflows, actionlint and shellcheck clean, CodeRabbit on this repo.",
      steps: [
        { id: "b9.branch", kind: "run", title: "Branch pipeline/workflows", detail: "git switch -c pipeline/workflows (or switch to it).", action: "Switch branch", verify: true },
        { id: "b9.lint", kind: "check", title: "actionlint and shellcheck", detail: "actionlint on .github/workflows/*.yml (custom runner labels in .github/actionlint.yaml) and shellcheck on scripts/ci/*.sh must be clean. No workflow reads a stored credential.", verify: true },
        { id: "b9.coderabbit", kind: "human", title: "CodeRabbit repository access", detail: "Install the CodeRabbit GitHub App with access to this repository. Its reviews appear as review signals on every PR, and it joins the review room in Slack.",
          urls: [u("Install CodeRabbit", "https://github.com/apps/coderabbitai/installations/new"), u("Org installed apps", `${org}/settings/installations`)], checklist: ["CodeRabbit installed with access to this repository"], verify: true },
        { id: "b9.pr", kind: "human", title: "Workflows PR", detail: "Push pipeline/workflows and open the PR; the Architect merges it (CODEOWNERS covers .github/).",
          urls: [u("Actions", `${gh}/actions`), u("Pull requests", `${gh}/pulls`)], checklist: ["pr-checks, design-gate, persona-gates, fix-router, deploy-prod visible in Actions", "Self-hosted jobs ran on circuit for a same-repo test PR", "CodeRabbit commented on the PR", "Merged by the Architect"], verify: true },
      ],
    },
    {
      id: "B10", name: "Protect main and production", summary: "Rulesets (HC-9) and production reviewers.",
      steps: [
        { id: "b10.rulesets", kind: "run", hc: "HC-9", title: "Rulesets for main", detail: "circuit-main-gates (PRs, code owners, required checks guard static code-analyzer qa design-gate gate/*) and circuit-merge-architects-only. You review both payloads before they are created.", action: "Review and create", verify: true },
        { id: "b10.env", kind: "run", title: "Production reviewers", detail: "Environment production: required reviewers = team architects, prevent self-review, deployments from main only. deploy-prod runs on circuit-release.", action: "Protect environment", verify: true },
      ],
    },
    {
      id: "B11", name: "Persona workstations", summary: "Every person: this extension, the plugin, their logins and MCP sign-ins.",
      steps: [
        { id: "b11.people", kind: "human", title: "Each person connects", detail: "Each person installs this extension and the plugin, runs scripts/setup-persona.sh, and checks Connections: GitHub, Claude, sf, acli, Atlassian MCP, Fireflies MCP (Architects), Slack MCP, runner online.",
          urls: [u("Team members", `${org}/teams`)], commands: ["./scripts/setup-persona.sh architect|developer|tester"],
          checklist: ["Architects connected", "Developers connected", "Testers connected", "Each ran a first command"], verify: true },
      ],
    },
    {
      id: "B12", name: "Dry run", summary: "One made-up feature through every step, every persona, every app (HC-10).",
      steps: [
        { id: "b12.vars", kind: "run", title: "Dry-run settings", detail: "DEPLOY_ENVIRONMENT=production-dryrun (an environment whose CIRCUIT_RELEASE_ALIAS is the QA alias) and FIX_ROUTER_DRY_RUN=false. The person also signs the release runner in to QA for the dry run, and out afterwards.", action: "Set dry-run variables", verify: true },
        { id: "b12.hc10", kind: "human", hc: "HC-10", title: "Run the circuit end to end", detail: "One made-up feature (Jira label dryrun) through the v3 flow with people at every gate.",
          urls: [u("Pull requests", `${gh}/pulls`), u("Actions", `${gh}/actions`)],
          checklist: ["Source added; Confluence design page with Decisions and Org snapshot", "G1 by an architect at version N", "Epic, Story 00 and stories with Approved design version N; a second push creates nothing",
            "Test cases per AC in Jira; G2", "Start story creates feature/<KEY>-<slug> and a draft PR", "Tester adds tests to the PR; G3/G4 by the right teams",
            "Removing a // TC: reference fails static", "Re-approving the design at N+1 fails design-gate", "A forced failure gives needs-fix, then needs-human after 3 attempts",
            "A blocked AI-tester case gives needs-qa", "Review room thread and verdict on the PR", "Merge is architect-only; deploy waits for approval and runs on circuit-release"], verify: true },
        { id: "b12.cleanup", kind: "run", title: "Clean up", detail: "Removes DEPLOY_ENVIRONMENT so deploys target production again. Close dry-run issues and delete branches yourself; keep the PRs as evidence.", action: "Reset variables", verify: true },
      ],
    },
    {
      id: "B13", name: "Go live", summary: "One small real feature; retro per persona; mark the bootstrap COMPLETE.",
      steps: [
        { id: "b13.live", kind: "human", title: "First real feature", detail: "One small real feature. Claude only watches and reports; people act at every gate. Then a retro per persona.",
          checklist: ["Feature delivered through every gate", "Retro notes folded into constitution, CLAUDE.md, .coderabbit.yaml and test conventions"], verify: true },
      ],
    },
  ];
}

export const PHASE_IDS = ["B0", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12", "B13"];

/** Verified vendor MCP URLs used to replace VERIFY placeholders in persona configs (by server name). */
export const MCP_URLS: Record<string, string> = {
  atlassian: "https://mcp.atlassian.com/v2/mcp",
  github: "https://api.githubcopilot.com/mcp/",
  lucid: "https://mcp.lucid.app/mcp",
  fireflies: "https://api.fireflies.ai/mcp",
  slack: "https://mcp.slack.com/mcp",
};

/** Replace "VERIFY: ..." url placeholders. Returns the new JSON text and the names changed. */
export function fillMcpUrls(jsonText: string): { text: string; changed: string[]; unknown: string[] } {
  const cfg = JSON.parse(jsonText);
  const changed: string[] = [];
  const unknown: string[] = [];
  for (const [name, def] of Object.entries<any>(cfg.mcpServers ?? {})) {
    if (!def || typeof def.url !== "string" || !/^VERIFY/i.test(def.url)) continue;
    if (MCP_URLS[name]) { def.url = MCP_URLS[name]; def.type = def.type || "http"; changed.push(name); } else unknown.push(name);
  }
  return { text: changed.length ? JSON.stringify(cfg, null, 2) + "\n" : jsonText, changed, unknown };
}
