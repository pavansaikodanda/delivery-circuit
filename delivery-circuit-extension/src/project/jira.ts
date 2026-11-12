// Jira side of the v3 project context: build.config.yml settings, the JQL the extension runs through acli, and the
// mapping of epics, stories and test cases to features. Pure functions (no vscode import), unit-tested on fixtures.
//
// Conventions (docs/CIRCUIT-V3.md section 2):
//   epic        = one feature; its Design page field (or any Confluence page link on it) names the design page
//   stories     = children of the epic (parent = epic); "Story 00" first; blocks links order the work
//   story facts = fields Design page, Approved design version, Acceptance criteria, Testability confirmed
//                 (ids from build.config.yml jira.fields; fallbacks: labels design-v<N> / testability-confirmed and
//                 "Approved design version: N" / an "Acceptance criteria" heading in the description)
//   test cases  = issues labelled test-case (or of a Test issue type) linked to a story
import type { Story, TestCaseRef } from "../core/contracts";
import { compareKeys, docText, keyList, PROJECT_KEY_RE } from "./acli";
import type { CircuitConfig, FeatureSource, JiraFieldMap, JiraIssue } from "./model";

export const TEST_CASE_LABEL = "test-case";
export const AI_READY = "ai-ready";
export const TESTABILITY_LABEL = "testability-confirmed";
export const STORIES_REVIEWED_LABEL = "dev-reviewed";

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

export function parseConfig(yaml: string | undefined): CircuitConfig {
  const y = yaml ?? "";
  const cfg: CircuitConfig = { fields: {}, architects: [], maxAttempts: 3 };
  const site = siteUrl(yamlValue(y, "jira", "site"));
  if (site) cfg.site = site;
  const pk = yamlValue(y, "jira", "project_key");
  if (pk && PROJECT_KEY_RE.test(pk)) cfg.projectKey = pk;
  const space = yamlValue(y, "confluence", "space_key");
  if (space && /^[A-Za-z0-9~_-]+$/.test(space)) cfg.spaceKey = space;
  // jira.fields: { design_page: customfield_10050, approved_design_version: customfield_10051, ... }
  const jira = yamlBlock(y, "jira") ?? "";
  const fieldsBlock = /^[ \t]+fields:[ \t]*(\{[^}\r\n]*\}|\r?\n(?:[ \t]{4,}.*(?:\r?\n|$))*)/m.exec(jira)?.[1] ?? "";
  const pick = (name: string): string | undefined => {
    const v = new RegExp(`\\b${name}:[ \\t]*["']?([A-Za-z0-9_]+)`).exec(fieldsBlock)?.[1];
    return v && FIELD_ID_RE.test(v) ? v : undefined;
  };
  const fields: JiraFieldMap = {};
  const dp = pick("design_page"); if (dp) fields.designPage = dp;
  const av = pick("approved_design_version"); if (av) fields.approvedDesignVersion = av;
  const ac = pick("acceptance_criteria"); if (ac) fields.acceptanceCriteria = ac;
  const tc = pick("testability_confirmed"); if (tc) fields.testabilityConfirmed = tc;
  cfg.fields = fields;
  // people.architects: [{ gh: "x", atlassian: "a@example.com", slack: "" }]
  const people = yamlBlock(y, "people") ?? "";
  const archLine = /^[ \t]+architects:[ \t]*(.*(?:\r?\n[ \t]{4,}.*)*)/m.exec(people)?.[1] ?? "";
  cfg.architects = [...archLine.matchAll(/atlassian:[ \t]*["']([^"']+)["']/g)].map((m) => m[1].trim()).filter(Boolean);
  const max = Number(yamlValue(y, "ai", "max_attempts"));
  if (Number.isInteger(max) && max > 0 && max < 10) cfg.maxAttempts = max;
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
  return `project = ${projectKey} AND labels = "${TEST_CASE_LABEL}" ORDER BY key ASC`;
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

const toInt = (v: unknown): number | undefined => {
  const raw = v && typeof v === "object" && !Array.isArray(v) ? (v as any).value ?? (v as any).name : v;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(/^\s*v?(\d+)(?:\.0+)?\s*$/i.exec(raw)?.[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** G1 record in Jira: the epic's "Approved design version", set only by the architects-only "Approve design"
 *  transition. Only the field counts: an epic's labels and description are free text anyone (or AI) can edit. */
export function epicApprovedVersionOf(epic: JiraIssue | undefined, fields: JiraFieldMap): number | undefined {
  return epic && fields.approvedDesignVersion ? toInt(epic.fields[fields.approvedDesignVersion]) : undefined;
}

export function approvedDesignVersionOf(issue: JiraIssue, fields: JiraFieldMap): number | undefined {
  if (fields.approvedDesignVersion) {
    const n = toInt(issue.fields[fields.approvedDesignVersion]);
    if (n) return n;
  }
  const label = issue.labels.map((l) => /^design-v(\d+)$/i.exec(l)?.[1]).filter(Boolean).map(Number);
  if (label.length) return Math.max(...label);
  const m = /approved design version\**\s*[:=]\s*\**\s*v?(\d+)/i.exec(issue.description ?? "");
  return m ? Number(m[1]) : undefined;
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

/** true / false when known; undefined when no field is configured and the label is absent (G2 then needs ai-ready only). */
export function testabilityOf(issue: JiraIssue, fields: JiraFieldMap): boolean | undefined {
  if (issue.labels.includes(TESTABILITY_LABEL)) return true;
  if (!fields.testabilityConfirmed) return undefined;
  const v: any = issue.fields[fields.testabilityConfirmed];
  const yes = (x: any) => x === true || /^(yes|true|confirmed|done)$/i.test(String(x?.value ?? x?.name ?? x ?? "").trim());
  return Array.isArray(v) ? v.some(yes) : yes(v);
}

const isTestIssue = (i: { issueType?: string; labels?: string[] }) =>
  /^test(\s*case)?$/i.test(i.issueType ?? "") || (i.labels ?? []).includes(TEST_CASE_LABEL);

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

/** "AC1", "AC-2" labels or an "AC2:" summary prefix; level labels ui | unit | manual (or level-ui, ...). */
export function testCaseRef(t: JiraIssue): TestCaseRef {
  const label = (re: RegExp) => t.labels.map((l) => re.exec(l)?.[1]).find(Boolean);
  const lv = (label(/^(?:level-)?(ui|unit|manual)$/i) ?? "manual").toLowerCase() as TestCaseRef["level"];
  const tcId = /\b((?:S\d{2}-)?TC-?\d{1,3})\b/i.exec(t.summary)?.[1]?.toUpperCase();
  const ref: TestCaseRef = { id: tcId ?? t.key, level: lv, jiraKey: t.key };
  const ac = label(/^ac-?(\d+)$/i) ?? /\bAC-?(\d+)\b/i.exec(t.summary)?.[1];
  if (ac) ref.ac = `AC${ac}`;
  return ref;
}

/** Group Jira results into features: epic + its stories + test cases linked to those stories. */
export function groupFeatures(epics: JiraIssue[], children: JiraIssue[], testIssues: JiraIssue[], fields: JiraFieldMap): FeatureSource[] {
  const byEpic = new Map<string, JiraIssue[]>();
  for (const c of children) {
    if (!c.parentKey || isTestIssue(c) || /^sub-?task$/i.test(c.issueType)) continue;
    (byEpic.get(c.parentKey) ?? byEpic.set(c.parentKey, []).get(c.parentKey)!).push(c);
  }
  const tests = [...testIssues, ...children.filter(isTestIssue)];
  return [...epics].sort((a, b) => compareKeys(a.key, b.key)).map((epic) => {
    const stories = orderStories(byEpic.get(epic.key) ?? []);
    const storyKeys = new Set(stories.map((s) => s.key));
    const seen = new Set<string>();
    const featureTests: JiraIssue[] = [];
    for (const t of tests) {
      if (seen.has(t.key)) continue;
      if (t.links.some((l) => storyKeys.has(l.key)) || (t.parentKey && storyKeys.has(t.parentKey))) { featureTests.push(t); seen.add(t.key); }
    }
    // test issues only known from a story's links (no test-case label search hit)
    for (const s of stories) for (const l of s.links) {
      if (seen.has(l.key) || !/^test(\s*case)?$/i.test(l.issueType ?? "")) continue;
      seen.add(l.key);
      featureTests.push({ key: l.key, summary: l.summary ?? l.key, issueType: l.issueType ?? "Test", status: l.status ?? "", labels: [],
        links: [{ type: l.type, direction: l.direction === "inward" ? "outward" : "inward", phrase: "", key: s.key }], fields: {} });
    }
    const src: FeatureSource = { epic, stories, tests: featureTests };
    const page = designPageOf(epic, fields) ?? stories.map((s) => designPageOf(s, fields)).find(Boolean);
    if (page) src.pageId = page.id;
    return src;
  });
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

/** Contract Story objects with numbers (missing numbers continue after the highest one). */
export function storyNumbers(stories: JiraIssue[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const s of stories) { const n = storyNumOf(s); if (n && !used.has(n)) { out.set(s.key, n); used.add(n); } }
  let next = used.size ? Math.max(...[...used].map(Number)) + 1 : 0;
  for (const s of stories) {
    if (out.has(s.key)) continue;
    while (used.has(String(next).padStart(2, "0"))) next++;
    const n = String(next++).padStart(2, "0");
    out.set(s.key, n); used.add(n);
  }
  return out;
}

export function testCasesFor(storyKey: string, tests: JiraIssue[]): TestCaseRef[] {
  return tests.filter((t) => t.links.some((l) => l.key === storyKey) || t.parentKey === storyKey).map(testCaseRef);
}

/** Keys of the issues that block a story ("is blocked by" links). */
export function blockedByOf(issue: JiraIssue): string[] {
  return issue.links.filter((l) => /^blocks?$/i.test(l.type) && l.direction === "inward").map((l) => l.key).sort(compareKeys);
}

export type { Story };
