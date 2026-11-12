// build.config.yml (v3) as a form: read fields, write them back keeping comments and layout. Never holds secrets:
// every connection is a login.
// No vscode import.
import * as YAML from "yaml";

export type FieldType = "text" | "url" | "number" | "bool" | "select" | "people";
export interface ConfigField {
  key: string;           // dotted path, e.g. "jira.site"
  label: string;
  type: FieldType;
  options?: string[];
  hint?: string;
}

export const CONFIG_FIELDS: ConfigField[] = [
  { key: "github.org", label: "GitHub organisation", type: "text" },
  { key: "github.repo", label: "Repository", type: "text" },
  { key: "github.default_branch", label: "Default branch", type: "text" },
  { key: "github.visibility", label: "Visibility", type: "select", options: ["private", "public"], hint: "private: the circuit uses self-hosted runners" },
  { key: "people.architects", label: "Architects", type: "people", hint: "One per line: GitHub login, Atlassian email, Slack handle" },
  { key: "people.developers", label: "Developers", type: "people", hint: "One per line: GitHub login, Atlassian email, Slack handle" },
  { key: "people.testers", label: "Testers", type: "people", hint: "One per line: GitHub login, Atlassian email, Slack handle" },
  { key: "runners.circuit.name", label: "Circuit runner name", type: "text", hint: "PR checks with logins (labels self-hosted, circuit)" },
  { key: "runners.circuit.os", label: "Circuit runner OS", type: "select", options: ["linux", "macos", "windows"] },
  { key: "runners.release.name", label: "Release runner name", type: "text", hint: "deploy-prod only (labels self-hosted, circuit-release)" },
  { key: "runners.release.os", label: "Release runner OS", type: "select", options: ["linux", "macos", "windows"] },
  { key: "jira.site", label: "Jira site", type: "url", hint: "https://<site>.atlassian.net" },
  { key: "jira.project_key", label: "Jira project key", type: "text" },
  { key: "jira.test_tool", label: "Jira test tool", type: "select", options: ["none", "xray", "zephyr"] },
  { key: "jira.design_pending_statuses", label: "Design pending statuses", type: "text", hint: "Epic statuses that mean the design is not approved" },
  { key: "confluence.space_key", label: "Confluence space key", type: "text" },
  { key: "confluence.architects_group", label: "Architects group", type: "text", hint: "Only this group edits design pages / sets them to Approved" },
  { key: "salesforce.dev_alias", label: "DEV org alias", type: "text", hint: "sf CLI alias; any connected org" },
  { key: "salesforce.qa_alias", label: "QA org alias", type: "text" },
  { key: "salesforce.prod_alias", label: "Production alias", type: "text", hint: "The org the project names as production: AI never touches it" },
  { key: "salesforce.api_version", label: "API version", type: "text" },
  { key: "slack.workspace", label: "Slack workspace", type: "text" },
  { key: "slack.channels.arch", label: "Architect channel", type: "text" },
  { key: "slack.channels.dev", label: "Developer channel", type: "text" },
  { key: "slack.channels.qa", label: "Tester channel", type: "text" },
  { key: "slack.channels.review", label: "Review room channel", type: "text" },
  { key: "slack.transport", label: "Slack notices", type: "select", options: ["claude", "github-app", "off"] },
  { key: "ai.max_attempts", label: "Max AI fix attempts", type: "number" },
  { key: "ai.sf_ai_tester_in_ci", label: "SF AI Tester in CI", type: "bool" },
  { key: "ai.sf_ai_tester_ref", label: "SF AI Tester commit", type: "text" },
  { key: "ai.sf_ai_tester_mode", label: "SF AI Tester mode", type: "select", options: ["manual", "automation", "both"] },
];

export interface Person { gh: string; atlassian: string; slack: string }

export interface RunnerConfig { name: string; os: string; labels: string[] }

export interface BuildConfig {
  org: string;
  repo: string;
  defaultBranch: string;
  visibility: string;
  people: Record<"architects" | "developers" | "testers", Person[]>;
  runners: { circuit: RunnerConfig; release: RunnerConfig };
  jiraSite: string;
  jiraKey: string;
  designPendingStatuses: string;
  spaceKey: string;
  architectsGroup: string;
  devAlias: string;
  qaAlias: string;
  prodAlias: string;
  channels: { arch: string; dev: string; qa: string; review: string };
  slackTransport: string;
  maxAttempts: number;
  testerInCi: boolean;
  testerRef: string;
  testerMode: string;
}

const get = (o: any, key: string) => key.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);

/** Placeholder values the template ships with count as empty. */
export function isPlaceholder(v: unknown): boolean {
  const s = String(v ?? "").trim();
  return !s || /<[^>]+>/.test(s);
}

export function peopleToText(list: unknown): string {
  return (Array.isArray(list) ? list : []).filter((p: any) => p && (p.gh || p.atlassian || p.slack))
    .map((p: any) => [p.gh ?? "", p.atlassian ?? "", p.slack ?? ""].join(", ")).join("\n");
}

export function textToPeople(text: string): Person[] {
  return String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [gh = "", atlassian = "", slack = ""] = l.split(/\s*,\s*/);
    return { gh: gh.replace(/^@/, ""), atlassian, slack: slack.replace(/^@/, "") };
  });
}

/** Form values (strings) for the webview. */
export function readForm(text: string): Record<string, string> {
  const data = YAML.parse(text) ?? {};
  const out: Record<string, string> = {};
  for (const f of CONFIG_FIELDS) {
    const v = get(data, f.key);
    out[f.key] = f.type === "people" ? peopleToText(v) : v == null ? "" : String(v);
  }
  return out;
}

export function readConfig(text: string): BuildConfig {
  const d = YAML.parse(text) ?? {};
  const str = (k: string, def = "") => { const v = get(d, k); return v == null || String(v).trim() === "" ? def : String(v).trim(); };
  const people = (k: string) => (Array.isArray(get(d, `people.${k}`)) ? get(d, `people.${k}`) : [])
    .filter((p: any) => p && String(p.gh ?? "").trim())
    .map((p: any) => ({ gh: String(p.gh).trim(), atlassian: String(p.atlassian ?? ""), slack: String(p.slack ?? "") }));
  const runner = (k: "circuit" | "release", label: string): RunnerConfig => {
    const labels = get(d, `runners.${k}.labels`);
    return { name: str(`runners.${k}.name`), os: str(`runners.${k}.os`, "linux"), labels: Array.isArray(labels) && labels.length ? labels.map(String) : [label] };
  };
  return {
    org: str("github.org"), repo: str("github.repo"), defaultBranch: str("github.default_branch", "main"), visibility: str("github.visibility", "private"),
    people: { architects: people("architects"), developers: people("developers"), testers: people("testers") },
    runners: { circuit: runner("circuit", "circuit"), release: runner("release", "circuit-release") },
    jiraSite: str("jira.site"), jiraKey: str("jira.project_key"), designPendingStatuses: str("jira.design_pending_statuses", "Backlog,Design Review"),
    spaceKey: str("confluence.space_key"), architectsGroup: str("confluence.architects_group", "architects"),
    devAlias: str("salesforce.dev_alias", "dev"), qaAlias: str("salesforce.qa_alias", "qa"), prodAlias: str("salesforce.prod_alias", "prod"),
    channels: { arch: str("slack.channels.arch", "arch-gate"), dev: str("slack.channels.dev", "dev-gate"), qa: str("slack.channels.qa", "qa-gate"), review: str("slack.channels.review", "review-room") },
    slackTransport: str("slack.transport", "claude"),
    maxAttempts: Number(get(d, "ai.max_attempts") ?? 3) || 3,
    testerInCi: get(d, "ai.sf_ai_tester_in_ci") === true || String(get(d, "ai.sf_ai_tester_in_ci")) === "true",
    testerRef: str("ai.sf_ai_tester_ref"), testerMode: str("ai.sf_ai_tester_mode", "manual"),
  };
}

/** Values that look like credentials: refused, because build.config.yml is committed. */
export function looksLikeSecret(v: string): boolean {
  const s = v.trim();
  return /^(ghp_|gho_|ghu_|ghs_|github_pat_|xox[abposr]-|sk-ant-|sk-|ATATT|AKIA|eyJ[\w-]{10,}\.)/.test(s)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)
    || /^https:\/\/hooks\.slack\.com\//.test(s)
    || /[?&](token|key|secret|sig)=/i.test(s);
}

export interface FormError { key: string; message: string }

export function validateForm(values: Record<string, string>): FormError[] {
  const errs: FormError[] = [];
  for (const f of CONFIG_FIELDS) {
    const v = String(values[f.key] ?? "");
    if (!v.trim()) continue;
    for (const part of f.type === "people" ? v.split(/[\n,]/) : [v]) {
      if (looksLikeSecret(part)) { errs.push({ key: f.key, message: "Looks like a secret. The circuit stores no credentials: every connection is a login (gh, sf, acli, claude, MCP OAuth)." }); break; }
    }
    if (f.type === "url" && !isPlaceholder(v) && !/^https:\/\/[\w.-]+(\/.*)?$/.test(v.trim())) errs.push({ key: f.key, message: "Use an https:// URL" });
    if (f.type === "number" && !/^\d+$/.test(v.trim())) errs.push({ key: f.key, message: "Use a whole number" });
    if (f.type === "select" && f.options && !f.options.includes(v.trim())) errs.push({ key: f.key, message: `One of ${f.options.join(", ")}` });
    if (f.type === "people") {
      for (const p of textToPeople(v)) if (p.gh && !/^[A-Za-z0-9-]+$/.test(p.gh)) errs.push({ key: f.key, message: `${p.gh} is not a GitHub login` });
    }
    if (f.key === "github.org" || f.key === "github.repo") if (!/^[\w.-]+$/.test(v.trim())) errs.push({ key: f.key, message: "Letters, digits, '.', '-' and '_' only" });
    if (/(_alias|\.name)$/.test(f.key) && !isPlaceholder(v) && !/^[\w.-]{1,60}$/.test(v.trim())) errs.push({ key: f.key, message: "Letters, digits, '.', '-' and '_' only" });
  }
  const seen = new Map<string, string>();
  for (const k of ["architects", "developers", "testers"]) {
    for (const p of textToPeople(values[`people.${k}`] ?? "")) {
      const login = p.gh.toLowerCase();
      if (!login) continue;
      if (seen.has(login) && seen.get(login) !== k) errs.push({ key: `people.${k}`, message: `${p.gh} is also in ${seen.get(login)}: the persona teams must be disjoint` });
      seen.set(login, k);
    }
  }
  return errs;
}

/** Write form values into the YAML text, keeping comments and untouched keys. */
export function writeForm(text: string, values: Record<string, string>): string {
  const doc = YAML.parseDocument(text);
  for (const f of CONFIG_FIELDS) {
    if (!(f.key in values)) continue;
    const raw = String(values[f.key] ?? "");
    const path = f.key.split(".");
    let v: unknown;
    if (f.type === "people") {
      const list = textToPeople(raw);
      const node = doc.createNode(list.length ? list : [{ gh: "", atlassian: "", slack: "" }], { flow: true });
      doc.setIn(path, node);
      continue;
    }
    if (f.type === "number") v = raw.trim() ? Number(raw.trim()) : null;
    else if (f.type === "bool") v = raw === "true";
    else v = raw.trim();
    const existing = doc.getIn(path, true) as any;
    if (existing && typeof existing === "object" && "value" in existing) {
      if (existing.value === v) continue;
      existing.value = v;
    } else doc.setIn(path, v);
  }
  return doc.toString({ lineWidth: 0 });
}
