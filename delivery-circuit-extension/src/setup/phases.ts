// Phases B0-B12 of skills/circuit-bootstrap/SKILL.md as wizard steps. No vscode import.
// Step kinds:
//   check     automatic, read-only check (CLI or API)
//   run       safe automatic step; always confirmed in a modal first
//   secret    set GitHub Actions secrets from a password box or a picked file (never shown, never logged)
//   terminal  opens a terminal running a fixed program with array arguments (interactive tools)
//   human     HUMAN CHECKPOINT: the person does it at the vendor URL; checklist + Verify by API
//   form      edit build.config.yml

export type StepKind = "check" | "run" | "secret" | "terminal" | "human" | "form";

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
  /** button label for run/terminal/secret steps */
  action?: string;
  /** secret names for secret steps; env = environment name for environment secrets */
  secrets?: string[];
  env?: string;
  /** step has an automatic check / verify */
  verify?: boolean;
}

export interface PhaseDef { id: string; name: string; summary: string; steps: StepDef[] }

export interface PhaseCtx {
  owner: string;
  repo: string;
  /** GitHub org from build.config.yml (falls back to owner) */
  org: string;
  devUrl: string;
  qaUrl: string;
  jiraSite: string;
  jiraKey: string;
  spaceKey: string;
}

const u = (label: string, url: string) => ({ label, url });
const sfSetup = (base: string, page: string) => (/^https:\/\//.test(base) ? `${base.replace(/\/$/, "")}/lightning/setup/${page}/home` : "");

export function phases(c: PhaseCtx): PhaseDef[] {
  const gh = `https://github.com/${c.owner}/${c.repo}`;
  const org = `https://github.com/organizations/${c.org}`;
  const jira = /^https:\/\/[\w.-]+\.atlassian\.net/.test(c.jiraSite) ? c.jiraSite.replace(/\/$/, "") : "";
  const keep = (l: { label: string; url: string }[]) => l.filter((x) => /^https:\/\//.test(x.url));
  return [
    {
      id: "B0", name: "Preflight", summary: "Tools, GitHub CLI scopes, installer dry run, build.config.yml.",
      steps: [
        { id: "b0.tools", kind: "check", title: "Tool versions", detail: "git, gh, node, npm, python, uv, sf (+ code-analyzer), claude, openssl, jq, actionlint, specify. Recorded in build-state.md.", verify: true, action: "Record in build-state.md" },
        { id: "b0.gh", kind: "check", title: "GitHub CLI and your access", detail: "gh auth status needs scopes repo, admin:org, workflow; you need to be an org owner or repo admin.", verify: true },
        { id: "b0.dryrun", kind: "run", title: "Installer dry run", detail: "Shows what install.mjs would add, update or skip. Changes nothing.", action: "Run dry run" },
        { id: "b0.config", kind: "form", title: "Fill build.config.yml", detail: "Org, repo, people per team, Jira, Confluence, Salesforce URLs, Slack. No secrets.", verify: true },
        { id: "b0.hc1", kind: "human", hc: "HC-1", title: "Sign in to every service in your browser", detail: "Sign in once so the later screens open directly.",
          urls: keep([u("GitHub", "https://github.com/login"), u("Atlassian", jira || "https://id.atlassian.com/login"), u("DEV sandbox", c.devUrl), u("QA sandbox", c.qaUrl), u("Slack", "https://slack.com/signin")]),
          checklist: ["Signed in to GitHub with an org owner account", "Signed in to Atlassian (Jira and Confluence)", "Signed in to the DEV and QA orgs", "Signed in to Slack"], verify: true },
      ],
    },
    {
      id: "B1", name: "GitHub org and bot", summary: "Teams, labels, GitHub App, secrets, variables, production environment.",
      steps: [
        { id: "b1.teams", kind: "run", title: "Persona teams", detail: "Creates architects, developers, testers (closed), adds the people from build.config.yml, gives each team push on the repo. Teams must be disjoint.", action: "Create teams and members", verify: true },
        { id: "b1.labels", kind: "run", title: "Labels", detail: "sdd, needs-clarification, plan-review, plan-approved, testplan-approved, ai-ready, ai-generated, ai-attempt-1..3, needs-human, needs-qa.", action: "Create missing labels", verify: true },
        { id: "b1.hc2", kind: "human", hc: "HC-2", title: "GitHub App for CI", detail: "Create the App in the browser, install it on this repo only, then store its id and private key below.",
          urls: [u("New GitHub App", `${org}/settings/apps/new`), u("Org installed apps", `${org}/settings/installations`)],
          checklist: ["No webhook", "Repository permissions: Contents RW, Pull requests RW, Issues RW, Actions Read, Commit statuses RW, Metadata Read", "Organization permissions: Members Read", "Workflows: no access", "Private key generated", "Installed on this repository only"], verify: true },
        { id: "b1.app", kind: "secret", title: "App secrets", detail: "APP_ID from the App page; APP_PRIVATE_KEY from the downloaded .pem (deleted afterwards if you agree).", secrets: ["APP_ID", "APP_PRIVATE_KEY"], verify: true },
        { id: "b1.hc3", kind: "human", hc: "HC-3", title: "Claude token for CI (subscription seat)", detail: "On the dedicated CI seat run claude setup-token (1-year token), then store it as CLAUDE_CODE_OAUTH_TOKEN. Never ANTHROPIC_API_KEY.",
          urls: [u("Claude Code authentication docs", "https://code.claude.com/docs/en/authentication")], action: "Open terminal: claude setup-token", secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
          checklist: ["Signed in as the dedicated CI seat", "Token copied from the terminal, not pasted anywhere else"], verify: true },
        { id: "b1.vars", kind: "run", title: "Repository variables", detail: "MAX_AI_ATTEMPTS, SF_INSTANCE_URL_SANDBOX, SF_INSTANCE_URL_PROD, SF_AI_TESTER_IN_CI, SF_AI_TESTER_REF, SF_AI_TESTER_MODE from build.config.yml.", action: "Set variables", verify: true },
        { id: "b1.env", kind: "run", title: "Environment production", detail: "Creates the production environment (reviewers are added in B9).", action: "Create environment", verify: true },
      ],
    },
    {
      id: "B2", name: "Salesforce access", summary: "DEV and QA integration users with JWT; production by a person (HC-5).",
      steps: [
        { id: "b2.orgs", kind: "check", title: "Org aliases dev and qa", detail: "sf org display for both aliases (read-only).", verify: true },
        { id: "b2.keys", kind: "run", title: "Key pairs", detail: "Creates dev.key/dev.crt and qa.key/qa.crt in ~/.sfkeys with openssl (730 days). Existing keys are kept.", action: "Create keys" },
        { id: "b2.hc4", kind: "human", hc: "HC-4", title: "Integration users and External Client Apps (DEV and QA)", detail: "Per sandbox: user ai-dev / ai-qa, permission set, External Client App with JWT and the .crt. You handle licence and MFA prompts.",
          urls: keep([u("DEV users", sfSetup(c.devUrl, "ManageUsers")), u("DEV External Client Apps", sfSetup(c.devUrl, "ManageExternalClientApplication")), u("QA users", sfSetup(c.qaUrl, "ManageUsers")), u("QA External Client Apps", sfSetup(c.qaUrl, "ManageExternalClientApplication"))]),
          checklist: ["ai-dev: API, read, run tests, check-only deploys; nothing else", "ai-qa: deploy, run tests, test-data DML", "External Client App: OAuth, JWT bearer, .crt uploaded, admin-approved users pre-authorised", "Consumer keys copied"], verify: true },
        { id: "b2.secrets", kind: "secret", title: "DEV and QA secrets", detail: "Client ids and usernames typed; JWT keys picked from ~/.sfkeys (deleted afterwards if you agree; keep the .crt).", secrets: ["SF_CLIENT_ID_DEV", "SF_USERNAME_DEV", "SF_JWT_KEY_DEV", "SF_CLIENT_ID_QA", "SF_USERNAME_QA", "SF_JWT_KEY_QA"], verify: true },
        { id: "b2.hc5", kind: "human", hc: "HC-5", title: "Production access (a person only)", detail: "The person with production rights follows docs/prod-access-steps.md and stores the three PROD secrets on the production environment. This extension never logs in to production.",
          urls: [u("Environment secrets", `${gh}/settings/environments`)], secrets: ["SF_CLIENT_ID_PROD", "SF_USERNAME_PROD", "SF_JWT_KEY_PROD"], env: "production",
          checklist: ["Release user with deploy rights only", "External Client App with its own certificate", "Secrets stored on the production environment, not the repo"], verify: true },
      ],
    },
    {
      id: "B3", name: "Repo foundation", summary: "Installer on pipeline/foundation; persona MCP URLs; PR merged by a person.",
      steps: [
        { id: "b3.branch", kind: "run", title: "Branch pipeline/foundation", detail: "git switch -c pipeline/foundation (or switch to it).", action: "Switch branch", verify: true },
        { id: "b3.install", kind: "run", title: "Run the installer", detail: "install.mjs for real: CLAUDE.md, .claude/, CODEOWNERS, PR template, scripts/ci, .coderabbit.yaml, sf-config, workflows. Existing files are skipped.", action: "Install", verify: true },
        { id: "b3.mcp", kind: "run", title: "Persona MCP URLs", detail: "Replaces VERIFY placeholders in .claude/personas/*.mcp.json with the verified vendor URLs (Atlassian v2, Lucid, Fireflies, GitHub, Slack).", action: "Fill URLs", verify: true },
        { id: "b3.pr", kind: "human", title: "Commit, push and merge the foundation PR", detail: "Commit everything except .github/workflows/, push pipeline/foundation, open the PR. A person merges it.",
          urls: [u("Pull requests", `${gh}/pulls`)], checklist: ["Committed without .github/workflows/", "PR opened", "PR merged by a person"], verify: true },
      ],
    },
    {
      id: "B4", name: "Spec Kit", summary: "specify init + spec-kit-sf v2.0.1; deploy skills removed; constitution.",
      steps: [
        { id: "b4.init", kind: "terminal", title: "specify init", detail: "specify init --here --integration claude --integration-options=--no-model-invocation", action: "Open terminal: specify init" },
        { id: "b4.ext", kind: "terminal", title: "spec-kit-sf extension", detail: "specify extension add sf --from the v2.0.1 release archive (confirm the URL in the terminal).", action: "Open terminal: add extension" },
        { id: "b4.skills", kind: "run", title: "Remove deploy skills", detail: "Deletes .claude/skills/speckit-sf-deploy, -hotfix and -pr (the guard blocks them anyway).", action: "Remove", verify: true },
        { id: "b4.check", kind: "check", title: "Spec Kit state", detail: ".specify/, extension sf, sf-config prod: \"none\", constitution present.", verify: true },
        { id: "b4.constitution", kind: "human", title: "Constitution", detail: "An Architect runs /speckit-sf-constitution against dev and appends the house rules as Article X; the Architect reviews and merges the PR.",
          action: "Start Architect session", checklist: ["Constitution generated", "Article X added", "PR merged by the Architect"], verify: true },
      ],
    },
    {
      id: "B5", name: "Jira", summary: "Service account, groups, fields, workflow, automation rules, GitHub for Jira.",
      steps: [
        { id: "b5.hc6", kind: "human", hc: "HC-6", title: "Jira service account token", detail: "Create the API token for delivery-bot and store it with the site URL and the bot email.",
          urls: [u("Atlassian API tokens", "https://id.atlassian.com/manage-profile/security/api-tokens")], secrets: ["JIRA_API_TOKEN", "JIRA_BASE_URL", "JIRA_EMAIL"],
          checklist: ["Token created while signed in as the service account", "Service account has project access"], verify: true },
        { id: "b5.setup", kind: "human", title: "Groups, project, fields, workflow", detail: "Groups architects/developers/testers; company-managed project; custom fields; workflow with restricted transitions (Design Approved: architects; Ready for Dev: testers + Testability confirmed).",
          urls: keep([u("Groups", "https://admin.atlassian.com/"), u("Custom fields", jira ? `${jira}/secure/admin/ViewCustomFields.jspa` : ""), u("Project settings", jira && c.jiraKey ? `${jira}/plugins/servlet/project-config/${c.jiraKey}/summary` : "")]),
          checklist: ["Fields: Spec file, Feature, Story type, Schema change, Persona, Test level, AC id, Testability confirmed, Acceptance criteria", "Statuses Backlog to Done in order", "Design Review to Design Approved: architects only", "Design Approved to Ready for Dev: testers only"], verify: true },
        { id: "b5.hc7", kind: "human", hc: "HC-7", title: "Automation rules A and B", detail: "Rule A posts repository_dispatch with the key only; the fine-grained PAT goes into its header, typed by you. Rule B syncs statuses from the bot's comments.",
          urls: keep([u("Jira automation", jira ? `${jira}/jira/settings/automation` : ""), u("New fine-grained PAT", "https://github.com/settings/personal-access-tokens/new")]),
          checklist: ["Rule A: trigger Ready for Dev, conditions ai-ready + Testability + blockers Done", "Rule A: POST /repos/<org>/<repo>/dispatches with {event_type: jira-ready, client_payload: {key}}", "Rule A: then transition to Plan Review", "Rule B rows for every bot comment"], verify: true },
        { id: "b5.app", kind: "human", title: "GitHub for Jira", detail: "Install the GitHub for Jira app and connect the organisation.",
          urls: [u("GitHub for Jira", "https://github.com/apps/jira")], checklist: ["App installed on the org", "Org connected in Jira"], verify: true },
        { id: "b5.discover", kind: "terminal", title: "Discover Jira ids", detail: "jira-sync.mjs discover writes .specify/extensions/jira/jira-config.json (your Jira credentials are passed through the environment).", action: "Open terminal: discover" },
      ],
    },
    {
      id: "B6", name: "Confluence, Lucid, Fireflies", summary: "Design space, Lucid for Confluence, Architect MCP sign-ins.",
      steps: [
        { id: "b6.space", kind: "check", title: "Confluence space", detail: "The space from build.config.yml exists (REST with your Atlassian token).", verify: true },
        { id: "b6.hc", kind: "human", title: "Lucid and Fireflies for the Architect", detail: "Install Lucid for Confluence; the Architect signs in to the Lucid and Fireflies MCP servers once with /mcp.",
          urls: [u("Lucid for Confluence", "https://marketplace.atlassian.com/search?query=lucid"), u("Lucid MCP", "https://help.lucid.co/hc/en-us/articles/42578801807508"), u("Fireflies MCP", "https://docs.fireflies.ai/getting-started/mcp-configuration")],
          checklist: ["Only architects can set pages to Approved", "Lucid for Confluence installed", "Architect signed in to Lucid and Fireflies MCP"], verify: true },
      ],
    },
    {
      id: "B7", name: "Slack", summary: "Gate channels and one incoming webhook per channel.",
      steps: [
        { id: "b7.hc", kind: "human", title: "Slack app Delivery Gates", detail: "Channels #arch-gate, #dev-gate, #qa-gate; one Slack app with an incoming webhook per channel. Paste each URL into the password box; it goes straight to GitHub.",
          urls: [u("Slack apps", "https://api.slack.com/apps")], secrets: ["SLACK_WEBHOOK_ARCH", "SLACK_WEBHOOK_DEV", "SLACK_WEBHOOK_QA"],
          checklist: ["Three channels created", "App Delivery Gates created", "Incoming webhooks on, one per channel"], verify: true },
      ],
    },
    {
      id: "B8", name: "Workflows and CodeRabbit", summary: "Workflows on pipeline/workflows, actionlint clean, CodeRabbit on this repo.",
      steps: [
        { id: "b8.branch", kind: "run", title: "Branch pipeline/workflows", detail: "git switch -c pipeline/workflows (or switch to it).", action: "Switch branch", verify: true },
        { id: "b8.lint", kind: "check", title: "actionlint", detail: "actionlint on .github/workflows/*.yml must be clean.", verify: true },
        { id: "b8.coderabbit", kind: "human", title: "Install CodeRabbit", detail: "Install the CodeRabbit GitHub App on this repository only. Its reviews appear as review signals on every PR.",
          urls: [u("Install CodeRabbit", "https://github.com/apps/coderabbitai/installations/new")], checklist: ["Installed on this repository only"], verify: true },
        { id: "b8.pr", kind: "human", title: "Workflows PR", detail: "Push pipeline/workflows and open the PR; the Architect merges it (CODEOWNERS covers .github/).",
          urls: [u("Actions", `${gh}/actions`), u("Pull requests", `${gh}/pulls`)], checklist: ["All workflows visible in Actions", "CodeRabbit commented on the PR", "Merged by the Architect"], verify: true },
      ],
    },
    {
      id: "B9", name: "Protect main and production", summary: "Rulesets (HC-8), production reviewers, tag ruleset.",
      steps: [
        { id: "b9.rulesets", kind: "run", hc: "HC-8", title: "Rulesets for main", detail: "circuit-main-gates (PRs, code owners, required checks guard static qa spec-gate gate/*) and circuit-merge-architects-only. You review both payloads before they are created.", action: "Review and create", verify: true },
        { id: "b9.env", kind: "run", title: "Production reviewers", detail: "Environment production: required reviewers = team architects, prevent self-review, deployments from main only.", action: "Protect environment", verify: true },
        { id: "b9.tag", kind: "human", title: "Tag ruleset prod-deployed", detail: "A tag ruleset for prod-deployed with the GitHub App as the only bypass actor.",
          urls: [u("New tag ruleset", `${gh}/settings/rules/new?target=tag`)], checklist: ["Target: tags matching prod-deployed", "Bypass: the circuit GitHub App only"], verify: true },
      ],
    },
    {
      id: "B10", name: "Persona workstations", summary: "Every person: this extension, their connections, MCP sign-ins.",
      steps: [
        { id: "b10.people", kind: "human", title: "Each person connects", detail: "Each person opens Delivery Circuit, connects GitHub, Claude and their tools on the Connections page, and signs in to the MCP servers once with /mcp in a persona terminal.",
          urls: [u("Team members", `${org}/teams`)], checklist: ["Architects connected", "Developers connected", "Testers connected", "Each ran a first command"], verify: true },
      ],
    },
    {
      id: "B11", name: "Dry run", summary: "Whole circuit on a made-up feature with people at every gate (HC-9).",
      steps: [
        { id: "b11.vars", kind: "run", title: "Dry-run settings", detail: "DEPLOY_ENVIRONMENT=production-dryrun (environment holding QA secrets under the PROD names) and AI_LOOP_DRY_RUN=false.", action: "Set dry-run variables", verify: true },
        { id: "b11.hc9", kind: "human", hc: "HC-9", title: "Run the circuit end to end", detail: "Push inputs/transcripts/000-sample-case-escalation.md on intake/sample and take it through every gate.",
          urls: [u("Pull requests", `${gh}/pulls?q=is%3Apr+head%3Aintake%2Fsample`), u("Actions", `${gh}/actions`)],
          checklist: ["spec-gate red until G1 by an architect", "Jira epic, Story 00, stories; second push creates nothing", "Test cases per AC linked in Jira", "Rule A fires only after Story 00 Done and G2", "Draft PR has only PLAN.md and TESTPLAN.md", "Build starts only after both labels by the right teams", "Removing a TC reference fails static", "Forced failure: 3 attempts then needs-human", "Blocked AI-tester case gives needs-qa", "Merge is architect-only; deploy waits for approval"], verify: true },
        { id: "b11.cleanup", kind: "run", title: "Clean up", detail: "Sets DEPLOY_ENVIRONMENT back (removes the variable). Close dry-run issues and delete branches yourself; keep the PRs.", action: "Reset variables", verify: true },
      ],
    },
    {
      id: "B12", name: "Go live", summary: "One small real feature; retro per persona; mark the bootstrap COMPLETE.",
      steps: [
        { id: "b12.live", kind: "human", title: "First real feature", detail: "One small feature with transcripts.source: file. People act at every gate. Then a retro per persona.",
          checklist: ["Feature delivered through every gate", "Retro notes folded into constitution, CLAUDE.md, .coderabbit.yaml"], verify: true },
      ],
    },
  ];
}

export const PHASE_IDS = ["B0", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12"];

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
