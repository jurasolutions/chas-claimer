/**
 * The smallest set of synthetic rows a repository test needs: one import, one visit with its first
 * revision, and one claim on that visit at version 1 with last_action 'n0'. Nothing here identifies
 * anyone; the mask and hash are placeholders.
 */
export const SEED_AT = "2026-07-01T02:00:00.000Z";

export async function seedClaim(db: D1Database, claimId = "C-1"): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO imports (id, source, actor, started_at) VALUES ('imp-1', 'synthetic', 'a@example.com', ?)").bind(SEED_AT),
    db.prepare(
      `INSERT INTO visits (visit_key, current_revision, content_hash, branch_id, visit_date, patient_hash, patient_mask)
       VALUES ('V-1', 1, 'h1', 'BR-CENTRAL', '2026-07-01', 'v1:aa', 'T****000J')`,
    ),
    db
      .prepare(
        `INSERT INTO visit_revisions (visit_key, revision, import_id, content_hash, clinical_json, identity_sealed, created_at)
         VALUES ('V-1', 1, 'imp-1', 'h1', '{}', 'sealed', ?)`,
      )
      .bind(SEED_AT),
    db
      .prepare(
        `INSERT INTO claims (id, visit_key, payer_id, scheme, branch_id, status, last_action, rule_set_id, built_from_revision,
           fee_cents, claimed_cents, patient_hash, patient_mask, visit_date, created_at, updated_at)
         VALUES (?, 'V-1', 'CHAS', 'chas', 'BR-CENTRAL', 'ready', 'n0', 'chas-2026', 1, 8000, 6000, 'v1:aa', 'T****000J', '2026-07-01', ?, ?)`,
      )
      .bind(claimId, SEED_AT, SEED_AT),
  ]);
}
