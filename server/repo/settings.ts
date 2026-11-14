/**
 * The desk settings: one versioned JSON document in the `settings` row (id 1), validated by
 * `DeskSettings` on every read and every write. Before the first save the desk runs on the defaults
 * at version 0.
 *
 * A save is a statement guarded by the version the editor last saw: when someone saved in between
 * it changes 0 rows, and the caller answers 409 `stale`.
 */
import { DEFAULT_SETTINGS, parseDeskSettings, type DeskSettings } from "../../src/domain/settings";
import type { ValidationIssue } from "../../src/domain/validation";

/** A settings document failed validation. Carries paths and messages, never the values. */
export class InvalidSettingsError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(`settings document is invalid at ${issues.map((i) => i.path || "(root)").join(", ")}`);
    this.name = "InvalidSettingsError";
  }
}

function checked(doc: unknown): DeskSettings {
  const parsed = parseDeskSettings(doc);
  if (!parsed.ok) throw new InvalidSettingsError(parsed.error);
  return parsed.value;
}

export async function get(db: D1Database): Promise<{ version: number; settings: DeskSettings }> {
  const row = await db.prepare("SELECT version, doc_json FROM settings WHERE id = 1").first<{ version: number; doc_json: string }>();
  if (!row) return { version: 0, settings: DEFAULT_SETTINGS };
  return { version: row.version, settings: checked(JSON.parse(row.doc_json)) };
}

/** Throws `InvalidSettingsError` before touching the database when `settings` is not a valid document. */
export function saveStatement(
  db: D1Database,
  settings: DeskSettings,
  expectedVersion: number,
  actor: string,
  at: string = new Date().toISOString(),
): D1PreparedStatement {
  const docJson = JSON.stringify(checked(settings));
  if (expectedVersion === 0) {
    return db
      .prepare("INSERT INTO settings (id, version, doc_json, updated_by, updated_at) VALUES (1, 1, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
      .bind(docJson, actor, at);
  }
  return db
    .prepare("UPDATE settings SET version = version + 1, doc_json = ?, updated_by = ?, updated_at = ? WHERE id = 1 AND version = ?")
    .bind(docJson, actor, at, expectedVersion);
}
