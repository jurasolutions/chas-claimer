import { describe, expect, it } from "vitest";
import { actorId, type AuditEvent } from "../../domain/types";
import type { RebuildReason } from "../../domain/types";
import { historyWords, who } from "./ClaimHistory";

describe("who did it, in a claim's history", () => {
  it("names the payer simulator, so its decisions don't read as the desk's own", () => {
    expect(who(actorId({ kind: "system", name: "simulator" }))).toBe("Payer simulator");
  });

  it("names any other system actor as the desk, and a person by their email", () => {
    expect(who(actorId({ kind: "system", name: "connector" }))).toBe("The desk");
    expect(who("officer@clinic.test")).toBe("officer@clinic.test");
  });
});

describe("a claim's history in words", () => {
  const event = (detail: Record<string, unknown>): AuditEvent => ({
    id: 1,
    at: "2026-11-14T02:00:00.000Z",
    actor: "officer@clinic.test",
    action: "accepted_by_remittance",
    entityType: "claim",
    entityId: "1",
    detail,
  });

  it("prints a whole-cent amount from the audit detail", () => {
    expect(historyWords(event({ acceptedCents: 12345 }))).toBe("Accepted by the payment at $123.45");
  });

  it("leaves out an amount that isn't a whole number of cents rather than failing", () => {
    expect(historyWords(event({ acceptedCents: 1.5 }))).toBe("Accepted by the payment");
  });
});

describe("a withdrawal in a claim's history (QA N4)", () => {
  const withdraw = (detail: Record<string, unknown>): AuditEvent => ({
    id: 2,
    at: "2026-11-14T02:00:00.000Z",
    actor: "system:rebuild",
    action: "withdraw",
    entityType: "claim",
    entityId: "1",
    detail,
  });

  const AFTER: Record<RebuildReason, string> = {
    import: "Withdrawn after an import (visit revision 3)",
    settings: "Withdrawn after a settings change (visit revision 3)",
    code_map: "Withdrawn after a code-map change (visit revision 3)",
    annotations: "Withdrawn after annotations were saved (visit revision 3)",
    deadline: "Withdrawn after the deadline check (visit revision 3)",
    lifecycle: "Withdrawn after a status change (visit revision 3)",
  };

  it.each(Object.entries(AFTER))("words a rebuild's %s reason as a sentence, never the raw reason", (reason, words) => {
    expect(historyWords(withdraw({ revision: 3, reason, from: "ready", why: "no_longer_built" }))).toBe(words);
  });

  it("says when the visit was voided in the clinic", () => {
    expect(historyWords(withdraw({ revision: 4, reason: "import", from: "approved", why: "voided_in_clinic" }))).toBe(
      "Withdrawn because the visit was voided in the clinic (visit revision 4)",
    );
  });

  it("keeps an officer's own reason as they wrote it", () => {
    expect(historyWords(withdraw({ reason: "Patient paid in cash instead" }))).toBe("Withdrawn: Patient paid in cash instead");
  });
});
