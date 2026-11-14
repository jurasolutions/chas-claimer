/**
 * Claims with their lines and findings (technical §3). Reads return `ClaimState`; writes are
 * statements for the caller's batch.
 *
 * Every write to a claim row is guarded by the version the writer read and stamps a fresh
 * `last_action` nonce. The statements that replace a claim's lines and findings, and any audit event
 * for the write, run only where the claim now carries that nonce, so a stale write changes nothing
 * at all (technical F7). The caller reads `meta.changes` of the claim statement to see whether it
 * landed.
 *
 * Nothing here reads or returns an identifier: a claim carries the patient's hash and mask.
 */
import { decodeCursor, encodeCursor } from "../cursor";
import { type ClaimFilter, type ClaimRow, OPEN_STATUSES } from "../../src/api/claims";
import type { Page } from "../../src/api/common";
import { type ClaimAnnotations, type DeadlineState, deadlineView, type DraftClaim, type PatientHistory } from "../../src/domain/claims/build";
import { claimDateOf } from "../../src/domain/claims/plan";
import { type ClaimLineState, type ClaimState, findingsInForce, UNSENT_STATUSES } from "../../src/domain/claims/state";
import { addDays, daysBetween, type IsoDate, sgtDay } from "../../src/domain/dates";
import type { Cents } from "../../src/domain/money";
import type { Channel, ClaimStatus, Finding, PayerId, Scheme } from "../../src/domain/types";
import * as settingsRepo from "./settings";
import { forPatientRange } from "./visits";

const PARAM_CHUNK = 90;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** Sorts claims without a deadline after every dated one. */
const NO_DEADLINE = "9999-12-31";
/** Stored when no rule set covered the visit (the column is NOT NULL). */
export const NO_RULE_SET = "none";

interface ClaimRowDb {
  id: string;
  visit_key: string;
  payer_id: string;
  scheme: Scheme;
  branch_id: string;
  status: ClaimStatus;
  version: number;
  last_action: string;
  rule_set_id: string;
  built_from_revision: number;
  approved_revision: number | null;
  submitted_revision: number | null;
  fee_cents: number;
  claimed_cents: number;
  paid_cents: number;
  accepted_cents: number | null;
  overpaid: number;
  deadline_date: string | null;
  portal_reference: string | null;
  channel: Channel | null;
  changed_after_submission: number;
  self_approved: number;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  patient_hash: string;
  patient_mask: string;
  visit_date: string;
  annotations_json: string;
  checkout_by: string | null;
  checkout_until: string | null;
  created_at: string;
  updated_at: string;
}

interface LineRowDb {
  claim_id: string;
  line_no: number;
  treatment_ref: string;
  scheme_code: string | null;
  tooth: string | null;
  quantity: number;
  fee_cents: number;
  considered_cents: number;
  claimed_cents: number;
}

interface FindingRowDb {
  claim_id: string;
  seq: number;
  code: Finding["code"];
  severity: Finding["severity"];
  params_json: string;
  rule_ref: string;
  line_no: number | null;
}

const toLine = (r: LineRowDb): ClaimLineState => ({
  lineNo: r.line_no,
  treatmentRef: Number(r.treatment_ref),
  schemeCode: r.scheme_code,
  tooth: r.tooth,
  quantity: r.quantity,
  feeCents: r.fee_cents as Cents,
  consideredCents: r.considered_cents as Cents,
  claimedCents: r.claimed_cents as Cents,
});

const toFinding = (r: FindingRowDb): Finding => ({
  code: r.code,
  severity: r.severity,
  params: JSON.parse(r.params_json) as Finding["params"],
  ...(r.rule_ref === "" ? {} : { ruleRef: r.rule_ref }),
  ...(r.line_no === null ? {} : { lineNo: r.line_no }),
});

function toState(r: ClaimRowDb, lines: ClaimLineState[], findings: Finding[]): ClaimState {
  return {
    id: r.id,
    visitKey: r.visit_key,
    payerId: r.payer_id,
    scheme: r.scheme,
    branchId: r.branch_id,
    status: r.status,
    version: r.version,
    lastAction: r.last_action,
    ruleSetId: r.rule_set_id,
    builtFromRevision: r.built_from_revision,
    approvedRevision: r.approved_revision,
    submittedRevision: r.submitted_revision,
    feeCents: r.fee_cents as Cents,
    claimedCents: r.claimed_cents as Cents,
    paidCents: r.paid_cents as Cents,
    acceptedCents: r.accepted_cents as Cents | null,
    overpaid: r.overpaid === 1,
    deadline: r.deadline_date as IsoDate | null,
    portalReference: r.portal_reference,
    channel: r.channel,
    changedAfterSubmission: r.changed_after_submission === 1,
    selfApproved: r.self_approved === 1,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    rejectionReason: r.rejection_reason,
    patientHash: r.patient_hash,
    patientMask: r.patient_mask,
    visitDate: r.visit_date as IsoDate,
    annotations: JSON.parse(r.annotations_json) as ClaimAnnotations[PayerId],
    checkoutBy: r.checkout_by,
    checkoutUntil: r.checkout_until,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lines,
    findings: findingsInForce(r.status, findings),
  };
}

async function inChunks<T>(ids: readonly string[], query: (chunk: string[], marks: string) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += PARAM_CHUNK) {
    const chunk = ids.slice(i, i + PARAM_CHUNK);
    out.push(...(await query(chunk, chunk.map(() => "?").join(", "))));
  }
  return out;
}

async function linesFor(db: D1Database, ids: readonly string[]): Promise<Map<string, ClaimLineState[]>> {
  const rows = await inChunks(ids, async (chunk, marks) => {
    const { results } = await db
      .prepare(`SELECT * FROM claim_lines WHERE claim_id IN (${marks}) ORDER BY claim_id, line_no`)
      .bind(...chunk)
      .all<LineRowDb>();
    return results;
  });
  const out = new Map<string, ClaimLineState[]>();
  for (const r of rows) out.set(r.claim_id, [...(out.get(r.claim_id) ?? []), toLine(r)]);
  return out;
}

async function findingsFor(db: D1Database, ids: readonly string[]): Promise<Map<string, Finding[]>> {
  const rows = await inChunks(ids, async (chunk, marks) => {
    const { results } = await db
      .prepare(`SELECT * FROM findings WHERE claim_id IN (${marks}) ORDER BY claim_id, seq`)
      .bind(...chunk)
      .all<FindingRowDb>();
    return results;
  });
  const out = new Map<string, Finding[]>();
  for (const r of rows) out.set(r.claim_id, [...(out.get(r.claim_id) ?? []), toFinding(r)]);
  return out;
}

async function withChildren(db: D1Database, rows: readonly ClaimRowDb[]): Promise<ClaimState[]> {
  const ids = rows.map((r) => r.id);
  const [lines, findings] = await Promise.all([linesFor(db, ids), findingsFor(db, ids)]);
  return rows.map((r) => toState(r, lines.get(r.id) ?? [], findings.get(r.id) ?? []));
}

/** One claim with its lines and findings, or null. */
export async function detail(db: D1Database, id: string): Promise<ClaimState | null> {
  const row = await db.prepare("SELECT * FROM claims WHERE id = ?").bind(id).first<ClaimRowDb>();
  if (!row) return null;
  return (await withChildren(db, [row]))[0]!;
}

/** Every claim on a visit, whatever its status, in payer order. */
export async function forVisit(db: D1Database, visitKey: string): Promise<ClaimState[]> {
  const { results } = await db.prepare("SELECT * FROM claims WHERE visit_key = ? ORDER BY payer_id").bind(visitKey).all<ClaimRowDb>();
  return withChildren(db, results);
}

/**
 * The patient's visits and claims dated within `window`, current revisions only: the history the
 * builder checks frequency limits, yearly caps and same-day rules against (see `historyWindow`).
 */
export async function history(db: D1Database, patientHash: string, window: { from: IsoDate; to: IsoDate }): Promise<PatientHistory> {
  const visits = await forPatientRange(db, patientHash, window.from, window.to);
  const byKey = new Map(visits.map((v) => [v.visitKey, v.clinical]));
  const { results } = await db
    .prepare("SELECT * FROM claims WHERE patient_hash = ? AND visit_date >= ? AND visit_date <= ? ORDER BY visit_date, visit_key, payer_id")
    .bind(patientHash, window.from, window.to)
    .all<ClaimRowDb>();
  const lines = await linesFor(
    db,
    results.map((r) => r.id),
  );
  return {
    visits: visits.map((v) => ({
      visitKey: v.visitKey,
      date: v.date,
      startTime: v.clinical.startTime,
      branchId: v.clinical.branchId,
      inProgressCodes: v.clinical.treatments.filter((t) => t.completion === "in_progress").map((t) => t.code),
    })),
    claims: results.map((r) => {
      const claimLines = lines.get(r.id) ?? [];
      const clinical = byKey.get(r.visit_key);
      const claimDate = clinical
        ? claimDateOf(
            clinical,
            claimLines.flatMap((l) => clinical.treatments[l.treatmentRef] ?? []),
          )
        : (r.visit_date as IsoDate);
      return {
        visitKey: r.visit_key,
        visitDate: r.visit_date as IsoDate,
        visitStartTime: clinical?.startTime ?? null,
        scheme: r.scheme,
        status: r.status,
        lines: claimLines.map((l) => ({ schemeCode: l.schemeCode, quantity: l.quantity })),
        payerId: r.payer_id,
        claimedCents: r.claimed_cents as Cents,
        claimDate,
      };
    }),
  };
}

type ListCursor = [deadlineKey: string, visitDate: string, id: string];

const isListCursor = (v: unknown): v is ListCursor => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "string");

/** A cursor that does not decode to a list position. The route answers 400 `invalid`. */
export class InvalidCursorError extends Error {
  constructor() {
    super("cursor is not a position in this list");
    this.name = "InvalidCursorError";
  }
}

/**
 * The queue: claims ordered by deadline (soonest first, undated last), then visit date. With no
 * status filter it shows the open statuses, or every status when only changed claims are asked for.
 * The deadline is worked out against `now` in SGT, and only for a claim still on the desk.
 */
export async function list(db: D1Database, filter: ClaimFilter, opts: { now: number }): Promise<Page<ClaimRow>> {
  const today = sgtDay(opts.now);
  const where: string[] = [];
  const params: unknown[] = [];
  const statuses = filter.status && filter.status.length > 0 ? filter.status : filter.changed ? null : OPEN_STATUSES;
  if (statuses) {
    where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (filter.scheme) where.push("scheme = ?"), params.push(filter.scheme);
  if (filter.payer) where.push("payer_id = ?"), params.push(filter.payer);
  if (filter.branch) where.push("branch_id = ?"), params.push(filter.branch);
  if (filter.due !== undefined) where.push("deadline_date BETWEEN ? AND ?"), params.push(today, addDays(today, filter.due));
  if (filter.changed) where.push("changed_after_submission = 1");
  if (filter.cursor !== undefined) {
    const position = decodeCursor(filter.cursor);
    if (!isListCursor(position)) throw new InvalidCursorError();
    where.push(`(COALESCE(deadline_date, '${NO_DEADLINE}'), visit_date, id) > (?, ?, ?)`);
    params.push(...position);
  }
  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const { results } = await db
    .prepare(
      `SELECT * FROM claims ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY COALESCE(deadline_date, '${NO_DEADLINE}'), visit_date, id LIMIT ?`,
    )
    .bind(...params, limit + 1)
    .all<ClaimRowDb>();
  const pageRows = results.slice(0, limit);
  const [findings, { settings }] = await Promise.all([
    findingsFor(
      db,
      pageRows.map((r) => r.id),
    ),
    settingsRepo.get(db),
  ]);
  const payerNames = new Map(settings.payers.map((p) => [p.id, p.name]));
  const branchNames = new Map(settings.branches.map((b) => [b.id, b.name]));
  const items = pageRows.map((r): ClaimRow => {
    const fs = findingsInForce(r.status, findings.get(r.id) ?? []);
    const onDesk = UNSENT_STATUSES.has(r.status) && r.deadline_date !== null;
    return {
      id: r.id,
      visitKey: r.visit_key,
      status: r.status,
      scheme: r.scheme,
      payerId: r.payer_id,
      payerName: payerNames.get(r.payer_id) ?? r.payer_id,
      branchId: r.branch_id,
      branchName: branchNames.get(r.branch_id) ?? r.branch_id,
      patientMask: r.patient_mask,
      visitDate: r.visit_date as IsoDate,
      feeCents: r.fee_cents as Cents,
      claimedCents: r.claimed_cents as Cents,
      deadline: onDesk
        ? deadlineView(r.deadline_date as IsoDate, today, daysBetween(r.visit_date as IsoDate, r.deadline_date as IsoDate))
        : null,
      changedAfterSubmission: r.changed_after_submission === 1,
      blockingCount: fs.filter((f) => f.severity === "blocking").length,
      findings: fs,
      version: r.version,
    };
  });
  const last = pageRows[pageRows.length - 1];
  const next = results.length > limit && last ? encodeCursor([last.deadline_date ?? NO_DEADLINE, last.visit_date, last.id] satisfies ListCursor) : null;
  return { items, next };
}

/** An unsent CHAS claim near or past its deadline, with the deadline finding it was last built with. */
export interface DeadlineCheck {
  visitKey: string;
  deadline: IsoDate;
  stored: DeadlineState;
}

/**
 * Unsent CHAS claims whose deadline falls on or before `until`, soonest first: the only claims whose
 * deadline finding can have moved since they were built, because time only runs forward.
 */
export async function deadlineChecks(db: D1Database, until: IsoDate): Promise<DeadlineCheck[]> {
  const unsent = [...UNSENT_STATUSES];
  const { results } = await db
    .prepare(
      `SELECT c.visit_key, c.deadline_date, f.code, f.params_json
         FROM claims c
         LEFT JOIN findings f ON f.claim_id = c.id AND f.code IN ('past_submission_window', 'deadline_approaching')
        WHERE c.scheme = 'chas' AND c.status IN (${unsent.map(() => "?").join(", ")})
          AND c.deadline_date IS NOT NULL AND c.deadline_date <= ?
        ORDER BY c.deadline_date, c.visit_key`,
    )
    .bind(...unsent, until)
    .all<{ visit_key: string; deadline_date: string; code: string | null; params_json: string | null }>();
  return results.map((r) => ({
    visitKey: r.visit_key,
    deadline: r.deadline_date as IsoDate,
    stored:
      r.code === "past_submission_window"
        ? { code: r.code }
        : r.code === "deadline_approaching"
          ? { code: r.code, daysLeft: (JSON.parse(r.params_json ?? "{}") as { daysLeft: number }).daysLeft }
          : null,
  }));
}

/** The visit facts every claim row copies, so the queue never joins to visits. */
export interface ClaimVisitFacts {
  visitKey: string;
  branchId: string;
  patientHash: string;
  patientMask: string;
  visitDate: IsoDate;
  revision: number;
}

/**
 * One build result to write. `existing` is the claim it replaces, read at `version`; without it the
 * claim is new. `status` is what the claim becomes (the draft's, or `approved` kept); with
 * `clearApproval` the approval is removed with it (decisions-g2 #13).
 */
export interface BuiltClaim {
  nonce: string;
  at: string;
  visit: ClaimVisitFacts;
  draft: DraftClaim;
  status: ClaimStatus;
  existing?: { id: string; version: number; clearApproval: boolean };
  /** The id for a new claim. */
  id?: string;
}

const CLEAR_APPROVAL =
  ", approved_revision = NULL, approved_by = NULL, approved_at = NULL, self_approved = 0, channel = NULL, checkout_by = NULL, checkout_until = NULL";

/**
 * The statements that write each build: the claim row first, then its lines and findings replaced
 * under the row's nonce. Index 0 of each claim's group is its claim statement; `claimStatementIndexes`
 * says where they are in the returned list.
 */
export function upsertBuiltStatements(db: D1Database, built: readonly BuiltClaim[]): { statements: D1PreparedStatement[]; claimStatementIndexes: number[] } {
  const statements: D1PreparedStatement[] = [];
  const claimStatementIndexes: number[] = [];
  for (const b of built) {
    const { draft, visit } = b;
    const id = b.existing?.id ?? b.id;
    if (!id) throw new Error("a new claim needs an id");
    claimStatementIndexes.push(statements.length);
    if (b.existing) {
      // An approval kept through a rebuild covers the content it was given for, which the new
      // revision carries unchanged, so it moves to that revision (technical F5).
      // SQLite reads every SET expression against the old row, so the new revision is bound, not
      // copied from built_from_revision.
      const keepApproval = !b.existing.clearApproval && b.status === "approved";
      const approval = b.existing.clearApproval ? CLEAR_APPROVAL : keepApproval ? ", approved_revision = ?" : "";
      statements.push(
        db
          .prepare(
            `UPDATE claims SET status = ?, version = version + 1, last_action = ?, rule_set_id = ?, built_from_revision = ?,
               fee_cents = ?, claimed_cents = ?, deadline_date = ?, branch_id = ?, patient_hash = ?, patient_mask = ?,
               visit_date = ?, updated_at = ?${approval}
             WHERE id = ? AND version = ?`,
          )
          .bind(
            b.status,
            b.nonce,
            draft.ruleSetId ?? NO_RULE_SET,
            visit.revision,
            draft.feeCents,
            draft.claimedCents,
            draft.deadline,
            visit.branchId,
            visit.patientHash,
            visit.patientMask,
            visit.visitDate,
            b.at,
            ...(keepApproval ? [visit.revision] : []),
            id,
            b.existing.version,
          ),
      );
    } else {
      statements.push(
        db
          .prepare(
            `INSERT INTO claims (id, visit_key, payer_id, scheme, branch_id, status, version, last_action, rule_set_id,
               built_from_revision, fee_cents, claimed_cents, deadline_date, patient_hash, patient_mask, visit_date,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (visit_key, payer_id) DO NOTHING`,
          )
          .bind(
            id,
            visit.visitKey,
            draft.payerId,
            draft.scheme,
            visit.branchId,
            b.status,
            b.nonce,
            draft.ruleSetId ?? NO_RULE_SET,
            visit.revision,
            draft.feeCents,
            draft.claimedCents,
            draft.deadline,
            visit.patientHash,
            visit.patientMask,
            visit.visitDate,
            b.at,
            b.at,
          ),
      );
    }
    const guard = "FROM claims WHERE id = ? AND last_action = ?";
    statements.push(
      db.prepare(`DELETE FROM claim_lines WHERE claim_id = ? AND EXISTS (SELECT 1 ${guard})`).bind(id, id, b.nonce),
      db.prepare(`DELETE FROM findings WHERE claim_id = ? AND EXISTS (SELECT 1 ${guard})`).bind(id, id, b.nonce),
      ...draft.lines.map((l) =>
        db
          .prepare(
            `INSERT INTO claim_lines (claim_id, line_no, treatment_ref, scheme_code, tooth, quantity, fee_cents, considered_cents, claimed_cents)
             SELECT id, ?, ?, ?, ?, ?, ?, ?, ? ${guard}`,
          )
          .bind(l.lineNo, String(l.treatmentRef), l.schemeCode, l.tooth, l.quantity, l.feeCents, l.consideredCents, l.claimedCents, id, b.nonce),
      ),
      ...draft.findings.map((f, seq) =>
        db
          .prepare(`INSERT INTO findings (claim_id, seq, code, severity, params_json, rule_ref, line_no) SELECT id, ?, ?, ?, ?, ?, ? ${guard}`)
          .bind(seq + 1, f.code, f.severity, JSON.stringify(f.params), f.ruleRef ?? "", f.lineNo ?? null, id, b.nonce),
      ),
    );
  }
  return { statements, claimStatementIndexes };
}

/** The columns a lifecycle transition may set. Lines, amounts and findings change only through a build. */
export interface ClaimPatch {
  updatedAt: string;
  status?: ClaimStatus;
  approvedRevision?: number | null;
  submittedRevision?: number | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  selfApproved?: boolean;
  channel?: Channel | null;
  portalReference?: string | null;
  paidCents?: Cents;
  acceptedCents?: Cents | null;
  overpaid?: boolean;
  rejectionReason?: string | null;
  changedAfterSubmission?: boolean;
  checkoutBy?: string | null;
  checkoutUntil?: string | null;
  annotations?: ClaimAnnotations[PayerId];
}

const PATCH_COLUMNS: Record<keyof ClaimPatch, string> = {
  updatedAt: "updated_at",
  status: "status",
  approvedRevision: "approved_revision",
  submittedRevision: "submitted_revision",
  approvedBy: "approved_by",
  approvedAt: "approved_at",
  selfApproved: "self_approved",
  channel: "channel",
  portalReference: "portal_reference",
  paidCents: "paid_cents",
  acceptedCents: "accepted_cents",
  overpaid: "overpaid",
  rejectionReason: "rejection_reason",
  changedAfterSubmission: "changed_after_submission",
  checkoutBy: "checkout_by",
  checkoutUntil: "checkout_until",
  annotations: "annotations_json",
};

/** One guarded write of a lifecycle transition: 0 rows changed when the claim moved on since `expectedVersion`. */
export function transitionStatement(db: D1Database, id: string, expectedVersion: number, nonce: string, patch: ClaimPatch): D1PreparedStatement {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of Object.keys(PATCH_COLUMNS) as (keyof ClaimPatch)[]) {
    if (!(key in patch)) continue;
    const value = patch[key];
    sets.push(`${PATCH_COLUMNS[key]} = ?`);
    values.push(key === "annotations" ? JSON.stringify(value) : typeof value === "boolean" ? Number(value) : value);
  }
  return db
    .prepare(`UPDATE claims SET ${sets.join(", ")}, version = version + 1, last_action = ? WHERE id = ? AND version = ?`)
    .bind(...values, nonce, id, expectedVersion);
}

/**
 * Extends the checklist hold `by` already has on a claim, leaving its version alone so a tab that
 * opened the checklist earlier can still record against it (QA D09). Changes nothing once the claim
 * has moved on or someone else holds it.
 */
export function extendCheckoutStatement(db: D1Database, id: string, expectedVersion: number, by: string, until: string): D1PreparedStatement {
  return db.prepare("UPDATE claims SET checkout_until = ? WHERE id = ? AND version = ? AND checkout_by = ?").bind(until, id, expectedVersion, by);
}

/** Who imported a visit's revision: approving your own import is recorded as a self-approval (AC-3.2). */
export async function importedBy(db: D1Database, visitKey: string, revision: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT i.actor FROM visit_revisions r JOIN imports i ON i.id = r.import_id WHERE r.visit_key = ? AND r.revision = ?")
    .bind(visitKey, revision)
    .first<{ actor: string }>();
  return row?.actor ?? null;
}
