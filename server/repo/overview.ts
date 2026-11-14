/**
 * Counts across the desk: the Today sentence and the approved-claim channels the settings screen
 * warns about (S15). Aggregates only; nothing here reads an identifier.
 */
import { OPEN_STATUSES } from "../../src/api/claims";
import { DUE_SOON_DAYS, type OverviewResponse } from "../../src/api/overview";
import type { ApprovedChannelCount } from "../../src/api/settings";
import { addDays, sgtDay } from "../../src/domain/dates";
import { type Channel, CLAIM_STATUSES, type ClaimStatus } from "../../src/domain/types";
import * as settingsRepo from "./settings";

/**
 * The Today counts (AC-8.3). The CHAS due count uses the queue's own due rule (open statuses, deadline
 * from today to today plus the window) so the sentence and the list it links to agree. A claim past its
 * window has no days left, so it is not counted (QA D18).
 */
export async function overview(db: D1Database, now: number): Promise<OverviewResponse> {
  const open = OPEN_STATUSES.map(() => "?").join(", ");
  const [byStatus, due, outstanding, statements, unmatched, { settings }] = await Promise.all([
    db.prepare("SELECT status, COUNT(*) AS n FROM claims GROUP BY status").all<{ status: ClaimStatus; n: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM claims WHERE scheme = 'chas' AND status IN (${open}) AND deadline_date BETWEEN ? AND ?`)
      .bind(...OPEN_STATUSES, sgtDay(now), addDays(sgtDay(now), DUE_SOON_DAYS))
      .first<number>("n"),
    db
      .prepare(
        `SELECT payer_id, COUNT(*) AS n, SUM(COALESCE(accepted_cents, claimed_cents) - paid_cents) AS cents FROM claims
         WHERE status IN ('submitted', 'accepted') GROUP BY payer_id ORDER BY payer_id`,
      )
      .all<{ payer_id: string; n: number; cents: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM remittances").first<number>("n"),
    db.prepare("SELECT COUNT(*) AS n FROM remittance_lines WHERE claim_id IS NULL").first<number>("n"),
    settingsRepo.get(db),
  ]);
  const payerNames = new Map(settings.payers.map((p) => [p.id, p.name]));
  const counts = Object.fromEntries(CLAIM_STATUSES.map((s) => [s, 0])) as Record<ClaimStatus, number>;
  for (const r of byStatus.results) counts[r.status] = r.n;
  return {
    byStatus: counts,
    chasDueSoon: { days: DUE_SOON_DAYS, count: due ?? 0 },
    outstandingByPayer: outstanding.results.map((r) => ({ payerId: r.payer_id, payerName: payerNames.get(r.payer_id) ?? r.payer_id, claims: r.n, cents: r.cents })),
    paymentStatements: statements ?? 0,
    unmatchedRemittanceLines: unmatched ?? 0,
  };
}

/** S15: approved claims keep the channel stamped when they were approved, whatever settings say now. */
export async function approvedByChannel(db: D1Database): Promise<ApprovedChannelCount[]> {
  const { results } = await db
    .prepare(
      `SELECT payer_id, channel, COUNT(*) AS n FROM claims
       WHERE status = 'approved' AND channel IS NOT NULL
       GROUP BY payer_id, channel ORDER BY payer_id, channel`,
    )
    .all<{ payer_id: string; channel: Channel; n: number }>();
  return results.map((r) => ({ payerId: r.payer_id, channel: r.channel, count: r.n }));
}
