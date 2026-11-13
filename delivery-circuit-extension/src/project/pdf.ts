// Best-effort text from a PDF transcript export (Fireflies, Zoom, Teams, Word "Save as PDF"): inflates FlateDecode
// content streams and reads the text-showing operators (Tj, TJ, ', "). Good for text PDFs with simple fonts; a scanned
// PDF, or one whose fonts use custom glyph codes, has no readable text and is refused with a hint. No vscode import.
import { inflateSync } from "zlib";

export class PdfTextError extends Error {}

const MAX_STREAM = 50 * 1024 * 1024;

export function pdfToText(buf: Buffer): string {
  if (buf.subarray(0, 1024).toString("latin1").indexOf("%PDF-") < 0) throw new PdfTextError("Not a PDF file.");
  const src = buf.toString("latin1");
  const chunks: string[] = [];
  const re = /<<((?:(?!>>\s*stream)[\s\S]){0,4000})>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const dict = m[1];
    const start = m.index + m[0].length;
    const lenM = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
    let end = lenM ? start + Number(lenM[1]) : -1;
    if (end < start || end > src.length || src.slice(end, end + 30).indexOf("endstream") < 0) end = src.indexOf("endstream", start);
    if (end < 0) break;
    re.lastIndex = end;
    if (/\/Subtype\s*\/(Image|XML|Form)\b|\/Type\s*\/(XObject|Metadata|XRef|ObjStm)\b|\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)\b/.test(dict)) continue;
    let raw = buf.subarray(start, end);
    if (raw.length > MAX_STREAM) continue;
    if (/\/FlateDecode\b/.test(dict)) {
      try { raw = inflateSync(raw); } catch { try { raw = inflateSync(trimEol(raw)); } catch { continue; } }
    } else if (/\/Filter\b/.test(dict)) continue;
    const text = contentText(raw.toString("latin1"));
    if (text.trim()) chunks.push(text);
  }
  const out = chunks.join("\n").split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter((l, i, a) => l || (i > 0 && a[i - 1])).join("\n").trim();
  const printable = out.replace(/[^\x20-\x7e -ɏ\n]/g, "").length;
  if (!out || printable / out.length < 0.85) {
    throw new PdfTextError("This PDF has no readable text (it may be scanned, or its fonts hide the text). Export the transcript as .txt, .docx, .vtt or .srt instead.");
  }
  return out;
}

function trimEol(b: Buffer): Buffer { let e = b.length; while (e > 0 && (b[e - 1] === 0x0a || b[e - 1] === 0x0d)) e--; return b.subarray(0, e); }

/** Text operators of one content stream, with line breaks at text positioning operators. */
export function contentText(cs: string): string {
  let out = "";
  let i = 0;
  const n = cs.length;
  const pending: string[] = [];
  while (i < n) {
    const c = cs[i];
    if (c === "%") { while (i < n && cs[i] !== "\n" && cs[i] !== "\r") i++; continue; }
    if (c === "(") { const [s, j] = readLiteral(cs, i); pending.push(s); i = j; continue; }
    if (c === "<" && cs[i + 1] !== "<") { const j = cs.indexOf(">", i); const hex = cs.slice(i + 1, j < 0 ? n : j); pending.push(hexText(hex)); i = j < 0 ? n : j + 1; continue; }
    if (c === "[") { pending.push("\u0000["); i++; continue; }
    if (/[-+.\d]/.test(c)) {
      let j = i + 1; while (j < n && /[.\d]/.test(cs[j])) j++;
      // inside a TJ array a large negative adjustment is a word gap
      if (pending.includes("\u0000[") && Number(cs.slice(i, j)) < -180) pending.push(" ");
      i = j; continue;
    }
    if (c === "]") { i++; const k = pending.lastIndexOf("\u0000["); const inner = k >= 0 ? pending.splice(k).slice(1).join("") : ""; pending.push(inner); continue; }
    if (/[A-Za-z'"*]/.test(c)) {
      let j = i; while (j < n && /[A-Za-z'"*0-9]/.test(cs[j])) j++;
      const op = cs.slice(i, j);
      if (op === "Tj" || op === "TJ") out += pending.pop() ?? "";
      else if (op === "'" || op === '"') out += "\n" + (pending.pop() ?? "");
      else if (op === "Td" || op === "TD" || op === "T*" || op === "Tm") { if (out && !out.endsWith("\n")) out += "\n"; }
      else if (op === "ET") { if (out && !out.endsWith("\n")) out += "\n"; }
      if (op !== "Tj" && op !== "TJ") pending.length = 0;
      i = j; continue;
    }
    i++;
  }
  return out;
}

function readLiteral(s: string, i: number): [string, number] {
  let depth = 0, out = "";
  let j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      const d = s[++j];
      if (d === "n") out += "\n"; else if (d === "r") out += "\r"; else if (d === "t") out += "\t";
      else if (d === "b" || d === "f") { /* skip */ }
      else if (/[0-7]/.test(d)) { let o = d; while (o.length < 3 && /[0-7]/.test(s[j + 1])) o += s[++j]; out += String.fromCharCode(parseInt(o, 8)); }
      else if (d === "\r" || d === "\n") { if (d === "\r" && s[j + 1] === "\n") j++; }
      else out += d ?? "";
      continue;
    }
    if (c === "(") { if (depth++ > 0) out += c; continue; }
    if (c === ")") { if (--depth === 0) return [decodePdfString(out), j + 1]; out += c; continue; }
    out += c;
  }
  return [decodePdfString(out), j];
}

function hexText(hex: string): string {
  const h = hex.replace(/[^0-9a-f]/gi, "");
  let s = "";
  for (let k = 0; k < h.length; k += 2) s += String.fromCharCode(parseInt(h.slice(k, k + 2).padEnd(2, "0"), 16));
  return decodePdfString(s);
}

/** UTF-16BE strings start with a BOM; everything else is treated as Latin-1 (PDFDocEncoding is close enough here). */
function decodePdfString(s: string): string {
  if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) {
    let o = ""; for (let k = 2; k + 1 < s.length; k += 2) o += String.fromCharCode((s.charCodeAt(k) << 8) | s.charCodeAt(k + 1));
    return o;
  }
  return s;
}
