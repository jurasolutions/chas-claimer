/**
 * The claim lifecycle (decisions-g2 §2, functional AC-3.1). `applyAction` is pure: given a claim,
 * an action and who is taking it, it returns the claim as it should be next and the audit events
 * that record the step, or why the step is refused. The service writes both in one batch.
 */
import { statusAfterBuild } from "./claims/build";
import { SENT_STATUSES, UNSENT_STATUSES, type ClaimState } from "./claims/state";
import { add, min, subtract } from "./money";
import { err, ok, type Result } from "./result";
import {
  actorId,
  CLAIM_ACTION_KINDS,
  type Actor,
  type AuditAction,
  type AuditDraft,
  type Channel,
  type ClaimAction,
  type ClaimActionKind,
  type ClaimStatus,
  type SystemActorName,
} from "./types";

export { statusAfterBuild };

export type LifecycleError =
  /** The action is not allowed from the claim's status (409). */
  | { code: "not_allowed"; detail: string }
  /** The actor may not take this action (403). */
  | { code: "forbidden"; detail: string }
  /** The action's payload is missing or wrong (400). */
  | { code: "invalid"; field: string; problem: string };

export interface LifecycleContext {
  /** Who imported the revision being approved; approving your own import is recorded as such. */
  importedBy?: string;
  /** The channel the payer is set to use now; an approval fixes it for the claim (S15). */
  channel?: Channel;
}

export interface Transition {
  next: ClaimState;
  audit: AuditDraft[];
}

export function applyAction(
  claim: ClaimState,
  action: ClaimAction,
  actor: Actor,
  now: string,
  ctx: LifecycleContext = {},
): Result<Transition, LifecycleError> {
  const audit = (kind: AuditAction, detail: Record<string, unknown>): AuditDraft => ({
    at: now,
    actor: actorId(actor),
    action: kind,
    entityType: "claim",
    entityId: claim.id,
    detail,
  });

  if (!mayAct(actor, action.kind)) {
    return err({ code: "forbidden", detail: `${actorId(actor)} may not ${action.kind.replace(/_/g, " ")} a claim.` });
  }

  switch (action.kind) {
    case "approve": {
      if (claim.status !== "ready" || hasBlocking(claim)) return notAllowed(claim, action.kind);
      const email = actorId(actor);
      const selfApproved = email === ctx.importedBy;
      const warnings = claim.findings.filter((f) => f.severity === "warning").length;
      return ok({
        next: {
          ...claim,
          status: "approved",
          approvedRevision: claim.builtFromRevision,
          approvedBy: email,
          approvedAt: now,
          selfApproved,
          channel: ctx.channel ?? null,
        },
        audit: [audit("approve", { label: selfApproved ? "approved (self-approval)" : "approved", warnings, revision: claim.builtFromRevision })],
      });
    }

    case "unapprove": {
      if (claim.status !== "approved") return notAllowed(claim, action.kind);
      const status = statusAfterBuild(claim.findings);
      return ok({ next: { ...claim, ...UNAPPROVED, status }, audit: [audit("unapprove", { status })] });
    }

    case "withdraw": {
      if (!UNSENT_STATUSES.has(claim.status)) return notAllowed(claim, action.kind);
      const reason = text(action.reason);
      if (!reason) return invalid("reason", "Say why the claim is withdrawn.");
      return ok({ next: { ...claim, ...UNAPPROVED, status: "withdrawn" }, audit: [audit("withdraw", { reason, from: claim.status })] });
    }

    case "submit": {
      if (claim.status !== "approved") return notAllowed(claim, action.kind);
      const reference = action.portalReference === undefined ? null : text(action.portalReference);
      if (action.portalReference !== undefined && !reference) return invalid("portalReference", "Enter the reference the portal gave you.");
      if (claim.channel === "assisted" && !reference) return invalid("portalReference", "Enter the reference the portal gave you.");
      // F5.2: only the revision a reviewer approved goes out.
      if (claim.approvedRevision !== claim.builtFromRevision) {
        return err({ code: "not_allowed", detail: "The visit changed after this claim was approved. Check it and approve it again." });
      }
      const submittedRevision = claim.builtFromRevision;
      return ok({
        next: { ...claim, ...CHECKED_IN, status: "submitted", submittedRevision, portalReference: reference },
        audit: [audit("submit", { channel: claim.channel, portalReference: reference, revision: submittedRevision })],
      });
    }

    case "portal_refused": {
      if (claim.status !== "approved") return notAllowed(claim, action.kind);
      const message = text(action.message);
      if (!message) return invalid("message", "Copy the portal's message.");
      return ok({
        next: { ...claim, ...CHECKED_IN, status: "rejected", rejectionReason: message, portalReference: null },
        audit: [audit("portal_refused", { message, channel: claim.channel })],
      });
    }

    case "accept": {
      if (claim.status !== "submitted") return notAllowed(claim, action.kind);
      const accepted = action.acceptedCents ?? claim.claimedCents;
      if (!Number.isInteger(accepted) || accepted < 0) return invalid("acceptedCents", "Enter the amount the payer accepted.");
      if (accepted > claim.claimedCents) return invalid("acceptedCents", "The payer cannot accept more than was claimed.");
      const reason = text(action.reason);
      if (accepted < claim.claimedCents && !reason) return invalid("reason", "Say why the payer accepted less than was claimed.");
      return ok({
        next: { ...claim, status: "accepted", acceptedCents: accepted },
        audit: [audit("accept", { acceptedCents: accepted, claimedCents: claim.claimedCents, ...(reason ? { reason } : {}) })],
      });
    }

    case "reject": {
      if (claim.status !== "submitted") return notAllowed(claim, action.kind);
      const reason = text(action.reason);
      if (!reason) return invalid("reason", "Enter the payer's reason.");
      return ok({ next: { ...claim, status: "rejected", rejectionReason: reason }, audit: [audit("reject", { reason })] });
    }

    case "record_payment": {
      if (claim.status !== "submitted" && claim.status !== "accepted" && claim.status !== "paid") return notAllowed(claim, action.kind);
      if (!Number.isInteger(action.cents) || action.cents <= 0) return invalid("cents", "Enter the amount paid.");
      if (!action.paidOn) return invalid("paidOn", "Enter the date it was paid.");
      const paid = add(claim.paidCents, action.cents);
      const payment = audit("record_payment", {
        cents: action.cents,
        paidOn: action.paidOn,
        ...(action.remittanceLineId ? { remittanceLineId: action.remittanceLineId } : {}),
      });
      if (claim.status === "submitted") {
        // A payment before any acceptance is the payer accepting what it paid (decisions-g2 §2).
        const accepted = min(paid, claim.claimedCents);
        return ok({
          next: { ...claim, status: "paid", acceptedCents: accepted, paidCents: paid, overpaid: paid > claim.claimedCents },
          audit: [audit("accepted_by_remittance", { acceptedCents: accepted, claimedCents: claim.claimedCents }), payment],
        });
      }
      const accepted = claim.acceptedCents ?? claim.claimedCents;
      return ok({
        next: { ...claim, status: paid >= accepted ? "paid" : claim.status, paidCents: paid, overpaid: paid > accepted },
        audit: [payment],
      });
    }

    case "accept_short_payment": {
      const accepted = claim.acceptedCents ?? claim.claimedCents;
      if (claim.status !== "accepted" || claim.paidCents >= accepted) return notAllowed(claim, action.kind);
      const reason = text(action.reason);
      if (!reason) return invalid("reason", "Say why the rest will not be paid.");
      return ok({
        next: { ...claim, status: "paid" },
        audit: [audit("accept_short_payment", { reason, paidCents: claim.paidCents, acceptedCents: accepted, writtenOffCents: subtract(accepted, claim.paidCents) })],
      });
    }

    case "reopen": {
      if (claim.status !== "rejected") return notAllowed(claim, action.kind);
      const status = statusAfterBuild(claim.findings);
      return ok({
        next: {
          ...claim,
          ...UNAPPROVED,
          status,
          rejectionReason: null,
          changedAfterSubmission: false,
          portalReference: null,
          submittedRevision: null,
        },
        audit: [audit("reopen", { status, rejectionReason: claim.rejectionReason })],
      });
    }

    case "write_off": {
      if (claim.status !== "rejected") return notAllowed(claim, action.kind);
      const reason = text(action.reason);
      if (!reason) return invalid("reason", "Say why the claim is written off.");
      return ok({ next: { ...claim, status: "written_off" }, audit: [audit("write_off", { reason })] });
    }

    case "acknowledge_change": {
      if (!claim.changedAfterSubmission || !ACKNOWLEDGEABLE.has(claim.status)) return notAllowed(claim, action.kind);
      const note = text(action.note);
      if (!note) return invalid("note", "Say why the payer needs no action.");
      return ok({ next: { ...claim, changedAfterSubmission: false }, audit: [audit("acknowledge_change", { note })] });
    }
  }
}

/** Every action a claim offers this actor now: what the claim page shows as buttons. */
export function allowedActions(claim: ClaimState, actor: Actor): ClaimActionKind[] {
  return CLAIM_ACTION_KINDS.filter((kind) => mayAct(actor, kind) && opensFrom(claim, kind));
}

function opensFrom(claim: ClaimState, kind: ClaimActionKind): boolean {
  switch (kind) {
    case "approve":
      return claim.status === "ready" && !hasBlocking(claim);
    case "unapprove":
    case "submit":
    case "portal_refused":
      return claim.status === "approved";
    case "accept":
    case "reject":
      return claim.status === "submitted";
    case "record_payment":
      // A paid claim isn't offered another payment (D17); a remittance line can still record an overpayment.
      return claim.status === "submitted" || claim.status === "accepted";
    case "accept_short_payment":
      return claim.status === "accepted" && claim.paidCents < (claim.acceptedCents ?? claim.claimedCents);
    case "reopen":
    case "write_off":
      return claim.status === "rejected";
    case "withdraw":
      return UNSENT_STATUSES.has(claim.status);
    case "acknowledge_change":
      return claim.changedAfterSubmission && ACKNOWLEDGEABLE.has(claim.status);
  }
}

/** The fields an approval sets, cleared when it is taken back or the claim leaves the desk (Sec-2). */
const UNAPPROVED = {
  approvedRevision: null,
  approvedBy: null,
  approvedAt: null,
  selfApproved: false,
  channel: null,
  checkoutBy: null,
  checkoutUntil: null,
} as const satisfies Partial<ClaimState>;

const CHECKED_IN = { checkoutBy: null, checkoutUntil: null } as const satisfies Partial<ClaimState>;

const ACKNOWLEDGEABLE: ReadonlySet<ClaimStatus> = new Set(["submitted", "accepted", "paid", "rejected"]);

function text(value: string | undefined): string | null {
  const t = (value ?? "").trim();
  return t ? t : null;
}

function invalid(field: string, problem: string): { ok: false; error: LifecycleError } {
  return err({ code: "invalid", field, problem });
}

/** Approving is a reviewer's call, and so is taking an approval back (S11). */
const REVIEWER_ONLY: ReadonlySet<ClaimActionKind> = new Set(["approve", "unapprove"]);

/** System actors record outcomes; none of them may approve, submit or close a claim. */
const SYSTEM_MAY: Record<SystemActorName, ReadonlySet<ClaimActionKind>> = {
  simulator: new Set(["accept", "reject", "record_payment"]),
  remittance: new Set(["record_payment"]),
  connector: new Set(),
};

export function mayAct(actor: Actor, kind: ClaimActionKind): boolean {
  if (actor.kind === "system") return SYSTEM_MAY[actor.name].has(kind);
  return REVIEWER_ONLY.has(kind) ? actor.roles.includes("reviewer") : actor.roles.length > 0;
}

function hasBlocking(claim: ClaimState): boolean {
  return claim.findings.some((f) => f.severity === "blocking");
}

function notAllowed(claim: ClaimState, kind: ClaimAction["kind"]): { ok: false; error: LifecycleError } {
  return err({ code: "not_allowed", detail: `A ${claim.status.replace(/_/g, " ")} claim cannot be sent "${kind}".` });
}
