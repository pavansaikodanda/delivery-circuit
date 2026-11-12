// A small read-only SQLite reader (no native module, no writes): enough to read Wispr Flow's local history database.
// It takes the database bytes (and the -wal file's bytes, if any) that the caller read with fs.readFile, so the original
// files are only ever opened for reading. Supports rowid tables (leaf/interior b-tree pages), overflow pages, UTF-8 and
// UTF-16 text and committed WAL frames. Not supported (not needed here): WITHOUT ROWID tables, index lookups.
// No vscode import.

export interface SqliteTable { name: string; rootpage: number; sql: string }
export type SqlValue = null | number | string | Uint8Array;

const MAX_ROWS = 50_000;
const MAX_PAGES_VISITED = 200_000;

export class SqliteReader {
  private pageSize: number;
  private usable: number;
  private encoding: "utf8" | "utf16le" | "utf16be";
  private wal = new Map<number, Buffer>();

  constructor(private db: Buffer, walBytes?: Buffer) {
    if (db.length < 100 || db.subarray(0, 16).toString("latin1") !== "SQLite format 3\u0000") throw new Error("Not an SQLite database");
    const ps = db.readUInt16BE(16);
    this.pageSize = ps === 1 ? 65536 : ps;
    if (this.pageSize < 512 || (this.pageSize & (this.pageSize - 1)) !== 0) throw new Error("Bad SQLite page size");
    this.usable = this.pageSize - db.readUInt8(20);
    const enc = db.readUInt32BE(56);
    this.encoding = enc === 2 ? "utf16le" : enc === 3 ? "utf16be" : "utf8";
    if (walBytes && walBytes.length >= 32) this.loadWal(walBytes);
  }

  /** Committed WAL frames whose salts match the WAL header: the newest copy of each page wins. */
  private loadWal(w: Buffer): void {
    const magic = w.readUInt32BE(0);
    if (magic !== 0x377f0682 && magic !== 0x377f0683) return;
    const ps = w.readUInt32BE(8);
    if (ps !== this.pageSize) return;
    const s1 = w.readUInt32BE(16), s2 = w.readUInt32BE(20);
    const pending = new Map<number, Buffer>();
    for (let off = 32; off + 24 + ps <= w.length; off += 24 + ps) {
      if (w.readUInt32BE(off + 8) !== s1 || w.readUInt32BE(off + 12) !== s2) break;
      const pgno = w.readUInt32BE(off);
      pending.set(pgno, w.subarray(off + 24, off + 24 + ps));
      if (w.readUInt32BE(off + 4) !== 0) { for (const [k, v] of pending) this.wal.set(k, v); pending.clear(); }
    }
  }

  private page(n: number): Buffer {
    const w = this.wal.get(n);
    if (w) return w;
    const start = (n - 1) * this.pageSize;
    if (n < 1 || start + this.pageSize > this.db.length) throw new Error(`SQLite page ${n} is outside the file`);
    return this.db.subarray(start, start + this.pageSize);
  }

  /** Every table in sqlite_master (name, root page, CREATE statement). */
  tables(): SqliteTable[] {
    const out: SqliteTable[] = [];
    for (const { values } of this.scan(1, MAX_ROWS)) {
      const [type, name, , rootpage, sql] = values;
      if (type === "table" && typeof name === "string" && typeof rootpage === "number" && rootpage > 0) out.push({ name, rootpage, sql: typeof sql === "string" ? sql : "" });
    }
    return out;
  }

  /** Rows of a table as objects keyed by column name (in rowid order; at most `limit`, the last ones when `last`). */
  rows(table: SqliteTable, o: { limit?: number; last?: boolean } = {}): Record<string, SqlValue>[] {
    if (/\bWITHOUT\s+ROWID\b/i.test(table.sql)) throw new Error(`${table.name} is a WITHOUT ROWID table`);
    const cols = parseColumns(table.sql);
    const all = this.scan(table.rootpage, MAX_ROWS);
    const pick = o.limit ? (o.last ? all.slice(-o.limit) : all.slice(0, o.limit)) : all;
    return pick.map(({ rowid, values }) => {
      const row: Record<string, SqlValue> = {};
      cols.forEach((c, i) => { row[c.name] = c.rowidAlias && values[i] == null ? rowid : (values[i] ?? null); });
      return row;
    });
  }

  private scan(root: number, max: number): { rowid: number; values: SqlValue[] }[] {
    const out: { rowid: number; values: SqlValue[] }[] = [];
    const stack = [root];
    const seen = new Set<number>();
    // depth-first, left to right, so rows come out in rowid order
    while (stack.length && out.length < max) {
      const n = stack.pop()!;
      if (seen.has(n) || seen.size > MAX_PAGES_VISITED) continue;
      seen.add(n);
      const p = this.page(n);
      const h = n === 1 ? 100 : 0;
      const type = p[h];
      const cells = p.readUInt16BE(h + 3);
      if (type === 0x05) {
        const right = p.readUInt32BE(h + 8);
        const kids: number[] = [];
        for (let i = 0; i < cells; i++) kids.push(p.readUInt32BE(p.readUInt16BE(h + 12 + i * 2)));
        stack.push(right, ...kids.reverse());
      } else if (type === 0x0d) {
        for (let i = 0; i < cells && out.length < max; i++) {
          let off = p.readUInt16BE(h + 8 + i * 2);
          const [size, a] = varint(p, off); off += a;
          const [rowid, b] = varint(p, off); off += b;
          out.push({ rowid: Number(rowid), values: this.record(this.payload(p, off, Number(size))) });
        }
      } else {
        throw new Error(`Unexpected SQLite b-tree page type ${type} on page ${n}`);
      }
    }
    return out;
  }

  /** The full cell payload, following overflow pages when it does not fit on the leaf. */
  private payload(p: Buffer, off: number, size: number): Buffer {
    const u = this.usable;
    const x = u - 35;
    if (size <= x) return p.subarray(off, off + size);
    const m = Math.floor(((u - 12) * 32) / 255) - 23;
    const k = m + ((size - m) % (u - 4));
    const local = k <= x ? k : m;
    const parts: Buffer[] = [p.subarray(off, off + local)];
    let left = size - local;
    let next = p.readUInt32BE(off + local);
    const seen = new Set<number>();
    while (left > 0 && next && !seen.has(next)) {
      seen.add(next);
      const op = this.page(next);
      const take = Math.min(left, u - 4);
      parts.push(op.subarray(4, 4 + take));
      left -= take;
      next = op.readUInt32BE(0);
    }
    return Buffer.concat(parts);
  }

  private record(buf: Buffer): SqlValue[] {
    const [hsize, a] = varint(buf, 0);
    const types: number[] = [];
    let off = a;
    while (off < Number(hsize)) { const [t, n] = varint(buf, off); types.push(Number(t)); off += n; }
    let pos = Number(hsize);
    return types.map((t) => {
      switch (t) {
        case 0: return null;
        case 1: pos += 1; return buf.readInt8(pos - 1);
        case 2: pos += 2; return buf.readInt16BE(pos - 2);
        case 3: pos += 3; return buf.readIntBE(pos - 3, 3);
        case 4: pos += 4; return buf.readInt32BE(pos - 4);
        case 5: pos += 6; return buf.readIntBE(pos - 6, 6);
        case 6: { pos += 8; const v = buf.readBigInt64BE(pos - 8); return Number(v); }
        case 7: pos += 8; return buf.readDoubleBE(pos - 8);
        case 8: return 0;
        case 9: return 1;
        default: {
          if (t < 12) return null;
          const len = t % 2 === 0 ? (t - 12) / 2 : (t - 13) / 2;
          const bytes = buf.subarray(pos, pos + len); pos += len;
          if (t % 2 === 0) return new Uint8Array(bytes);
          if (this.encoding === "utf8") return bytes.toString("utf8");
          if (this.encoding === "utf16le") return bytes.toString("utf16le");
          const sw = Buffer.from(bytes); sw.swap16(); return sw.toString("utf16le");
        }
      }
    });
  }
}

/** SQLite varint at off -> [value, bytes used]. */
export function varint(b: Buffer, off: number): [bigint, number] {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    const x = b[off + i];
    if (x === undefined) return [v, i || 1];
    v = (v << 7n) | BigInt(x & 0x7f);
    if (!(x & 0x80)) return [v, i + 1];
  }
  return [(v << 8n) | BigInt(b[off + 8] ?? 0), 9];
}

export interface ColumnDef { name: string; rowidAlias: boolean }

/** Column names from a CREATE TABLE statement (table constraints skipped; quotes, backticks and brackets removed). */
export function parseColumns(sql: string): ColumnDef[] {
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open < 0 || close <= open) return [];
  const body = sql.slice(open + 1, close);
  const parts: string[] = [];
  let depth = 0, cur = "", quote = "";
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"' || ch === "`" ) { quote = ch; cur += ch; continue; }
    if (ch === "[") { quote = "]"; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p && !/^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i.test(p)).map((p) => {
    const m = p.match(/^("([^"]|"")+"|`[^`]+`|\[[^\]]+\]|'[^']+'|\S+)\s*(.*)$/s)!;
    const name = m[1].replace(/^["`'[]|["`'\]]$/g, "").replace(/""/g, '"');
    return { name, rowidAlias: /^INTEGER\s+PRIMARY\s+KEY\b/i.test(m[3].trim()) && !/\bDESC\b/i.test(m[3]) };
  });
}
