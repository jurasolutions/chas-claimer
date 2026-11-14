/**
 * Reads a clinic's SQLite file (or a copy of it) in memory with sql.js. Read-only: the bytes are
 * loaded and the clinic's file is never written. Rows come in rowid order, so "appointments row 3"
 * is the third row a person sees in a SQLite browser.
 */
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from "sql.js";
import type { SourceSchema } from "../../src/domain/source-mapping";
import { checkColumns, noTable, type SourceRow, type TableSource } from "./source";

let SQL: SqlJsStatic | undefined;
const sqlite = async () => (SQL ??= await initSqlJs());

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function openSqlite(bytes: Uint8Array): Promise<TableSource> {
  const db = new (await sqlite()).Database(bytes);

  const tableNames = (): string[] =>
    all(db, "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => String(r[0]));
  const columnsOf = (table: string): string[] => all(db, `PRAGMA table_info(${quote(table)})`).map((r) => String(r[1]));

  return {
    async describe(): Promise<SourceSchema> {
      return { kind: "sqlite", tables: tableNames().map((name) => ({ name, columns: columnsOf(name) })) };
    },

    async rows(table, columns): Promise<SourceRow[]> {
      if (!tableNames().includes(table)) throw noTable(table);
      checkColumns(table, columnsOf(table), columns);
      const select = `SELECT ${columns.length > 0 ? columns.map(quote).join(", ") : "1"} FROM ${quote(table)}`;
      let found: SqlValue[][];
      try {
        found = all(db, `${select} ORDER BY rowid`);
      } catch {
        found = all(db, select); // a view or a WITHOUT ROWID table: the source's own order
      }
      return found.map((r, i) => ({
        where: `${table} row ${i + 1}`,
        values: Object.fromEntries(columns.map((c, j) => [c, r[j]])),
      }));
    },

    close: () => db.close(),
  };
}

function all(db: Database, sql: string): SqlValue[][] {
  const stmt = db.prepare(sql);
  try {
    const out: SqlValue[][] = [];
    while (stmt.step()) out.push(stmt.get());
    return out;
  } finally {
    stmt.free();
  }
}
