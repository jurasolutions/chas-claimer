/**
 * Submission channels (technical §5, S15): one adapter per way a payer takes claims. The submissions
 * service picks the adapter from the channel stamped on the claim at approval, builds each claim's
 * packet with `buildPacket` (the same for every channel, so the adapters do not each prepare one),
 * and records what the adapter answers through the claims service.
 *
 * An adapter only moves packets. It never changes a claim's status, so the checkout, the reference
 * check and the audit trail stay in `act`.
 */
import type { ClaimPacket } from "../../src/domain/packet";
import type { PayerSettings } from "../../src/domain/settings";
import type { Channel } from "../../src/domain/types";
import type { Env } from "../env";
import { apiChannel } from "./api";
import { assistedChannel } from "./assisted";
import { fileChannel } from "./file";
import { simulatorChannel } from "./simulator";

/** One claim on its way out: its packet, and the visit revision it was approved at. */
export interface Outgoing {
  packet: ClaimPacket;
  revision: number;
  /**
   * Which submission of the claim this is: the number of its earlier attempts that did not fail. A
   * retry after a failure keeps it; a claim the payer rejected, reopened and sent again moves it on.
   */
  cycle: number;
}

export interface ChannelContext {
  env: Env;
  payer: PayerSettings;
  db: D1Database;
  now: number;
}

/** Why a send did not reach the payer. Each leaves the claim approved, to be sent again. */
export type SendError = "timeout" | "network" | `http_${number}` | "redirect" | "bad_response";

export type SendResult =
  /** `assisted`: the officer submits each claim in the portal and records the reference. */
  | { kind: "checklist"; claimIds: string[] }
  /** `file`: the payer's file. The claims stay approved until the officer confirms the upload. */
  | { kind: "file"; claimIds: string[]; filename: string; csv: string; batchRef: string }
  /** `api`, `simulator`: the payer's answer per claim. */
  | { kind: "sent"; results: ({ claimId: string; ok: true; reference: string } | { claimId: string; ok: false; error: SendError })[] };

export interface SubmissionChannel {
  readonly kind: Channel;
  /** True when the packets this channel sends carry identifiers in full (and their sending is audited). */
  readonly opensIdentity: boolean;
  /** Why this payer cannot be sent to on this channel right now, in words for the officer; null when it can. */
  unavailable(payer: PayerSettings, env: Env): string | null;
  send(outgoing: Outgoing[], ctx: ChannelContext): Promise<SendResult>;
}

const CHANNELS: Record<Channel, SubmissionChannel> = {
  assisted: assistedChannel,
  file: fileChannel,
  api: apiChannel,
  simulator: simulatorChannel,
};

export function channelFor(kind: Channel): SubmissionChannel {
  return CHANNELS[kind];
}
