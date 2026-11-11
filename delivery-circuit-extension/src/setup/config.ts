// build.config.yml as a form: read fields, write them back keeping comments and layout. Never holds secrets.
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
  { key: "people.architects", label: "Architects", type: "people", hint: "One per line: GitHub login, Atlassian email, Slack handle" },
  { key: "people.developers", label: "Developers", type: "people", hint: "One per line: GitHub login, Atlassian email, Slack handle" },
  { key: "people.testers", label: "Testers", type: "people", hint: "One per line: GitHub login, Atlassian email, Slack handle" },
  { key: "jira.site", label: "Jira site", type: "url", hint: "https://<site>.atlassian.net" },
  { key: "jira.project_key", label: "Jira project key", type: "text" },
  { key: "jira.test_tool", label: "Jira test tool", type: "select", options: ["none", "xray", "zephyr"] },
  { key: "confluence.space_key", label: "Confluence space key", type: "text" },
  { key: "salesforce.dev_sandbox_url", label: "DEV sandbox URL", type: "url" },
  { key: "salesforce.qa_sandbox_url", label: "QA sandbox URL", type: "url" },
  { key: "salesforce.prod_url", label: "Production URL", type: "text", hint: "URL, or none" },
  { key: "salesforce.api_version", label: "API version", type: "text" },
  { key: "slack.workspace", label: "Slack workspace", type: "text" },
  { key: "slack.channels.arch", label: "Architect channel", type: "text" },
  { key: "slack.channels.dev", label: "Developer channel", type: "text" },
  { key: "slack.channels.qa", label: "Tester channel", type: "text" },
  { key: "transcripts.source", label: "Transcript source", type: "select", options: ["file", "fireflies", "both"] },
  { key: "ai.max_attempts", label: "Max AI attempts", type: "number" },
  { key: "ai.sf_ai_tester_in_ci", label: "SF AI Tester in CI", type: "bool" },
  { key: "ai.sf_ai_tester_ref", label: "SF AI Tester commit", type: "text" },
  { key: "ai.sf_ai_tester_mode", label: "SF AI Tester mode", type: "select", options: ["manual", "automation", "both"] },
];

export interface Person { gh: string; atlassian: string; slack: string }

export interface BuildConfig {
  org: string;
  repo: string;
  defaultBranch: string;
  people: Record<"architects" | "developers" | "testers", Person[]>;
  jiraSite: string;
  jiraKey: string;
  spaceKey: string;
  devUrl: string;
  qaUrl: string;
  prodUrl: string;
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
  const people = (k: string) => (Array.isArray(get(d, `people.${k}`)) ? get(d, `people.${k}`) : [])
    .filter((p: any) => p && String(p.gh ?? "").trim())
    .map((p: any) => ({ gh: String(p.gh).trim(), atlassian: String(p.atlassian ?? ""), slack: String(p.slack ?? "") }));
  return {
    org: String(get(d, "github.org") ?? ""), repo: String(get(d, "github.repo") ?? ""), defaultBranch: String(get(d, "github.default_branch") ?? "main"),
    people: { architects: people("architects"), developers: people("developers"), testers: people("testers") },
    jiraSite: String(get(d, "jira.site") ?? ""), jiraKey: String(get(d, "jira.project_key") ?? ""), spaceKey: String(get(d, "confluence.space_key") ?? ""),
    devUrl: String(get(d, "salesforce.dev_sandbox_url") ?? ""), qaUrl: String(get(d, "salesforce.qa_sandbox_url") ?? ""),
    prodUrl: String(get(d, "salesforce.prod_url") ?? ""),
    maxAttempts: Number(get(d, "ai.max_attempts") ?? 3) || 3,
    testerInCi: get(d, "ai.sf_ai_tester_in_ci") === true || String(get(d, "ai.sf_ai_tester_in_ci")) === "true",
    testerRef: String(get(d, "ai.sf_ai_tester_ref") ?? ""), testerMode: String(get(d, "ai.sf_ai_tester_mode") ?? "manual"),
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
      if (looksLikeSecret(part)) { errs.push({ key: f.key, message: "Looks like a secret. Secrets go to GitHub Actions secrets, never into build.config.yml." }); break; }
    }
    if (f.type === "url" && !isPlaceholder(v) && !/^https:\/\/[\w.-]+(\/.*)?$/.test(v.trim())) errs.push({ key: f.key, message: "Use an https:// URL" });
    if (f.type === "number" && !/^\d+$/.test(v.trim())) errs.push({ key: f.key, message: "Use a whole number" });
    if (f.type === "select" && f.options && !f.options.includes(v.trim())) errs.push({ key: f.key, message: `One of ${f.options.join(", ")}` });
    if (f.type === "people") {
      for (const p of textToPeople(v)) if (p.gh && !/^[A-Za-z0-9-]+$/.test(p.gh)) errs.push({ key: f.key, message: `${p.gh} is not a GitHub login` });
    }
    if (f.key === "github.org" || f.key === "github.repo") if (!/^[\w.-]+$/.test(v.trim())) errs.push({ key: f.key, message: "Letters, digits, '.', '-' and '_' only" });
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
