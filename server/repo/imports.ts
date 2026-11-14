/** The imports log: one row per import, with its counts. Never carries a visit or an identifier. */
import type { ImportListItem } from "../../src/api/imports";
import type { ImportSource } from "../../src/domain/types";

interface ImportRowDb {
  id: string;
  source: ImportSource;
  actor: string;
  started_at: string;
  finished_at: string | null;
  received: number;
  new: number;
  changed: number;
  unchanged: number;
  ignored: number;
  flagged: number;
  refused: number;
}

/** An import as it starts: who sent it, how many visits arrived, how many failed validation. */
export interface ImportStart {
  id: string;
  source: ImportSource;
  actor: string;
  startedAt: string;
  received: number;
  refused: number;
}

/** What an import did once every visit has been looked at. */
export interface ImportCounts {
  new: number;
  changed: number;
  unchanged: number;
  /** Visits that repeated an earlier revision. */
  ignored: number;
  flagged: number;
}

/** Records an import as started. */
export function startStatement(db: D1Database, row: ImportStart): D1PreparedStatement {
  return db
    .prepare("INSERT INTO imports (id, source, actor, started_at, received, refused) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.source, row.actor, row.startedAt, row.received, row.refused);
}

/** Closes an import that was refused whole: it finished without writing a visit. */
export function refusedStatement(db: D1Database, id: string, finishedAt: string): D1PreparedStatement {
  return db.prepare("UPDATE imports SET finished_at = ? WHERE id = ?").bind(finishedAt, id);
}

/** Closes an import with its counts. */
export function finishStatement(db: D1Database, id: string, finishedAt: string, counts: ImportCounts): D1PreparedStatement {
  return db
    .prepare("UPDATE imports SET finished_at = ?, new = ?, changed = ?, unchanged = ?, ignored = ?, flagged = ? WHERE id = ?")
    .bind(finishedAt, counts.new, counts.changed, counts.unchanged, counts.ignored, counts.flagged, id);
}

/** The most recent imports, newest first. */
export async function recent(db: D1Database, limit = 20): Promise<ImportListItem[]> {
  const { results } = await db.prepare("SELECT * FROM imports ORDER BY started_at DESC, rowid DESC LIMIT ?").bind(limit).all<ImportRowDb>();
  return results.map((r) => ({
    id: r.id,
    source: r.source,
    actor: r.actor,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    received: r.received,
    new: r.new,
    changed: r.changed,
    unchanged: r.unchanged,
    ignored: r.ignored,
    flagged: r.flagged,
    refused: r.refused,
  }));
}
