/**
 * A small in-memory stand-in for a Cloudflare D1 binding, built on sql.js
 * (SQLite compiled to WebAssembly). It implements the parts of the D1 API the
 * Functions use: prepare/bind, first, run, all, batch and exec. The real
 * migrations from `migrations/` are applied, so tests exercise the schema
 * production runs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from "sql.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../migrations");

let SQL: SqlJsStatic | undefined;

class Statement {
  constructor(
    private db: Database,
    private sql: string,
    private params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new Statement(this.db, this.sql, params);
  }

  private rows(): Record<string, unknown>[] {
    const stmt = this.db.prepare(this.sql);
    try {
      stmt.bind(this.params.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v)) as SqlValue[]);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const rows = this.rows();
    if (rows.length === 0) return null;
    return (column ? rows[0]![column] : rows[0]) as T;
  }

  async all<T = Record<string, unknown>>() {
    const results = this.rows() as T[];
    return { success: true, results, meta: { changes: this.db.getRowsModified() } };
  }

  async run<T = Record<string, unknown>>() {
    return this.runSync<T>();
  }

  /** Runs without yielding, so a batch cannot interleave with another caller's statements. */
  runSync<T = Record<string, unknown>>() {
    const results = this.rows() as T[];
    return { success: true, results, meta: { changes: this.db.getRowsModified() } };
  }

  async raw() {
    return this.rows().map((r) => Object.values(r));
  }
}

export async function createD1({ migrate = true } = {}): Promise<D1Database> {
  SQL ??= await initSqlJs();
  const db = new SQL.Database();
  db.exec("PRAGMA foreign_keys = ON;");

  if (migrate && fs.existsSync(MIGRATIONS)) {
    for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS, file), "utf8"));
    }
  }

  const d1 = {
    prepare: (sql: string) => new Statement(db, sql),
    // D1 runs each batch as one transaction, serialised with every other query. Running the whole
    // batch synchronously gives the same guarantee here: concurrent callers cannot interleave.
    async batch(statements: Statement[]) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const statement of statements) out.push(statement.runSync());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump() {
      throw new Error("dump is not supported by the test D1");
    },
  };
  return d1 as unknown as D1Database;
}
