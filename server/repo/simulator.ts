/**
 * The payer simulator's inbox (AC-4.7): one row per claim sent to it, with the masked packet, the
 * simulator's reference and what the simulated payer decided. It holds no identifier.
 */
import type { SimState } from "../../src/domain/types";
import { toHex } from "../bytes";

export interface SimClaim {
  id: string;
  claimId: string;
  payerId: string;
  packetMasked: unknown;
  state: SimState;
  reason: string | null;
  simReference: string;
  paidCents: number | null;
  updatedAt: string;
}

interface SimRow {
  id: string;
  claim_id: string;
  payer_id: string;
  packet_masked_json: string;
  state: SimState;
  reason: string | null;
  sim_reference: string;
  paid_cents: number | null;
  updated_at: string;
}

function fromRow(r: SimRow): SimClaim {
  return {
    id: r.id,
    claimId: r.claim_id,
    payerId: r.payer_id,
    packetMasked: JSON.parse(r.packet_masked_json) as unknown,
    state: r.state,
    reason: r.reason,
    simReference: r.sim_reference,
    paidCents: r.paid_cents,
    updatedAt: r.updated_at,
  };
}

function newReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `SIM-${toHex(bytes).toUpperCase()}`;
}

/**
 * Puts a claim in the inbox and answers its reference. A claim already waiting there keeps its row and
 * reference, as a real payer would. The desk takes back a row whose answer it could not record
 * (`discardStatement`), so a waiting row is one left by a send that stopped before it was recorded.
 */
export async function receive(db: D1Database, sent: { claimId: string; payerId: string; packetMasked: unknown; at: string }): Promise<string> {
  const waiting = await db
    .prepare("SELECT sim_reference FROM sim_inbox WHERE claim_id = ? AND state = 'received' ORDER BY updated_at DESC LIMIT 1")
    .bind(sent.claimId)
    .first<{ sim_reference: string }>();
  if (waiting) {
    await db
      .prepare("UPDATE sim_inbox SET packet_masked_json = ?, updated_at = ? WHERE claim_id = ? AND sim_reference = ?")
      .bind(JSON.stringify(sent.packetMasked), sent.at, sent.claimId, waiting.sim_reference)
      .run();
    return waiting.sim_reference;
  }
  const reference = newReference();
  await db
    .prepare("INSERT INTO sim_inbox (id, claim_id, payer_id, packet_masked_json, state, reason, sim_reference, paid_cents, updated_at) VALUES (?, ?, ?, ?, 'received', NULL, ?, NULL, ?)")
    .bind(crypto.randomUUID(), sent.claimId, sent.payerId, JSON.stringify(sent.packetMasked), reference, sent.at)
    .run();
  return reference;
}

/**
 * Takes a claim back out of the inbox when the desk could not record the simulator's answer, so no
 * row is left waiting against a claim the desk does not show as sent. Only a row nobody has decided.
 */
export function discardStatement(db: D1Database, claimId: string, simReference: string): D1PreparedStatement {
  return db.prepare("DELETE FROM sim_inbox WHERE claim_id = ? AND sim_reference = ? AND state = 'received'").bind(claimId, simReference);
}

/** The inbox, newest first. */
export async function inbox(db: D1Database): Promise<SimClaim[]> {
  const { results } = await db.prepare("SELECT * FROM sim_inbox ORDER BY updated_at DESC, id").all<SimRow>();
  return results.map(fromRow);
}

export async function get(db: D1Database, id: string): Promise<SimClaim | null> {
  const row = await db.prepare("SELECT * FROM sim_inbox WHERE id = ?").bind(id).first<SimRow>();
  return row ? fromRow(row) : null;
}

/** Records the simulated payer's decision, only if the row is still in the state it was read in. */
export async function decide(
  db: D1Database,
  id: string,
  from: SimState,
  to: { state: SimState; reason: string | null; paidCents: number | null; at: string },
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE sim_inbox SET state = ?, reason = COALESCE(?, reason), paid_cents = COALESCE(?, paid_cents), updated_at = ? WHERE id = ? AND state = ?")
    .bind(to.state, to.reason, to.paidCents, to.at, id, from)
    .run();
  return res.meta.changes === 1;
}
