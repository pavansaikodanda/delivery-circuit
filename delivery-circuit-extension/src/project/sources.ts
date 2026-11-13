// Transcripts for "New design from transcript": encrypted local storage of pasted text and files (AES-256-GCM) in the
// extension's global storage, and text extraction (txt, md, vtt, srt, docx, pdf best effort). Nothing is written into
// the repository. No vscode import: the caller passes the key and the storage folder.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { inflateRawSync } from "zlib";
import { PdfTextError, pdfToText } from "./pdf";

export const SOURCE_REF_RE = /^(fireflies|upload):([A-Za-z0-9][A-Za-z0-9_-]{2,})$/;

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

export const UPLOAD_EXTENSIONS = ["txt", "md", "vtt", "srt", "docx", "pdf"];

export function extractText(fileName: string, buf: Buffer): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  switch (ext) {
    case "txt": case "md": case "": return buf.toString("utf8").replace(/^﻿/, "");
    case "vtt": case "srt": return subtitlesToText(buf.toString("utf8"));
    case "docx": return docxToText(buf);
    case "pdf":
      try { return pdfToText(buf); } catch (e) { throw new Error(e instanceof PdfTextError ? e.message : String((e as any)?.message ?? e)); }
    default: throw new Error(`Unsupported transcript type .${ext}. Use ${UPLOAD_EXTENSIONS.map((e) => "." + e).join(", ")}.`);
  }
}
