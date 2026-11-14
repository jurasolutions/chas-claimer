import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbActionSequence } from "../../tests/helpers/arbitraries";
import { allowedActions, applyAction } from "./lifecycle";
import type { ClaimState } from "./claims/state";
import { CLAIM_STATUSES, type Actor, type ClaimAction, type ClaimStatus, type Finding } from "./types";
import type { Cents } from "./money";
import type { IsoDate } from "./dates";

const NOW = "2026-11-13T02:00:00.000Z";
const REVIEWER: Actor = { kind: "person", email: "reviewer@example.com", roles: ["reviewer"] };
const OFFICER: Actor = { kind: "person", email: "officer@example.com", roles: ["officer"] };

const c = (n: number) => n as Cents;

function claim(overrides: Partial<ClaimState> = {}): ClaimState {
  return {
    id: "C-1",
    visitKey: "V-1",
    payerId: "CHAS",
    scheme: "chas",
    branchId: "B-1",
    status: "ready",
    version: 1,
    lastAction: "n0",
    ruleSetId: "chas-2026",
    builtFromRevision: 2,
    approvedRevision: null,
    submittedRevision: null,
    feeCents: c(8000),
    claimedCents: c(6000),
    paidCents: c(0),
    acceptedCents: null,
    overpaid: false,
    deadline: "2026-12-01" as IsoDate,
    portalReference: null,
    channel: null,
    changedAfterSubmission: false,
    selfApproved: false,
    approvedBy: null,
    approvedAt: null,
    rejectionReason: null,
    patientHash: "h",
    patientMask: "T****567A",
    visitDate: "2026-11-01" as IsoDate,
    annotations: {},
    checkoutBy: null,
    checkoutUntil: null,
    createdAt: NOW,
    updatedAt: NOW,
    lines: [],
    findings: [],
    ...overrides,
  };
}

describe("approve", () => {
  it("moves a ready claim to approved and records who approved it, from which revision, on which channel", () => {
    const r = applyAction(claim(), { kind: "approve" }, REVIEWER, NOW, { importedBy: "a@example.com", channel: "assisted" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.next).toMatchObject({
      status: "approved",
      approvedRevision: 2,
      approvedBy: "reviewer@example.com",
      approvedAt: NOW,
      selfApproved: false,
      channel: "assisted",
    });
    expect(r.value.audit).toEqual([
      {
        at: NOW,
        actor: "reviewer@example.com",
        action: "approve",
        entityType: "claim",
        entityId: "C-1",
        detail: { label: "approved", warnings: 0, revision: 2 },
      },
    ]);
  });

  it("labels an approval of your own import as self-approval and counts the warnings it was approved with (S17)", () => {
    const warning: Finding = { code: "deadline_approaching", severity: "warning", params: { daysLeft: 3 } };
    const r = applyAction(claim({ findings: [warning] }), { kind: "approve" }, REVIEWER, NOW, { importedBy: "reviewer@example.com" });
    expect(r.ok && r.value.next.selfApproved).toBe(true);
    expect(r.ok && r.value.audit[0]?.detail).toMatchObject({ label: "approved (self-approval)", warnings: 1 });
  });

  it("refuses an officer (S11)", () => {
    const r = applyAction(claim(), { kind: "approve" }, OFFICER, NOW);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: "forbidden" }) });
  });

  it("refuses a claim with a blocking finding even if its status still says ready", () => {
    const blocking: Finding = { code: "past_submission_window", severity: "blocking", params: {} };
    const r = applyAction(claim({ findings: [blocking] }), { kind: "approve" }, REVIEWER, NOW);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: "not_allowed" }) });
  });
});

// ---------------------------------------------------------------- SC4.1: the transition table

const BLOCKING: Finding = { code: "card_expired", severity: "blocking", params: {} };
const SENT = { submittedRevision: 2, approvedRevision: 2, approvedBy: "reviewer@example.com", approvedAt: NOW, channel: "assisted" as const, portalReference: "REF-1", changedAfterSubmission: true };

/** One or more claims per status, covering each way out of it. */
const FROM: Record<ClaimStatus, ClaimState[]> = {
  needs_attention: [claim({ status: "needs_attention", findings: [BLOCKING] })],
  ready: [claim({ status: "ready" })],
  approved: [claim({ status: "approved", approvedRevision: 2, approvedBy: "reviewer@example.com", approvedAt: NOW, channel: "assisted" })],
  submitted: [claim({ status: "submitted", ...SENT })],
  accepted: [claim({ status: "accepted", ...SENT, acceptedCents: c(6000) })],
  paid: [claim({ status: "paid", ...SENT, acceptedCents: c(6000), paidCents: c(6000) })],
  rejected: [
    claim({ status: "rejected", ...SENT, rejectionReason: "Card invalid", findings: [BLOCKING] }),
    claim({ status: "rejected", ...SENT, rejectionReason: "Card invalid" }),
  ],
  withdrawn: [claim({ status: "withdrawn" })],
  written_off: [claim({ status: "written_off", ...SENT, rejectionReason: "Card invalid" })],
};

/** Every action with a payload the lifecycle would accept if the status allowed it. */
const ACTIONS: ClaimAction[] = [
  { kind: "approve" },
  { kind: "unapprove" },
  { kind: "submit", portalReference: "REF-2" },
  { kind: "portal_refused", message: "Balance used up" },
  { kind: "accept" },
  { kind: "accept", acceptedCents: c(5000), reason: "Benchmark applied" },
  { kind: "reject", reason: "Not covered" },
  { kind: "record_payment", cents: c(6000), paidOn: "2026-11-20" as IsoDate },
  { kind: "record_payment", cents: c(3000), paidOn: "2026-11-20" as IsoDate },
  { kind: "record_payment", cents: c(7000), paidOn: "2026-11-20" as IsoDate },
  { kind: "accept_short_payment", reason: "Payer will not pay the rest" },
  { kind: "reopen" },
  { kind: "withdraw", reason: "Patient paid in cash" },
  { kind: "write_off", reason: "Not worth resubmitting" },
  { kind: "acknowledge_change", note: "Only the notes changed" },
];

/** AC-3.1 as a table: the statuses each status can reach by a person's or payer's action. */
const REACHABLE: Record<ClaimStatus, ClaimStatus[]> = {
  needs_attention: ["withdrawn"],
  ready: ["approved", "withdrawn"],
  approved: ["ready", "submitted", "rejected", "withdrawn"],
  submitted: ["submitted", "accepted", "rejected", "paid"],
  accepted: ["accepted", "paid"],
  rejected: ["rejected", "needs_attention", "ready", "written_off"],
  paid: ["paid"],
  withdrawn: [],
  written_off: [],
};

// ---------------------------------------------------------------- each step's details

const APPROVED = FROM.approved[0]!;
const SUBMITTED = FROM.submitted[0]!;
const ACCEPTED = FROM.accepted[0]!;
const ON = "2026-11-20" as IsoDate;

function step(from: ClaimState, action: ClaimAction, actor: Actor = REVIEWER) {
  const r = applyAction(from, action, actor, NOW);
  if (!r.ok) throw new Error(`expected ${action.kind} to succeed: ${JSON.stringify(r.error)}`);
  return r.value;
}

describe("accept", () => {
  it("accepts the claimed amount when the payer names no other", () => {
    expect(step(SUBMITTED, { kind: "accept" }).next).toMatchObject({ status: "accepted", acceptedCents: 6000 });
  });

  it("needs a reason when the payer accepts less than was claimed", () => {
    const r = applyAction(SUBMITTED, { kind: "accept", acceptedCents: c(5000) }, REVIEWER, NOW);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: "invalid", field: "reason" }) });
    expect(step(SUBMITTED, { kind: "accept", acceptedCents: c(5000), reason: "Benchmark applied" }).audit[0]?.detail).toEqual({
      acceptedCents: 5000,
      claimedCents: 6000,
      reason: "Benchmark applied",
    });
  });

  it("refuses an accepted amount above what was claimed", () => {
    const r = applyAction(SUBMITTED, { kind: "accept", acceptedCents: c(6001) }, REVIEWER, NOW);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: "invalid", field: "acceptedCents" }) });
  });
});

describe("record payment", () => {
  it("treats a payment on a submitted claim as the payer accepting what it paid, and records both", () => {
    const t = step(SUBMITTED, { kind: "record_payment", cents: c(4500), paidOn: ON, remittanceLineId: "RL-1" });
    expect(t.next).toMatchObject({ status: "paid", acceptedCents: 4500, paidCents: 4500, overpaid: false });
    expect(t.audit.map((a) => [a.action, a.detail])).toEqual([
      ["accepted_by_remittance", { acceptedCents: 4500, claimedCents: 6000 }],
      ["record_payment", { cents: 4500, paidOn: ON, remittanceLineId: "RL-1" }],
    ]);
  });

  it("keeps an accepted claim accepted until the payments reach the accepted amount", () => {
    const part = step(ACCEPTED, { kind: "record_payment", cents: c(2500), paidOn: ON }).next;
    expect(part).toMatchObject({ status: "accepted", paidCents: 2500, overpaid: false });
    const rest = step(part, { kind: "record_payment", cents: c(3500), paidOn: ON }).next;
    expect(rest).toMatchObject({ status: "paid", paidCents: 6000, overpaid: false });
  });

  it("flags a payment above the accepted amount as an overpayment", () => {
    expect(step(ACCEPTED, { kind: "record_payment", cents: c(6500), paidOn: ON }).next).toMatchObject({ status: "paid", paidCents: 6500, overpaid: true });
    expect(step(SUBMITTED, { kind: "record_payment", cents: c(7000), paidOn: ON }).next).toMatchObject({ acceptedCents: 6000, overpaid: true });
  });

  it("refuses a zero amount and a missing date", () => {
    expect(applyAction(ACCEPTED, { kind: "record_payment", cents: c(0), paidOn: ON }, REVIEWER, NOW)).toEqual({ ok: false, error: expect.objectContaining({ field: "cents" }) });
    expect(applyAction(ACCEPTED, { kind: "record_payment", cents: c(100), paidOn: "" as IsoDate }, REVIEWER, NOW)).toEqual({
      ok: false,
      error: expect.objectContaining({ field: "paidOn" }),
    });
  });
});

describe("accept short payment", () => {
  it("closes a part-paid claim as paid and records what is written off", () => {
    const part = claim({ ...ACCEPTED, paidCents: c(4000) });
    const t = step(part, { kind: "accept_short_payment", reason: "Payer will not pay the rest" });
    expect(t.next.status).toBe("paid");
    expect(t.audit[0]?.detail).toEqual({ reason: "Payer will not pay the rest", paidCents: 4000, acceptedCents: 6000, writtenOffCents: 2000 });
  });

  it("needs a reason", () => {
    const r = applyAction(claim({ ...ACCEPTED, paidCents: c(4000) }), { kind: "accept_short_payment", reason: " " }, REVIEWER, NOW);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: "invalid", field: "reason" }) });
  });
});

describe("submit", () => {
  it("records the reference, fixes the submitted revision and releases the checkout", () => {
    const t = step(claim({ ...APPROVED, checkoutBy: "reviewer@example.com", checkoutUntil: NOW }), { kind: "submit", portalReference: " REF-9 " });
    expect(t.next).toMatchObject({ status: "submitted", portalReference: "REF-9", submittedRevision: 2, checkoutBy: null, checkoutUntil: null });
    expect(t.audit[0]?.detail).toEqual({ channel: "assisted", portalReference: "REF-9", revision: 2 });
  });

  it("refuses a claim whose approval was for an older revision of the visit (F5.2)", () => {
    const r = applyAction(claim({ ...APPROVED, builtFromRevision: 3, approvedRevision: 2 }), { kind: "submit", portalReference: "REF-9" }, REVIEWER, NOW);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: "not_allowed", detail: expect.stringMatching(/approve it again/) }) });
  });

  it("refuses an empty reference (AC-4.3)", () => {
    const r = applyAction(APPROVED, { kind: "submit", portalReference: "   " }, REVIEWER, NOW);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: "invalid", field: "portalReference" }) });
  });

  it("refuses an assisted submission with no reference at all", () => {
    const r = applyAction(APPROVED, { kind: "submit" }, REVIEWER, NOW);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: "invalid", field: "portalReference" }) });
  });
});

describe("leaving the desk clears the approval (Sec-2)", () => {
  const CLEARED = { approvedRevision: null, approvedBy: null, approvedAt: null, selfApproved: false, channel: null, checkoutBy: null, checkoutUntil: null };

  it("withdraw needs a reason and clears who approved it", () => {
    expect(applyAction(APPROVED, { kind: "withdraw", reason: "" }, REVIEWER, NOW)).toEqual({ ok: false, error: expect.objectContaining({ field: "reason" }) });
    const t = step(claim({ ...APPROVED, selfApproved: true, checkoutBy: "x@example.com", checkoutUntil: NOW }), { kind: "withdraw", reason: "Patient paid in cash" }, OFFICER);
    expect(t.next).toMatchObject({ status: "withdrawn", ...CLEARED });
    expect(t.audit[0]?.detail).toEqual({ reason: "Patient paid in cash", from: "approved" });
  });

  it("unapprove returns the claim to ready and clears the approval", () => {
    expect(step(APPROVED, { kind: "unapprove" }).next).toMatchObject({ status: "ready", ...CLEARED });
  });

  it("reopen sends a rejected claim back to the desk with nothing left from the last submission", () => {
    const t = step(FROM.rejected[1]!, { kind: "reopen" });
    expect(t.next).toMatchObject({ status: "ready", ...CLEARED, rejectionReason: null, portalReference: null, submittedRevision: null, changedAfterSubmission: false });
    expect(t.audit[0]?.detail).toEqual({ status: "ready", rejectionReason: "Card invalid" });
  });
});

describe("acknowledge change", () => {
  const changed = claim({ ...SUBMITTED, changedAfterSubmission: true });

  it("needs a note, and clears the flag", () => {
    expect(applyAction(changed, { kind: "acknowledge_change", note: "" }, REVIEWER, NOW)).toEqual({ ok: false, error: expect.objectContaining({ field: "note" }) });
    expect(step(changed, { kind: "acknowledge_change", note: "Only the notes changed" }).next.changedAfterSubmission).toBe(false);
  });

  it("is not offered when nothing changed", () => {
    expect(applyAction(claim({ ...SUBMITTED, changedAfterSubmission: false }), { kind: "acknowledge_change", note: "x" }, REVIEWER, NOW)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_allowed" }),
    });
  });
});

describe("who may act", () => {
  const SIMULATOR: Actor = { kind: "system", name: "simulator" };
  const REMITTANCE: Actor = { kind: "system", name: "remittance" };
  const CONNECTOR: Actor = { kind: "system", name: "connector" };
  const NOBODY: Actor = { kind: "person", email: "nobody@example.com", roles: [] };

  it("lets the simulator record outcomes but not approve or submit", () => {
    expect(applyAction(SUBMITTED, { kind: "accept" }, SIMULATOR, NOW).ok).toBe(true);
    expect(applyAction(APPROVED, { kind: "submit", portalReference: "R" }, SIMULATOR, NOW)).toEqual({ ok: false, error: expect.objectContaining({ code: "forbidden" }) });
  });

  it("lets remittance record payments and nothing else", () => {
    expect(applyAction(SUBMITTED, { kind: "record_payment", cents: c(100), paidOn: ON }, REMITTANCE, NOW).ok).toBe(true);
    expect(applyAction(SUBMITTED, { kind: "reject", reason: "x" }, REMITTANCE, NOW)).toEqual({ ok: false, error: expect.objectContaining({ code: "forbidden" }) });
  });

  it("refuses the connector and a person with no role everything", () => {
    for (const action of ACTIONS) {
      expect(applyAction(SUBMITTED, action, CONNECTOR, NOW)).toEqual({ ok: false, error: expect.objectContaining({ code: "forbidden" }) });
      expect(applyAction(SUBMITTED, action, NOBODY, NOW)).toEqual({ ok: false, error: expect.objectContaining({ code: "forbidden" }) });
    }
  });

  it("does not offer Approve to an officer (AC-3.3)", () => {
    expect(allowedActions(claim(), REVIEWER)).toEqual(["approve", "withdraw"]);
    expect(allowedActions(claim(), OFFICER)).toEqual(["withdraw"]);
    expect(allowedActions(APPROVED, OFFICER)).toEqual(["submit", "portal_refused", "withdraw"]);
  });

  it("offers no further payment on a paid claim, though a remittance line can still record one (D17)", () => {
    const paid = claim({ ...ACCEPTED, status: "paid", paidCents: c(6000) });
    expect(allowedActions(paid, OFFICER)).not.toContain("record_payment");
    expect(allowedActions(ACCEPTED, OFFICER)).toContain("record_payment");
    expect(allowedActions(SUBMITTED, OFFICER)).toContain("record_payment");
    expect(applyAction(paid, { kind: "record_payment", cents: c(100), paidOn: ON }, REMITTANCE, NOW).ok).toBe(true);
  });
});

describe("the transition table (AC-3.1)", () => {
  it.each(CLAIM_STATUSES.map((s) => [s]))("from %s reaches exactly the allowed statuses, and refuses everything else as not allowed", (from) => {
    const reached = new Set<ClaimStatus>();
    for (const start of FROM[from]) {
      for (const action of ACTIONS) {
        const r = applyAction(start, action, REVIEWER, NOW);
        if (r.ok) reached.add(r.value.next.status);
        else expect(r.error.code, `${from} + ${action.kind}`).toBe("not_allowed");
      }
    }
    expect([...reached].sort()).toEqual([...REACHABLE[from]].sort());
  });
});

// ---------------------------------------------------------------- SC4.2: random runs

const AFTER_SUBMISSION: ReadonlySet<ClaimStatus> = new Set(["submitted", "accepted", "paid", "rejected", "written_off"]);
const WARNING: Finding = { code: "deadline_approaching", severity: "warning", params: { daysLeft: 3 } };

const LINE: ClaimState["lines"][number] = { lineNo: 1, treatmentRef: 0, schemeCode: "CONS", tooth: null, quantity: 1, feeCents: c(8000), consideredCents: c(8000), claimedCents: c(6000) };

/** A claim in every status, so short runs still reach each part of the table. */
const arbStart = fc.record({
  start: fc.constantFrom(claim({ findings: [WARNING] }), ...Object.values(FROM).flat()).map((s): ClaimState => ({ ...s, lines: [LINE] })),
  channel: fc.constantFrom("assisted" as const, "api" as const, "file" as const),
  changeAfterSubmission: fc.boolean(),
});

describe("any run of actions (SC4.2)", () => {
  it("only moves a claim along the table, and never changes its amounts once it has been sent", () => {
    fc.assert(
      fc.property(arbStart, arbActionSequence, ({ start, channel, changeAfterSubmission }, steps) => {
        let current = start;
        for (const { action, actor } of steps) {
          const r = applyAction(current, action, actor, NOW, { channel, importedBy: "reviewer@example.com" });
          if (!r.ok) {
            expect(["not_allowed", "forbidden", "invalid"]).toContain(r.error.code);
            continue;
          }
          const { next, audit } = r.value;
          expect(REACHABLE[current.status]).toContain(next.status);
          expect(audit.length).toBeGreaterThan(0);
          expect(next.paidCents).toBeGreaterThanOrEqual(current.paidCents);
          if (next.acceptedCents !== null) expect(next.acceptedCents).toBeLessThanOrEqual(next.claimedCents);
          if (next.status === "approved" && current.status !== "approved") {
            // Only a reviewer's approval puts a claim in approved, and it names them.
            expect(actor.kind === "person" && actor.roles.includes("reviewer")).toBe(true);
            expect(next.approvedBy).toBe(actor.kind === "person" ? actor.email : undefined);
          }
          if (next.status !== "approved" && !AFTER_SUBMISSION.has(next.status)) expect(next.approvedBy).toBeNull();
          if (AFTER_SUBMISSION.has(current.status)) {
            expect({ fee: next.feeCents, claimed: next.claimedCents, lines: next.lines }).toEqual({ fee: current.feeCents, claimed: current.claimedCents, lines: current.lines });
          }
          // The connector may flag a sent claim as changed at any point; model that so acknowledging is exercised.
          current = changeAfterSubmission && next.status === "submitted" ? { ...next, changedAfterSubmission: true } : next;        }
      }),
    );  });
});
