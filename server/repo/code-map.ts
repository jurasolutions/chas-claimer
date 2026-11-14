/**
 * The code map: which scheme or benefit code each clinic treatment code claims as. One row per
 * clinic code, target and payer (`""` for CHAS and TOSP).
 */
import type { UnmappedCode } from "../../src/api/settings";
import type { CodeMapEntry, CodeMapOrigin, CodeMapTarget } from "../../src/domain/types";

interface CodeMapRow {
  clinic_code: string;
  target: CodeMapTarget;
  payer_id: string;
  target_code: string | null;
  origin: CodeMapOrigin;
  updated_by: string;
  updated_at: string;
}

const toEntry = (r: CodeMapRow): CodeMapEntry => ({
  clinicCode: r.clinic_code,
  target: r.target,
  payerId: r.payer_id,
  targetCode: r.target_code,
  origin: r.origin,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

export async function get(db: D1Database): Promise<CodeMapEntry[]> {
  const { results } = await db
    .prepare("SELECT clinic_code, target, payer_id, target_code, origin, updated_by, updated_at FROM code_map ORDER BY clinic_code, target, payer_id")
    .all<CodeMapRow>();
  return results.map(toEntry);
}

/**
 * Clinic codes on the current revision of a live (not voided) visit that no code-map row covers,
 * with the description the clinic gave the first such line and how many visits carry it.
 */
export async function unmapped(db: D1Database): Promise<UnmappedCode[]> {
  const { results } = await db
    .prepare(
      `SELECT json_extract(t.value, '$.code') AS code,
              MIN(json_extract(t.value, '$.description')) AS description,
              COUNT(DISTINCT v.visit_key) AS n
       FROM visits v
       JOIN visit_revisions r ON r.visit_key = v.visit_key AND r.revision = v.current_revision
       JOIN json_each(r.clinical_json, '$.treatments') t
       WHERE COALESCE(json_extract(r.clinical_json, '$.voided'), 0) = 0
         AND NOT EXISTS (SELECT 1 FROM code_map m WHERE m.clinic_code = json_extract(t.value, '$.code'))
       GROUP BY code ORDER BY code`,
    )
    .all<{ code: string; description: string; n: number }>();
  return results.map((r) => ({ clinicCode: r.code, description: r.description, visits: r.n }));
}

/** The one entry at this key, or null. */
export async function find(db: D1Database, clinicCode: string, target: CodeMapTarget, payerId: string): Promise<CodeMapEntry | null> {
  const row = await db
    .prepare(
      "SELECT clinic_code, target, payer_id, target_code, origin, updated_by, updated_at FROM code_map WHERE clinic_code = ? AND target = ? AND payer_id = ?",
    )
    .bind(clinicCode, target, payerId)
    .first<CodeMapRow>();
  return row ? toEntry(row) : null;
}

export function deleteStatement(db: D1Database, clinicCode: string, target: CodeMapTarget, payerId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM code_map WHERE clinic_code = ? AND target = ? AND payer_id = ?").bind(clinicCode, target, payerId);
}

/** One upsert per entry, for the caller to put in its batch. */
export function saveStatements(db: D1Database, entries: readonly CodeMapEntry[]): D1PreparedStatement[] {
  return entries.map((e) =>
    db
      .prepare(
        `INSERT INTO code_map (clinic_code, target, payer_id, target_code, origin, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (clinic_code, target, payer_id) DO UPDATE SET
           target_code = excluded.target_code, origin = excluded.origin,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(e.clinicCode, e.target, e.payerId, e.targetCode, e.origin, e.updatedBy, e.updatedAt),
  );
}
