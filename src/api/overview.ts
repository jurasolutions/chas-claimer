/**
 * `GET /api/overview`: the counts behind the Today sentence (functional AC-8.3). Aggregates only.
 */
import { DEADLINE_WARNING_DAYS } from "../domain/claims/build";
import type { ClaimStatus } from "../domain/types";

/** The CHAS window the Today screen counts down to; the queue's `due` filter uses the same days. */
export const DUE_SOON_DAYS = DEADLINE_WARNING_DAYS;

export interface OutstandingPayer {
  payerId: string;
  /** The payer's name from settings; its ID when settings no longer list it. */
  payerName: string;
  /** Submitted or accepted claims not yet paid in full. */
  claims: number;
  /** What those claims still wait for: accepted (or else claimed) less paid. */
  cents: number;
}

export interface OverviewResponse {
  byStatus: Record<ClaimStatus, number>;
  /** Open CHAS claims whose submission deadline is `days` days away or fewer. */
  chasDueSoon: { days: number; count: number };
  outstandingByPayer: OutstandingPayer[];
  /** Payment statements (remittance files) imported so far; with none, there is nothing to match (QA D04). */
  paymentStatements: number;
  /** Remittance lines no claim was matched to. */
  unmatchedRemittanceLines: number;
}
