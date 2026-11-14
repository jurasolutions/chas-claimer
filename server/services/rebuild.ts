/**
 * Rebuilding a visit's claims from its current revision (technical F5, decisions-g2 #13).
 *
 * - A claim already sent to its payer is a fixed input: its amount stays as sent, the downstream
 *   claims are built from it, and it is flagged changed after submission when the visit moved on.
 * - A closed claim (rejected, written off, withdrawn) is never touched or brought back.
 * - An unsent claim takes its new build. Any change to its lines, amounts or blocking findings
 *   clears an approval, audited `approval_cleared`.
 * - An unsent claim the visit no longer produces is withdrawn; a voided visit says why.
 * - What the build says about the visit as a whole (a held line, a payer with no claim and why, a
 *   warning on no one claim) is stored with the visit when it changes. A withdrawn claim the build
 *   would make again adds a note that the desk doesn't.
 *
 * Audit detail carries revisions, reasons and amounts, never an identifier.
 */
import { buildVisitClaims, type ClaimAnnotations, type DraftClaim, type FixedClaim, historyWindow, laterReach } from "../../src/domain/claims/build";
import { orderKey } from "../../src/domain/claims/plan";
import { CLOSED_STATUSES, type ClaimState, SENT_STATUSES, UNSENT_STATUSES } from "../../src/domain/claims/state";
import { type IsoDate, sgtDay } from "../../src/domain/dates";
import { canonicalJson, type ClinicalVisit } from "../../src/domain/source-visit";
import { type Actor, type AuditAction, actorId, type ClaimStatus, type Finding, type RebuildReason, type VisitNote } from "../../src/domain/types";
import { auditStatement } from "../repo/audit";
import * as claims from "../repo/claims";
import * as codeMap from "../repo/code-map";
import * as settingsRepo from "../repo/settings";
import { loadClinical, remarks, remarksStatement, type VisitRemarks } from "../repo/visits";
import { RETRY, withRetry } from "../retry";

export interface RebuildDeps {
  db: D1Database;
  now: number;
}

/** The visit as of its current revision, de-identified. */
export interface RebuildVisit {
  clinical: ClinicalVisit;
  revision: number;
  patientHash: string;
  patientMask: string;
}

export type { RebuildReason };

export interface RebuildPlan {
  statements: D1PreparedStatement[];
  /** Indexes into `statements` of the guarded claim writes; each must change exactly one row. */
  guardIndexes: number[];
  /** Sent claims newly marked changed after submission. */
  flagged: number;
}

/** A withdrawn claim keeps no approval and no checkout: neither can outlive the claim being sendable. */
const WITHDRAWN_CLEARS = {
  approvedRevision: null,
  approvedBy: null,
  approvedAt: null,
  selfApproved: false,
  channel: null,
  checkoutBy: null,
  checkoutUntil: null,
} satisfies Partial<claims.ClaimPatch>;

const lineKey = (l: { lineNo: number; treatmentRef: number; schemeCode: string | null; tooth: string | null; quantity: number; feeCents: number; consideredCents: number; claimedCents: number }) =>
  [l.lineNo, l.treatmentRef, l.schemeCode, l.tooth, l.quantity, l.feeCents, l.consideredCents, l.claimedCents];

const findingKey = (f: Finding) => ({ code: f.code, severity: f.severity, params: f.params, ruleRef: f.ruleRef ?? "", lineNo: f.lineNo ?? null });

const blockingKey = (fs: readonly Finding[]) =>
  canonicalJson(
    fs
      .filter((f) => f.severity === "blocking")
      .map((f) => [f.code, f.lineNo ?? null])
      .sort(),
  );

/** Lines, amounts or blocking findings differ: what an approval was given for (decisions-g2 #13). */
function materiallyDiffers(stored: ClaimState, draft: DraftClaim): boolean {
  return (
    stored.feeCents !== draft.feeCents ||
    stored.claimedCents !== draft.claimedCents ||
    canonicalJson(stored.lines.map(lineKey)) !== canonicalJson(draft.lines.map(lineKey)) ||
    blockingKey(stored.findings) !== blockingKey(draft.findings)
  );
}

/** Nothing a reader of the claim would see has changed. */
function identical(stored: ClaimState, draft: DraftClaim, revision: number): boolean {
  return (
    stored.builtFromRevision === revision &&
    !materiallyDiffers(stored, draft) &&
    stored.deadline === draft.deadline &&
    stored.ruleSetId === (draft.ruleSetId ?? claims.NO_RULE_SET) &&
    canonicalJson(stored.findings.map(findingKey)) === canonicalJson(draft.findings.map(findingKey)) &&
    (stored.status === draft.status || stored.status === "approved")
  );
}

/**
 * Reads what the build needs, builds, and returns the statements that write the result. The caller
 * runs them in one batch with whatever else it is writing (a new revision, say).
 */
export async function rebuildStatements(deps: RebuildDeps, visit: RebuildVisit, actor: Actor, reason: RebuildReason): Promise<RebuildPlan> {
  const { db, now } = deps;
  const { clinical, revision } = visit;
  const today = sgtDay(now);
  const at = new Date(now).toISOString();
  const [history, existing, { settings }, map, stored] = await Promise.all([
    claims.history(db, visit.patientHash, historyWindow(clinical.date)),
    claims.forVisit(db, clinical.visitKey),
    settingsRepo.get(db),
    codeMap.get(db),
    remarks(db, clinical.visitKey),
  ]);
  const fixed: FixedClaim[] = existing
    .filter((c) => SENT_STATUSES.has(c.status))
    .map((c) => ({ payerId: c.payerId, scheme: c.scheme, claimedCents: c.claimedCents }));
  const annotations: ClaimAnnotations = Object.fromEntries(existing.map((c) => [c.payerId, c.annotations]));
  const built = buildVisitClaims({ visit: clinical, settings, codeMap: map, history, fixed, annotations, today });

  const facts: claims.ClaimVisitFacts = {
    visitKey: clinical.visitKey,
    branchId: clinical.branchId,
    patientHash: visit.patientHash,
    patientMask: visit.patientMask,
    visitDate: clinical.date,
    revision,
  };
  const plan: RebuildPlan = { statements: [], guardIndexes: [], flagged: 0 };
  const actorName = actorId(actor);
  const audit = (claimId: string, nonce: string, action: AuditAction, detail: Record<string, unknown>) =>
    auditStatement(db, { at, actor: actorName, action, entityType: "claim", entityId: claimId, detail: { revision, reason, ...detail } }, { claimId, nonce });
  const guarded = (statement: D1PreparedStatement) => {
    plan.guardIndexes.push(plan.statements.length);
    plan.statements.push(statement);
  };

  const byPayer = new Map(existing.map((c) => [c.payerId, c]));
  const drafts = new Map(built.claims.map((d) => [d.payerId, d]));

  for (const c of existing) {
    if (CLOSED_STATUSES.has(c.status)) continue;
    const nonce = crypto.randomUUID();
    if (SENT_STATUSES.has(c.status)) {
      if (c.changedAfterSubmission || c.submittedRevision === revision || c.builtFromRevision === revision) continue;
      guarded(claims.transitionStatement(db, c.id, c.version, nonce, { changedAfterSubmission: true, updatedAt: at }));
      plan.statements.push(audit(c.id, nonce, "flagged_changed", { claimedCents: c.claimedCents, voided: clinical.voided }));
      plan.flagged += 1;
      continue;
    }
    const draft = drafts.get(c.payerId);
    if (!draft) {
      guarded(claims.transitionStatement(db, c.id, c.version, nonce, { status: "withdrawn", updatedAt: at, ...WITHDRAWN_CLEARS }));
      plan.statements.push(audit(c.id, nonce, "withdraw", { from: c.status, why: clinical.voided ? "voided_in_clinic" : "no_longer_built" }));
      continue;
    }
    if (identical(c, draft, revision)) continue;
    const clearApproval = c.status === "approved" && materiallyDiffers(c, draft);
    const status: ClaimStatus = c.status === "approved" && !clearApproval ? "approved" : draft.status;
    const { statements, claimStatementIndexes } = claims.upsertBuiltStatements(db, [
      { nonce, at, visit: facts, draft, status, existing: { id: c.id, version: c.version, clearApproval } },
    ]);
    plan.guardIndexes.push(plan.statements.length + claimStatementIndexes[0]!);
    plan.statements.push(...statements);
    plan.statements.push(
      audit(c.id, nonce, clearApproval ? "approval_cleared" : "rebuilt", {
        from: c.status,
        to: status,
        claimedCents: { before: c.claimedCents, after: draft.claimedCents },
      }),
    );
  }

  for (const draft of built.claims) {
    if (byPayer.has(draft.payerId)) continue;
    const id = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const { statements, claimStatementIndexes } = claims.upsertBuiltStatements(db, [{ nonce, at, visit: facts, draft, status: draft.status, id }]);
    plan.guardIndexes.push(plan.statements.length + claimStatementIndexes[0]!);
    plan.statements.push(...statements);
    plan.statements.push(audit(id, nonce, "built", { status: draft.status, claimedCents: draft.claimedCents }));
  }

  const rebuiltWithdrawn = existing.some((c) => c.status === "withdrawn" && drafts.has(c.payerId));
  const remark: VisitRemarks = {
    notes: rebuiltWithdrawn ? [...built.visitNotes, WITHDRAWN_NOTE] : built.visitNotes,
    findings: built.visitFindings,
  };
  if (stored === null || canonicalJson(stored) !== canonicalJson(remark)) {
    plan.statements.push(remarksStatement(db, clinical.visitKey, revision, remark));
  }
  return plan;
}

const WITHDRAWN_NOTE: VisitNote = { code: "withdrawn_not_rebuilt", params: {} };

/** Every guarded claim write changed its one row: nothing moved under the rebuild. */
export const landed = (results: readonly D1Result[], guardIndexes: readonly number[]): boolean =>
  guardIndexes.every((i) => results[i]?.meta.changes === 1);

export class RebuildConflictError extends Error {
  constructor(readonly visitKey: string) {
    super(`claims for ${visitKey} kept changing during the rebuild`);
    this.name = "RebuildConflictError";
  }
}

export interface RebuildCounts {
  rebuilt: number;
  flagged: number;
}

/**
 * Rebuilds each visit's claims from its current revision, one batch per visit. A batch whose guarded
 * writes missed (a claim moved on since it was read) changes nothing and is tried again from fresh
 * reads, up to three times.
 */
export async function rebuildVisits(deps: RebuildDeps, visitKeys: readonly string[], actor: Actor, reason: RebuildReason): Promise<RebuildCounts> {
  const counts: RebuildCounts = { rebuilt: 0, flagged: 0 };
  for (const key of visitKeys) {
    await withRetry(async () => {
      const current = await loadClinical(deps.db, key);
      if (!current) return;
      const plan = await rebuildStatements(deps, current, actor, reason);
      if (plan.statements.length === 0) return;
      const results = await deps.db.batch(plan.statements);
      if (!landed(results, plan.guardIndexes)) return RETRY;
      counts.rebuilt += 1;
      counts.flagged += plan.flagged;
    }, () => new RebuildConflictError(key));
  }
  return counts;
}

/**
 * Rebuilds the patient's later visits whose limits count this visit's claims, oldest first, so each
 * reads the history the one before it just wrote. Only visits with an unsent claim are rebuilt: a
 * sent claim's amount is fixed, and the rebuild leaves it unflagged since its own visit is unchanged.
 */
export async function rebuildLaterVisits(
  deps: RebuildDeps,
  visit: { visitKey: string; date: IsoDate; startTime: string | null; patientHash: string },
  actor: Actor,
  reason: RebuildReason,
): Promise<RebuildCounts> {
  const here = orderKey(visit.date, visit.startTime, visit.visitKey);
  const later = await claims.history(deps.db, visit.patientHash, { from: visit.date, to: laterReach(visit.date) });
  const unsent = new Set(later.claims.filter((c) => UNSENT_STATUSES.has(c.status)).map((c) => c.visitKey));
  const keys = later.visits
    .map((v) => ({ key: v.visitKey, order: orderKey(v.date, v.startTime, v.visitKey) }))
    .filter((v) => unsent.has(v.key) && v.order > here)
    .sort((a, b) => (a.order < b.order ? -1 : 1))
    .map((v) => v.key);
  return rebuildVisits(deps, keys, actor, reason);
}
