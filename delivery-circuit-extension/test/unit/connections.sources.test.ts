// Sources page logic (no VS Code): validation, Fireflies-through-Claude listing, Wispr Flow history, the page state and
// PDF text extraction.
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { deflateSync } from "zlib";
import { createRequire } from "module";
import type { Identity, SourceRef } from "../../src/core/contracts";
import { contentText, PdfTextError, pdfToText } from "../../src/connections/pdf";
import {
  buildSourcesState, cleanTitle, combineWispr, defaultTitle, firefliesPrompt, insideRepo, isAllowedFirefliesTool, parseFirefliesMeetings, pickWisprColumns,
  readWisprHistory, subscriptionEnv, titleFromFile, toIso, validateAttach, validateText, wisprDbCandidates, wisprEntries, wisprPreview,
} from "../../src/connections/sourcesCore";
import { SqliteReader } from "../../src/connections/sqlite";

const who = (personas: Identity["personas"], active: Identity["active"]): Identity =>
  ({ login: "demo-architect", personas, active, isAdmin: false, owner: "acme-org", repo: "acme-shipping", orgOwned: true });

describe("validation and titles", () => {
  it("attachments: the six types, size limits", () => {
    for (const f of ["a.txt", "b.MD", "c.docx", "d.vtt", "e.srt", "f.pdf"]) expect(validateAttach(f, 10)).toBeUndefined();
    expect(validateAttach("x.mp3", 10)).toMatch(/use \.txt, \.md, \.docx, \.vtt, \.srt, \.pdf/);
    expect(validateAttach("x.txt", 0)).toMatch(/empty/);
    expect(validateAttach("x.txt", 21 * 1024 * 1024)).toMatch(/larger than 20 MB/);
  });
  it("text", () => {
    expect(validateText("   ")).toMatch(/no text/);
    expect(validateText("Kick-off notes")).toBeUndefined();
    expect(validateText("x".repeat(2_000_001))).toMatch(/longer than/);
  });
  it("titles are one clean line", () => {
    expect(cleanTitle("  Acme\nShipping\t kick-off ", "f")).toBe("Acme Shipping kick-off");
    expect(cleanTitle("", "fallback")).toBe("fallback");
    expect(cleanTitle("x".repeat(300), "f")).toHaveLength(120);
    expect(titleFromFile("/tmp/acme_shipping_kickoff.vtt")).toBe("acme shipping kickoff");
    expect(defaultTitle("wispr-flow", new Date("2026-11-12T09:30:00Z"))).toBe("Wispr Flow notes 2026-11-12 09:30");
    expect(defaultTitle("paste", new Date("2026-11-12T09:30:00Z"))).toBe("Notes 2026-11-12 09:30");
  });
  it("watch folders must be outside the repo", () => {
    expect(insideRepo("C:\\work\\repo\\notes", "C:\\Work\\Repo", "win32")).toBe(true);
    expect(insideRepo("C:\\work\\repo", "C:\\work\\repo", "win32")).toBe(true);
    expect(insideRepo("C:\\work\\repo-notes", "C:\\work\\repo", "win32")).toBe(false);
    expect(insideRepo("/home/a/repo/x", "/home/a/repo", "linux")).toBe(true);
    expect(insideRepo("/home/a/Repo/x", "/home/a/repo", "linux")).toBe(false);
    expect(insideRepo("/home/a/transcripts", "/home/a/repo", "darwin")).toBe(false);
  });
});

describe("Fireflies through the person's Claude", () => {
  it("the Agent SDK call never carries an API key", () => {
    const e = subscriptionEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-x", CLAUDE_CODE_OAUTH_TOKEN: "x", ANTHROPIC_AUTH_TOKEN: "y", CLAUDE_CODE_USE_BEDROCK: "1" });
    expect(e.PATH).toBe("/bin");
    for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"]) expect(k in e).toBe(false);
    expect(e.CLAUDE_AGENT_SDK_CLIENT_APP).toMatch(/^delivery-circuit-sources\//);
  });
  it("only Fireflies listing tools are allowed (any server name)", () => {
    expect(isAllowedFirefliesTool("mcp__fireflies__fireflies_get_transcripts")).toBe(true);
    expect(isAllowedFirefliesTool("mcp__claude_ai_Fireflies__fireflies_get_transcripts")).toBe(true);
    expect(isAllowedFirefliesTool("mcp__fireflies__fireflies_search")).toBe(true);
    expect(isAllowedFirefliesTool("StructuredOutput")).toBe(true);
    for (const t of ["mcp__fireflies__fireflies_get_transcript", "mcp__fireflies__fireflies_create_meeting_from_transcript", "Bash", "Read", "WebFetch", "mcp__x__slack_send_message"]) {
      expect(isAllowedFirefliesTool(t)).toBe(false);
    }
  });
  it("prompt asks for metadata only and clamps the count", () => {
    expect(firefliesPrompt(500)).toMatch(/^List my 50 most recent/);
    expect(firefliesPrompt(0)).toMatch(/^List my 1 most recent/);
    expect(firefliesPrompt(20)).toMatch(/do not fetch transcripts/);
  });
  it("parses and cleans the structured result", () => {
    const r = parseFirefliesMeetings({ meetings: [
      { id: "01KABCDEF", title: "Acme Shipping kick-off", date: "2026-11-10T15:00:00Z", durationMinutes: 42.4, organizer: "demo.user@example.com", participants: 5 },
      { id: "01KABCDEF", title: "duplicate", date: "2026-11-10T15:00:00Z" },
      { id: "../etc", title: "bad id", date: "2026-11-10" },
      { id: "02KXYZ", title: "", date: 1_794_500_000 },
      { id: "03KNODATE", title: "no date", date: "soon" },
    ] });
    expect(r.meetings.map((m) => m.id)).toEqual(["02KXYZ", "01KABCDEF"]);
    expect(r.meetings[1]).toEqual({ id: "01KABCDEF", title: "Acme Shipping kick-off", date: "2026-11-10T15:00:00.000Z", durationMin: 42, organizer: "demo.user@example.com", participants: 5 });
    expect(r.meetings[0].title).toBe("Untitled meeting");
    expect(parseFirefliesMeetings({ meetings: [], error: "No Fireflies tool available" })).toEqual({ meetings: [], error: "No Fireflies tool available" });
    expect(parseFirefliesMeetings(null)).toEqual({ meetings: [] });
  });
  it("dates from ISO, epoch seconds and milliseconds", () => {
    expect(toIso("2026-11-10T15:00:00Z")).toBe("2026-11-10T15:00:00.000Z");
    expect(toIso(1_762_786_800)).toBe(toIso(1_762_786_800_000));
    expect(toIso("1762786800")).toBe(toIso(1_762_786_800));
    expect(toIso("later")).toBeUndefined();
    expect(toIso(0)).toBeUndefined();
  });
});

describe("Wispr Flow history (read-only)", () => {
  it("locations per platform; none on Linux", () => {
    expect(wisprDbCandidates("darwin", { home: "/Users/demo" })).toEqual(["/Users/demo/Library/Application Support/Wispr Flow/flow.sqlite"]);
    const w = wisprDbCandidates("win32", { home: "C:\\Users\\demo", appData: "C:\\Users\\demo\\AppData\\Roaming" });
    expect(w[0]).toBe("C:\\Users\\demo\\AppData\\Roaming\\Wispr Flow\\flow.sqlite");
    expect(w[1]).toBe("C:\\Users\\demo\\AppData\\Local\\Wispr Flow\\flow.sqlite");
    expect(wisprDbCandidates("linux", { home: "/home/demo" })).toEqual([]);
  });
  it("picks the history table and its columns", () => {
    expect(pickWisprColumns([{ name: "Settings", columns: ["key", "value"] }, { name: "History", columns: ["id", "asrText", "formattedText", "timestamp", "app"] }]))
      .toEqual({ table: "History", text: "formattedText", time: "timestamp", app: "app" });
    expect(pickWisprColumns([{ name: "Settings", columns: ["key", "value"] }])).toBeUndefined();
  });
  it("entries newest first; edited text preferred; empty rows skipped", () => {
    const cols = { table: "History", text: "formattedText", time: "timestamp", app: "app" };
    const e = wisprEntries([
      { formattedText: "first note", timestamp: 1_762_000_000_000, app: "Slack" },
      { formattedText: "", asrText: "raw only", timestamp: 1_762_000_100_000, app: null },
      { formattedText: "  ", timestamp: 1_762_000_200_000 },
      { editedText: "edited wins", formattedText: "formatted", timestamp: 1_762_000_300_000, app: "Code" },
    ], cols);
    expect(e.map((x) => x.text)).toEqual(["formatted", "raw only", "first note"]);
    expect(e[2]).toMatchObject({ app: "Slack", at: "2025-11-01T12:26:40.000Z" });
    const combined = combineWispr(e);
    expect(combined.indexOf("first note")).toBeLessThan(combined.indexOf("formatted"));
    expect(combined).toMatch(/^\[2025-11-01 12:26 · Slack\]\nfirst note/);
    expect(wisprPreview({ key: "0", text: "a ".repeat(60), at: "2026-11-12T09:30:00.000Z", app: "Slack" }).label).toHaveLength(80);
  });

  const req = createRequire(__filename);
  let sqlite: any; try { sqlite = req("node:sqlite"); } catch { sqlite = undefined; }
  (sqlite ? it : it.skip)("reads a real flow.sqlite-like database without changing it", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dc-wispr-")), "flow.sqlite");
    const db = new sqlite.DatabaseSync(f);
    db.exec("CREATE TABLE History (transcriptEntityId TEXT PRIMARY KEY, asrText TEXT, formattedText TEXT, timestamp TEXT, app TEXT)");
    const ins = db.prepare("INSERT INTO History VALUES (?, ?, ?, ?, ?)");
    ins.run("a", "raw one", "Acme Shipping wants a tracking page", "2026-11-10 10:00:00", "Slack");
    ins.run("b", "raw two", null, "2026-11-11 10:00:00", "Code");
    db.close();
    const before = fs.readFileSync(f);
    const r = readWisprHistory(new SqliteReader(fs.readFileSync(f)));
    expect(r.columns).toMatchObject({ table: "History", text: "formattedText", time: "timestamp" });
    expect(r.entries.map((x) => x.text)).toEqual(["raw two", "Acme Shipping wants a tracking page"]);
    expect(fs.readFileSync(f).equals(before)).toBe(true);
  });
});

describe("page state", () => {
  const sources: SourceRef[] = [
    { id: "upload:abc123def456", kind: "upload", title: "Acme Shipping notes", date: "2026-11-09T10:00:00Z", usedBy: ["ACME-12"] },
    { id: "fireflies:01KABCDEF", kind: "fireflies", title: "Acme Shipping kick-off", date: "2026-11-10T15:00:00Z" },
  ];
  const base = {
    sources, origins: { "upload:abc123def456": "wispr-flow" as const },
    fireflies: { mcpState: "connected" as const, status: "ready" as const, meetings: [{ id: "01KABCDEF", title: "Acme Shipping kick-off", date: "2026-11-10T15:00:00.000Z" }, { id: "02KXYZ", title: "Weekly", date: "2026-11-11T15:00:00.000Z" }] },
    wispr: { platform: "darwin" as const, candidates: ["/Users/demo/Library/Application Support/Wispr Flow/flow.sqlite"] },
    watch: { active: false }, busy: ["paste"],
  };
  it("architect acting as architect: everything, newest first, origins and Fireflies links", () => {
    const s = buildSourcesState({ ...base, identity: who(["architect"], "architect") });
    expect(s.canAct).toBe(true);
    expect(s.reason).toBeUndefined();
    expect(s.sources.map((x) => [x.id, x.originLabel])).toEqual([["fireflies:01KABCDEF", "Fireflies"], ["upload:abc123def456", "Wispr Flow"]]);
    expect(s.sources[0].links[0].target).toBe("https://app.fireflies.ai/view/01KABCDEF");
    expect(s.fireflies.meetings.map((m) => m.indexed)).toEqual([true, false]);
    expect(s.wispr).toEqual({ supported: true, candidates: base.wispr.candidates });
    expect(s.busy).toEqual(["paste"]);
    expect(s.extensions).toEqual(["txt", "md", "docx", "vtt", "srt", "pdf"]);
  });
  it("architect acting as developer sees the list but cannot act", () => {
    const s = buildSourcesState({ ...base, identity: who(["architect", "developer"], "developer") });
    expect(s.canAct).toBe(false);
    expect(s.reason).toMatch(/Switch to acting as Architect/);
    expect(s.sources).toHaveLength(2);
  });
  it("other personas and signed-out people see no sources", () => {
    const d = buildSourcesState({ ...base, identity: who(["developer"], "developer") });
    expect(d.canAct).toBe(false);
    expect(d.sources).toEqual([]);
    expect(d.reason).toMatch(/architects team/);
    expect(buildSourcesState({ ...base, identity: null }).reason).toMatch(/Sign in to GitHub/);
  });
  it("no text of a transcript is in the state", () => {
    const s = buildSourcesState({ ...base, identity: who(["architect"], "architect") });
    expect(Object.keys(s.sources[0]).sort()).toEqual(["date", "id", "kind", "links", "origin", "originLabel", "title", "usedBy"]);
  });
});

describe("PDF text", () => {
  function pdf(content: string, compress = true): Buffer {
    const body = compress ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
    const head = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${body.length}${compress ? " /Filter /FlateDecode" : ""} >>\nstream\n`, "latin1");
    return Buffer.concat([head, body, Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")]);
  }
  it("reads Tj, TJ and line moves from a compressed stream", () => {
    const t = pdfToText(pdf("BT /F1 12 Tf 72 700 Td (Acme Shipping kick-off) Tj 0 -14 Td [(Speaker 1:) -250 (we need) -300 (tracking)] TJ ET"));
    expect(t).toBe("Acme Shipping kick-off\nSpeaker 1: we need tracking");
  });
  it("escapes, octal and UTF-16 hex strings", () => {
    expect(contentText("BT (a\\(b\\) \\101) Tj ET")).toBe("a(b) A\n");
    expect(contentText("BT <FEFF00480069> Tj ET")).toBe("Hi\n");
    expect(pdfToText(pdf("BT (plain stream) Tj ET", false))).toBe("plain stream");
  });
  it("refuses what is not a text PDF", () => {
    expect(() => pdfToText(Buffer.from("hello"))).toThrow(PdfTextError);
    expect(() => pdfToText(pdf("q 1 0 0 1 0 0 cm Q"))).toThrow(/no readable text/);
  });
});
