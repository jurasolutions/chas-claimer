/**
 * `GET /api/claims`: the queue (technical §6). Rows carry the masked patient and never an
 * identifier. The deadline arrives worked out: the page never reads the clock.
 */
import { z } from "zod";
import type { IsoDate } from "../domain/dates";
import type { Cents } from "../domain/money";
import type { Result } from "../domain/result";
import { CLAIM_STATUSES, type ClaimStatus, type Finding, PAYER_ID_PATTERN, type PayerId, type Scheme, SCHEMES } from "../domain/types";
import { validate, type ValidationIssue } from "../domain/validation";
import type { Page, PageQuery } from "./common";

/** The submission deadline as the desk sees it today (decisions-g2 #5). */
export interface DeadlineView {
  deadline: IsoDate;
  /** Negative once the window has passed. */
  daysLeft: number;
  /** Within the warning period, or past it. */
  warning: boolean;
  windowDays?: number;
}

export interface ClaimRow {
  id: string;
  visitKey: string;
  status: ClaimStatus;
  scheme: Scheme;
  payerId: PayerId;
  /** The payer's name from settings, falling back to its ID. */
  payerName: string;
  branchId: string;
  /** The branch's name from settings, falling back to its ID. */
  branchName: string;
  patientMask: string;
  visitDate: IsoDate;
  feeCents: Cents;
  claimedCents: Cents;
  /** Null for a scheme without a submission window, and once the claim is with its payer. */
  deadline: DeadlineView | null;
  changedAfterSubmission: boolean;
  blockingCount: number;
  findings: Finding[];
  version: number;
}

/** Statuses the queue shows when no status filter is given: the work still to do. */
export const OPEN_STATUSES: readonly ClaimStatus[] = ["needs_attention", "ready", "approved"];

export interface ClaimFilter extends PageQuery {
  status?: ClaimStatus[];
  scheme?: Scheme;
  payer?: PayerId;
  branch?: string;
  /** Claims with 0 to this many days left on their deadline; a claim past its window is not due (QA D18). */
  due?: number;
  /** Only claims whose visit changed after they were sent. */
  changed?: boolean;
}

export type ClaimListResponse = Page<ClaimRow>;

export const isClaimStatus = (s: string): s is ClaimStatus => (CLAIM_STATUSES as readonly string[]).includes(s);
export const isScheme = (s: string): s is Scheme => (SCHEMES as readonly string[]).includes(s);

/** The queue shows at most this many claims a page. */
export const MAX_CLAIMS_PAGE = 100;
/** `due` reaches at most a year ahead. */
const MAX_DUE_DAYS = 366;

const wholeNumber = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,6}$/, "a whole number")
    .transform(Number)
    .pipe(z.number().min(min, `at least ${min}`).max(max, `at most ${max}`));

const ClaimQuerySchema = z.object({
  status: z
    .array(z.string())
    .refine((all) => all.every(isClaimStatus), "one of the claim statuses")
    .transform((all) => all as ClaimStatus[])
    .optional(),
  scheme: z.string().refine(isScheme, "one of the schemes").optional(),
  payer: z.string().regex(PAYER_ID_PATTERN, "a payer ID").optional(),
  branch: z.string().min(1).max(64).optional(),
  due: wholeNumber(0, MAX_DUE_DAYS).optional(),
  changed: z
    .enum(["true", "1", "false", "0"], "true or false")
    .transform((v) => v === "true" || v === "1")
    .optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: wholeNumber(1, MAX_CLAIMS_PAGE).optional(),
});

/**
 * Reads the queue filter from a query string. `status` may repeat or be comma-separated; an empty
 * value counts as absent. Issues name the parameter, never echo its value.
 */
export function parseClaimQuery(query: URLSearchParams): Result<ClaimFilter, ValidationIssue[]> {
  const one = (name: string) => query.get(name) || undefined;
  const statuses = query.getAll("status").flatMap((s) => s.split(",")).filter(Boolean);
  return validate(ClaimQuerySchema, {
    status: statuses.length > 0 ? statuses : undefined,
    scheme: one("scheme"),
    payer: one("payer"),
    branch: one("branch"),
    due: one("due"),
    changed: one("changed"),
    cursor: one("cursor"),
    limit: one("limit"),
  });
}
