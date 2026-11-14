/**
 * Taking a lifecycle action on a claim (decisions-g2 §2, functional AC-3.1 to AC-3.7).
 *
 * `act` reads the claim, checks the caller saw the version it is acting on, asks the pure lifecycle
 * what the claim becomes, and writes the change and its audit events in one batch. The claim write
 * is guarded by the version read and stamps a fresh nonce; the audit events and any submissions row
 * are inserted only where the claim carries that nonce, so a write that lost a race records nothing.
 */
import type { ClaimDetail, ClaimDetailLine, SiblingClaim, SubmissionView } from "../../src/api/claim-detail";
import { MAX_ACTION_TEXT, MAX_BATCH_ITEMS, MAX_PORTAL_REFERENCE } from "../../src/api/claim-limits";
import { deadlineState, type DeadlineState, deadlineView, frozenSplit, splitAcross } from "../../src/domain/claims/build";
import { daysBetween, sgtDay } from "../../src/domain/dates";
import { allowedActions, applyAction, type LifecycleError } from "../../src/domain/lifecycle";
import { listRuleSets } from "../../src/domain/rules";
import { CLOSED_STATUSES, type ClaimState, UNSENT_STATUSES } from "../../src/domain/claims/state";
import { add, type Cents, cents } from "../../src/domain/money";
import { err, ok, type Result } from "../../src/domain/result";
import { canonicalJson, type ClinicalVisit, type VisitIdentity } from "../../src/domain/source-visit";
import type { DeskSettings } from "../../src/domain/settings";
import {
  actorId,
  IDENTITY_FIELDS,
  type Actor,
  type AuditAction,
  type Channel,
  type ClaimAction,
  type Finding,
  type IdentityField,
  type PayerId,
  type SplitSegment,
  type VisitNote,
} from "../../src/domain/types";
import { sha256Hex } from "../bytes";
import type { IdentifierKeys } from "../crypto";
import * as audit from "../repo/audit";
import { auditStatement } from "../repo/audit";
import * as claims from "../repo/claims";
import * as settingsRepo from "../repo/settings";
import * as submissions from "../repo/submissions";
import type { SubmissionResult } from "../repo/submissions";
import { loadClinical, loadIdentity, remarks, type VisitRemarks } from "../repo/visits";
import { same as sameDeadline } from "./deadlines";
import { RebuildConflictError, type RebuildDeps, type RebuildReason, rebuildVisits } from "./rebuild";

export type ClaimDeps = RebuildDeps;

export type ActError =
  | LifecycleError
  /** No claim has this id (404). */
  | { code: "not_found" }
  /** The claim moved on since the caller read it (409). */
  | { code: "stale"; currentVersion: number }
  /** Another officer has the claim's checklist open (409). */
  | { code: "checked_out"; by: string; until: string }
  /** Another claim to the same payer was submitted with this portal reference (409). */
  | { code: "reference_taken"; portalReference: string };

/** The lifecycle columns a transition may change; lines, amounts and findings change only through a build. */
const PATCH_FIELDS = [
  "status",
  "approvedRevision",
  "submittedRevision",
  "approvedBy",
  "approvedAt",
  "selfApproved",
  "channel",
  "portalReference",
  "paidCents",
  "acceptedCents",
  "overpaid",
  "rejectionReason",
  "changedAfterSubmission",
  "checkoutBy",
  "checkoutUntil",
] as const satisfies readonly (keyof claims.ClaimPatch & keyof ClaimState)[];

function patchBetween(before: ClaimState, after: ClaimState, at: string): claims.ClaimPatch {
  const patch: Record<string, unknown> & { updatedAt: string } = { updatedAt: at };
  for (const key of PATCH_FIELDS) if (before[key] !== after[key]) patch[key] = after[key];
  return patch as claims.ClaimPatch;
}

export interface ActOptions {
  /**
   * What a submit sent, masked, and the hash of the packet. A channel that built its own packet
   * passes it; without one the attempt records the claim's masked summary (`summaryPacket`).
   */
  packet?: { masked: unknown; hash: string };
  /** The export batch a file-channel submit belongs to. */
  batchRef?: string;
}

/** How each channel's submission is recorded when it goes through. */
const SUBMITTED_AS: Record<Channel, SubmissionResult> = { assisted: "checklist", file: "exported", api: "sent", simulator: "sent" };

export async function act(
  deps: ClaimDeps,
  claimId: string,
  action: ClaimAction,
  expectedVersion: number,
  actor: Actor,
  opts: ActOptions = {},
): Promise<Result<ClaimState, ActError>> {
  const { db } = deps;
  const seen = await claims.detail(db, claimId);
  if (!seen) return err({ code: "not_found" });
  if (seen.version !== expectedVersion) return err({ code: "stale", currentVersion: seen.version });
  const current = await withTodaysDeadline(deps, seen, action, actor);
  if (!current.ok) return current;
  const claim = current.value;

  const at = new Date(deps.now).toISOString();
  const [importer, { settings }] = await Promise.all([claims.importedBy(db, claim.visitKey, claim.builtFromRevision), settingsRepo.get(db)]);
  const payer = settings.payers.find((p) => p.id === claim.payerId);
  const transition = applyAction(claim, action, actor, at, { importedBy: importer ?? undefined, channel: payer?.channel });
  if (!transition.ok) return transition;

  const nonce = crypto.randomUUID();
  const attempt = action.kind === "submit" || action.kind === "portal_refused" ? await submissionAttempt(deps, claim, action, actor, at, opts) : null;
  if (attempt && !attempt.ok) return attempt;
  let write: D1Result | undefined;
  try {
    [write] = await db.batch([
      claims.transitionStatement(db, claim.id, claim.version, nonce, patchBetween(claim, transition.value.next, at)),
      ...transition.value.audit.map((a) => auditStatement(db, a, { claimId: claim.id, nonce })),
      ...(attempt ? [submissions.submissionStatement(db, attempt.value, { nonce })] : []),
    ]);
  } catch (e) {
    // The schema refuses a portal reference that already names another claim at this payer.
    if (attempt?.value.portalReference && submissions.isReferenceTaken(e)) {
      return err({ code: "reference_taken", portalReference: attempt.value.portalReference });
    }
    throw e;
  }
  if (write?.meta.changes !== 1) {
    const current = await claims.detail(db, claim.id);
    return current ? err({ code: "stale", currentVersion: current.version }) : err({ code: "not_found" });
  }
  if (REBUILDS_VISIT.has(action.kind)) await rebuildAfter(deps, claim.visitKey, actor);
  return ok((await claims.detail(db, claim.id))!);
}

export type Annotations = ClaimState["annotations"];

/** What each annotation may hold: a clinical justification, or a reference the payer gave. */
export const ANNOTATION_LIMITS = { justification: MAX_ACTION_TEXT, preAuthReference: MAX_PORTAL_REFERENCE, mcafReference: MAX_PORTAL_REFERENCE } as const satisfies Record<keyof Annotations, number>;

/** Trims each value and drops empty ones; refuses a field the desk does not keep or a value too long. */
function cleanAnnotations(input: Record<string, unknown>): Result<Annotations, ActError> {
  const out: Record<string, string> = {};
  for (const [field, value] of Object.entries(input)) {
    if (!Object.hasOwn(ANNOTATION_LIMITS, field)) return err({ code: "invalid", field, problem: "The desk does not keep this annotation." });
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return err({ code: "invalid", field, problem: "An annotation is text." });
    const trimmed = value.trim();
    const max = ANNOTATION_LIMITS[field as keyof Annotations];
    if (trimmed.length > max) return err({ code: "invalid", field, problem: `Keep this to ${max} characters or fewer.` });
    if (trimmed) out[field] = trimmed;
  }
  return ok(out as Annotations);
}

/**
 * Replaces a claim's annotations, the justification and payer references its build reads (AC-2.8,
 * technical `PUT /api/claims/:id/annotations`), then rebuilds the visit so the findings answer them:
 * a justification of 20 characters or more clears a benchmark finding. Only a claim not yet sent
 * takes annotations; what was sent stays as sent. The audit trail records which fields changed,
 * never what they say.
 */
export async function saveAnnotations(
  deps: ClaimDeps,
  claimId: string,
  input: Record<string, unknown>,
  expectedVersion: number,
  actor: Actor,
): Promise<Result<ClaimState, ActError>> {
  const { db } = deps;
  if (actor.kind !== "person") return err({ code: "forbidden", detail: `${actorId(actor)} may not annotate a claim.` });
  const claim = await claims.detail(db, claimId);
  if (!claim) return err({ code: "not_found" });
  if (claim.version !== expectedVersion) return err({ code: "stale", currentVersion: claim.version });
  if (!UNSENT_STATUSES.has(claim.status)) {
    return err({ code: "not_allowed", detail: `A ${claim.status.replace(/_/g, " ")} claim keeps the annotations it had.` });
  }
  const cleaned = cleanAnnotations(input);
  if (!cleaned.ok) return cleaned;
  const annotations = cleaned.value;
  const fields = (Object.keys(ANNOTATION_LIMITS) as (keyof Annotations)[]).filter((f) => (claim.annotations[f] ?? null) !== (annotations[f] ?? null));
  if (fields.length === 0) return ok(claim);

  const at = new Date(deps.now).toISOString();
  const nonce = crypto.randomUUID();
  const [write] = await db.batch([
    claims.transitionStatement(db, claim.id, claim.version, nonce, { updatedAt: at, annotations }),
    auditStatement(
      db,
      { at, actor: actorId(actor), action: "annotations_saved", entityType: "claim", entityId: claim.id, detail: { fields } },
      { claimId: claim.id, nonce },
    ),
  ]);
  if (write?.meta.changes !== 1) {
    const current = await claims.detail(db, claim.id);
    return current ? err({ code: "stale", currentVersion: current.version }) : err({ code: "not_found" });
  }
  await rebuildAfter(deps, claim.visitKey, actor, "annotations");
  return ok((await claims.detail(db, claim.id))!);
}

/** A claim as the caller saw it when they selected it. */
export interface BatchItem {
  id: string;
  version: number;
}

export interface BatchOutcome {
  /** Claims the action went through for, with the warnings each carried when approved (S17). */
  done: { id: string; version: number; warnings: number }[];
  /** Claims it did not, and why: the screen names each one (AC-3.4). */
  failed: { id: string; error: ActError }[];
}

/**
 * Approve, or take back approval of, several claims (AC-3.4). Each claim goes through `act` on its
 * own, at the version the caller selected it at, so a claim that changed since (and may now carry a
 * warning the reviewer never saw, S17) fails as stale instead of being approved unseen, and the rest
 * go through. Claims are taken one at a time: each approval reads the payer settings and the
 * importer afresh, and a batch is at most `MAX_BATCH_ITEMS`.
 */
export async function actMany(
  deps: ClaimDeps,
  items: readonly BatchItem[],
  action: { kind: "approve" } | { kind: "unapprove" },
  actor: Actor,
): Promise<Result<BatchOutcome, Extract<LifecycleError, { code: "invalid" }>>> {
  if (items.length === 0 || items.length > MAX_BATCH_ITEMS) {
    return err({ code: "invalid", field: "items", problem: `A batch takes between 1 and ${MAX_BATCH_ITEMS} claims.` });
  }
  const outcome: BatchOutcome = { done: [], failed: [] };
  for (const item of items) {
    const result = await act(deps, item.id, action, item.version, actor);
    if (result.ok) {
      const warnings = result.value.findings.filter((f) => f.severity === "warning").length;
      outcome.done.push({ id: item.id, version: result.value.version, warnings });
    } else {
      outcome.failed.push({ id: item.id, error: result.error });
    }
  }
  return ok(outcome);
}

/** Actions that commit a claim to its payer, and so must see today's deadline, not the one it was built with. */
const DEADLINE_GATED: ReadonlySet<ClaimAction["kind"]> = new Set(["approve", "submit"]);

/** The deadline finding a claim was last built with. */
function storedDeadline(claim: ClaimState): DeadlineState {
  for (const f of claim.findings) {
    if (f.code === "past_submission_window") return { code: f.code };
    if (f.code === "deadline_approaching") return { code: f.code, daysLeft: (f.params as { daysLeft: number }).daysLeft };
  }
  return null;
}

/**
 * The claim to act on (AC-3.5, decisions-g2 #5). Before an approval or a submission, a CHAS claim
 * whose deadline finding has moved since it was built is rebuilt for today, the same rebuild the queue
 * load runs, so a window that closed overnight shows on the claim and the lifecycle refuses the action
 * against the claim as it now is. The caller saw the version before this rebuild; the rebuild is the
 * desk's own correction, not another officer's change, so it does not make the caller's version stale.
 */
async function withTodaysDeadline(deps: ClaimDeps, claim: ClaimState, action: ClaimAction, actor: Actor): Promise<Result<ClaimState, ActError>> {
  if (!DEADLINE_GATED.has(action.kind) || claim.scheme !== "chas" || !claim.deadline) return ok(claim);
  if (sameDeadline(storedDeadline(claim), deadlineState(claim.deadline, sgtDay(deps.now)))) return ok(claim);
  try {
    await rebuildVisits(deps, [claim.visitKey], actor, "deadline");
  } catch (e) {
    if (!(e instanceof RebuildConflictError)) throw e;
    const moved = await claims.detail(deps.db, claim.id);
    return moved ? err({ code: "stale", currentVersion: moved.version }) : err({ code: "not_found" });
  }
  const fresh = await claims.detail(deps.db, claim.id);
  return fresh ? ok(fresh) : err({ code: "not_found" });
}

/**
 * Actions after which the visit is rebuilt: a claim leaving or rejoining the waterfall changes what
 * the payers below it are asked for, and a reopened claim is rebuilt from the visit as it is now.
 */
const REBUILDS_VISIT: ReadonlySet<ClaimAction["kind"]> = new Set(["reject", "portal_refused", "reopen"]);

/**
 * The action has landed; a rebuild that keeps colliding with other writes is left to the next import,
 * settings change or queue load rather than failing an action already recorded.
 */
async function rebuildAfter(deps: ClaimDeps, visitKey: string, actor: Actor, reason: RebuildReason = "lifecycle"): Promise<void> {
  try {
    await rebuildVisits(deps, [visitKey], actor, reason);
  } catch (e) {
    if (!(e instanceof RebuildConflictError)) throw e;
  }
}

/**
 * Records a send that failed without the payer refusing the claim: a timeout, a dropped connection,
 * a server error (S6, AC-4.6). The claim stays approved and can be sent again; the attempt is kept
 * with its error, and the audit trail records that it failed but not the error text.
 *
 * The claim's version moves on, so the attempt and its audit event are written only if nothing else
 * changed the claim since it was read.
 */
export async function recordFailedSubmission(
  deps: ClaimDeps,
  claimId: string,
  actor: Actor,
  failure: { error: string } & ActOptions,
): Promise<Result<ClaimState, ActError>> {
  const { db } = deps;
  const claim = await claims.detail(db, claimId);
  if (!claim) return err({ code: "not_found" });
  if (claim.status !== "approved") {
    return err({ code: "not_allowed", detail: `A ${claim.status.replace(/_/g, " ")} claim is not waiting to be sent.` });
  }
  const at = new Date(deps.now).toISOString();
  const holder = heldByAnother(claim, actor, at);
  if (holder) return err({ code: "checked_out", ...holder });

  const channel = claim.channel ?? "assisted";
  const packet = failure.packet ?? (await summaryPacket(claim));
  const attempt = (await submissions.list(db, claim.id)).length + 1;
  const nonce = crypto.randomUUID();
  const [write] = await db.batch([
    claims.transitionStatement(db, claim.id, claim.version, nonce, { updatedAt: at }),
    auditStatement(
      db,
      { at, actor: actorId(actor), action: "submission_failed", entityType: "claim", entityId: claim.id, detail: { attempt, channel } },
      { claimId: claim.id, nonce },
    ),
    submissions.submissionStatement(
      db,
      {
        claimId: claim.id,
        channel,
        batchRef: failure.batchRef ?? null,
        packetMasked: packet.masked,
        packetHash: packet.hash,
        result: "failed",
        portalReference: null,
        error: failure.error.trim(),
        actor: actorId(actor),
        at,
      },
      { nonce },
    ),
  ]);
  if (write?.meta.changes !== 1) {
    const current = await claims.detail(db, claim.id);
    return current ? err({ code: "stale", currentVersion: current.version }) : err({ code: "not_found" });
  }
  return ok((await claims.detail(db, claim.id))!);
}

/** How long opening a claim's checklist holds it for one officer (S6). */
export const CHECKOUT_MINUTES = 30;

/** Who else holds the claim's checklist right now, if anyone but `actor`. */
function heldByAnother(claim: ClaimState, actor: Actor, at: string): { by: string; until: string } | null {
  if (!claim.checkoutBy || !claim.checkoutUntil || claim.checkoutBy === actorId(actor)) return null;
  return claim.checkoutUntil > at ? { by: claim.checkoutBy, until: claim.checkoutUntil } : null;
}

/**
 * Opens an approved claim's checklist for `actor`, marking it "being submitted by" them for
 * `CHECKOUT_MINUTES` (S6). Opening it again while the hold is theirs extends the hold without moving
 * the claim's version or logging another checkout (QA D09, D17). While another officer holds it, the
 * answer is `checked_out`; `takeOver` takes it from them.
 */
export function checkout(deps: ClaimDeps, claimId: string, actor: Actor): Promise<Result<ClaimState, ActError>> {
  return hold(deps, claimId, actor, false);
}

/** Takes an approved claim's checklist from whoever holds it, after the officer confirms (S6). */
export function takeOver(deps: ClaimDeps, claimId: string, actor: Actor): Promise<Result<ClaimState, ActError>> {
  return hold(deps, claimId, actor, true);
}

async function hold(deps: ClaimDeps, claimId: string, actor: Actor, takingOver: boolean): Promise<Result<ClaimState, ActError>> {
  const { db } = deps;
  if (actor.kind !== "person") return err({ code: "forbidden", detail: `${actorId(actor)} may not open a claim's checklist.` });
  const claim = await claims.detail(db, claimId);
  if (!claim) return err({ code: "not_found" });
  if (claim.status !== "approved") {
    return err({ code: "not_allowed", detail: `A ${claim.status.replace(/_/g, " ")} claim has no checklist to open.` });
  }
  const at = new Date(deps.now).toISOString();
  const holder = heldByAnother(claim, actor, at);
  if (holder && !takingOver) return err({ code: "checked_out", ...holder });

  const until = new Date(deps.now + CHECKOUT_MINUTES * 60_000).toISOString();
  if (claim.checkoutBy === actorId(actor) && claim.checkoutUntil !== null && claim.checkoutUntil > at) {
    const extended = await claims.extendCheckoutStatement(db, claim.id, claim.version, actorId(actor), until).run();
    if (extended.meta.changes !== 1) {
      const current = await claims.detail(db, claim.id);
      return current ? err({ code: "stale", currentVersion: current.version }) : err({ code: "not_found" });
    }
    return ok((await claims.detail(db, claim.id))!);
  }
  const nonce = crypto.randomUUID();
  const event = holder
    ? { action: "checkout_taken_over" as const, detail: { from: holder.by, until } }
    : { action: "checkout" as const, detail: { until } };
  const [write] = await db.batch([
    claims.transitionStatement(db, claim.id, claim.version, nonce, { updatedAt: at, checkoutBy: actorId(actor), checkoutUntil: until }),
    auditStatement(db, { at, actor: actorId(actor), entityType: "claim", entityId: claim.id, ...event }, { claimId: claim.id, nonce }),
  ]);
  if (write?.meta.changes !== 1) {
    const current = await claims.detail(db, claim.id);
    return current ? err({ code: "stale", currentVersion: current.version }) : err({ code: "not_found" });
  }
  return ok((await claims.detail(db, claim.id))!);
}

/**
 * The attempt a submit or a portal refusal records, or why it cannot be recorded: someone else
 * holds the claim's checklist. A portal reference already used at this payer is refused by the write.
 */
async function submissionAttempt(
  deps: ClaimDeps,
  claim: ClaimState,
  action: Extract<ClaimAction, { kind: "submit" | "portal_refused" }>,
  actor: Actor,
  at: string,
  opts: ActOptions,
): Promise<Result<submissions.SubmissionDraft, ActError>> {
  const holder = heldByAnother(claim, actor, at);
  if (holder) return err({ code: "checked_out", ...holder });
  const channel = claim.channel ?? "assisted";
  const reference = action.kind === "submit" ? (action.portalReference?.trim() ?? null) : null;
  const packet = opts.packet ?? (await summaryPacket(claim));
  return ok({
    claimId: claim.id,
    channel,
    batchRef: opts.batchRef ?? null,
    packetMasked: packet.masked,
    packetHash: packet.hash,
    result: action.kind === "submit" ? SUBMITTED_AS[channel] : "failed",
    portalReference: reference,
    error: action.kind === "portal_refused" ? action.message.trim() : null,
    actor: actorId(actor),
    at,
  });
}

/** One identity field off the visit's sealed identity, for the claim's payer; null when the visit has none. */
function identityValue(identity: VisitIdentity, field: IdentityField, payerId: string): string | null {
  switch (field) {
    case "nric":
      return identity.nric;
    case "name":
      return identity.name;
    case "phone":
      return identity.phone;
    case "date_of_birth":
      return identity.dateOfBirth;
    case "address":
      return identity.address;
    case "member_id":
      return identity.memberIds.find((m) => m.payerId === payerId)?.memberId ?? null;
    case "account_holder_nric":
      return identity.accountHolderNric;
  }
}

/**
 * One identity field of a claim's patient, in full (S11). The reveal is audited first, with the field
 * named and never its value, and the value is answered only once that event is written: if the audit
 * write fails, the call throws and nothing is revealed. Officers and reviewers may reveal; the
 * connector and other system actors may not.
 */
export async function reveal(
  deps: ClaimDeps & { keys: IdentifierKeys },
  claimId: string,
  field: IdentityField,
  actor: Actor,
): Promise<Result<string, ActError>> {
  if (actor.kind !== "person") return err({ code: "forbidden", detail: `${actorId(actor)} may not reveal a patient's details.` });
  if (!(IDENTITY_FIELDS as readonly string[]).includes(field)) return err({ code: "invalid", field: "field", problem: "is not an identity field" });
  const claim = await claims.detail(deps.db, claimId);
  if (!claim) return err({ code: "not_found" });
  const identity = await loadIdentity(deps.db, deps.keys, claim.visitKey);
  const value = identity ? identityValue(identity, field, claim.payerId) : null;
  if (value === null) return err({ code: "invalid", field: "field", problem: "has no value on this visit" });

  const at = new Date(deps.now).toISOString();
  await auditStatement(deps.db, { at, actor: actorId(actor), action: "revealed", entityType: "claim", entityId: claim.id, detail: { field } }).run();
  return ok(value);
}

/**
 * The claim as a masked packet: what was claimed, line by line, with the patient masked. Recorded
 * when a caller has no payer packet; a send through a channel records the payer template's packet.
 */
export async function summaryPacket(claim: ClaimState): Promise<{ masked: unknown; hash: string }> {
  const masked = {
    claimId: claim.id,
    payerId: claim.payerId,
    scheme: claim.scheme,
    visitDate: claim.visitDate,
    patient: claim.patientMask,
    lines: claim.lines.map((l) => ({ schemeCode: l.schemeCode, tooth: l.tooth, quantity: l.quantity, claimedCents: l.claimedCents })),
    claimedCents: claim.claimedCents,
  };
  return { masked, hash: await sha256Hex(canonicalJson(masked)) };
}

/** The clinical side of one visit revision: the treatments a claim's lines point into. */
async function revisionTreatments(db: D1Database, visitKey: string, revision: number): Promise<ClinicalVisit["treatments"]> {
  const row = await db
    .prepare("SELECT clinical_json FROM visit_revisions WHERE visit_key = ? AND revision = ?")
    .bind(visitKey, revision)
    .first<{ clinical_json: string }>();
  return row ? (JSON.parse(row.clinical_json) as ClinicalVisit).treatments : [];
}

/**
 * The visit's bill across its open claims, in waterfall order, the patient last: the build's split
 * (`splitAcross`), drawn from the claims as stored. The segments sum to the fee with GST.
 */
function splitVisit(settings: DeskSettings, treatments: ClinicalVisit["treatments"], open: readonly ClaimState[]): { feeCents: Cents; segments: SplitSegment[] } {
  const segments = splitAcross(treatments, settings, open);
  return { feeCents: add(cents(0), ...segments.map((s) => s.cents)), segments };
}

/**
 * A frozen claim's bill (D12, N3, B1). While today's split of the claims built from the same
 * revision still gives every sent claim among them what it claimed, that is the bill: every payer
 * by name, the patient last. Once it would give one of them a different amount (the waterfall or a
 * rebuild moved since), or an open claim was rebuilt from another revision, each sent claim keeps
 * what it claims and the remainder is the rest of the bill. Every sent claim on the visit draws the
 * same bill, so their pages agree.
 */
function frozenVisitSplit(
  settings: DeskSettings,
  treatments: ClinicalVisit["treatments"],
  claim: ClaimState,
  onVisit: readonly ClaimState[],
): { feeCents: Cents; segments: SplitSegment[] } {
  const others = onVisit.filter((c) => c.id !== claim.id && !CLOSED_STATUSES.has(c.status));
  const sameRevision = others.filter((c) => c.builtFromRevision === claim.builtFromRevision);
  const frozenWith = sameRevision.filter((c) => !UNSENT_STATUSES.has(c.status));
  if (sameRevision.length === others.length) {
    const today = splitAcross(treatments, settings, [claim, ...sameRevision]);
    const asClaimed = (c: ClaimState) => today.find((s) => s.claimId === c.id)?.cents === c.claimedCents;
    if ([claim, ...frozenWith].every(asClaimed)) return { feeCents: add(cents(0), ...today.map((s) => s.cents)), segments: today };
  }
  const segments = frozenSplit(treatments, settings, claim, frozenWith, others.length > frozenWith.length);
  return { feeCents: add(cents(0), ...segments.map((s) => s.cents)), segments };
}

/**
 * Everything the claim page shows (AC-3.7): the claim with its patient masked, each line beside the
 * clinic code it came from, the visit's bill across its payers, the other payers' claims, every
 * submission attempt and the audit trail. The deadline and the actions on offer are worked out for
 * this viewer today. Null when no claim has the id.
 */
export async function claimDetail(deps: ClaimDeps, claimId: string, actor: Actor): Promise<ClaimDetail | null> {
  const { db, now } = deps;
  const claim = await claims.detail(db, claimId);
  if (!claim) return null;
  const [onVisit, { settings }, attempts, trail, current, visitRemarks] = await Promise.all([
    claims.forVisit(db, claim.visitKey),
    settingsRepo.get(db),
    submissions.list(db, claim.id),
    audit.list(db, { type: "claim", id: claim.id }),
    loadClinical(db, claim.visitKey),
    remarks(db, claim.visitKey),
  ]);
  const currentRevision = current?.revision ?? claim.builtFromRevision;
  const builtFrom =
    current && current.revision === claim.builtFromRevision ? current.clinical.treatments : await revisionTreatments(db, claim.visitKey, claim.builtFromRevision);

  const nameOf = (payerId: PayerId) => settings.payers.find((p) => p.id === payerId)?.name ?? payerId;
  const lines: ClaimDetailLine[] = claim.lines.map((l) => ({ ...l, clinicCode: builtFrom[l.treatmentRef]?.code ?? null }));
  const siblings: SiblingClaim[] = onVisit
    .filter((c) => c.id !== claim.id)
    .map((c) => ({ id: c.id, payerId: c.payerId, payerName: nameOf(c.payerId), scheme: c.scheme, status: c.status, claimedCents: c.claimedCents }));
  const submissionViews: SubmissionView[] = attempts.map((s) => ({
    id: s.id,
    attempt: s.attempt,
    channel: s.channel,
    batchRef: s.batchRef,
    packetHash: s.packetHash,
    result: s.result,
    portalReference: s.portalReference,
    error: s.error,
    actor: s.actor,
    at: s.at,
  }));
  const deadline =
    UNSENT_STATUSES.has(claim.status) && claim.deadline !== null
      ? deadlineView(claim.deadline, sgtDay(now), daysBetween(claim.visitDate, claim.deadline))
      : null;
  const { patientHash: _hash, lastAction: _nonce, lines: _lines, ...view } = claim;
  // A sent or closed claim keeps the figures it was built with, so its bill is drawn from that
  // revision and the claims built with it, never from the visit as it is now (D12).
  // Its own share is what it claims, whatever today's waterfall says (N3); see frozenVisitSplit.
  const frozen = !UNSENT_STATUSES.has(claim.status);
  const split = frozen ? frozenVisitSplit(settings, builtFrom, claim, onVisit) : splitVisit(settings, current?.clinical.treatments ?? builtFrom, onVisit.filter((c) => !CLOSED_STATUSES.has(c.status)));
  const lastBuilt = trail.filter((e) => BUILD_ACTIONS.has(e.action)).at(-1)?.at ?? claim.createdAt;
  const ruleSets = listRuleSets();
  const pricedBy = split.segments.flatMap((s) => {
    const priced = onVisit.find((c) => c.id === s.claimId);
    const ruleSet = priced?.ruleSetId ? ruleSets.find((r) => r.id === priced.ruleSetId) : undefined;
    return priced && ruleSet ? [{ payerId: priced.payerId, payerName: s.label, ruleSet }] : [];
  });

  return {
    claim: view,
    payerName: nameOf(claim.payerId),
    branchName: settings.branches.find((b) => b.id === claim.branchId)?.name ?? claim.branchId,
    deadline,
    actions: allowedActions(claim, actor),
    lines,
    split,
    frozenOn: frozen ? sgtDay(Date.parse(lastBuilt)) : null,
    pricedBy,
    siblings,
    submissions: submissionViews,
    audit: trail,
    revision: { builtFrom: claim.builtFromRevision, current: currentRevision },
    ruleSet: ruleSets.find((r) => r.id === claim.ruleSetId) ?? null,
    visit:
      frozen && claim.builtFromRevision !== currentRevision
        ? laterRemarks(visitRemarks)
        : {
            notes: visitRemarks?.notes ?? [],
            findings: (visitRemarks?.findings ?? []).filter((f) => !claim.findings.some((own) => sameFinding(own, f))),
          },
  };
}

/**
 * Notes that still hold for a claim frozen at an earlier revision: why the desk left it alone. They
 * say what happened to the visit, not what its later revision would claim.
 */
const FROZEN_NOTE_CODES: ReadonlySet<VisitNote["code"]> = new Set<VisitNote["code"]>(["withdrawn_not_rebuilt", "voided_in_clinic"]);

/**
 * Findings that still hold for a claim frozen at an earlier revision: the claims already sent now
 * pass the visit's fee, so one of them needs amending (QA 03 B1). They are about the sent claims,
 * this one among them, not about what the later revision would claim.
 */
const FROZEN_FINDING_CODES: ReadonlySet<Finding["code"]> = new Set<Finding["code"]>(["sent_claims_exceed_fee"]);

/**
 * The visit's remarks were built from a later revision than a frozen claim's figures, so only the
 * remarks about the claim as sent carry over; the rest would mix the two revisions (D12).
 */
function laterRemarks(r: VisitRemarks | null): ClaimDetail["visit"] {
  return {
    notes: (r?.notes ?? []).filter((n) => FROZEN_NOTE_CODES.has(n.code)),
    findings: (r?.findings ?? []).filter((f) => FROZEN_FINDING_CODES.has(f.code)),
  };
}

/** The audit actions that set a claim's figures: the last one is when they were built. */
const BUILD_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>(["built", "rebuilt", "approval_cleared"]);

const sameFinding = (a: Finding, b: Finding) => a.code === b.code && canonicalJson(a.params) === canonicalJson(b.params);
