/**
 * The append-only audit log (technical F7). Writes are statements for the caller to batch with the
 * change they record; the table's triggers refuse any update or delete.
 *
 * A guarded event is inserted only if the change it records went through, so a stale write (0 rows
 * changed) records nothing:
 * - a claim transition names its nonce, which the claim must now carry in `last_action`;
 * - a settings save names the version it wrote, and must come straight after that save in the batch
 *   (`changes()` reads the statement before it).
 */
import type { AuditDraft, AuditEntityType, AuditEvent } from "../../src/domain/types";

const COLUMNS = "INSERT INTO audit_events (at, actor, action, entity_type, entity_id, detail_json)";

export type AuditGuard = { claimId: string; nonce: string } | { settingsVersion: number };

export function auditStatement(db: D1Database, draft: AuditDraft, guard?: AuditGuard): D1PreparedStatement {
  const values = [draft.at, draft.actor, draft.action, draft.entityType, draft.entityId, JSON.stringify(draft.detail)];
  if (!guard) return db.prepare(`${COLUMNS} VALUES (?, ?, ?, ?, ?, ?)`).bind(...values);
  if ("settingsVersion" in guard)
    return db
      .prepare(`${COLUMNS} SELECT ?, ?, ?, ?, ?, ? FROM settings WHERE id = 1 AND version = ? AND changes() = 1`)
      .bind(...values, guard.settingsVersion);
  return db
    .prepare(`${COLUMNS} SELECT ?, ?, ?, ?, ?, ? FROM claims WHERE id = ? AND last_action = ?`)
    .bind(...values, guard.claimId, guard.nonce);
}

interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: AuditEvent["action"];
  entity_type: AuditEntityType;
  entity_id: string;
  detail_json: string;
}

/** Every event for one entity, oldest first. */
export async function list(db: D1Database, entity: { type: AuditEntityType; id: string }): Promise<AuditEvent[]> {
  const { results } = await db
    .prepare("SELECT id, at, actor, action, entity_type, entity_id, detail_json FROM audit_events WHERE entity_type = ? AND entity_id = ? ORDER BY id")
    .bind(entity.type, entity.id)
    .all<AuditRow>();
  return results.map((r) => ({
    id: r.id,
    at: r.at,
    actor: r.actor,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    detail: JSON.parse(r.detail_json) as Record<string, unknown>,
  }));
}
