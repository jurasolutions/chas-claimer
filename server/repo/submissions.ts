/**
 * Submission attempts (decisions-g2 #9: a resubmission is an attempt, not a new claim). Each row
 * records what was sent, masked, with the hash of the packet, and how the channel answered.
 *
 * A row written with a claim transition passes `guard`: it is inserted only if the claim now carries
 * the transition's nonce in `last_action`, like the transition's audit events, so a write that lost a
 * race records no attempt.
 */
import type { Channel } from "../../src/domain/types";

export const SUBMISSION_RESULTS = ["checklist", "exported", "sent", "failed"] as const;
export type SubmissionResult = (typeof SUBMISSION_RESULTS)[number];

export interface SubmissionDraft {
  claimId: string;
  channel: Channel;
  batchRef: string | null;
  /** The packet with every identifier masked: what the desk keeps of what it sent. */
  packetMasked: unknown;
  packetHash: string;
  result: SubmissionResult;
  portalReference: string | null;
  error: string | null;
  actor: string;
  at: string;
}

export interface Submission extends SubmissionDraft {
  id: string;
  attempt: number;
}

const NEXT_ATTEMPT = "(SELECT COALESCE(MAX(attempt), 0) + 1 FROM submissions WHERE claim_id = ?)";

/** The statement that records one attempt, numbered after the claim's last. */
export function submissionStatement(db: D1Database, draft: SubmissionDraft, guard?: { nonce: string }): D1PreparedStatement {
  const values = [
    crypto.randomUUID(),
    draft.claimId,
    draft.claimId,
    draft.channel,
    draft.batchRef,
    JSON.stringify(draft.packetMasked),
    draft.packetHash,
    draft.result,
    draft.portalReference,
    draft.error,
    draft.actor,
    draft.at,
  ];
  const columns = "INSERT INTO submissions (id, claim_id, attempt, channel, batch_ref, packet_masked_json, packet_hash, result, portal_reference, error, actor, at)";
  const select = `SELECT ?, ?, ${NEXT_ATTEMPT}, ?, ?, ?, ?, ?, ?, ?, ?, ?`;
  if (!guard) return db.prepare(`${columns} ${select}`).bind(...values);
  return db.prepare(`${columns} ${select} FROM claims WHERE id = ? AND last_action = ?`).bind(...values, draft.claimId, guard.nonce);
}

interface SubmissionRow {
  id: string;
  claim_id: string;
  attempt: number;
  channel: Channel;
  batch_ref: string | null;
  packet_masked_json: string;
  packet_hash: string;
  result: SubmissionResult;
  portal_reference: string | null;
  error: string | null;
  actor: string;
  at: string;
}

/** A claim's attempts, first first. */
export async function list(db: D1Database, claimId: string): Promise<Submission[]> {
  const { results } = await db.prepare("SELECT * FROM submissions WHERE claim_id = ? ORDER BY attempt").bind(claimId).all<SubmissionRow>();
  return results.map((r) => ({
    id: r.id,
    claimId: r.claim_id,
    attempt: r.attempt,
    channel: r.channel,
    batchRef: r.batch_ref,
    packetMasked: JSON.parse(r.packet_masked_json) as unknown,
    packetHash: r.packet_hash,
    result: r.result,
    portalReference: r.portal_reference,
    error: r.error,
    actor: r.actor,
    at: r.at,
  }));
}

/**
 * Whether a write failed because its portal reference already names another claim at the same
 * payer. A reference names one claim at one payer, so a second use is a typing slip (S6, AC-4.3).
 * The `submissions_reference_once` trigger refuses that insert inside the transition's batch, so
 * the whole write rolls back and two claims sent at once cannot both take one reference.
 */
export function isReferenceTaken(error: unknown): boolean {
  return error instanceof Error && error.message.includes("portal_reference_taken");
}
