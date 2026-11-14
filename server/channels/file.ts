/**
 * The file channel (AC-4.5, F9): one CSV for the payer, its columns the payer's template in order, one
 * row per claim. `toCsv` neutralises any text cell that starts like a formula. The file is answered
 * once and never stored; the claims stay approved until the officer confirms the upload.
 */
import { toCsv } from "../../src/domain/csv";
import { sgtDay } from "../../src/domain/dates";
import type { SubmissionChannel } from "./index";

export const fileChannel: SubmissionChannel = {
  kind: "file",
  opensIdentity: true,
  unavailable: () => null,
  send: async (outgoing, { payer, now }) => {
    const columns = payer.templateFields.map((key) => ({ key, header: key }));
    const rows = outgoing.map(({ packet }) => Object.fromEntries(packet.fields.map((f) => [f.key, f.value])));
    const batchRef = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    return {
      kind: "file",
      claimIds: outgoing.map((o) => o.packet.claimId),
      filename: `${payer.id.toLowerCase()}-${sgtDay(now)}-${batchRef.slice(0, 6)}.csv`,
      csv: toCsv(columns, rows),
      batchRef,
    };
  },
};
