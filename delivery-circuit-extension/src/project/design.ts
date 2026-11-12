// Confluence design pages: normalising what the read-only reader returns, G1 (status Approved by an architect at a
// known version) and C5 (the story's Approved design version against the page's current approved version).
// Pure functions (no vscode import), unit-tested.
import type { DesignApproval, DesignPage, DesignPageListing, DesignSync, Decision, FeatureSource, OrgSnapshot, PageVersion } from "./model";

export const PAGE_ID_RE = /^\d{1,20}$/;
export const SOURCE_ID_RE = /\b(?:fireflies|upload):[A-Za-z0-9][A-Za-z0-9_-]{2,}/g;

const str = (v: unknown, max = 500): string | undefined => {
  if (v == null) return undefined;
  const s = String(typeof v === "object" ? (v as any).displayName ?? (v as any).email ?? (v as any).accountId ?? (v as any).name ?? "" : v).trim();
  return s ? s.slice(0, max) : undefined;
};
const int = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
};
const strList = (v: unknown, max = 200): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => str(typeof x === "object" && x ? (x as any).name ?? (x as any).apiName ?? x : x, 300)).filter((x): x is string => !!x))].slice(0, max) : [];

/** Normalise the reader's JSON for one page. Anything unexpected is dropped, never trusted as instructions. */
export function normalizePage(raw: any, pageId: string, readAt = new Date().toISOString()): DesignPage {
  const page: DesignPage = { id: pageId, versions: [], sections: [], openQuestions: 0, decisions: [], sources: [], readAt };
  if (!raw || typeof raw !== "object") return { ...page, error: "The design page could not be read" };
  if (raw.error) page.error = str(raw.error, 300);
  const title = str(raw.title, 300); if (title) page.title = title;
  const url = str(raw.url, 1000); if (url && /^https:\/\//.test(url)) page.url = url;
  const space = str(raw.spaceKey ?? raw.space?.key, 100); if (space) page.spaceKey = space;
  const status = str(raw.status?.name ?? raw.status ?? raw.contentState?.name, 100); if (status) page.status = status;
  const version = int(raw.version?.number ?? raw.version); if (version) page.version = version;
  page.versions = (Array.isArray(raw.versions) ? raw.versions : [])
    .map((v: any): PageVersion | undefined => {
      const n = int(v?.number ?? v?.version);
      if (!n) return undefined;
      const o: PageVersion = { number: n };
      const by = str(v.by ?? v.author ?? v.authorId); if (by) o.by = by;
      const at = str(v.at ?? v.when ?? v.createdAt, 60); if (at) o.at = at;
      const msg = str(v.message, 300); if (msg) o.message = msg;
      return o;
    })
    .filter((v: PageVersion | undefined): v is PageVersion => !!v)
    .sort((a: PageVersion, b: PageVersion) => b.number - a.number);
  if (!page.version && page.versions.length) page.version = page.versions[0].number;
  const sc = raw.statusChange;
  if (sc && typeof sc === "object") {
    const o: NonNullable<DesignPage["statusChange"]> = {};
    const by = str(sc.by ?? sc.author ?? sc.accountId); if (by) o.by = by;
    const at = str(sc.at ?? sc.when, 60); if (at && !Number.isNaN(Date.parse(at))) o.at = at;
    const n = int(sc.version ?? sc.number); if (n) o.version = n;
    if (Object.keys(o).length) page.statusChange = o;
  }
  page.sections = strList(raw.sections, 100);
  page.openQuestions = int(raw.openQuestions) ?? 0;
  page.decisions = (Array.isArray(raw.decisions) ? raw.decisions : []).map((d: any): Decision | undefined => {
    const text = str(d?.decision ?? d?.text, 2000);
    if (!text) return undefined;
    const o: Decision = { decision: text };
    const date = str(d.date, 40); if (date) o.date = date;
    const who = str(d.who, 200); if (who) o.who = who;
    const why = str(d.why, 2000); if (why) o.why = why;
    const source = str(d.source, 1000); if (source) o.source = source;
    return o;
  }).filter((d: Decision | undefined): d is Decision => !!d).slice(0, 500);
  page.sources = [...new Set<string>((Array.isArray(raw.sources) ? raw.sources.map(String) : []).join(" ").match(SOURCE_ID_RE) ?? [])].sort();
  const os = raw.orgSnapshot;
  if (os && typeof os === "object") {
    const snap: OrgSnapshot = { objects: strList(os.objects), fields: strList(os.fields, 1000), flows: strList(os.flows), permissionSets: strList(os.permissionSets) };
    const other = strList(os.other); if (other.length) snap.other = other;
    const pid = str(os.pageId ?? os.id, 30); if (pid && PAGE_ID_RE.test(pid)) snap.pageId = pid;
    const u = str(os.url, 1000); if (u && /^https:\/\//.test(u)) snap.url = u;
    const t = str(os.title, 300); if (t) snap.title = t;
    const v = int(os.version); if (v) snap.version = v;
    page.orgSnapshot = snap;
  }
  return page;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Whether a version author is one of the configured architects (email, account id or display name). */
export function isArchitect(by: string | undefined, architects: string[]): boolean | undefined {
  if (!architects.length) return undefined;
  if (!by) return false;
  const who = norm(by);
  return architects.some((a) => norm(a) === who || (who.includes("@") ? false : norm(a).split("@")[0] === who));
}

export const isApprovedStatus = (s: string | undefined) => /^\s*approved\s*$/i.test(s ?? "");

/** The page version the status change refers to: the record's version, else the newest version created at or before
 *  the status was set. Undefined when the reader returned no status-change record. */
function statusChangeVersion(page: DesignPage): number | undefined {
  const sc = page.statusChange;
  if (!sc) return undefined;
  if (sc.version) return sc.version;
  const t = sc.at ? Date.parse(sc.at) : NaN;
  if (Number.isNaN(t)) return undefined;
  return page.versions.find((v) => v.at && !Number.isNaN(Date.parse(v.at)) && Date.parse(v.at) <= t)?.number;
}

/**
 * G1. The page is approved when its status is "Approved". The approved version comes from a record people cannot
 * fake by editing the page: first the epic's "Approved design version" in Jira (set only by the architects-only
 * "Approve design" transition, the same record design-gate reads in CI), else the page's status-change record.
 * Version messages ("Approved v5") are free text any editor, including AI, can write: they never count.
 * A newer current version means the design changed after approval: re-approve.
 */
export function designApproval(page: DesignPage | undefined, architects: string[], epicApprovedVersion?: number): DesignApproval {
  if (!page) return { state: "missing", changedSinceApproval: false, detail: "No Confluence design page linked to the epic" };
  if (page.error && !page.status) return { state: "unknown", changedSinceApproval: false, detail: page.error };
  if (!isApprovedStatus(page.status)) {
    return { state: "draft", changedSinceApproval: false, detail: `Design page status: ${page.status || "none"}${page.version ? ` (v${page.version})` : ""}` };
  }
  const recorded = statusChangeVersion(page);
  const current = page.version ?? epicApprovedVersion ?? recorded;
  const source: DesignApproval["approvedVersionSource"] = epicApprovedVersion ? "jira-epic" : recorded ? "status-change" : "current";
  const approvedVersion = epicApprovedVersion ?? recorded ?? current;
  const approvedBy = page.statusChange?.by ?? page.versions.find((v) => v.number === approvedVersion)?.by;
  const approverIsArchitect = isArchitect(approvedBy, architects);
  const changed = !!(approvedVersion && current && current > approvedVersion);
  const out: DesignApproval = { state: "approved", changedSinceApproval: changed, detail: "", approvedVersionSource: source };
  if (approvedVersion) out.approvedVersion = approvedVersion;
  if (approvedBy) out.approvedBy = approvedBy;
  if (approverIsArchitect !== undefined) out.approverIsArchitect = approverIsArchitect;
  if (changed) {
    out.state = "changed";
    out.detail = `Design changed after approval: v${current} is newer than approved v${approvedVersion}. Re-approve.`;
  } else if (approverIsArchitect === false) {
    out.state = "unverified-approver";
    out.detail = `Status Approved was set by ${approvedBy ?? "someone"} who is not in the architects list`;
  } else {
    out.detail = `Approved v${approvedVersion ?? "?"}${approvedBy ? ` by ${approvedBy}` : ""}` +
      (source === "current" ? " (approved version not recorded: run the epic's Approve design transition in Jira)" : "") +
      (approverIsArchitect === undefined ? " (approver not verified: no architects in build.config.yml)" : "");
  }
  return out;
}

/** C5 for one story. */
export function designSync(storyVersion: number | undefined, approval: DesignApproval | undefined): DesignSync {
  if (!approval || approval.state === "missing" || approval.state === "unknown" || approval.state === "draft") return "unknown";
  if (!approval.approvedVersion) return "unknown";
  if (!storyVersion) return "missing";
  if (storyVersion < approval.approvedVersion) return "changed";
  if (storyVersion > approval.approvedVersion) return "ahead";
  return approval.changedSinceApproval ? "changed" : "ok";
}

export const C5_MESSAGE = "Design changed since this story was planned: re-plan or re-approve";

export function designSyncText(s: DesignSync, storyVersion?: number, approved?: number): string {
  switch (s) {
    case "ok": return `Planned on approved design v${approved}`;
    case "changed": return `${C5_MESSAGE} (story v${storyVersion ?? "?"}, page v${approved ?? "?"})`;
    case "missing": return "Story has no Approved design version";
    case "ahead": return `Story names design v${storyVersion}, but the page's approved version is v${approved}`;
    default: return "Design approval unknown";
  }
}

/** Design pages that no epic links to yet become page-only features (the epic is created after G1). */
export function withPageOnlyFeatures(sources: FeatureSource[], listing: DesignPageListing[]): FeatureSource[] {
  const linked = new Set(sources.map((s) => s.pageId).filter(Boolean));
  const out = sources.map((s) => {
    const l = s.pageId ? listing.find((x) => x.id === s.pageId) : undefined;
    return l ? { ...s, pageListing: l } : s;
  });
  for (const l of listing) {
    if (linked.has(l.id)) continue;
    out.push({ stories: [], tests: [], pageId: l.id, pageListing: l });
  }
  return out;
}
