/**
 * The assisted channel (AC-4.2): nothing leaves the desk. The officer opens each claim's checklist,
 * copies the fields into the payer's portal and records the reference the portal gives.
 */
import type { SubmissionChannel } from "./index";

export const assistedChannel: SubmissionChannel = {
  kind: "assisted",
  opensIdentity: false,
  unavailable: () => null,
  send: async (outgoing) => ({ kind: "checklist", claimIds: outgoing.map((o) => o.packet.claimId) }),
};
