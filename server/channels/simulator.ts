/**
 * The simulator channel (AC-4.7): the desk's own stand-in for a payer. A claim lands in the simulator's
 * inbox with its masked packet and a `SIM-` reference; a person then accepts, rejects or pays it on
 * the simulator page. Nothing leaves the desk, so the packet stays masked.
 *
 * The simulator records payments with no money behind them, so it is off on a deployed desk: it runs
 * only with `DEMO_MODE=yes` or on a desk addressed as localhost. Off, its routes answer 404 and a
 * claim approved for the simulator channel is refused before it is sent.
 */
import { isLoopback } from "../auth";
import type { Env } from "../env";
import { problem } from "../http";
import { receive } from "../repo/simulator";
import type { SubmissionChannel } from "./index";

/** Whether the payer simulator runs for this request: a demo deployment, or a developer's machine. */
export const simulatorOn = (env: Env, request: Request): boolean => env.DEMO_MODE === "yes" || isLoopback(request);

/** Wraps a simulator route so it answers 404 `not_found`, before anything else, while the simulator is off. */
export function simulatorOnly(handler: PagesFunction<Env>): PagesFunction<Env> {
  return (context) => (simulatorOn(context.env, context.request) ? handler(context) : problem(404, "not_found"));
}

export const simulatorChannel: SubmissionChannel = {
  kind: "simulator",
  opensIdentity: false,
  unavailable: () => null,
  async send(outgoing, { db, payer, now }) {
    const at = new Date(now).toISOString();
    const results = [];
    for (const { packet } of outgoing) {
      const reference = await receive(db, { claimId: packet.claimId, payerId: payer.id, packetMasked: packet, at });
      results.push({ claimId: packet.claimId, ok: true as const, reference });
    }
    return { kind: "sent", results };
  },
};
