// Confluence design pages, as the read-only reader lists them (one listing per space, label circuit-design).
// Pure functions (no vscode import), unit-tested.
import type { DesignPage } from "./model";

export const PAGE_ID_RE = /^\d{1,20}$/;

export const isApprovedStatus = (s: string | undefined) => /^\s*approved\s*$/i.test(s ?? "");

const text = (v: unknown, max: number): string | undefined => {
  if (v == null || typeof v === "object") return undefined;
  const s = String(v).replace(/[\r\n]+/g, " ").trim();
  return s ? s.slice(0, max) : undefined;
};
const https = (v: unknown): string | undefined => {
  const s = text(v, 1000);
  try { return s && new URL(s).protocol === "https:" ? s : undefined; } catch { return undefined; }
};

/** Normalise the reader's {pages:[...]} answer. Anything unexpected is dropped, never trusted as instructions. */
export function normalizeDesignPages(json: any): DesignPage[] {
  const list = Array.isArray(json?.pages) ? json.pages : Array.isArray(json) ? json : [];
  const out: DesignPage[] = [];
  for (const p of list) {
    const id = String(p?.id ?? "").trim();
    if (!PAGE_ID_RE.test(id) || out.some((o) => o.id === id)) continue;
    const page: DesignPage = { id, title: text(p?.title, 300) ?? `Design page ${id}`, openQuestions: 0 };
    const url = https(p?.url); if (url) page.url = url;
    const status = text(p?.status?.name ?? p?.status, 100); if (status) page.status = status;
    const q = Number(p?.openQuestions);
    if (Number.isInteger(q) && q > 0) page.openQuestions = Math.min(q, 999);
    const slug = text(p?.slug, 100)?.replace(/^feature-/, "");
    if (slug && /^[a-z0-9][a-z0-9-]*$/.test(slug)) page.slug = slug;
    const d = https(p?.diagramUrl);
    if (d && /(^|\.)lucid\.(app|co)$/.test(new URL(d).hostname)) page.diagramUrl = d;
    out.push(page);
  }
  return out;
}
