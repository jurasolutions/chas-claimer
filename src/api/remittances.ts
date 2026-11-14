/**
 * `POST /api/remittances`, `GET /api/remittances`, `GET /api/remittances/:id` and
 * `POST /api/remittances/:id/lines/:n/match` (technical §6, spec §5). A payment statement carries
 * NRICs: nothing here ever holds one, or its hash. A line is named by its number.
 */
import { z } from "zod";
import type { IsoDate } from "../domain/dates";
import type { Cents } from "../domain/money";
import type { Result } from "../domain/result";
import { type RemittanceColumns, RemittanceColumnsSchema } from "../domain/settings";
import type { StatementProblem } from "../domain/statement";
import { type ClaimStatus, PAYER_ID_PATTERN, type PayerId, type Scheme } from "../domain/types";
import { validate, type ValidationIssue } from "../domain/validation";

/**
 * A statement has at most this many payment lines; more is 422 `statement_unreadable`. A paid line costs
 * about 13 D1 statements (its insert, its hold, and the payment through the lifecycle), so a full file
 * stays well under the per-invocation query limit (technical F7, §9). `remittances.budget.test.ts` pins it.
 */
export const MAX_REMITTANCE_LINES = 50;
/** The largest statement the upload route reads, in bytes of JSON. */
export const MAX_REMITTANCE_BYTES = 512 * 1024;
/** A file name is shown back to the officer as given, up to this length. */
export const MAX_FILE_NAME = 200;

export interface RemittanceRequest {
  payerId: PayerId;
  fileName: string;
  /** The CSV file's text. */
  csv: string;
  /**
   * The payer's column mapping, saved to settings with this upload. Reviewers only (settings are
   * theirs, AC-8.4); an officer uploads against the mapping a reviewer saved.
   */
  columns?: RemittanceColumns;
  /**
   * Import the file although it looks like one imported under a retired identifier key (the 409
   * `possible_duplicate` answer). Reviewers only.
   */
  confirmPossibleDuplicate?: boolean;
}

const RemittanceRequestSchema = z.strictObject({
  payerId: z.string().regex(PAYER_ID_PATTERN, "a payer ID"),
  fileName: z.string().trim().min(1).max(MAX_FILE_NAME),
  csv: z.string(),
  columns: RemittanceColumnsSchema.optional(),
  confirmPossibleDuplicate: z.boolean().optional(),
});

/** Shape only: whether the payer exists and the file reads is the service's call. */
export function parseRemittanceRequest(body: unknown): Result<RemittanceRequest, ValidationIssue[]> {
  return validate(RemittanceRequestSchema, body);
}

/** What one upload did. */
export type RemittanceSummary =
  | {
      outcome: "imported";
      remittanceId: string;
      /** Payment lines read. */
      lines: number;
      /** Lines the desk recorded as payments. */
      matched: number;
      /** Lines left to match by hand: `lines - matched`. */
      forPerson: number;
    }
  /** The same file for this payer was imported before: nothing was added. */
  | { outcome: "already_imported"; remittanceId: string; added: 0 }
  /** The file had a header row and no payment lines: nothing was written. */
  | { outcome: "empty" };

/**
 * Why an upload was refused. The 409 `columns_not_mapped` and `possible_duplicate` and the 422
 * `statement_unreadable` bodies; `statement_unreadable` carries the parser's problem, which names
 * headers and line numbers only.
 */
export type RemittanceRefusal =
  | { error: "columns_not_mapped"; payerId: PayerId }
  | { error: "statement_unreadable"; problem: StatementProblem }
  /**
   * The payer has an earlier statement with this file name and line count, imported under an
   * identifier key that has since been retired, so the desk can't tell by its content whether this is
   * the same file. A reviewer may import it anyway with `confirmPossibleDuplicate`.
   */
  | { error: "possible_duplicate"; remittanceId: string };

/** One row of `GET /api/remittances`, newest first. */
export interface RemittanceListItem {
  id: string;
  payerId: PayerId;
  fileName: string;
  importedAt: string;
  actor: string;
  lines: number;
  matched: number;
}

/** The claim a line paid. */
export interface LineClaim {
  claimId: string;
  visitKey: string;
  scheme: Scheme;
  status: ClaimStatus;
}

/** Why the desk left a line for a person. */
export type LineNote =
  /** No claim of this payer carries the reference, or fits the patient, date and amount. */
  | { kind: "no_claim" }
  /** A negative or zero line: a clawback or a recovery, outside the desk's scope (S12). */
  | { kind: "not_a_payment" }
  /** The claim it points at is paid, withdrawn, written off or rejected. */
  | ({ kind: "closed" } & LineClaim)
  /** The claim it points at was already paid by another line of this file. */
  | ({ kind: "taken" } & LineClaim)
  /** More than one open claim fits the patient, date and amount. */
  | { kind: "several"; claims: LineClaim[] }
  /** One open claim fits now: it was sent, or reopened, after the file came in. A person confirms it. */
  | ({ kind: "fits" } & LineClaim);

export interface RemittanceLineView {
  lineNo: number;
  portalReference: string | null;
  visitDate: IsoDate | null;
  amountCents: number;
  paidOn: IsoDate | null;
  /** Null while the line waits for a person. */
  match: ({ kind: "reference" | "patient_date_amount" | "manual" } & LineClaim) | null;
  /** Why it waits; null once matched. */
  note: LineNote | null;
}

/** An open claim of the file's payer a person can match a line to. Masked: no identifier. */
export interface OpenClaimOption extends LineClaim {
  version: number;
  visitDate: IsoDate;
  portalReference: string | null;
  patientMask: string;
  claimedCents: Cents;
  acceptedCents: Cents | null;
  paidCents: Cents;
}

/** `GET /api/remittances/:id`. */
export interface RemittanceDetail {
  remittance: RemittanceListItem;
  lines: RemittanceLineView[];
  /** The payer's open claims (submitted or accepted), for matching by hand; at most `MAX_OPEN_CLAIM_OPTIONS`. */
  openClaims: OpenClaimOption[];
}

export const MAX_OPEN_CLAIM_OPTIONS = 200;

/** `POST /api/remittances/:id/lines/:n/match`: the claim, at the version the person saw. */
export interface ManualMatchRequest {
  claimId: string;
  expectedVersion: number;
}

const ManualMatchRequestSchema = z.strictObject({
  claimId: z.string().min(1).max(64),
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export function parseManualMatchRequest(body: unknown): Result<ManualMatchRequest, ValidationIssue[]> {
  return validate(ManualMatchRequestSchema, body);
}
