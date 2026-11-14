/**
 * Visits and their revisions (technical §3). A visit's head row says which revision is current;
 * `visit_revisions` is append-only and holds each revision's de-identified clinical JSON beside its
 * sealed identity.
 *
 * Writing a revision is two statements for the caller's batch. The revision's primary key
 * (visit_key, revision) is the concurrency lock: two imports that both read revision N and both try
 * to write N + 1 collide there, the loser's whole batch rolls back, and it re-reads the head and
 * tries again (`isRevisionConflict`).
 */
import type { IsoDate } from "../../src/domain/dates";
import type { ClinicalVisit, VisitIdentity } from "../../src/domain/source-visit";
import type { Finding, VisitNote } from "../../src/domain/types";
import { type IdentifierKeys, openIdentity } from "../crypto";

export interface VisitHead {
  revision: number;
  contentHash: string;
}

export interface NewRevision {
  visitKey: string;
  revision: number;
  /** The revision the writer read as current; 0 for a visit the desk has not seen. */
  previousRevision: number;
  importId: string;
  contentHash: string;
  clinical: ClinicalVisit;
  identitySealed: string;
  patientHash: string;
  patientMask: string;
  createdAt: string;
}

const PARAM_CHUNK = 90;

export async function heads(db: D1Database, visitKeys: readonly string[]): Promise<Map<string, VisitHead>> {
  const out = new Map<string, VisitHead>();
  const keys = [...new Set(visitKeys)];
  for (let i = 0; i < keys.length; i += PARAM_CHUNK) {
    const chunk = keys.slice(i, i + PARAM_CHUNK);
    const { results } = await db
      .prepare(`SELECT visit_key, current_revision, content_hash FROM visits WHERE visit_key IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<{ visit_key: string; current_revision: number; content_hash: string }>();
    for (const r of results) out.set(r.visit_key, { revision: r.current_revision, contentHash: r.content_hash });
  }
  return out;
}

/**
 * The revision of this visit that carried any of `contentHashes` (the content under each key in use),
 * if any: an older payload arriving late.
 */
export async function revisionWithHash(db: D1Database, visitKey: string, contentHashes: readonly string[]): Promise<number | null> {
  const row = await db
    .prepare(
      "SELECT revision FROM visit_revisions WHERE visit_key = ? AND content_hash IN (SELECT value FROM json_each(?)) ORDER BY revision DESC LIMIT 1",
    )
    .bind(visitKey, JSON.stringify(contentHashes))
    .first<{ revision: number }>();
  return row?.revision ?? null;
}

/** Moves the head from `previousRevision` and appends the revision. */
export function revisionStatements(db: D1Database, rev: NewRevision): D1PreparedStatement[] {
  const c = rev.clinical;
  return [
    db
      .prepare(
        `INSERT INTO visits (visit_key, current_revision, content_hash, branch_id, visit_date, patient_hash, patient_mask)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (visit_key) DO UPDATE SET
           current_revision = excluded.current_revision, content_hash = excluded.content_hash,
           branch_id = excluded.branch_id, visit_date = excluded.visit_date,
           patient_hash = excluded.patient_hash, patient_mask = excluded.patient_mask
         WHERE visits.current_revision = ?`,
      )
      .bind(rev.visitKey, rev.revision, rev.contentHash, c.branchId, c.date, rev.patientHash, rev.patientMask, rev.previousRevision),
    db
      .prepare(
        `INSERT INTO visit_revisions (visit_key, revision, import_id, content_hash, clinical_json, identity_sealed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(rev.visitKey, rev.revision, rev.importId, rev.contentHash, JSON.stringify(c), rev.identitySealed, rev.createdAt),
  ];
}

/** A batch failed because another writer took the same revision number first. */
export function isRevisionConflict(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed: visit_revisions\./.test(message);
}

export interface CurrentVisit {
  revision: number;
  patientHash: string;
  patientMask: string;
  clinical: ClinicalVisit;
}

/** The current revision's de-identified visit, or null for a visit the desk has not seen. */
export async function loadClinical(db: D1Database, visitKey: string): Promise<CurrentVisit | null> {
  const row = await db
    .prepare(
      `SELECT v.current_revision, v.patient_hash, v.patient_mask, r.clinical_json
       FROM visits v JOIN visit_revisions r ON r.visit_key = v.visit_key AND r.revision = v.current_revision
       WHERE v.visit_key = ?`,
    )
    .bind(visitKey)
    .first<{ current_revision: number; patient_hash: string; patient_mask: string; clinical_json: string }>();
  if (!row) return null;
  return {
    revision: row.current_revision,
    patientHash: row.patient_hash,
    patientMask: row.patient_mask,
    clinical: JSON.parse(row.clinical_json) as ClinicalVisit,
  };
}

/** The de-identified clinical record as it stood at `revision`, e.g. the one a claim was built from. */
export async function clinicalAt(db: D1Database, visitKey: string, revision: number): Promise<ClinicalVisit | null> {
  const row = await db
    .prepare("SELECT clinical_json FROM visit_revisions WHERE visit_key = ? AND revision = ?")
    .bind(visitKey, revision)
    .first<{ clinical_json: string }>();
  return row ? (JSON.parse(row.clinical_json) as ClinicalVisit) : null;
}

/** What the last build said about the visit as a whole: notes, and findings on no one claim. */
export interface VisitRemarks {
  notes: VisitNote[];
  findings: Finding[];
}

/** The visit's remarks as its last rebuild stored them, or null for a visit the desk has not seen. */
export async function remarks(db: D1Database, visitKey: string): Promise<VisitRemarks | null> {
  const row = await db
    .prepare("SELECT notes_json, findings_json FROM visits WHERE visit_key = ?")
    .bind(visitKey)
    .first<{ notes_json: string; findings_json: string }>();
  return row ? { notes: JSON.parse(row.notes_json) as VisitNote[], findings: JSON.parse(row.findings_json) as Finding[] } : null;
}

/** Stores the remarks built from `revision`; a visit that has moved on to a later revision keeps its own. */
export function remarksStatement(db: D1Database, visitKey: string, revision: number, r: VisitRemarks): D1PreparedStatement {
  return db
    .prepare("UPDATE visits SET notes_json = ?, findings_json = ? WHERE visit_key = ? AND current_revision = ?")
    .bind(JSON.stringify(r.notes), JSON.stringify(r.findings), visitKey, revision);
}

/** Opens the current revision's sealed identity. Only identity routes call this. */
export async function loadIdentity(db: D1Database, k: IdentifierKeys, visitKey: string): Promise<VisitIdentity | null> {
  const row = await db
    .prepare(
      `SELECT r.revision, r.identity_sealed FROM visits v
       JOIN visit_revisions r ON r.visit_key = v.visit_key AND r.revision = v.current_revision
       WHERE v.visit_key = ?`,
    )
    .bind(visitKey)
    .first<{ revision: number; identity_sealed: string }>();
  if (!row) return null;
  return openIdentity(k, row.identity_sealed, { visitKey, revision: row.revision });
}

/** The patient's visits dated `from` to `to` inclusive, current revisions only, oldest first. */
export async function forPatientRange(
  db: D1Database,
  patientHash: string,
  from: IsoDate,
  to: IsoDate,
): Promise<{ visitKey: string; date: IsoDate; clinical: ClinicalVisit }[]> {
  const { results } = await db
    .prepare(
      `SELECT v.visit_key, v.visit_date, r.clinical_json FROM visits v
       JOIN visit_revisions r ON r.visit_key = v.visit_key AND r.revision = v.current_revision
       WHERE v.patient_hash = ? AND v.visit_date >= ? AND v.visit_date <= ?
       ORDER BY v.visit_date, v.visit_key`,
    )
    .bind(patientHash, from, to)
    .all<{ visit_key: string; visit_date: IsoDate; clinical_json: string }>();
  return results.map((r) => ({ visitKey: r.visit_key, date: r.visit_date, clinical: JSON.parse(r.clinical_json) as ClinicalVisit }));
}
