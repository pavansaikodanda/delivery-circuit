// Transcript sources: the repo index .circuit/sources.json (metadata only, never content), encrypted local
// storage of uploads (AES-256-GCM), and text extraction for uploads (txt, md, vtt, srt, docx best effort).
// No vscode import: the caller passes the key and the storage folder.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { inflateRawSync } from "zlib";
import type { SourceOrigin, SourceRef } from "../core/contracts";

export const SOURCES_INDEX = ".circuit/sources.json";
export const SOURCE_REF_RE = /^(fireflies|upload):([A-Za-z0-9][A-Za-z0-9_-]{2,})$/;
const ORIGINS: readonly SourceOrigin[] = ["paste", "file", "fireflies", "fireflies-export", "wispr-flow", "watch-folder"];
export const isSourceOrigin = (x: unknown): x is SourceOrigin => typeof x === "string" && (ORIGINS as readonly string[]).includes(x);

interface IndexFile { version: 1; sources: SourceRef[] }

export function parseIndex(json: string | undefined): SourceRef[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json);
    const list = Array.isArray(raw) ? raw : raw?.sources;
    if (!Array.isArray(list)) return [];
    return list.filter((s: any) => s && typeof s.id === "string" && SOURCE_REF_RE.test(s.id)).map((s: any): SourceRef => ({
      id: s.id, kind: s.id.startsWith("fireflies:") ? "fireflies" : "upload",
      title: String(s.title ?? s.id), date: String(s.date ?? ""), ...(isSourceOrigin(s.origin) ? { origin: s.origin } : {}),
      ...(Array.isArray(s.usedBy) ? { usedBy: s.usedBy.map(String) } : {}),
    }));
  } catch { return []; }
}

/** Only ids, kinds, titles, dates, origin and usedBy are written. Anything else on the objects is dropped. */
export function serializeIndex(sources: SourceRef[]): string {
  const clean = [...sources].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)).map((s) => {
    const o: SourceRef = { id: s.id, kind: s.kind, title: s.title, date: s.date };
    if (isSourceOrigin(s.origin)) o.origin = s.origin;
    if (s.usedBy?.length) o.usedBy = [...new Set(s.usedBy)].sort();
    return o;
  });
  const file: IndexFile = { version: 1, sources: clean };
  return JSON.stringify(file, null, 2) + "\n";
}

export async function readIndex(root: string): Promise<SourceRef[]> {
  try { return parseIndex(await fs.readFile(path.join(root, SOURCES_INDEX), "utf8")); } catch { return []; }
}

export async function writeIndex(root: string, sources: SourceRef[]): Promise<void> {
  const file = path.join(root, SOURCES_INDEX);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, serializeIndex(sources), "utf8");
}

/** Add or update one source (title/date refreshed, usedBy kept). */
export function upsertSource(list: SourceRef[], s: SourceRef): SourceRef[] {
  const i = list.findIndex((x) => x.id === s.id);
  if (i === -1) return [...list, s];
  const merged: SourceRef = { ...list[i], title: s.title, date: s.date, ...(s.origin ? { origin: s.origin } : {}) };
  const usedBy = [...new Set([...(list[i].usedBy ?? []), ...(s.usedBy ?? [])])];
  if (usedBy.length) merged.usedBy = usedBy.sort();
  return list.map((x, j) => (j === i ? merged : x));
}

/** usedBy from the specs that cite each source (feature id -> cited ids). */
export function withUsage(list: SourceRef[], citations: Record<string, string[]>): SourceRef[] {
  return list.map((s) => {
    const by = Object.entries(citations).filter(([, ids]) => ids.includes(s.id)).map(([f]) => f).sort();
    const o: SourceRef = { ...s };
    if (by.length) o.usedBy = by; else delete o.usedBy;
    return o;
  });
}

// ---------- encryption ----------
const MAGIC = Buffer.from("DCS1");

export function newKey(): Buffer { return randomBytes(32); }

export function encrypt(plain: string, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("Source key must be 32 bytes");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(MAGIC);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

export function decrypt(blob: Buffer, key: Buffer): string {
  if (blob.length < 32 || !blob.subarray(0, 4).equals(MAGIC)) throw new Error("Not a Delivery Circuit encrypted source");
  const iv = blob.subarray(4, 16), tag = blob.subarray(16, 32), body = blob.subarray(32);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(MAGIC);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

/** upload:<first 12 hex of sha256(text)> */
export function uploadId(text: string): string {
  return "upload:" + createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

/** File name in the global storage folder for an upload id. */
export function uploadFile(storageDir: string, id: string): string {
  const m = SOURCE_REF_RE.exec(id);
  if (!m || m[1] !== "upload") throw new Error(`Not an upload source id: ${id}`);
  return path.join(storageDir, "sources", `${m[2]}.enc`);
}

export async function storeUpload(storageDir: string, id: string, text: string, key: Buffer): Promise<string> {
  const file = uploadFile(storageDir, id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, encrypt(text, key));
  return file;
}

export async function loadUpload(storageDir: string, id: string, key: Buffer): Promise<string> {
  let blob: Buffer;
  try { blob = await fs.readFile(uploadFile(storageDir, id)); } catch {
    throw new Error(`${id} is not stored on this machine. Uploads stay encrypted on the machine that added them.`);
  }
  return decrypt(blob, key);
}

// ---------- text extraction ----------
/** WebVTT / SRT to "Speaker: text" lines (cue numbers, timings and tags removed, repeats collapsed). */
export function subtitlesToText(src: string): string {
  const out: string[] = [];
  const lines = src.replace(/^﻿/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l === "WEBVTT" || /^(NOTE|STYLE|REGION)\b/.test(l) || /^\d+$/.test(l)) continue;
    if (/-->/.test(l)) continue;
    let t = l.replace(/<v\s+([^>]+)>/g, "$1: ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    t = t.replace(/^(.+?):\s+:\s*/, "$1: ");
    if (t && out[out.length - 1] !== t) out.push(t);
  }
  return out.join("\n");
}

/** Read one entry of a zip (stored or deflated) by name, using the central directory. */
export function readZipEntry(zip: Buffer, name: string): Buffer | undefined {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return undefined;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return undefined;
    const method = zip.readUInt16LE(p + 10), csize = zip.readUInt32LE(p + 20);
    const nlen = zip.readUInt16LE(p + 28), xlen = zip.readUInt16LE(p + 30), clen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entry = zip.subarray(p + 46, p + 46 + nlen).toString("utf8");
    if (entry === name) {
      const lnlen = zip.readUInt16LE(local + 26), lxlen = zip.readUInt16LE(local + 28);
      const data = zip.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      return undefined;
    }
    p += 46 + nlen + xlen + clen;
  }
  return undefined;
}

const XML_ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function docxToText(buf: Buffer): string {
  const xml = readZipEntry(buf, "word/document.xml")?.toString("utf8");
  if (!xml) throw new Error("Could not read the .docx file (word/document.xml not found). Save it as .txt or .md and upload again.");
  return xml
    .replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>/g, "\n").replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_ENT[e])
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .split("\n").map((l) => l.trim()).filter((l, i, a) => l || (i > 0 && a[i - 1])).join("\n").trim();
}

export const UPLOAD_EXTENSIONS = ["txt", "md", "vtt", "srt", "docx"];

export function extractText(fileName: string, buf: Buffer): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  switch (ext) {
    case "txt": case "md": case "": return buf.toString("utf8").replace(/^﻿/, "");
    case "vtt": case "srt": return subtitlesToText(buf.toString("utf8"));
    case "docx": return docxToText(buf);
    default: throw new Error(`Unsupported transcript type .${ext}. Use ${UPLOAD_EXTENSIONS.map((e) => "." + e).join(", ")}.`);
  }
}
