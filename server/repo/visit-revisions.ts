/**
 * Visit revisions not yet under the current identifier key, for the re-seal (infra I1, ADR 0006).
 * A revision's `identity_sealed` and `content_hash` carry the prefix of the key that wrote them
 * (`v<n>:`), and move together: a row whose sealed identity has another prefix is stale. The
 * progress count also spans the payment statement tables, for the rows a re-seal cannot move.
 */

export interface StaleRevision {
  visitKey: string;
  revision: number;
  contentHash: string;
  clinicalJson: string;
  identitySealed: string;
}

interface StaleRevisionDb {
  visit_key: string;
  revision: number;
  content_hash: string;
  clinical_json: string;
  identity_sealed: string;
}

/** Where a page starts: after this revision, in (visit key, revision) order. */
export interface RevisionAt {
  visitKey: string;
  revision: number;
}

const STALE = "substr(identity_sealed, 1, length(?1)) <> ?1";

/** Up to `limit` stale revisions after `after`, in (visit key, revision) order. */
export async function stalePage(db: D1Database, prefix: string, after: RevisionAt, limit: number): Promise<StaleRevision[]> {
  const { results } = await db
    .prepare(
      `SELECT visit_key, revision, content_hash, clinical_json, identity_sealed FROM visit_revisions
       WHERE ${STALE} AND (visit_key, revision) > (?2, ?3)
       ORDER BY visit_key, revision LIMIT ?4`,
    )
    .bind(prefix, after.visitKey, after.revision, limit)
    .all<StaleRevisionDb>();
  return results.map((r) => ({
    visitKey: r.visit_key,
    revision: r.revision,
    contentHash: r.content_hash,
    clinicalJson: r.clinical_json,
    identitySealed: r.identity_sealed,
  }));
}

export interface ResealCounts {
  /** Revisions not under the current key. */
  remaining: number;
  /** Payment statements whose file hash is under another key version (or an unknown one). */
  remittanceFiles: number;
  /** Statement lines under another key version whose patient has no visit, so nothing can move them. */
  remittanceLines: number;
}

/** What is left under keys other than the current one (`prefix`, `version`), in one query. */
export async function resealCounts(db: D1Database, key: { prefix: string; version: number }): Promise<ResealCounts> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT count(*) FROM visit_revisions WHERE ${STALE}) AS remaining,
         (SELECT count(*) FROM remittances WHERE key_version IS NOT ?2) AS files,
         (SELECT count(*) FROM remittance_lines
           WHERE patient_hash IS NOT NULL AND key_version IS NOT ?2
             AND patient_hash NOT IN (SELECT patient_hash FROM visits)) AS lines`,
    )
    .bind(key.prefix, key.version)
    .first<{ remaining: number; files: number; lines: number }>();
  return { remaining: row?.remaining ?? 0, remittanceFiles: row?.files ?? 0, remittanceLines: row?.lines ?? 0 };
}

/**
 * The re-key of one revision, for the caller's batch: the revision's sealed identity and content hash,
 * guarded on the values read so a concurrent change is left alone (the one update the
 * `visit_revisions` trigger allows, migration 0002), then the visit head's hash if it still points at
 * this revision's. The first statement's `changes` says whether the revision moved.
 */
export function rekeyStatements(
  db: D1Database,
  row: Pick<StaleRevision, "visitKey" | "revision" | "contentHash" | "identitySealed">,
  next: { identitySealed: string; contentHash: string },
): [D1PreparedStatement, D1PreparedStatement] {
  return [
    db
      .prepare(
        `UPDATE visit_revisions SET identity_sealed = ?, content_hash = ?
         WHERE visit_key = ? AND revision = ? AND identity_sealed = ? AND content_hash = ?`,
      )
      .bind(next.identitySealed, next.contentHash, row.visitKey, row.revision, row.identitySealed, row.contentHash),
    db.prepare("UPDATE visits SET content_hash = ? WHERE visit_key = ? AND content_hash = ?").bind(next.contentHash, row.visitKey, row.contentHash),
  ];
}
