// Regenerates preview/fixtures/connections.connections.*.json from the real state builder, so the fixtures always match
// PanelState. Run: npx esbuild test/fixtures/connections/gen-preview.ts --bundle --platform=node --outfile=<tmp>/gen.js && node <tmp>/gen.js
import * as fs from "fs";
import * as path from "path";
import type { ConnectionId, ConnectionStatus, DeepLink, Identity, Persona } from "../../../src/core/contracts";
import { baseStatus } from "../../../src/connections/catalog";
import { buildPanelState, buildProjectInfo } from "../../../src/connections/panelState";

const now = new Date("2026-11-11T10:00:00Z");
const s = (id: ConnectionId, p: Partial<ConnectionStatus>, extra: Persona[] = []): ConnectionStatus => ({ ...baseStatus(id, extra), ...p });
const repo = "https://github.com/acme-org/salesDemoOrg";
const org = "https://acme-demo.my.salesforce.com";

const statuses: ConnectionStatus[] = [
  s("github", { state: "connected", account: "pavansaikodanda", detail: "Signed in · acme-org/salesDemoOrg · admin" }),
  s("claude", { state: "expiring", account: "maintainer@example.com", expiresAt: "2026-11-30T08:39:17.723Z", detail: "Max plan · Conscendo" }),
  s("sf-dev", { state: "connected", account: "demo.user@example.com", detail: "alias dev · acme-demo.my.salesforce.com · trial org (per build.config.yml)" }),
  s("sf-qa", { state: "disconnected", detail: "No org with alias \"qa\". Connect logs in to https://acme-demo.my.salesforce.com." }),
  s("jira", { state: "connected", account: "dev.user@example.com", detail: "Pavan Sai · acme.atlassian.net" }),
  s("confluence", { state: "error", account: "dev.user@example.com", detail: "Confluence is not enabled on acme.atlassian.net." }),
  s("slack", { state: "unknown", detail: "Slack workspace is not set in build.config.yml (slack.workspace)." }),
  s("fireflies", { state: "disconnected", detail: "Optional: transcripts come from files in this repo (build.config.yml). Add a key to index meetings." }),
  s("lucid", { state: "connected", detail: "Signed in to Lucid (confirmed 2026-11-02)" }),
  s("testing-browsers", { state: "connected", detail: "Chrome for Testing r1246 + Chrome Headless Shell r1246" }),
  s("mcp-atlassian", { state: "error", detail: "URL in .claude/personas/architect.mcp.json is a placeholder; documented URL is https://mcp.atlassian.com/v2/mcp. Connect can fix it." }, ["architect", "developer", "tester"]),
  s("mcp-github", { state: "unknown", detail: "Configured (architect, developer, tester) (api.githubcopilot.com); sign-in state shows in Claude's /mcp." }, ["tester"]),
  s("mcp-salesforce", { state: "expiring", detail: "Local server (npx @salesforce/mcp --orgs dev) (architect, developer, tester). @salesforce/mcp reached end of life on 2026-11-02; plan the move to forcedotcom/sf-skills." }),
  s("mcp-slack", { state: "disconnected", detail: "Not in any persona's MCP config (.claude/personas/<persona>.mcp.json)." }),
  s("mcp-lucid", { state: "error", detail: "URL in .claude/personas/architect.mcp.json is a placeholder; documented URL is https://mcp.lucid.app/mcp. Connect can fix it." }),
  s("mcp-fireflies", { state: "disconnected", detail: "Configured; sign in once in Claude with /mcp." }),
  s("coderabbit", { state: "unknown", detail: "Config present · no CodeRabbit review seen yet · no pull requests yet. Install the app on the repo if it is not." }),
  s("code-analyzer", { state: "connected", detail: "plugin-code-analyzer 5.1.0 locally · runs in CI (pr-checks)" }),
  s("ai-reviewer", { state: "disconnected", manageUrl: `${repo}/settings/secrets/actions`, detail: "reviewer.md present · repo secret CLAUDE_CODE_OAUTH_TOKEN is missing." }),
];

const links: Partial<Record<ConnectionId, DeepLink[]>> = {
  github: [{ kind: "github", label: "Repo", target: repo }],
  "sf-dev": [{ kind: "salesforce", label: "Org", target: org }, { kind: "salesforce", label: "Setup", target: `${org}/lightning/setup/SetupOneHome/home` }],
  "sf-qa": [{ kind: "salesforce", label: "Login page", target: org }],
  jira: [{ kind: "jira", label: "Jira ABC", target: "https://acme.atlassian.net/browse/ABC" }],
  confluence: [{ kind: "confluence", label: "Space SD", target: "https://acme.atlassian.net/wiki/spaces/SD" }],
  "mcp-atlassian": [{ kind: "url", label: "Docs", target: "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/" }, { kind: "file", label: "architect.mcp.json", target: ".claude/personas/architect.mcp.json" }],
  coderabbit: [{ kind: "coderabbit", label: "CodeRabbit", target: "https://app.coderabbit.ai/" }, { kind: "github", label: "GitHub App", target: "https://github.com/apps/coderabbitai" }, { kind: "file", label: ".coderabbit.yaml", target: ".coderabbit.yaml" }],
  "code-analyzer": [{ kind: "file", label: "pr-checks.yml", target: ".github/workflows/pr-checks.yml" }],
  "ai-reviewer": [{ kind: "file", label: "reviewer.md", target: ".claude/agents/reviewer.md" }, { kind: "github", label: "Secrets", target: `${repo}/settings/secrets/actions` }],
};

const project = (admin: boolean) => buildProjectInfo({
  needed: ["APP_ID", "APP_PRIVATE_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "JIRA_API_TOKEN", "JIRA_BASE_URL", "JIRA_EMAIL", "SF_CLIENT_ID_DEV", "SF_JWT_KEY_DEV",
    "SF_USERNAME_DEV", "SF_JWT_KEY_PROD", "SLACK_WEBHOOK_ARCH", "SLACK_WEBHOOK_DEV", "SLACK_WEBHOOK_QA"],
  envOf: { SF_JWT_KEY_PROD: "production" }, environments: ["production"],
  repoSecrets: admin ? ["APP_ID", "APP_PRIVATE_KEY", "JIRA_API_TOKEN", "JIRA_BASE_URL", "JIRA_EMAIL", "SF_CLIENT_ID_DEV", "SF_JWT_KEY_DEV", "SF_USERNAME_DEV", "SLACK_WEBHOOK_DEV"] : [],
  envSecrets: admin ? { production: [] } : {},
  reminders: [{ label: "Jira PAT for Rule A", date: "2026-11-25" }, { label: "Salesforce JWT certificates", date: "2027-06-01" }],
  now, repoUrl: repo, error: admin ? undefined : "Only repo admins can see which Actions secrets exist.",
});

const id = (personas: Persona[], active: Persona, isAdmin: boolean, login: string): Identity =>
  ({ login, personas, active, isAdmin, owner: "acme-org", repo: "salesDemoOrg", orgOwned: true });

const out = path.resolve(process.cwd(), "preview", "fixtures");
const write = (name: string, data: unknown) => fs.writeFileSync(path.join(out, `connections.connections.${name}.json`), JSON.stringify(data, null, 2) + "\n");

write("architect", buildPanelState({ identity: id(["architect", "developer"], "architect", true, "pavansaikodanda"), statuses, links, project: project(true), now }));
write("developer", buildPanelState({ identity: id(["developer"], "developer", false, "dev-one"), statuses, links, project: project(false), now,
  notice: undefined }));
write("tester", buildPanelState({ identity: id(["tester"], "tester", false, "qa-one"), statuses, links, project: project(false), now }));
write("signedout", buildPanelState({ identity: null, notice: "Sign in to GitHub to load your personas.", statuses: statuses.map((x) => x.id === "github" ? { ...x, state: "disconnected", account: undefined, detail: "Sign in with GitHub (scopes repo, read:org, workflow)." } : x), links, now }));
console.log("fixtures written to", out);
