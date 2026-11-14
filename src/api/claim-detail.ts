/**
 * `GET /api/claims/:id`: one claim with everything the claim page shows (technical §6, AC-3.7).
 * Masked patient only: no patient hash, no identifier. The deadline and the actions on offer
 * arrive worked out for the viewer today, so the page never reads the clock or the roles.
 */
import type { ClaimLineState, ClaimState } from "../domain/claims/state";
import type { IsoDate } from "../domain/dates";
import type { Cents } from "../domain/money";
import type { RuleSetSummary } from "../domain/rules";
import type { AuditEvent, Channel, ClaimActionKind, ClaimStatus, Finding, PayerId, Scheme, SplitSegment, VisitNote } from "../domain/types";
import type { DeadlineView } from "./claims";

/** The claim as the page sees it: the stored claim without its patient hash or write nonce. */
export type ClaimView = Omit<ClaimState, "patientHash" | "lastAction" | "lines">;

export interface ClaimDetailLine extends ClaimLineState {
  /** The clinic's own code for the treatment this line claims, from the revision the claim was built from. */
  clinicCode: string | null;
}

/** Another payer's claim on the same visit. */
export interface SiblingClaim {
  id: string;
  payerId: PayerId;
  payerName: string;
  scheme: Scheme;
  status: ClaimStatus;
  claimedCents: Cents;
}

/** A scheme payer on the visit's bill and the rule set that priced its claim. */
export interface PricedBy {
  payerId: PayerId;
  payerName: string;
  ruleSet: RuleSetSummary;
}

/** One submission attempt, without the packet: the packet has its own route. */
export interface SubmissionView {
  id: string;
  attempt: number;
  channel: Channel;
  batchRef: string | null;
  packetHash: string;
  result: "checklist" | "exported" | "sent" | "failed";
  portalReference: string | null;
  error: string | null;
  actor: string;
  at: string;
}

export interface ClaimDetail {
  claim: ClaimView;
  /** The payer's name from settings, falling back to its ID. */
  payerName: string;
  /** The visit's branch by its name in settings, falling back to its ID. */
  branchName: string;
  /** Null for a scheme without a submission window, and once the claim is with its payer. */
  deadline: DeadlineView | null;
  /** What this viewer may do to the claim now: the buttons the page shows. */
  actions: ClaimActionKind[];
  lines: ClaimDetailLine[];
  /**
   * The visit's bill across its payers, in waterfall order, the patient last. For an unsent claim it
   * follows the visit as it is now; once the claim is frozen (`frozenOn`) it is the bill as the claim
   * was built, this claim in it, so its figures never mix with a later revision's (D12).
   */
  split: { feeCents: Cents; segments: SplitSegment[] };
  /**
   * The day the claim's figures were last built, once it is sent or closed and no rebuild changes
   * them: the page labels its lines and split "as built on" that day. Null for an unsent claim.
   */
  frozenOn: IsoDate | null;
  /**
   * Each scheme payer on the bill, in waterfall order, with the rule set that priced its claim and
   * where that rule set came from. Insurers aren't priced by a scheme rule set, so they aren't here.
   */
  pricedBy: PricedBy[];
  siblings: SiblingClaim[];
  submissions: SubmissionView[];
  /** The claim's audit trail, oldest first. */
  audit: AuditEvent[];
  /** The visit revision the claim was built from, and the visit's current one. */
  revision: { builtFrom: number; current: number };
  /** The rule set the amounts came from, with its sources and the dates they were read; null when none applied. */
  ruleSet: RuleSetSummary | null;
  /**
   * What the visit's last build said about the visit as a whole: a line held until it's complete, a
   * payer with no claim and why, a withdrawn claim the desk doesn't build again, and warnings that
   * belong to no one claim. Findings already on this claim are left out. A sent or closed claim
   * built from an earlier revision gets only the notes on why it was left alone (withdrawn, voided):
   * the rest describe the later revision, which its figures don't (D12).
   */
  visit: { notes: VisitNote[]; findings: Finding[] };
}
