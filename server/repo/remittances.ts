/**
 * Payment statements and their lines (technical §3). A line holds the match-key hash of the patient
 * the payer named, never the NRIC (ADR 0006); nothing read from here leaves the server with it.
 * Writes are statements for the caller's batch.
 */
import type { RemittanceListItem } from "../../src/api/remittances";
import type { IsoDate } from "../../src/domain/dates";
import type { MatchCandidate, RemittanceLine } from "../../src/domain/matcher";
import type { Cents } from "../../src/domain/money";
import type { ClaimStatus, PayerId, Scheme } from "../../src/domain/types";

export type MatchKind = "reference" | "patient_date_amount" | "manual";

interface RemittanceRowDb {
  id: string;
  payer_id: string;
  file_name: string;
  file_hash: string;
  imported_at: string;
  actor: string;
  lines: number;
  matched: number;
}

interface LineRowDb {
  line_no: number;
  portal_reference: string | null;
  patient_hash: string | null;
  visit_date: string | null;
  amount_cents: number;
  paid_on: string | null;
  claim_id: string | null;
  match_kind: MatchKind | null;
}

/** A stored line: what the matcher reads, plus when it was paid and what it matched. */
export interface StoredLine extends RemittanceLine {
  paidOn: IsoDate | null;
  claimId: string | null;
  matchKind: MatchKind | null;
}

/** A claim as the matcher and the line views need it. Masked: the hash and mask only. */
export interface ClaimFacts extends MatchCandidate {
  version: number;
  visitKey: string;
  scheme: Scheme;
  patientMask: string;
  claimedCents: Cents;
  acceptedCents: Cents | null;
  paidCents: Cents;
}

interface ClaimFactsRowDb {
  id: string;
  version: number;
  visit_key: string;
  scheme: Scheme;
  status: ClaimStatus;
  portal_reference: string | null;
  patient_hash: string;
  patient_mask: string;
  visit_date: string;
  claimed_cents: number;
  accepted_cents: number | null;
  paid_cents: number;
}

const toItem = (r: RemittanceRowDb): RemittanceListItem => ({
  id: r.id,
  payerId: r.payer_id,
  fileName: r.file_name,
  importedAt: r.imported_at,
  actor: r.actor,
  lines: r.lines,
  matched: r.matched,
});

const toFacts = (r: ClaimFactsRowDb): ClaimFacts => ({
  claimId: r.id,
  version: r.version,
  visitKey: r.visit_key,
  scheme: r.scheme,
  status: r.status,
  portalReference: r.portal_reference,
  patientHash: r.patient_hash,
  patientMask: r.patient_mask,
  visitDate: r.visit_date as IsoDate,
  claimedCents: r.claimed_cents as Cents,
  acceptedCents: r.accepted_cents as Cents | null,
  paidCents: r.paid_cents as Cents,
  outstandingCents: Math.max(0, (r.accepted_cents ?? r.claimed_cents) - r.paid_cents) as Cents,
});

export interface NewRemittance {
  id: string;
  payerId: PayerId;
  fileName: string;
  fileHash: string;
  /** The identifier key's version the file's hash, and each line's patient hash, were written under. */
  keyVersion: number;
  importedAt: string;
  actor: string;
}

export interface NewLine {
  lineNo: number;
  portalReference: string | null;
  patientHash: string | null;
  visitDate: IsoDate | null;
  amountCents: number;
  paidOn: IsoDate | null;
}

/** The file row, then its lines. The file row's `UNIQUE (payer_id, file_hash)` refuses the same file twice. */
export function insertStatements(db: D1Database, file: NewRemittance, lines: readonly NewLine[]): D1PreparedStatement[] {
  return [
    db
      .prepare("INSERT INTO remittances (id, payer_id, file_name, file_hash, key_version, imported_at, actor, lines) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(file.id, file.payerId, file.fileName, file.fileHash, file.keyVersion, file.importedAt, file.actor, lines.length),
    ...lines.map((l) =>
      db
        .prepare(
          "INSERT INTO remittance_lines (remittance_id, line_no, portal_reference, patient_hash, key_version, visit_date, amount_cents, paid_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(file.id, l.lineNo, l.portalReference, l.patientHash, l.patientHash === null ? null : file.keyVersion, l.visitDate, l.amountCents, l.paidOn),
    ),
  ];
}

/** Whether an insert failed on the file's `UNIQUE (payer_id, file_hash)`. */
export function isDuplicateFile(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed: remittances\.payer_id, remittances\.file_hash/.test(e.message);
}

/**
 * An earlier file of the payer's with the same name and line count whose hash was taken under a key
 * no longer in use (`versions` are the ones in use; an unknown version counts as retired). Its hash
 * can't be compared, so this is the closest the desk can come to recognising the same file again.
 */
export async function retiredLookalike(
  db: D1Database,
  file: { payerId: PayerId; fileName: string; lines: number },
  versions: readonly number[],
): Promise<string | null> {
  return (
    (await db
      .prepare(
        `SELECT id FROM remittances
         WHERE payer_id = ? AND file_name = ? AND lines = ?
           AND (key_version IS NULL OR key_version NOT IN (SELECT value FROM json_each(?)))
         ORDER BY imported_at DESC LIMIT 1`,
      )
      .bind(file.payerId, file.fileName, file.lines, JSON.stringify(versions))
      .first<string>("id")) ?? null
  );
}

/** The payer's file that carried any of `fileHashes` (the content under each key in use), if any. */
export async function byHash(db: D1Database, payerId: PayerId, fileHashes: readonly string[]): Promise<string | null> {
  return (
    (await db
      .prepare("SELECT id FROM remittances WHERE payer_id = ? AND file_hash IN (SELECT value FROM json_each(?)) LIMIT 1")
      .bind(payerId, JSON.stringify(fileHashes))
      .first<string>("id")) ?? null
  );
}

export async function get(db: D1Database, id: string): Promise<RemittanceListItem | null> {
  const row = await db.prepare("SELECT * FROM remittances WHERE id = ?").bind(id).first<RemittanceRowDb>();
  return row ? toItem(row) : null;
}

/** Every file, newest first. */
export async function list(db: D1Database, limit: number): Promise<RemittanceListItem[]> {
  const { results } = await db.prepare("SELECT * FROM remittances ORDER BY imported_at DESC, rowid DESC LIMIT ?").bind(limit).all<RemittanceRowDb>();
  return results.map(toItem);
}

export async function lines(db: D1Database, remittanceId: string): Promise<StoredLine[]> {
  const { results } = await db.prepare("SELECT * FROM remittance_lines WHERE remittance_id = ? ORDER BY line_no").bind(remittanceId).all<LineRowDb>();
  return results.map((r) => ({
    lineNo: r.line_no,
    portalReference: r.portal_reference,
    patientHash: r.patient_hash,
    visitDate: r.visit_date as IsoDate | null,
    amountCents: r.amount_cents,
    paidOn: r.paid_on as IsoDate | null,
    claimId: r.claim_id,
    matchKind: r.match_kind,
  }));
}

const FACTS = "SELECT id, version, visit_key, scheme, status, portal_reference, patient_hash, patient_mask, visit_date, claimed_cents, accepted_cents, paid_cents FROM claims";

/**
 * The payer's claims any of these lines could pay: those carrying one of the references, or for one
 * of the patients. Every status, so a line that points at a closed claim can say so.
 */
export async function candidates(db: D1Database, payerId: PayerId, forLines: readonly RemittanceLine[]): Promise<ClaimFacts[]> {
  const refs = [...new Set(forLines.flatMap((l) => (l.portalReference === null ? [] : [l.portalReference])))];
  const patients = [...new Set(forLines.flatMap((l) => (l.patientHash === null ? [] : [l.patientHash])))];
  if (refs.length === 0 && patients.length === 0) return [];
  const { results } = await db
    .prepare(
      `${FACTS} WHERE payer_id = ? AND (upper(trim(portal_reference)) IN (SELECT upper(trim(value)) FROM json_each(?)) OR patient_hash IN (SELECT value FROM json_each(?)))
       ORDER BY visit_date, visit_key`,
    )
    .bind(payerId, JSON.stringify(refs), JSON.stringify(patients))
    .all<ClaimFactsRowDb>();
  return results.map(toFacts);
}

/** Claims by id, whatever their payer. */
export async function claimFacts(db: D1Database, ids: readonly string[]): Promise<ClaimFacts[]> {
  if (ids.length === 0) return [];
  const { results } = await db
    .prepare(`${FACTS} WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify([...new Set(ids)]))
    .all<ClaimFactsRowDb>();
  return results.map(toFacts);
}

/** The payer's claims still waiting on money, oldest visit first, for a person's match. */
export async function openClaims(db: D1Database, payerId: PayerId, limit: number): Promise<ClaimFacts[]> {
  const { results } = await db
    .prepare(`${FACTS} WHERE payer_id = ? AND status IN ('submitted', 'accepted') ORDER BY visit_date, visit_key LIMIT ?`)
    .bind(payerId, limit)
    .all<ClaimFactsRowDb>();
  return results.map(toFacts);
}

/** The payer a claim belongs to, or null. */
export async function claimPayer(db: D1Database, claimId: string): Promise<PayerId | null> {
  return (await db.prepare("SELECT payer_id FROM claims WHERE id = ?").bind(claimId).first<string>("payer_id")) ?? null;
}

/**
 * Holds a line for a claim before its payment is recorded, so one line pays once. It changes the line
 * only while the line holds no claim and no other line of the file holds this one: the caller reads
 * this statement's own `meta.changes`, and 0 means another request got there first.
 */
export function reserveStatement(db: D1Database, remittanceId: string, lineNo: number, claimId: string, kind: MatchKind): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE remittance_lines SET claim_id = ?, match_kind = ?
       WHERE remittance_id = ? AND line_no = ? AND claim_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM remittance_lines WHERE remittance_id = ? AND claim_id = ?)`,
    )
    .bind(claimId, kind, remittanceId, lineNo, remittanceId, claimId);
}

/** Gives a held line back when its payment was not recorded. Only the hold for this claim. */
export function releaseStatement(db: D1Database, remittanceId: string, lineNo: number, claimId: string): D1PreparedStatement {
  return db
    .prepare("UPDATE remittance_lines SET claim_id = NULL, match_kind = NULL WHERE remittance_id = ? AND line_no = ? AND claim_id = ?")
    .bind(remittanceId, lineNo, claimId);
}

/** Sets the file's matched count from its lines and returns it. A recount, so it never depends on what changed before it. */
export function countMatchedStatement(db: D1Database, remittanceId: string): D1PreparedStatement {
  return db
    .prepare("UPDATE remittances SET matched = (SELECT count(*) FROM remittance_lines WHERE remittance_id = ? AND claim_id IS NOT NULL) WHERE id = ? RETURNING matched")
    .bind(remittanceId, remittanceId);
}
