// Commands and API payloads the setup wizard runs. No vscode import.
import * as path from "path";
import type { BuildConfig } from "./config";

/** Tools checked in B0 (program, args, display name). Fixed strings only. */
export const TOOLS: { name: string; cmd: string; args: string[]; required: boolean }[] = [
  { name: "git", cmd: "git", args: ["--version"], required: true },
  { name: "gh", cmd: "gh", args: ["--version"], required: true },
  { name: "node", cmd: "node", args: ["--version"], required: true },
  { name: "npm", cmd: "npm", args: ["--version"], required: true },
  { name: "python", cmd: "python", args: ["--version"], required: true },
  { name: "uv", cmd: "uv", args: ["--version"], required: false },
  { name: "sf", cmd: "sf", args: ["--version"], required: true },
  { name: "claude", cmd: "claude", args: ["--version"], required: true },
  { name: "openssl", cmd: "openssl", args: ["version"], required: true },
  { name: "jq", cmd: "jq", args: ["--version"], required: false },
  { name: "actionlint", cmd: "actionlint", args: ["--version"], required: false },
  { name: "specify", cmd: "specify", args: ["--version"], required: true },
];

/** First version-looking token of a --version output. */
export function versionOf(out: string): string | undefined {
  const m = out.match(/(\d+\.\d+(?:\.\d+)?(?:[-.][\w.]+)?)/);
  return m?.[1];
}

/** Labels from the bootstrap (B1), plus ai-ready (G2 evidence on PRs). */
export const LABELS: { name: string; color: string; description: string }[] = [
  { name: "sdd", color: "5319e7", description: "Spec-driven delivery" },
  { name: "needs-clarification", color: "fbca04", description: "Spec has open questions" },
  { name: "plan-review", color: "c5def5", description: "AI plan waiting for review" },
  { name: "plan-approved", color: "0e8a16", description: "G3: Developer approved the AI plan" },
  { name: "testplan-approved", color: "0e8a16", description: "G4: Tester approved the AI test plan" },
  { name: "ai-ready", color: "0e8a16", description: "G2: Tester confirmed testability" },
  { name: "ai-generated", color: "bfd4f2", description: "Changes written by Claude" },
  { name: "ai-attempt-1", color: "ededed", description: "AI fix loop attempt 1" },
  { name: "ai-attempt-2", color: "ededed", description: "AI fix loop attempt 2" },
  { name: "ai-attempt-3", color: "ededed", description: "AI fix loop attempt 3" },
  { name: "needs-human", color: "d93f0b", description: "AI stopped; a person takes over" },
  { name: "needs-qa", color: "d93f0b", description: "AI tester blocked; QA takes over" },
];

/** Repository variables (B1) from build.config.yml. */
export function variablesFor(c: BuildConfig): { name: string; value: string }[] {
  // Trial and developer orgs log in at login.salesforce.com; real sandboxes at test.salesforce.com.
  const devHost = (() => { try { return new URL(c.devUrl).hostname; } catch { return ""; } })();
  const sandbox = /\.sandbox\.my\.salesforce\.com$|--\w+\.(sandbox\.)?my\.salesforce\.com$/.test(devHost) || !devHost
    ? "https://test.salesforce.com" : "https://login.salesforce.com";
  const out = [
    { name: "MAX_AI_ATTEMPTS", value: String(c.maxAttempts || 3) },
    { name: "SF_INSTANCE_URL_SANDBOX", value: sandbox },
    { name: "SF_INSTANCE_URL_PROD", value: "https://login.salesforce.com" },
    { name: "SF_AI_TESTER_IN_CI", value: c.testerInCi ? "true" : "false" },
    { name: "SF_AI_TESTER_MODE", value: c.testerMode || "manual" },
  ];
  if (c.testerRef && /^[0-9a-f]{7,40}$/i.test(c.testerRef)) out.push({ name: "SF_AI_TESTER_REF", value: c.testerRef });
  return out;
}

/** Secrets the circuit needs, per scope. Never ANTHROPIC_API_KEY. */
export const SECRETS = {
  b1: ["APP_ID", "APP_PRIVATE_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  b2: ["SF_CLIENT_ID_DEV", "SF_USERNAME_DEV", "SF_JWT_KEY_DEV", "SF_CLIENT_ID_QA", "SF_USERNAME_QA", "SF_JWT_KEY_QA"],
  prod: ["SF_CLIENT_ID_PROD", "SF_USERNAME_PROD", "SF_JWT_KEY_PROD"],
  b5: ["JIRA_API_TOKEN", "JIRA_BASE_URL", "JIRA_EMAIL"],
  b7: ["SLACK_WEBHOOK_ARCH", "SLACK_WEBHOOK_DEV", "SLACK_WEBHOOK_QA"],
} as const;

export const FORBIDDEN_SECRETS = ["ANTHROPIC_API_KEY"];

/** Secrets whose value is a file (private keys): picked from disk rather than typed. */
export const FILE_SECRETS = new Set(["APP_PRIVATE_KEY", "SF_JWT_KEY_DEV", "SF_JWT_KEY_QA", "SF_JWT_KEY_PROD"]);

export function secretNameOk(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name) && !FORBIDDEN_SECRETS.includes(name) && !name.startsWith("GITHUB_");
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
    const m = l.match(/^(ADD|UPDATE|SKIP|WARN|MERGE|APPEND)\s+(.*)$/);
    if (!m) { r.other.push(l); continue; }
    const k = m[1] === "ADD" ? "add" : m[1] === "UPDATE" || m[1] === "MERGE" || m[1] === "APPEND" ? "update" : m[1] === "SKIP" ? "skip" : "warn";
    r[k].push(m[2]);
  }
  return r;
}

/** Ruleset payloads (B9) from the plugin templates with the architects team id filled in. */
export function rulesetWithTeam(template: string, teamId: number): any {
  return JSON.parse(template.replace(/"ARCHITECTS_TEAM_ID"/g, String(teamId)).replace(/ARCHITECTS_TEAM_ID/g, String(teamId)));
}
