/**
 * A claim as the desk holds it: one row of `claims` with its lines and findings. The repo maps rows
 * to this shape and the lifecycle (ticket 04) decides what may happen to it next. It carries the
 * patient's hash and mask, never an identifier.
 */
import type { IsoDate } from "../dates";
import type { Cents } from "../money";
import type { Channel, ClaimStatus, Finding, PayerId, Scheme } from "../types";
import type { ClaimAnnotations } from "./build";

export interface ClaimLineState {
  lineNo: number;
  /** The treatment's index in the visit revision the claim was built from. */
  treatmentRef: number;
  schemeCode: string | null;
  tooth: string | null;
  quantity: number;
  feeCents: Cents;
  consideredCents: Cents;
  claimedCents: Cents;
}

export interface ClaimState {
  id: string;
  visitKey: string;
  payerId: PayerId;
  scheme: Scheme;
  branchId: string;
  status: ClaimStatus;
  /** Bumped on every write; a write guarded by a stale version changes nothing. */
  version: number;
  /** The nonce of the last write, which ties its audit event to it. */
  lastAction: string;
  /** "none" when no rule set covered the visit. */
  ruleSetId: string;
  builtFromRevision: number;
  approvedRevision: number | null;
  submittedRevision: number | null;
  feeCents: Cents;
  claimedCents: Cents;
  paidCents: Cents;
  acceptedCents: Cents | null;
  overpaid: boolean;
  deadline: IsoDate | null;
  portalReference: string | null;
  channel: Channel | null;
  changedAfterSubmission: boolean;
  selfApproved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  patientHash: string;
  patientMask: string;
  visitDate: IsoDate;
  annotations: ClaimAnnotations[PayerId];
  checkoutBy: string | null;
  checkoutUntil: string | null;
  createdAt: string;
  updatedAt: string;
  lines: ClaimLineState[];
  findings: Finding[];
}

/** Statuses after the claim has left the desk: its amounts are what the payer was sent. */
export const SENT_STATUSES: ReadonlySet<ClaimStatus> = new Set(["submitted", "accepted", "paid"]);

/** Statuses a rebuild never touches and a re-import never brings back. */
export const CLOSED_STATUSES: ReadonlySet<ClaimStatus> = new Set(["rejected", "written_off", "withdrawn"]);

/** Statuses still on the desk: a rebuild may change them. */
export const UNSENT_STATUSES: ReadonlySet<ClaimStatus> = new Set(["needs_attention", "ready", "approved"]);

/**
 * The findings that still apply to a claim in this status (QA 02 N6). A claim keeps the findings it
 * was last built with once it leaves the desk, and "submit soon" means nothing once it has been
 * sent or closed, so a read drops it. Every other finding stays as built.
 */
export function findingsInForce(status: ClaimStatus, findings: Finding[]): Finding[] {
  return UNSENT_STATUSES.has(status) ? findings : findings.filter((f) => f.code !== "deadline_approaching");
}
