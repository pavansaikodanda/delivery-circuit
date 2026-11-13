// View models of the sidebar (three tabs) and the story panel. Pure (no vscode import): unit-tested, and the preview
// fixtures are generated from these builders. Run specs stay on the extension side: rows carry an id only.
import {
  roleChoices, ROLE_LABEL, STORY_STATUS_LABEL, type ConnectionStatus, type Identity, type MissingItem, type Role, type StoryDetail,
  type StoryStatus, type WorkRow, type WorkSnapshot,
} from "../core/contracts";
import { buttonFor, rowsFor } from "../connections/catalog";

export interface RowView { id: string; title: string; detail?: string; button: string }
export interface MissingView extends RowView { group: MissingItem["group"] }

export interface HomeState {
  mode: "signin" | "no-remote" | "ready";
  user?: { login: string; role: Role | null; roleLabel: string; roles: { id: Role; label: string }[] };
  notice?: string;
  repo?: string;
  /** undefined while the first read runs */
  work?: {
    next: RowView[];
    sprint: { name?: string; stories: { key: string; title: string; status: StoryStatus; statusLabel: string }[] };
    errors: string[];
    updatedAt: string;
  };
  connections: (Pick<ConnectionStatus, "id" | "label" | "state" | "account" | "detail"> & { button: string })[];
  /** undefined while the first read runs */
  missing?: MissingView[];
  missingCount: number;
}

const row = (r: WorkRow): RowView => ({ id: r.id, title: r.title, ...(r.detail ? { detail: r.detail } : {}), button: r.button });

export function buildHome(id: Identity | null, connections: ConnectionStatus[], work: WorkSnapshot | undefined): HomeState {
  if (!id) return { mode: "signin", connections: [], missingCount: 0 };
  const role = id.active;
  const user = {
    login: id.login, role, roleLabel: role ? ROLE_LABEL[role] : "",
    roles: roleChoices(id).map((r) => ({ id: r, label: ROLE_LABEL[r] })),
  };
  const conns = rowsFor(connections, role).map((c) => ({
    id: c.id, label: c.label, state: c.state, button: buttonFor(c),
    ...(c.account ? { account: c.account } : {}), ...(c.detail ? { detail: c.detail } : {}),
  }));
  const s: HomeState = { mode: id.owner ? "ready" : "no-remote", user, connections: conns, missingCount: 0 };
  if (id.notice) s.notice = id.notice;
  if (id.owner) s.repo = `${id.owner}/${id.repo}`;
  if (work) {
    s.work = {
      next: work.next.map(row),
      sprint: { ...(work.sprint.name ? { name: work.sprint.name } : {}), stories: work.sprint.stories.map((x) => ({ key: x.key, title: x.title, status: x.status, statusLabel: STORY_STATUS_LABEL[x.status] })) },
      errors: work.errors,
      updatedAt: work.updatedAt,
    };
    s.missing = work.missing.map((m) => ({ ...row(m), group: m.group }));
    s.missingCount = work.missing.length;
  }
  return s;
}

export interface StoryState {
  loading?: boolean;
  error?: string;
  story?: StoryDetail & { statusLabel: string; pr?: StoryDetail["pr"] & { scanText: string; coderabbitText: string; approvalText: string } };
}

const SCAN_TEXT = { success: "passed", failure: "failed", pending: "running", missing: "not run" } as const;
const RABBIT_TEXT = { approved: "approved", changes: "changes requested", pending: "pending" } as const;

/** "2 h", "3 d" since an ISO time. */
export function since(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const h = Math.max(0, (now - t) / 3_600_000);
  return h < 1 ? "under 1 h" : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`;
}

export function buildStory(d: StoryDetail | undefined, now = Date.now()): StoryState {
  if (!d) return { error: "Story not found" };
  const { pr: _pr, ...rest } = d;
  const story: NonNullable<StoryState["story"]> = { ...rest, statusLabel: STORY_STATUS_LABEL[d.status] };
  if (d.pr) {
    const p = d.pr;
    const approvalText = p.approvedBy.length ? `approved by ${p.approvedBy.join(", ")}`
      : p.state === "open" ? `waiting${p.waitingSince ? ` ${since(p.waitingSince, now)}` : ""}` : "none";
    story.pr = { ...p, scanText: SCAN_TEXT[p.scan], coderabbitText: RABBIT_TEXT[p.coderabbit], approvalText };
  }
  return { story };
}
