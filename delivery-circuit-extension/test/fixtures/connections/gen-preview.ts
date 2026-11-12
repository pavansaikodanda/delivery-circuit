// Regenerates preview/fixtures/connections.connections.*.json and connections.sources.*.json from the real state builders,
// so the fixtures always match PanelState / SourcesState. Placeholder data only (acme-org, example.com).
// Run: npx esbuild test/fixtures/connections/gen-preview.ts --bundle --platform=node --outfile=<tmp>/gen.js && node <tmp>/gen.js
import * as fs from "fs";
import * as path from "path";
import type { DeepLink, Identity, Persona, SourceRef } from "../../../src/core/contracts";
import { baseStatus, type RowId, type RowStatus } from "../../../src/connections/catalog";
import { buildPanelState, buildProjectInfo } from "../../../src/connections/panelState";
import { buildSourcesState, type FirefliesMeeting } from "../../../src/connections/sourcesCore";

const now = new Date("2026-11-11T10:00:00Z");
const s = (id: RowId, p: Partial<RowStatus>, extra: Persona[] = []): RowStatus => ({ ...baseStatus(id, extra), ...p });
const repo = "https://github.com/acme-org/acme-shipping";
const org = "https://acme-demo.my.salesforce.com";
const site = "https://acme.atlassian.net";

const statuses: RowStatus[] = [
  s("github", { state: "connected", account: "demo-architect", detail: "Signed in · acme-org/acme-shipping · admin" }),
  s("claude", { state: "expiring", account: "demo.user@example.com", expiresAt: "2026-11-30T08:39:17.723Z", detail: "Max plan · Acme" }),
  s("sf-dev", { state: "connected", account: "demo.user@example.com", detail: "alias dev · acme-demo.my.salesforce.com" }),
  s("sf-qa", { state: "disconnected", detail: "No org with alias \"qa\". Connect logs in to https://acme-demo.my.salesforce.com." }),
  s("acli", { state: "connected", account: "demo.user@example.com", detail: "Jira via acli · acme.atlassian.net. Confluence goes through the Atlassian MCP. Keep acli updated: each version is supported for 6 months." }),
  s("slack", { state: "connected", detail: "Member of acme.slack.com · #arch-gate #dev-gate #qa-gate (confirmed 2026-11-02)" }),
  s("lucid", { state: "connected", detail: "Signed in to Lucid (confirmed 2026-11-02)" }),
  s("testing-browsers", { state: "connected", detail: "Chrome for Testing r1246 + Chrome Headless Shell r1246" }),
  s("mcp-atlassian", { state: "connected", account: "atlassian", detail: "Signed in (Claude reports as \"atlassian\" connected)" }),
  s("mcp-github", { state: "unknown", detail: "Configured (architect, developer) (api.githubcopilot.com); sign-in state shows in Claude's /mcp." }),
  s("mcp-salesforce", { state: "connected", detail: "Local server (npx @salesforce/mcp --orgs dev) (architect, developer, tester)" }),
  s("mcp-slack", { state: "disconnected", detail: "Add the Slack connector in claude.ai (Settings > Connectors); it then shows up in Claude Code." }),
  s("mcp-lucid", { state: "error", detail: "URL in .claude/personas/architect.mcp.json is a placeholder; documented URL is https://mcp.lucid.app/mcp. Connect can fix it." }),
  s("mcp-fireflies", { state: "connected", account: "claude.ai Fireflies", detail: "Signed in (Claude reports as \"claude.ai Fireflies\" connected)" }),
  s("code-analyzer", { state: "connected", detail: "plugin-code-analyzer 5.1.0 locally · runs in CI on the self-hosted runner" }),
  s("ai-reviewer", { state: "connected", detail: "reviewer.md · runs in pr-checks on the self-hosted runner (its claude login)" }),
  s("runner", { state: "connected", detail: "circuit: 1 online (1 busy) · circuit-release: 1 online (1 busy)" }),
  s("github-jira", { state: "unknown", detail: "Only GitHub org owners can see installed apps. If a PR shows in a Jira work item's Development panel, it is installed." }),
  s("coderabbit", { state: "connected", account: "coderabbitai[bot]", detail: "Has access to acme-shipping · last review on PR #12 (2026-11-10)" }),
];

const links: Partial<Record<RowId, DeepLink[]>> = {
  github: [{ kind: "github", label: "Repo", target: repo }],
  "sf-dev": [{ kind: "salesforce", label: "Org", target: org }, { kind: "salesforce", label: "Setup", target: `${org}/lightning/setup/SetupOneHome/home` }],
  "sf-qa": [{ kind: "salesforce", label: "Login page", target: org }],
  acli: [{ kind: "jira", label: "Jira ACME", target: `${site}/browse/ACME` }, { kind: "confluence", label: "Space SD", target: `${site}/wiki/spaces/SD` },
    { kind: "url", label: "acli guide", target: "https://developer.atlassian.com/cloud/acli/guides/how-to-get-started/" }],
  runner: [{ kind: "github", label: "Runners", target: `${repo}/settings/actions/runners` }, { kind: "github", label: "Actions", target: `${repo}/actions` }],
  coderabbit: [{ kind: "coderabbit", label: "CodeRabbit", target: "https://app.coderabbit.ai/" }, { kind: "github", label: "PR #12", target: `${repo}/pull/12` }],
};

const project = (admin: boolean) => buildProjectInfo({
  repoUrl: repo, defaultBranch: "main",
  rulesets: admin ? [{ id: 1, name: "main-architects-merge", target: "branch", enforcement: "active" }] : undefined,
  environments: admin ? [{ name: "production", reviewers: ["team architects"], waitMinutes: 0, branchPolicy: true }] : undefined,
  bannedRefs: admin ? [] : [{ file: ".github/workflows/deploy-prod.yml", names: ["SF_JWT_KEY_PROD"] }], workflowCount: 4,
  reminders: [{ label: "acli version support ends", date: "2026-11-25" }], now,
  error: admin ? undefined : "Only repo admins can read rulesets and environments.",
});

const id = (personas: Persona[], active: Persona | null, isAdmin: boolean, login: string): Identity =>
  ({ login, personas, active, isAdmin, owner: "acme-org", repo: "acme-shipping", orgOwned: true });
const architect = id(["architect", "developer"], "architect", true, "demo-architect");

const out = path.resolve(process.cwd(), "preview", "fixtures");
const write = (page: string, name: string, data: unknown) => fs.writeFileSync(path.join(out, `connections.${page}.${name}.json`), JSON.stringify(data, null, 2) + "\n");

// ---------- Connections ----------
write("connections", "architect", buildPanelState({ identity: architect, statuses, links, project: project(true), now }));
write("connections", "developer", buildPanelState({ identity: id(["developer"], "developer", false, "demo-developer"), statuses, links, project: project(false), now }));
write("connections", "tester", buildPanelState({ identity: id(["tester"], "tester", false, "demo-tester"), statuses, links, project: project(false), now }));
write("connections", "signedout", buildPanelState({ identity: null, notice: "Sign in to GitHub to load your personas.",
  statuses: statuses.map((x) => x.id === "github" ? { ...x, state: "disconnected", account: undefined, detail: "Sign in with GitHub (scopes repo, read:org, workflow)." } : x), links, now }));
write("connections", "checking", buildPanelState({ identity: architect, statuses, links, project: project(true), now, checking: ["acli", "runner", "mcp-fireflies"] }));
write("connections", "loading", buildPanelState({ identity: architect, statuses: statuses.map((x) => ({ ...x, state: "checking", detail: "Checking…", account: undefined })), links: {}, now, refreshing: true }));
write("connections", "problems", buildPanelState({
  identity: architect, links, project: buildProjectInfo({ repoUrl: repo, rulesets: [], environments: [{ name: "production", reviewers: [], branchPolicy: false }],
    bannedRefs: [{ file: ".github/workflows/pr-checks.yml", names: ["CLAUDE_CODE_OAUTH_TOKEN"] }], workflowCount: 3, reminders: [], now }), now,
  statuses: statuses.map((x) =>
    x.id === "acli" ? { ...x, state: "disconnected", account: undefined, detail: "The Atlassian CLI (acli) is not installed. Download acli.exe from https://acli.atlassian.com/windows/latest/acli_windows_amd64/acli.exe into a folder on your PATH, then check it with acli --help." }
      : x.id === "runner" ? { ...x, state: "error", detail: "circuit: 1 offline · circuit-release: 1 offline" }
        : x.id === "mcp-fireflies" ? { ...x, state: "disconnected", account: undefined, detail: "Configured as \"fireflies\"; sign in once in Claude with /mcp." }
          : x.id === "github-jira" ? { ...x, state: "disconnected", detail: "Not installed on this GitHub org. A Jira site admin installs GitHub for Atlassian from Jira (Apps > Explore more apps) and a GitHub org owner approves it." }
            : x),
}));

// ---------- Sources ----------
const sources: SourceRef[] = [
  { id: "fireflies:01KACMEKICKOFF", kind: "fireflies", title: "Acme Shipping kick-off", date: "2026-11-10T15:00:00.000Z", usedBy: ["ACME-12"] },
  { id: "upload:3f9a1c2b7d4e", kind: "upload", title: "Acme Shipping tracking notes", date: "2026-11-11T09:12:00.000Z" },
  { id: "upload:a1b2c3d4e5f6", kind: "upload", title: "Returns workshop", date: "2026-11-08T13:30:00.000Z" },
];
const origins = { "upload:3f9a1c2b7d4e": "wispr-flow" as const, "upload:a1b2c3d4e5f6": "file" as const };
const meetings: FirefliesMeeting[] = [
  { id: "02KACMEWEEKLY", title: "Acme Shipping weekly", date: "2026-11-11T08:00:00.000Z", durationMin: 31, organizer: "demo.user@example.com", participants: 4 },
  { id: "01KACMEKICKOFF", title: "Acme Shipping kick-off", date: "2026-11-10T15:00:00.000Z", durationMin: 58, participants: 6 },
];
const wisprMac = { platform: "darwin" as const, candidates: ["/Users/demo/Library/Application Support/Wispr Flow/flow.sqlite"], found: "/Users/demo/Library/Application Support/Wispr Flow/flow.sqlite" };
const watchOn = { folder: "/Users/demo/Transcripts", active: true, last: { title: "Returns workshop", at: "2026-11-11T09:40:00.000Z" } };
const ffReady = { mcpState: "connected" as const, status: "ready" as const, meetings, loadedAt: "2026-11-11T09:58:00.000Z" };

write("sources", "architect", buildSourcesState({ identity: architect, sources, origins, fireflies: ffReady, wispr: wisprMac, watch: watchOn, busy: [] }));
write("sources", "empty", buildSourcesState({ identity: architect, sources: [], origins: {},
  fireflies: { mcpState: "disconnected", mcpDetail: "Configured as \"fireflies\"; sign in once in Claude with /mcp.", status: "idle", meetings: [] },
  wispr: { platform: "win32", candidates: ["C:\\Users\\demo\\AppData\\Roaming\\Wispr Flow\\flow.sqlite", "C:\\Users\\demo\\AppData\\Local\\Wispr Flow\\flow.sqlite"] },
  watch: { active: false }, busy: [] }));
write("sources", "busy", buildSourcesState({ identity: architect, sources, origins, fireflies: { mcpState: "connected", status: "loading", meetings: [] },
  wispr: wisprMac, watch: { active: false }, busy: ["paste", "fireflies", "wispr"] }));
write("sources", "errors", buildSourcesState({ identity: architect, sources, origins, sourcesError: "Could not read .circuit/sources.json (unexpected token).",
  fireflies: { mcpState: "connected", status: "error", meetings: [], error: "No Fireflies tool is available in this Claude session. Check the Fireflies MCP row on the Connections page." },
  wispr: { platform: "linux", candidates: [] }, watch: { folder: "/home/demo/transcripts", active: false, error: "The folder no longer exists." }, busy: [] }));
write("sources", "acting-developer", buildSourcesState({ identity: { ...architect, active: "developer" }, sources, origins, fireflies: ffReady, wispr: wisprMac, watch: watchOn, busy: [] }));
write("sources", "developer", buildSourcesState({ identity: id(["developer"], "developer", false, "demo-developer"), sources, origins,
  fireflies: { mcpState: "unknown", status: "idle", meetings: [] }, wispr: wisprMac, watch: { active: false }, busy: [] }));
console.log("fixtures written to", out);
