// The read-only SQLite reader used for the Wispr Flow history import, checked against databases Node's own SQLite
// (node:sqlite) writes: rollback journal and WAL mode, overflow pages, many pages, rowid aliases.
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import { parseColumns, SqliteReader, varint } from "../../src/connections/sqlite";

const req = createRequire(__filename);
let sqlite: any;
try { sqlite = req("node:sqlite"); } catch { sqlite = undefined; }
const withSqlite = sqlite ? describe : describe.skip;

function tmpDb(): string { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dc-sqlite-")), "flow.sqlite"); }
const read = (f: string) => new SqliteReader(fs.readFileSync(f), fs.existsSync(f + "-wal") ? fs.readFileSync(f + "-wal") : undefined);

describe("sqlite helpers", () => {
  it("varints", () => {
    expect(varint(Buffer.from([0x05]), 0)).toEqual([5n, 1]);
    expect(varint(Buffer.from([0x81, 0x00]), 0)).toEqual([128n, 2]);
    expect(varint(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0)[1]).toBe(9);
  });
  it("column names from CREATE TABLE", () => {
    expect(parseColumns('CREATE TABLE "History" ("id" INTEGER PRIMARY KEY, `asrText` TEXT, [app name] TEXT, ts INTEGER DEFAULT (strftime(\'%s\',\'now\')), PRIMARY KEY (x), CONSTRAINT c CHECK (1))'))
      .toEqual([{ name: "id", rowidAlias: true }, { name: "asrText", rowidAlias: false }, { name: "app name", rowidAlias: false }, { name: "ts", rowidAlias: false }]);
  });
  it("refuses a file that is not SQLite", () => {
    expect(() => new SqliteReader(Buffer.from("hello world".repeat(20)))).toThrow(/Not an SQLite/);
  });
});

withSqlite("reads what node:sqlite wrote", () => {
  it("rollback-journal database with overflow pages and an interior b-tree", () => {
    const f = tmpDb();
    const db = new sqlite.DatabaseSync(f);
    db.exec("CREATE TABLE History (id INTEGER PRIMARY KEY, formattedText TEXT, timestamp INTEGER, app TEXT, score REAL, raw BLOB)");
    const ins = db.prepare("INSERT INTO History (formattedText, timestamp, app, score, raw) VALUES (?, ?, ?, ?, ?)");
    db.exec("BEGIN"); // one transaction: 1500 autocommits each fsync and can time out on a busy Windows disk
    for (let i = 1; i <= 1500; i++) ins.run(`note ${i} ` + "x".repeat(i % 50 === 0 ? 9000 : 30), 1_762_000_000_000 + i, i % 2 ? "Slack" : null, i / 4, Buffer.from([i % 256]));
    db.exec("COMMIT");
    db.close();
    const r = read(f);
    const t = r.tables().find((x) => x.name === "History")!;
    expect(t).toBeTruthy();
    const all = r.rows(t);
    expect(all).toHaveLength(1500);
    expect(all[0]).toMatchObject({ id: 1, timestamp: 1_762_000_000_001, app: "Slack", score: 0.25 });
    expect(all[49].formattedText).toHaveLength("note 50 ".length + 9000);
    expect(all[1].app).toBeNull();
    const last = r.rows(t, { limit: 2, last: true });
    expect(last.map((x) => x.id)).toEqual([1499, 1500]);
  });

  it("WAL database: committed rows still in the -wal file are read", () => {
    const f = tmpDb();
    const db = new sqlite.DatabaseSync(f);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE History (id INTEGER PRIMARY KEY, asrText TEXT)");
    const ins = db.prepare("INSERT INTO History (asrText) VALUES (?)");
    for (let i = 1; i <= 300; i++) ins.run(`dictation ${i}`);
    // read while the writer is still open, as when Wispr Flow is running
    expect(fs.existsSync(f + "-wal")).toBe(true);
    const r = read(f);
    const rows = r.rows(r.tables().find((x) => x.name === "History")!);
    expect(rows).toHaveLength(300);
    expect(rows[299]).toEqual({ id: 300, asrText: "dictation 300" });
    db.close();
  });

  it("never writes: the database bytes are unchanged after reading", () => {
    const f = tmpDb();
    const db = new sqlite.DatabaseSync(f);
    db.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('one'), ('two');");
    db.close();
    const before = fs.readFileSync(f);
    const mtime = fs.statSync(f).mtimeMs;
    read(f).rows(read(f).tables()[0]);
    expect(fs.readFileSync(f).equals(before)).toBe(true);
    expect(fs.statSync(f).mtimeMs).toBe(mtime);
  });
});
