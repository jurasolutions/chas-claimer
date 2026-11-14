/**
 * Submission routes (technical §6, ticket 07): the packet a payer's template asks for, the send by
 * channel, the take-over of a claim another officer is submitting, and the payer simulator.
 * Packets on these routes are masked: an identifier appears only through the audited reveal route.
 */
import { z } from "zod";
import type { Result } from "../domain/result";
import type { Channel, ClaimStatus, IdentityField, SimState } from "../domain/types";
import { validate, type ValidationIssue } from "../domain/validation";
import { MAX_ACTION_TEXT, MAX_BATCH_ITEMS } from "./claim-limits";
import type { ErrorCode, ProblemBody } from "./common";

/** One field of `GET /api/claims/:id/packet`, in the payer's template order. */
export interface PacketFieldView {
  key: string;
  label: string;
  /** What the officer copies; amounts as "288.00". Null when empty, or masked with nothing to show. */
  text: string | null;
  /** True while the value is withheld; `revealField` names what the reveal route shows in full. */
  masked: boolean;
  revealField: IdentityField | null;
}

/** `GET /api/claims/:id/packet`: what the submission checklist shows. */
export interface PacketView {
  claimId: string;
  payerId: string;
  payerName: string;
  channel: Channel;
  status: ClaimStatus;
  version: number;
  portalReference: string | null;
  /** The payer's claims portal from settings, for an "Open portal" link; null when settings name none. */
  portalUrl: string | null;
  /** The officer holding the claim's checklist while their hold lasts; null when nobody holds it. */
  checkout: { by: string; until: string } | null;
  fields: PacketFieldView[];
}

/**
 * `POST /api/claims/:id/checkout`: hold an approved claim's checklist for 30 minutes. While another
 * officer holds it the answer is 409 `checked_out` naming them; `takeOver: true` takes it from them,
 * and the page sends that only after the officer confirms. Answers the claim's `PacketView`.
 */
export interface CheckoutRequest {
  takeOver?: boolean;
}

const CheckoutRequestSchema = z.strictObject({ takeOver: z.boolean().optional() });

export function parseCheckoutRequest(body: unknown): Result<CheckoutRequest, ValidationIssue[]> {
  return validate(CheckoutRequestSchema, body);
}

const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Items = z
  .array(z.strictObject({ id: z.string().min(1).max(128), version }))
  .min(1)
  .max(MAX_BATCH_ITEMS)
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length, "Name each claim once.");

/**
 * `POST /api/submissions`: send approved claims down the channel each was approved for (S15). Each
 * item names the version the officer selected it at, so a claim that changed since is refused on its
 * own. Claims are grouped by payer; what each group answers depends on its channel.
 */
export interface SubmitRequest {
  items: { id: string; version: number }[];
}

/**
 * Why a send did not go through. The first five are the network's answer and leave the claim approved
 * with the failed attempt on its trail; an `ErrorCode` is the desk refusing to record the payer's answer.
 */
export type SendFailure = "timeout" | "network" | `http_${number}` | "redirect" | "bad_response" | ErrorCode;

/**
 * How one claim fared on a channel that sends for the officer (`api`, `simulator`). A failure that
 * carries `portalReference` reached the payer, which answered that reference, but the desk could not
 * record it: the attempt and a `sent_not_recorded` event keep it on the claim's trail.
 */
export type SentResult =
  | { claimId: string; ok: true; portalReference: string }
  | { claimId: string; ok: false; error: SendFailure; portalReference?: string };

export type SubmitGroup =
  /** `assisted`: nothing moves yet. The officer works through each claim's checklist and records the reference. */
  | { kind: "checklist"; payerId: string; payerName: string; claimIds: string[] }
  /**
   * `file`: the payer's file, returned once and never stored. The claims stay approved until the
   * officer confirms the upload with `POST /api/submissions/confirm` and this `batchRef`.
   */
  | { kind: "file"; payerId: string; payerName: string; claimIds: string[]; filename: string; csv: string; batchRef: string }
  /** `api` and `simulator`: sent; each claim that went through is now submitted with the payer's reference. */
  | { kind: "sent"; payerId: string; payerName: string; results: SentResult[] };

export interface SubmitResponse {
  groups: SubmitGroup[];
  /** Claims not sent, each with the status and body the single-claim route would answer. */
  refused: { id: string; status: number; error: ProblemBody }[];
}

/** `POST /api/submissions/confirm`: the officer uploaded an exported file; its claims become submitted. */
export interface ConfirmExportRequest {
  batchRef: string;
  /** The same items, at the same versions, the file was exported from. */
  items: { id: string; version: number }[];
}

export interface ConfirmExportResponse {
  done: { id: string; version: number }[];
  failed: { id: string; status: number; error: ProblemBody }[];
}

const SubmitRequestSchema = z.strictObject({ items: Items });
const ConfirmExportRequestSchema = z.strictObject({ batchRef: z.string().min(1).max(64), items: Items });

export function parseSubmitRequest(body: unknown): Result<SubmitRequest, ValidationIssue[]> {
  return validate(SubmitRequestSchema, body);
}

export function parseConfirmExportRequest(body: unknown): Result<ConfirmExportRequest, ValidationIssue[]> {
  return validate(ConfirmExportRequestSchema, body);
}

/**
 * One claim in the payer simulator's inbox (`GET /api/simulator/inbox`): what the simulator received,
 * masked as it was sent, and what the simulated payer decided. The simulator is the desk's own stand-in
 * for a payer; nothing in it reaches a real one.
 */
export interface SimulatorItem {
  id: string;
  claimId: string;
  payerId: string;
  payerName: string;
  simReference: string;
  state: SimState;
  /** The simulated payer's reason for a partial accept or a rejection. */
  reason: string | null;
  paidCents: number | null;
  claimedCents: number;
  acceptedCents: number | null;
  /** Where the claim itself now stands on the desk; null if it is no longer there. */
  claimStatus: ClaimStatus | null;
  fields: PacketFieldView[];
  updatedAt: string;
}

export interface SimulatorInbox {
  items: SimulatorItem[];
}

/**
 * `POST /api/simulator/inbox/:id`: the simulated payer's decision, recorded on the claim with the
 * simulator as actor (AC-4.7). `amount` is in cents: an accept below the claimed amount needs a reason;
 * a payment defaults to the accepted amount, or the claimed one. A rejection always needs a reason.
 * Answers the item as it now stands.
 */
export type SimulatorDecision =
  | { decision: "accept"; amount?: number; reason?: string }
  | { decision: "reject"; reason: string }
  | { decision: "pay"; amount?: number };

const simAmount = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const simReason = z.string().trim().min(1, "Give a reason.").max(MAX_ACTION_TEXT);

const SimulatorDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("accept"), amount: simAmount.optional(), reason: simReason.optional() }),
  z.strictObject({ decision: z.literal("reject"), reason: simReason }),
  z.strictObject({ decision: z.literal("pay"), amount: simAmount.optional() }),
]);

export function parseSimulatorDecision(body: unknown): Result<SimulatorDecision, ValidationIssue[]> {
  return validate(SimulatorDecisionSchema, body);
}
