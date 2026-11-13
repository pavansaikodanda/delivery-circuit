// Jira side of the project context: build.config.yml settings, the JQL the extension runs, and the mapping of epics,
// stories and test cases. Pure functions (no vscode import), unit-tested on fixtures.
//
// Conventions (docs/CIRCUIT-V4.md section 2):
//   epic        = one feature; its Design page field (or any Confluence page link on it) names the design page
//   stories     = children of the epic; "Story 00" first; acceptance criteria in a field or an "Acceptance criteria"
//                 heading of the description; people move a story to jira.ready_status ("Ready for Dev")
//   test cases  = issues labelled circuit-test (v3: test-case) or of a Test issue type, linked to a story
import { parse as parseYaml } from "yaml";
import { compareKeys, docText, keyList, PROJECT_KEY_RE } from "./acli";
import type { CircuitConfig, JiraFieldMap, JiraIssue } from "./model";

export const TEST_CASE_LABELS = ["circuit-test", "test-case"];
export const DEFAULT_ENVIRONMENTS = [
  { branch: "sprint/*", environment: "qa" }, { branch: "dev", environment: "dev" }, { branch: "sit", environment: "sit" },
  { branch: "uat", environment: "uat" }, { branch: "main", environment: "production" },
];

// ---------- build.config.yml ----------
/** Value of `key:` inside the top-level `section:` block of a simple YAML file (no YAML library needed). */
export function yamlValue(yaml: string, section: string, key: string): string | undefined {
  const block = yamlBlock(yaml, section);
  if (!block) return undefined;
  const m = new RegExp(`^[ \\t]+${key}:[ \\t]*([^#\\r\\n]*)`, "m").exec(block);
  const v = m?.[1]?.trim().replace(/^["']|["']$/g, "");
  return v ? v : undefined;
}
function yamlBlock(yaml: string, section: string): string | undefined {
  const m = new RegExp(`^${section}:[ \\t]*(?:#.*)?\\r?\\n((?:[ \\t]+.*(?:\\r?\\n|$)|[ \\t]*(?:\\r?\\n))*)`, "m").exec(yaml);
  return m?.[1];
}

export function siteUrl(site: string | undefined): string | undefined {
  const s = (site ?? "").trim().replace(/\/+$/, "");
  if (!s || s.includes("<")) return undefined;
  const url = /^https:\/\//i.test(s) ? s : /^[a-z0-9.-]+$/i.test(s) ? `https://${s.includes(".") ? s : `${s}.atlassian.net`}` : undefined;
  if (!url) return undefined;
  try { return new URL(url).origin; } catch { return undefined; }
}

const FIELD_ID_RE = /^(customfield_\d+|[a-z][A-Za-z0-9_]*)$/;
const BRANCH_RE = /^[A-Za-z0-9._/*-]{1,100}$/;
const ENV_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function parseConfig(yaml: string | undefined): CircuitConfig {
  const y = yaml ?? "";
  const cfg: CircuitConfig = { fields: {}, readyStatus: "Ready for Dev", environments: DEFAULT_ENVIRONMENTS.map((e) => ({ ...e })) };
  const site = siteUrl(yamlValue(y, "jira", "site"));
  if (site) cfg.site = site;
  const pk = yamlValue(y, "jira", "project_key");
  if (pk && PROJECT_KEY_RE.test(pk)) cfg.projectKey = pk;
  const space = yamlValue(y, "confluence", "space_key");
  if (space && /^[A-Za-z0-9~_-]+$/.test(space)) cfg.spaceKey = space;
  const ready = yamlValue(y, "jira", "ready_status");
  if (ready && ready.length < 60) cfg.readyStatus = ready;
  // jira.fields: { design_page: customfield_10050, acceptance_criteria: customfield_10052 }
  const jira = yamlBlock(y, "jira") ?? "";
  const fieldsBlock = /^[ \t]+fields:[ \t]*(\{[^}\r\n]*\}|\r?\n(?:[ \t]{4,}.*(?:\r?\n|$))*)/m.exec(jira)?.[1] ?? "";
  const pick = (name: string): string | undefined => {
    const v = new RegExp(`\\b${name}:[ \\t]*["']?([A-Za-z0-9_]+)`).exec(fieldsBlock)?.[1];
    return v && FIELD_ID_RE.test(v) ? v : undefined;
  };
  const fields: JiraFieldMap = {};
  const dp = pick("design_page"); if (dp) fields.designPage = dp;
  const ac = pick("acceptance_criteria"); if (ac) fields.acceptanceCriteria = ac;
  cfg.fields = fields;
  // environments: [{ branch, environment }] (the same list scripts/ci/env-for-branch.mjs reads)
  try {
    const envs = (parseYaml(y) as any)?.environments;
    if (Array.isArray(envs)) {
      const list = envs.map((e: any) => ({ branch: String(e?.branch ?? ""), environment: String(e?.environment ?? "") }))
        .filter((e) => BRANCH_RE.test(e.branch) && ENV_RE.test(e.environment));
      if (list.length) cfg.environments = list;
    }
  } catch { /* keep the defaults */ }
  return cfg;
}

// ---------- JQL ----------
/** Feature epics of the project: open ones, plus those closed in the last 30 days (release still visible). */
export function epicsJql(projectKey: string): string {
  if (!PROJECT_KEY_RE.test(projectKey)) throw new Error(`Not a Jira project key: ${projectKey}`);
  return `project = ${projectKey} AND issuetype = Epic AND (statusCategory != Done OR updated >= -30d) ORDER BY created ASC`;
}
export function childrenJql(epicKeys: string[]): string | undefined {
  const keys = keyList(epicKeys);
  return keys ? `parent in (${keys}) ORDER BY key ASC` : undefined;
}
export function testCasesJql(projectKey: string): string {
  if (!PROJECT_KEY_RE.test(projectKey)) throw new Error(`Not a Jira project key: ${projectKey}`);
  return `project = ${projectKey} AND labels in (${TEST_CASE_LABELS.map((l) => `"${l}"`).join(", ")}) ORDER BY key ASC`;
}
/** Stories of the open sprint (Scrum boards). Fails on a project without sprints; the caller falls back to epics. */
export function sprintJql(projectKey: string): string {
  if (!PROJECT_KEY_RE.test(projectKey)) throw new Error(`Not a Jira project key: ${projectKey}`);
  return `project = ${projectKey} AND sprint in openSprints() AND issuetype != Epic ORDER BY key ASC`;
}

// ---------- field helpers ----------
const CONFLUENCE_PAGE_RE = /https:\/\/[a-z0-9.-]+\/wiki\/(?:spaces\/[^/\s"')\]]+\/pages\/(\d+)|pages\/viewpage\.action\?pageId=(\d+)|x\/[A-Za-z0-9_-]+)[^\s"')\]]*/i;

/** Confluence page id + URL from a value (string, ADF, or any nested object). */
export function confluencePage(v: unknown): { id: string; url: string } | undefined {
  const text = typeof v === "string" ? v : v && typeof v === "object" ? JSON.stringify(v) : "";
  const m = CONFLUENCE_PAGE_RE.exec(text);
  const id = m?.[1] ?? m?.[2];
  return m && id ? { id, url: m[0] } : undefined;
}

export function designPageOf(issue: JiraIssue, fields: JiraFieldMap): { id: string; url: string } | undefined {
  if (fields.designPage) {
    const hit = confluencePage(issue.fields[fields.designPage]);
    if (hit) return hit;
  }
  const fromDesc = confluencePage(issue.description);
  if (fromDesc) return fromDesc;
  // any custom field holding a Confluence page link
  for (const [k, v] of Object.entries(issue.fields)) {
    if (!/^customfield_/.test(k)) continue;
    const hit = confluencePage(v);
    if (hit) return hit;
  }
  return undefined;
}

/** Text after an "Acceptance criteria" heading in a description, up to the next heading. */
export function sectionAfter(text: string | undefined, heading: RegExp): string | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => heading.test(l.replace(/^#+\s*|[*:]+/g, "").trim()));
  if (i < 0) return undefined;
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (/^#{1,6}\s/.test(l) || /^\*\*[^*]+\*\*:?\s*$/.test(l.trim())) break;
    out.push(l);
  }
  return out.join("\n").trim() || undefined;
}

export function acceptanceCriteriaOf(issue: JiraIssue, fields: JiraFieldMap): string | undefined {
  if (fields.acceptanceCriteria) {
    const t = docText(issue.fields[fields.acceptanceCriteria]);
    if (t) return t;
  }
  return sectionAfter(issue.description, /^acceptance criteria$/i);
}

export const isTestIssue = (i: { issueType?: string; labels?: string[] }) =>
  /^test(\s*case)?$/i.test(i.issueType ?? "") || (i.labels ?? []).some((l) => TEST_CASE_LABELS.includes(l));

/** "Story 00: Foundation", "[01] ...", "S02 - ..." -> "00"/"01"/"02"; label story-NN works too. */
export function storyNumOf(issue: JiraIssue): string | undefined {
  const m = /^\s*(?:\[\s*)?(?:story|s)?[\s-]*(\d{1,2})\b\s*(?:\]|[:.)\-–—])/i.exec(issue.summary);
  if (m) return m[1].padStart(2, "0");
  const l = issue.labels.map((x) => /^story-(\d{1,2})$/i.exec(x)?.[1]).find(Boolean);
  return l ? l.padStart(2, "0") : undefined;
}

/** "Story 01: Agent escalates a Case" -> "Agent escalates a Case" */
export function storyTitleOf(summary: string): string {
  return summary.replace(/^\s*(?:\[\s*)?(?:story|s)?[\s-]*\d{1,2}\b\s*(?:\]|[:.)\-–—])\s*/i, "").trim() || summary.trim();
}

/** Stories of epics (children that are not test cases or sub-tasks), Story 00 first. */
export function storiesOf(children: JiraIssue[]): JiraIssue[] {
  return orderStories(children.filter((c) => !isTestIssue(c) && !/^(sub-?task|epic)$/i.test(c.issueType)));
}

/** Story 00 first, then by story number, then by key. */
export function orderStories(stories: JiraIssue[]): JiraIssue[] {
  return [...stories].sort((a, b) => {
    const na = storyNumOf(a), nb = storyNumOf(b);
    if (na && nb && na !== nb) return na.localeCompare(nb);
    if (na && !nb) return -1;
    if (!na && nb) return 1;
    return compareKeys(a.key, b.key);
  });
}

/** Test-case issues linked to (or under) a story, including links seen only from the story's side. */
export function testCasesOf(story: JiraIssue, tests: JiraIssue[]): string[] {
  const keys = new Set<string>();
  for (const t of tests) if (t.links.some((l) => l.key === story.key) || t.parentKey === story.key) keys.add(t.key);
  for (const l of story.links) if (/^test(\s*case)?$/i.test(l.issueType ?? "") || /^tests?$/i.test(l.type)) keys.add(l.key);
  return [...keys].sort(compareKeys);
}
