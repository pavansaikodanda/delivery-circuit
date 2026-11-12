// Commands, guides and API payloads the setup wizard uses (v3: no stored credentials). No vscode import.
import * as path from "path";
import type { BuildConfig, RunnerConfig } from "./config";

/** Tools checked in B0 (program, args, display name). Fixed strings only. */
export const TOOLS: { name: string; cmd: string; args: string[]; required: boolean }[] = [
  { name: "git", cmd: "git", args: ["--version"], required: true },
  { name: "gh", cmd: "gh", args: ["--version"], required: true },
  { name: "node", cmd: "node", args: ["--version"], required: true },
  { name: "npm", cmd: "npm", args: ["--version"], required: true },
  { name: "python", cmd: "python", args: ["--version"], required: false },
  { name: "uv", cmd: "uv", args: ["--version"], required: false },
  { name: "sf", cmd: "sf", args: ["--version"], required: true },
  { name: "claude", cmd: "claude", args: ["--version"], required: true },
  { name: "acli", cmd: "acli", args: ["--version"], required: true },
  { name: "jq", cmd: "jq", args: ["--version"], required: false },
  { name: "actionlint", cmd: "actionlint", args: ["--version"], required: false },
  { name: "shellcheck", cmd: "shellcheck", args: ["--version"], required: false },
  { name: "specify", cmd: "specify", args: ["--version"], required: false },
];

/** First version-looking token of a --version output. */
export function versionOf(out: string): string | undefined {
  const m = out.match(/(\d+\.\d+(?:\.\d+)?(?:[-.][\w.]+)?)/);
  return m?.[1];
}

/** PR labels of the v3 circuit (B1): the installer's list, the G2 label the gate actions accept, and the review room. */
export const LABELS: { name: string; color: string; description: string }[] = [
  { name: "plan-review", color: "c5def5", description: "Story plan waiting for review" },
  { name: "plan-approved", color: "0e8a16", description: "G3: Developer approved the plan" },
  { name: "testplan-approved", color: "0e8a16", description: "G4: Tester approved the test plan" },
  { name: "ai-ready", color: "0e8a16", description: "G2: Tester confirmed testability" },
  { name: "ai-generated", color: "bfd4f2", description: "Changes written by Claude" },
  { name: "ai-attempt-1", color: "ededed", description: "Fix with AI attempt 1" },
  { name: "ai-attempt-2", color: "ededed", description: "Fix with AI attempt 2" },
  { name: "ai-attempt-3", color: "ededed", description: "Fix with AI attempt 3" },
  { name: "needs-fix", color: "fbca04", description: "A check failed: Fix with AI waits for the Developer" },
  { name: "needs-human", color: "d93f0b", description: "AI attempts used up; a person takes over" },
  { name: "needs-qa", color: "d93f0b", description: "AI tester blocked; the Tester takes over" },
  { name: "review-room", color: "c5def5", description: "Review room thread open in Slack" },
  { name: "review-verdict", color: "0e8a16", description: "Review room verdict copied to the PR" },
];

/** Repository variables (B1) from build.config.yml. No secrets: every value is a name, alias or flag. */
export function variablesFor(c: BuildConfig): { name: string; value: string }[] {
  const out = [
    { name: "MAX_AI_ATTEMPTS", value: String(c.maxAttempts || 3) },
    { name: "CIRCUIT_QA_ALIAS", value: c.qaAlias || "qa" },
    { name: "CIRCUIT_PROD_ALIAS", value: c.prodAlias || "prod" },
    { name: "CIRCUIT_RELEASE_ALIAS", value: c.prodAlias || "prod" },
    { name: "DESIGN_PENDING_STATUSES", value: c.designPendingStatuses || "Backlog,Design Review" },
    { name: "SLACK_CHANNEL_DEV", value: c.channels.dev },
    { name: "SLACK_CHANNEL_QA", value: c.channels.qa },
    { name: "CIRCUIT_SLACK_TRANSPORT", value: c.slackTransport || "claude" },
    { name: "SF_AI_TESTER_IN_CI", value: c.testerInCi ? "true" : "false" },
    { name: "SF_AI_TESTER_MODE", value: c.testerMode || "manual" },
  ];
  if (c.testerRef && /^[0-9a-f]{7,40}$/i.test(c.testerRef)) out.push({ name: "SF_AI_TESTER_REF", value: c.testerRef });
  return out;
}

/**
 * Stored credentials of the v2 circuit. v3 uses none: if any of these is still a repository or environment secret,
 * the wizard reports it so an admin deletes it. ANTHROPIC_API_KEY is never used.
 */
export const STORED_CREDENTIALS = [
  "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "APP_ID", "APP_PRIVATE_KEY",
  "SF_CLIENT_ID_DEV", "SF_USERNAME_DEV", "SF_JWT_KEY_DEV", "SF_CLIENT_ID_QA", "SF_USERNAME_QA", "SF_JWT_KEY_QA",
  "SF_CLIENT_ID_PROD", "SF_USERNAME_PROD", "SF_JWT_KEY_PROD",
  "JIRA_API_TOKEN", "JIRA_BASE_URL", "JIRA_EMAIL", "FIREFLIES_API_KEY",
  "SLACK_WEBHOOK_ARCH", "SLACK_WEBHOOK_DEV", "SLACK_WEBHOOK_QA",
];
/** Kept for callers of the v2 API: the one secret that was always refused. */
export const FORBIDDEN_SECRETS = ["ANTHROPIC_API_KEY"];

/** Secret names (from GitHub's list) that the v3 circuit does not want to exist. */
export function leftoverCredentials(names: string[]): string[] {
  return names.filter((n) => STORED_CREDENTIALS.includes(n) || /^(SF_JWT_|SLACK_WEBHOOK|JIRA_)/.test(n) || /(_TOKEN|_API_KEY|_PRIVATE_KEY)$/.test(n));
}

/** A secret name GitHub would accept (used only to validate names before deleting a leftover). */
export function secretNameOk(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name) && !name.startsWith("GITHUB_");
}

/** Quote one argument for run() on Windows, where it goes through cmd.exe. Refuses characters cmd would expand. */
export function shellArg(arg: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return arg;
  if (/["%!\r\n^]/.test(arg)) throw new Error(`Argument has characters that cannot be passed safely: ${arg}`);
  return /[\s&|<>()]/.test(arg) ? `"${arg}"` : arg;
}

/** node <pluginRoot>/skills/circuit-bootstrap/scripts/install.mjs --repo <root> --org <org> [--project-name X] [--dry-run] */
export function installCommand(p: { pluginRoot: string; root: string; org: string; projectName?: string; dryRun: boolean; platform: NodeJS.Platform }):
  { cmd: string; args: string[]; cwd: string; script: string } {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(p.org)) throw new Error(`"${p.org}" is not a GitHub organisation name`);
  const script = (p.platform === "win32" ? path.win32 : path.posix).join(p.pluginRoot, "skills", "circuit-bootstrap", "scripts", "install.mjs");
  const args = [shellArg(script, p.platform), "--repo", ".", "--org", p.org];
  if (p.projectName && p.projectName.trim()) {
    if (!/^[\w .-]+$/.test(p.projectName)) throw new Error("Project name: letters, digits, spaces, '.', '-' and '_' only");
    args.push("--project-name", shellArg(p.projectName.trim(), p.platform));
  }
  if (p.dryRun) args.push("--dry-run");
  // cwd = repo root and --repo "." so the repo path (often with spaces) is never an argument.
  return { cmd: "node", args, cwd: p.root, script };
}

/** Parse installer output lines ("  ADD    path", "  SKIP   path (...)", "  WARN   ..."). */
export function parseInstallOutput(out: string): { add: string[]; update: string[]; skip: string[]; warn: string[]; other: string[] } {
  const r = { add: [] as string[], update: [] as string[], skip: [] as string[], warn: [] as string[], other: [] as string[] };
  for (const l of out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
    const m = l.match(/^(ADD|UPDATE|SKIP|WARN|MERGE|APPEND|STALE|ERROR)\s+(.*)$/);
    if (!m) { r.other.push(l); continue; }
    const k = m[1] === "ADD" ? "add" : m[1] === "UPDATE" || m[1] === "MERGE" || m[1] === "APPEND" ? "update" : m[1] === "SKIP" ? "skip" : "warn";
    r[k].push(m[1] === "STALE" || m[1] === "ERROR" ? `${m[1]} ${m[2]}` : m[2]);
  }
  return r;
}

/** Ruleset payloads (B10) from the plugin templates with the architects team id filled in. */
export function rulesetWithTeam(template: string, teamId: number): any {
  return JSON.parse(template.replace(/"ARCHITECTS_TEAM_ID"/g, String(teamId)).replace(/ARCHITECTS_TEAM_ID/g, String(teamId)));
}

// ---------- self-hosted runners (B2) ----------

/** The v3 workflows (B9) and the v2 ones that must be gone. */
export const V3_WORKFLOWS = ["pr-checks.yml", "design-gate.yml", "persona-gates.yml", "fix-router.yml", "deploy-prod.yml"];
export const V2_WORKFLOWS = ["claude-plan.yml", "claude-build.yml", "ai-fix-loop.yml", "spec-gate.yml"];

export type RunnerOs = "linux" | "macos" | "windows";
export const runnerOs = (os: string): RunnerOs => (os === "windows" || os === "macos" ? os : "linux");

/**
 * Registration guide for one runner, as copyable commands (no token value: the person gets the token with gh on the
 * runner machine itself and it never passes through the extension).
 */
export function runnerGuide(owner: string, repo: string, r: RunnerConfig, kind: "circuit" | "release"): { title: string; commands: string[]; notes: string[] } {
  const url = `https://github.com/${owner}/${repo}`;
  const labels = (r.labels.length ? r.labels : [kind === "release" ? "circuit-release" : "circuit"]).join(",");
  const name = r.name || (kind === "release" ? "circuit-release-1" : "circuit-1");
  const tokenCmd = `gh api -X POST repos/${owner}/${repo}/actions/runners/registration-token --jq .token`;
  const os = runnerOs(r.os);
  const commands = os === "windows"
    ? [
      "# admin PowerShell, in C:\\actions-runner (runner downloaded from Settings > Actions > Runners > New self-hosted runner)",
      `$t = ${tokenCmd}`,
      `.\\config.cmd --url ${url} --token $t --name ${name} --labels ${labels}`,
      "# answer Y to \"run as service\"; then:",
      "Get-Service \"actions.runner.*\"",
    ]
    : [
      "# in the runner folder (downloaded from Settings > Actions > Runners > New self-hosted runner)",
      `./config.sh --url ${url} --token "$(${tokenCmd})" --name ${name} --labels ${labels}`,
      os === "macos" ? "./svc.sh install && ./svc.sh start" : "sudo ./svc.sh install <service-user> && sudo ./svc.sh start",
      os === "macos" ? "./svc.sh status" : "sudo ./svc.sh status",
    ];
  const notes = [
    "The registration token expires after 1 hour; it is read on the runner machine and never stored.",
    "config cannot add labels to a registered runner: change them in Settings > Actions > Runners > the runner > Labels.",
    kind === "release" ? "This runner holds the one login to the production alias and runs deploy-prod only." : "This runner holds DEV/QA logins only, never production.",
  ];
  return { title: `${kind === "release" ? "Release" : "Circuit"} runner (${os}): labels self-hosted, ${labels}`, commands, notes };
}

/** Logins the runner's service user does once, in a terminal on the runner (HC-3 / HC-5). */
export function runnerLogins(c: Pick<BuildConfig, "devAlias" | "qaAlias" | "prodAlias">, kind: "circuit" | "release"): string[] {
  if (kind === "release") {
    return [`sf org login web --alias ${c.prodAlias || "prod"}    # HC-5: a person, on the release runner only`,
      `bash scripts/ci/runner-check.sh --tools sf,jq,git --sf-plugin sfdx-git-delta --sf ${c.prodAlias || "prod"}`];
  }
  return [
    "gh auth login    # scopes repo, read:org",
    "claude           # sign in with the Claude Team seat; then /mcp > Slack if notices use transport claude",
    "acli jira auth login --web",
    `sf org login web --alias ${c.devAlias || "dev"}    # or: sf org login device --alias ${c.devAlias || "dev"} on a headless machine`,
    `sf org login web --alias ${c.qaAlias || "qa"}`,
    `bash scripts/ci/runner-check.sh --gh --acli --claude --sf ${c.devAlias || "dev"} --sf ${c.qaAlias || "qa"} --not-sf ${c.prodAlias || "prod"}`,
  ];
}

export interface RunnerInfo { name: string; status: string; busy?: boolean; labels: string[] }

/** GET /repos/{o}/{r}/actions/runners -> the runners, with label names. */
export function parseRunners(body: any): RunnerInfo[] {
  return (Array.isArray(body?.runners) ? body.runners : []).map((r: any) => ({
    name: String(r?.name ?? ""), status: String(r?.status ?? "unknown"), busy: !!r?.busy,
    labels: (Array.isArray(r?.labels) ? r.labels : []).map((l: any) => String(l?.name ?? "")).filter(Boolean),
  }));
}

/** Whether a runner carrying every wanted label is online (labels are case-insensitive). */
export function runnerReady(runners: RunnerInfo[], labels: string[]): { ok: boolean; line: string } {
  const want = ["self-hosted", ...labels].map((l) => l.toLowerCase());
  const match = runners.filter((r) => want.every((w) => r.labels.map((l) => l.toLowerCase()).includes(w)));
  const online = match.filter((r) => r.status === "online");
  const tag = `[${want.join(", ")}]`;
  if (online.length) return { ok: true, line: `${tag}: ${online.map((r) => `${r.name} online${r.busy ? " (busy)" : ""}`).join(", ")}` };
  if (match.length) return { ok: false, line: `${tag}: ${match.map((r) => `${r.name} ${r.status}`).join(", ")}` };
  return { ok: false, line: `${tag}: no runner registered with these labels` };
}

// ---------- Atlassian CLI (B6) ----------

/** acli install commands from developer.atlassian.com/cloud/acli (per platform). */
export function acliInstall(platform: NodeJS.Platform, arch = "x64"): string[] {
  if (platform === "win32") {
    const a = arch === "arm64" ? "arm64" : "amd64";
    return [`Invoke-WebRequest -Uri https://acli.atlassian.com/windows/latest/acli_windows_${a}/acli.exe -OutFile acli.exe`,
      "# move acli.exe to a folder on PATH, then:", ".\\acli.exe --help"];
  }
  if (platform === "darwin") return ["brew tap atlassian/homebrew-acli && brew install acli", "acli --help"];
  const a = arch === "arm64" ? "arm64" : "amd64";
  return [`curl -LO https://acli.atlassian.com/linux/latest/acli_linux_${a}/acli && chmod +x acli && sudo mv acli /usr/local/bin/`,
    "# or the apt repo https://acli.atlassian.com/linux/deb (key https://acli.atlassian.com/gpg/public-key.asc)", "acli --help"];
}

/**
 * `acli jira auth status` result. Its output format and signed-out exit code are not documented, so this reads
 * both: a non-zero exit or wording like "not logged in" means signed out.
 */
export function acliStatus(code: number, out: string): { signedIn: boolean; detail: string } {
  const text = out.replace(/\s+/g, " ").trim();
  if (/not (logged|authenticated|signed)|no (active )?(account|session)|unauthori[sz]ed|log ?in first|please (log|sign) ?in/i.test(text)) return { signedIn: false, detail: text.slice(0, 160) };
  if (code !== 0) return { signedIn: false, detail: text.slice(0, 160) || `exit ${code}` };
  const site = text.match(/([\w-]+\.atlassian\.net)/)?.[1];
  return { signedIn: true, detail: site ? `signed in to ${site}` : text.slice(0, 160) || "signed in" };
}

/** Production aliases the guard protects: the configured one plus the fixed names. */
export function prodAliases(prodAlias: string): string[] {
  return [...new Set([prodAlias, "prod", "production", "live"].filter(Boolean).map((x) => x.toLowerCase()))];
}
