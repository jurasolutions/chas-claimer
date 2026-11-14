/**
 * The UAT's §7 starting point for payment statements: the claims R1 and R2 pay, already sent. The
 * submission flows belong to other tickets, so these claims are moved straight to their status.
 */
import type { ClaimPatch } from "../../server/repo/claims";
import * as claims from "../../server/repo/claims";
import { cents } from "../../src/domain/money";
import type { PayerId } from "../../src/domain/types";
import { CLINIC, type Desk, seededDesk } from "./fixtures";

const AT = "2026-11-13T02:00:00.000Z";

/** R1, the CHAS statement, as an upload names it. */
export const R1 = { payerId: "CHAS", fileName: "r1-chas.csv", csv: CLINIC.remittances.r1Chas };
/** R2, the Meridian statement. */
export const R2 = { payerId: "MERIDIAN", fileName: "r2-meridian.csv", csv: CLINIC.remittances.r2Meridian };

export async function claimOf(db: D1Database, visitKey: string, payerId: PayerId) {
  const claim = (await claims.forVisit(db, visitKey)).find((c) => c.payerId === payerId);
  if (!claim) throw new Error(`no ${payerId} claim for ${visitKey}`);
  return claim;
}

/** Moves a claim straight to a status, standing in for the submission flows of other tickets. */
export async function force(db: D1Database, visitKey: string, payerId: PayerId, status: "submitted" | "accepted", patch: Partial<ClaimPatch> = {}) {
  const c = await claimOf(db, visitKey, payerId);
  await claims
    .transitionStatement(db, c.id, c.version, crypto.randomUUID(), {
      status,
      updatedAt: AT,
      submittedRevision: c.builtFromRevision,
      channel: "assisted",
      ...patch,
    })
    .run();
}

/** D01, D03, P04's D02 and D04b, sent and waiting for payment. */
export async function awaitingPayment(): Promise<Desk> {
  const desk = await seededDesk();
  await force(desk.db, "SC-D01", "CHAS", "submitted", { portalReference: "MHCP-0001" });
  await force(desk.db, "SC-D03", "CHAS", "accepted", { portalReference: "MHCP-0002", acceptedCents: cents(59450) });
  await force(desk.db, "SC-D02-P04", "CHAS", "submitted");
  await force(desk.db, "SC-D04b", "MERIDIAN", "submitted", { portalReference: "MDP-0001" });
  return desk;
}
