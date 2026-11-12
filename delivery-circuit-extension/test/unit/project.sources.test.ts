import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { deflateRawSync } from "zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
  decrypt, docxToText, encrypt, extractText, loadUpload, newKey, parseIndex, readIndex, readZipEntry, serializeIndex, storeUpload,
  subtitlesToText, uploadFile, uploadId, upsertSource, withUsage, writeIndex,
} from "../../src/project/sources";
import { siteUrl } from "../../src/project/jira";
import { firefliesPointer, readFirefliesMeta, readFirefliesRecent, type ClaudeExec } from "../../src/project/mcpReader";

const FIX = path.join(__dirname, "..", "fixtures", "project", "repo");
const tmpDirs: string[] = [];
const tmp = async () => { const d = await fsp.mkdtemp(path.join(os.tmpdir(), "dc-src-")); tmpDirs.push(d); return d; };
afterAll(async () => { for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true }); });

describe(".circuit/sources.json index", () => {
  it("reads the fixture index and drops invalid ids", async () => {
    const list = await readIndex(FIX);
    expect(list.map((s) => s.id)).toEqual(["fireflies:01JD7K2M9Q", "upload:3f9a0c1b2d4e"]);
    expect(list[0]).toEqual({ id: "fireflies:01JD7K2M9Q", kind: "fireflies", title: "Support escalations call", date: "2026-11-01T15:00:00.000Z" });
  });
  it("serializes metadata only, newest first", () => {
    const text = serializeIndex([
      { id: "upload:aaaaaaaaaaaa", kind: "upload", title: "A", date: "2026-01-01", ...({ content: "SECRET TEXT", path: "/x" } as any) },
      { id: "fireflies:abc", kind: "fireflies", title: "B", date: "2026-02-01", usedBy: ["002", "001", "001"] },
    ]);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("/x");
    const back = JSON.parse(text);
    expect(back.version).toBe(1);
    expect(back.sources.map((s: any) => s.id)).toEqual(["fireflies:abc", "upload:aaaaaaaaaaaa"]);
    expect(back.sources[0].usedBy).toEqual(["001", "002"]);
    expect(parseIndex(text)).toHaveLength(2);
    expect(parseIndex("[{\"id\":\"upload:abcdef\"}]")[0]).toMatchObject({ kind: "upload", title: "upload:abcdef" });
    expect(parseIndex("nope")).toEqual([]);
  });
  it("upserts and computes usage from spec citations", () => {
    let list = upsertSource([], { id: "upload:abc123", kind: "upload", title: "old", date: "1", usedBy: ["001"] });
    list = upsertSource(list, { id: "upload:abc123", kind: "upload", title: "new", date: "2" });
    expect(list).toEqual([{ id: "upload:abc123", kind: "upload", title: "new", date: "2", usedBy: ["001"] }]);
    const used = withUsage(list, { "001": [], "003": ["upload:abc123"], "002": ["upload:abc123"] });
    expect(used[0].usedBy).toEqual(["002", "003"]);
    expect(withUsage(list, {})[0].usedBy).toBeUndefined();
  });
  it("writes the index under .circuit/", async () => {
    const root = await tmp();
    await writeIndex(root, [{ id: "fireflies:xyz", kind: "fireflies", title: "Call", date: "2026-11-11T00:00:00.000Z" }]);
    expect(await readIndex(root)).toEqual([{ id: "fireflies:xyz", kind: "fireflies", title: "Call", date: "2026-11-11T00:00:00.000Z" }]);
  });
});

describe("encrypted uploads", () => {
  it("round-trips AES-256-GCM and refuses tampering or a wrong key", () => {
    const key = newKey();
    const blob = encrypt("Client: we need escalations.\nÜmlaut ✓", key);
    expect(blob.subarray(0, 4).toString()).toBe("DCS1");
    expect(blob.toString("utf8")).not.toContain("escalations");
    expect(decrypt(blob, key)).toBe("Client: we need escalations.\nÜmlaut ✓");
    const bad = Buffer.from(blob); bad[bad.length - 1] ^= 1;
    expect(() => decrypt(bad, key)).toThrow();
    expect(() => decrypt(blob, newKey())).toThrow();
    expect(() => decrypt(Buffer.from("garbage"), key)).toThrow(/Not a Delivery Circuit/);
    expect(() => encrypt("x", Buffer.alloc(16))).toThrow(/32 bytes/);
    expect(encrypt("same", key).equals(encrypt("same", key))).toBe(false);
  });
  it("derives a stable upload id and stores outside the repo", async () => {
    expect(uploadId("hello")).toBe("upload:2cf24dba5fb0");
    const dir = await tmp();
    const key = newKey();
    const id = uploadId("transcript text");
    const file = await storeUpload(dir, id, "transcript text", key);
    expect(file).toBe(path.join(dir, "sources", `${id.slice(7)}.enc`));
    expect(await fsp.readFile(file, "utf8")).not.toContain("transcript text");
    expect(await loadUpload(dir, id, key)).toBe("transcript text");
    await expect(loadUpload(dir, "upload:000000000000", key)).rejects.toThrow(/not stored on this machine/);
    expect(() => uploadFile(dir, "fireflies:abc")).toThrow();
    expect(() => uploadFile(dir, "upload:../../etc")).toThrow();
  });
});

function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = deflateRawSync(Buffer.from(text, "utf8"));
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(Buffer.byteLength(text), 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(Buffer.byteLength(text), 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("text extraction", () => {
  it("cleans WebVTT and SRT", () => {
    const vtt = "WEBVTT\n\nNOTE x\n\n1\n00:00:01.000 --> 00:00:03.000\n<v Anna>We need escalation.</v>\n\n2\n00:00:03.000 --> 00:00:05.000\n<v Anna>We need escalation.</v>\n\n00:00:05.000 --> 00:00:06.000\n<v Ben>Which reasons?";
    expect(subtitlesToText(vtt)).toBe("Anna: We need escalation.\nBen: Which reasons?");
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nHello <i>there</i>\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond line";
    expect(subtitlesToText(srt)).toBe("Hello there\nSecond line");
  });
  it("reads .docx text from word/document.xml", () => {
    const xml = '<w:document><w:body><w:p><w:r><w:t>Client &amp; partner</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Line </w:t><w:tab/><w:t>two</w:t></w:r></w:p></w:body></w:document>';
    const buf = zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": xml });
    expect(readZipEntry(buf, "word/document.xml")!.toString()).toBe(xml);
    expect(readZipEntry(buf, "missing")).toBeUndefined();
    expect(docxToText(buf)).toBe("Client & partner\nLine \ttwo");
    expect(extractText("call.DOCX", buf)).toBe("Client & partner\nLine \ttwo");
    expect(() => docxToText(Buffer.from("not a zip at all, definitely not"))).toThrow(/\.docx/);
  });
  it("passes txt and md through, rejects other types", () => {
    expect(extractText("a.md", Buffer.from("﻿# Call"))).toBe("# Call");
    expect(extractText("a.txt", Buffer.from("x"))).toBe("x");
    expect(() => extractText("a.pdf", Buffer.from("x"))).toThrow(/Unsupported/);
  });
});

const FF = path.join(__dirname, "..", "fixtures", "project", "confluence");

/** A fake `claude -p` that records its args and prompt and answers with a recorded result. */
function fakeClaude(answer: (prompt: string) => { code?: number; stdout: string; stderr?: string }): ClaudeExec & { calls: { args: string[]; prompt: string }[] } {
  const calls: { args: string[]; prompt: string }[] = [];
  const f = (async (args: string[], prompt: string) => {
    calls.push({ args, prompt });
    const r = answer(prompt);
    return { code: r.code ?? 0, stdout: r.stdout, stderr: r.stderr ?? "" };
  }) as any;
  f.calls = calls;
  return f;
}

describe("Fireflies through the person's Fireflies MCP (read-only claude call)", () => {
  it("lists recent meetings with read-only tools only and drops bad ids", async () => {
    const out = await fsp.readFile(path.join(FF, "fireflies-recent.json"), "utf8");
    const c = fakeClaude(() => ({ stdout: out }));
    const list = await readFirefliesRecent(c, 500);
    expect(list).toEqual([{ id: "fireflies:01JD7K2M9Q", kind: "fireflies", title: "Support escalations call", date: "2026-11-01T15:00:00.000Z" }]);
    const args = c.calls[0].args;
    const allowed = args[args.indexOf("--allowedTools") + 1].split(",");
    expect(allowed.every((t) => /^mcp__[A-Za-z_]+__fireflies_get_transcripts?$/.test(t))).toBe(true);
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Bash");
    expect(c.calls[0].prompt).toContain("50 most recent");
    expect(args.join(" ")).not.toMatch(/api[_-]?key|token/i);
  });
  it("reads one meeting's metadata and never copies the transcript", async () => {
    const c = fakeClaude(() => ({ stdout: JSON.stringify({ type: "result", result: JSON.stringify({ meetings: [{ id: "01ABC", title: "Kickoff", date: "2026-11-01T10:00:00Z" }] }) }) }));
    expect(await readFirefliesMeta(c, "01ABC")).toEqual({ id: "fireflies:01ABC", kind: "fireflies", title: "Kickoff", date: "2026-11-01T10:00:00.000Z" });
    await expect(readFirefliesMeta(c, "bad id!")).rejects.toThrow(/Invalid/);
    const p = firefliesPointer("01ABC");
    expect(p).toContain("fireflies_get_transcript");
    expect(p).toContain("Source: fireflies:01ABC");
  });
  it("reports reader errors", async () => {
    const none = fakeClaude(() => ({ stdout: JSON.stringify({ type: "result", result: JSON.stringify({ meetings: [], error: "Fireflies MCP not connected" }) }) }));
    await expect(readFirefliesRecent(none, 5)).rejects.toThrow("Fireflies: Fireflies MCP not connected");
    const fail = fakeClaude(() => ({ code: 1, stdout: "", stderr: "" }));
    await expect(readFirefliesRecent(fail, 5)).rejects.toThrow(/not installed/);
    const isErr = fakeClaude(() => ({ stdout: JSON.stringify({ type: "result", is_error: true, result: "Not logged in" }) }));
    await expect(readFirefliesRecent(isErr, 5)).rejects.toThrow("claude: Not logged in");
  });
});

describe("Jira site", () => {
  it("normalises the site", () => {
    expect(siteUrl("https://acme.atlassian.net/")).toBe("https://acme.atlassian.net");
    expect(siteUrl("acme.atlassian.net")).toBe("https://acme.atlassian.net");
    expect(siteUrl("acme")).toBe("https://acme.atlassian.net");
    expect(siteUrl("https://<site>.atlassian.net")).toBeUndefined();
    expect(siteUrl("http://evil")).toBeUndefined();
    expect(siteUrl(undefined)).toBeUndefined();
  });
});
