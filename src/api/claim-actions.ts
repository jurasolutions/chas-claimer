/**
 * The claim's write routes (technical §6): `POST /api/claims/:id/actions`, `POST /api/claims/actions`
 * (batch), `PUT /api/claims/:id/annotations` and `POST /api/claims/:id/reveal`. Each write carries
 * the version the caller read, and a write against a claim that has moved on is 409 `stale`.
 *
 * The parsers check shape only. Whether an action is allowed now, and by whom, is the lifecycle's
 * call (`src/domain/lifecycle.ts`), so the page and the server agree on one answer.
 */
import { z } from "zod";
import { parseIsoDate } from "../domain/dates";
import { cents } from "../domain/money";
import type { Result } from "../domain/result";
import { type ClaimAction, IDENTITY_FIELDS, type IdentityField } from "../domain/types";
import { validate, type ValidationIssue } from "../domain/validation";
import type { ProblemBody } from "./common";
import { MAX_ACTION_TEXT, MAX_BATCH_ITEMS, MAX_PORTAL_REFERENCE } from "./claim-limits";

export { MAX_ACTION_TEXT, MAX_BATCH_ITEMS, MAX_PORTAL_REFERENCE } from "./claim-limits";

/** `POST /api/claims/:id/actions`. Answers the claim's `ClaimDetail` as it now stands. */
export interface ActionRequest {
  action: ClaimAction;
  /** The claim's `version` when the page read it. */
  expectedVersion: number;
}

/** `POST /api/claims/actions`: reviewers only. Each item names the version the reviewer selected. */
export interface BatchRequest {
  action: "approve" | "unapprove";
  items: { id: string; version: number }[];
}

/** What a batch did, claim by claim. A failure carries the same body the single route would answer. */
export interface BatchResponse {
  /** `warnings` counts the warnings the claim carried when approved, so the page can say so (S17). */
  done: { id: string; version: number; warnings: number }[];
  failed: { id: string; status: number; error: ProblemBody }[];
}

/** `PUT /api/claims/:id/annotations`: replaces all three. A field left out or empty is cleared. */
export interface AnnotationsRequest {
  annotations: { justification?: string | null; preAuthReference?: string | null; mcafReference?: string | null };
  expectedVersion: number;
}

/** `POST /api/claims/:id/reveal`: audited before it answers. */
export interface RevealRequest {
  field: IdentityField;
}

export interface RevealResponse {
  value: string;
}

const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const amount = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .transform((n) => cents(n));
const words = z.string().max(MAX_ACTION_TEXT);
const isoDate = z
  .string()
  .refine((s) => parseIsoDate(s) !== null, "a date as YYYY-MM-DD")
  .transform((s) => parseIsoDate(s)!);

// A payment's remittance line is set only by the remittance import, never by a person (technical §6).
const ActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve") }),
  z.object({ kind: z.literal("unapprove") }),
  z.object({ kind: z.literal("submit"), portalReference: z.string().max(MAX_PORTAL_REFERENCE).optional() }),
  z.object({ kind: z.literal("portal_refused"), message: words }),
  z.object({ kind: z.literal("accept"), acceptedCents: amount.optional(), reason: words.optional() }),
  z.object({ kind: z.literal("reject"), reason: words }),
  z.object({ kind: z.literal("record_payment"), cents: amount, paidOn: isoDate }),
  z.object({ kind: z.literal("accept_short_payment"), reason: words }),
  z.object({ kind: z.literal("reopen") }),
  z.object({ kind: z.literal("withdraw"), reason: words }),
  z.object({ kind: z.literal("write_off"), reason: words }),
  z.object({ kind: z.literal("acknowledge_change"), note: words }),
]);

const ActionRequestSchema = z.object({ action: ActionSchema, expectedVersion: version });

const BatchRequestSchema = z.object({
  action: z.enum(["approve", "unapprove"]),
  items: z
    .array(z.object({ id: z.string().min(1).max(128), version }))
    .min(1)
    .max(MAX_BATCH_ITEMS),
});

const annotation = z.string().nullable().optional();
const AnnotationsRequestSchema = z.object({
  annotations: z.strictObject({ justification: annotation, preAuthReference: annotation, mcafReference: annotation }),
  expectedVersion: version,
});

const RevealRequestSchema = z.object({ field: z.enum(IDENTITY_FIELDS) });

export function parseActionRequest(body: unknown): Result<ActionRequest, ValidationIssue[]> {
  return validate(ActionRequestSchema, body) as Result<ActionRequest, ValidationIssue[]>;
}

export function parseBatchRequest(body: unknown): Result<BatchRequest, ValidationIssue[]> {
  return validate(BatchRequestSchema, body);
}

export function parseAnnotationsRequest(body: unknown): Result<AnnotationsRequest, ValidationIssue[]> {
  return validate(AnnotationsRequestSchema, body);
}

export function parseRevealRequest(body: unknown): Result<RevealRequest, ValidationIssue[]> {
  return validate(RevealRequestSchema, body);
}
