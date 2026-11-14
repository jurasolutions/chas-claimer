// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { jsonAnswer, stubNetwork, type Answer } from "../../../tests/helpers/network";
import type { ClaimDetail as Detail } from "../../api/claim-detail";
import type { MeResponse } from "../../api/common";
import type { IsoDate } from "../../domain/dates";
import { finding } from "../../domain/claims/findings";
import { cents } from "../../domain/money";
import type { AuditEvent } from "../../domain/types";
import { MeContext } from "../me";
import { ClaimDetail } from "./ClaimDetail";

const day = (s: string) => s as IsoDate;
const origin = window.location.origin;
const DETAIL = `${origin}/api/claims/c-d01`;
const ACTIONS = `${origin}/api/claims/c-d01/actions`;
const ANNOTATIONS = `${origin}/api/claims/c-d01/annotations`;

const OFFICER: MeResponse = { email: "officer@clinic.test", roles: ["officer"], aiConfigured: false, demoMode: true };
const REVIEWER: MeResponse = { email: "reviewer@clinic.test", roles: ["reviewer"], aiConfigured: false, demoMode: true };

const event = (id: number, action: AuditEvent["action"], detail: Record<string, unknown>, at = "2026-11-12T02:05:00.000Z"): AuditEvent => ({
  id,
  at,
  actor: "officer@clinic.test",
  action,
  entityType: "claim",
  entityId: "c-d01",
  detail,
});

/** A synthetic D01-like CHAS claim, ready for a reviewer: masked patient only. */
function detail(overrides: Partial<Detail> = {}, claim: Partial<Detail["claim"]> = {}): Detail {
  return {
    claim: {
      id: "c-d01",
      visitKey: "SC-D01",
      payerId: "CHAS",
      scheme: "chas",
      branchId: "BR-EAST",
      status: "ready",
      version: 3,
      ruleSetId: "chas-2026-01",
      builtFromRevision: 1,
      approvedRevision: null,
      submittedRevision: null,
      feeCents: cents(9592),
      claimedCents: cents(5050),
      paidCents: cents(0),
      acceptedCents: null,
      overpaid: false,
      deadline: day("2026-12-10"),
      portalReference: null,
      channel: null,
      changedAfterSubmission: false,
      selfApproved: false,
      approvedBy: null,
      approvedAt: null,
      rejectionReason: null,
      patientMask: "T••••567D",
      visitDate: day("2026-11-10"),
      annotations: {},
      checkoutBy: null,
      checkoutUntil: null,
      createdAt: "2026-11-12T02:00:00.000Z",
      updatedAt: "2026-11-12T02:00:00.000Z",
      findings: [],
      ...claim,
    },
    payerName: "CHAS Blue",
    deadline: { deadline: day("2026-12-10"), daysLeft: 26, warning: false, windowDays: 30 },
    actions: ["withdraw"],
    lines: [
      {
        lineNo: 1,
        treatmentRef: 0,
        schemeCode: "CHAS-D-EXT",
        tooth: "36",
        quantity: 1,
        feeCents: cents(9592),
        consideredCents: cents(9592),
        claimedCents: cents(5050),
        clinicCode: "EXT01",
      },
    ],
    split: {
      feeCents: cents(9592),
      segments: [
        { payer: "CHAS", label: "CHAS Blue", cents: cents(5050), claimId: "c-d01" },
        { payer: "patient", label: "Patient", cents: cents(4542) },
      ],
    },
    siblings: [],
    submissions: [],
    audit: [event(1, "built", { reason: "import" })],
    revision: { builtFrom: 1, current: 1 },
    frozenOn: null,
    branchName: "East branch",
    pricedBy: [
      {
        payerId: "CHAS",
        payerName: "CHAS Blue",
        ruleSet: {
          id: "chas-2026-01",
          scheme: "chas",
          effectiveFrom: "2026-01-01",
          effectiveTo: null,
          sources: [{ url: "https://www.chas.sg/example-fee-table", retrieved: "2026-10-01" }],
        },
      },
    ],
    ruleSet: {
      id: "chas-2026-01",
      scheme: "chas",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      sources: [{ url: "https://www.chas.sg/example-fee-table", retrieved: "2026-10-01" }],
    },
    visit: { notes: [], findings: [] },
    ...overrides,
  };
}

function openClaim({ me = OFFICER, routes }: { me?: MeResponse; routes: Record<string, Answer> }) {
  window.history.replaceState(null, "", "/claims/c-d01");
  const fetchStub = stubNetwork(routes);
  render(
    <MeContext.Provider value={me}>
      <ClaimDetail claimId="c-d01" />
    </MeContext.Provider>,
  );
  return fetchStub;
}

/** The JSON bodies the page sent to `url` with a write method. */
function sent(fetchStub: ReturnType<typeof stubNetwork>, url: string): unknown[] {
  return fetchStub.mock.calls
    .filter(([input, init]) => String(input) === url && init?.method !== undefined && init.method !== "GET")
    .map(([, init]) => JSON.parse(String(init!.body)));
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("ClaimDetail", () => {
  it("leads with the amount and payer, its status and deadline, and puts the findings before the claim (S6 layout)", async () => {
    const expired = finding("card_expired", { tier: "orange", expiry: "2026-10-02" });
    openClaim({ routes: { [DETAIL]: jsonAnswer(detail({}, { status: "needs_attention", findings: [expired] })) } });

    const amount = await screen.findByText("$50.50", { selector: ".claim-amount__value" });
    expect(screen.getByText("from CHAS Blue")).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("Due in 26 days")).toBeTruthy();

    const findings = screen.getByRole("region", { name: "What to fix" });
    const claim = screen.getByRole("region", { name: "The claim" });
    expect(findings.compareDocumentPosition(claim) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(findings).getByText(/card/i)).toBeTruthy();
    expect(amount).toBeTruthy();
  });

  it("shows each line's codes and amounts, and the rule set with its sources and the dates they were read (AC-3.7)", async () => {
    openClaim({ routes: { [DETAIL]: jsonAnswer(detail()) } });

    const lines = await screen.findByRole("table", { name: "Lines" });
    const row = within(lines).getAllByRole("row")[1]!;
    for (const text of ["EXT01", "CHAS-D-EXT", "36", "1", "$95.92", "$50.50"]) expect(within(row).getAllByText(text).length).toBeGreaterThan(0);

    const rules = screen.getByRole("region", { name: "Rule set" });
    expect(within(rules).getByText("chas-2026-01")).toBeTruthy();
    expect(within(rules).getByText(/In force from 1 Jan 2026/)).toBeTruthy();
    const source = within(rules).getByRole("link", { name: /chas\.sg/ });
    expect(source.getAttribute("href")).toBe("https://www.chas.sg/example-fee-table");
    expect(within(rules).getByText(/Read on 1 Oct 2026/)).toBeTruthy();
    expect(within(rules).getByText(/Built from visit revision 1/)).toBeTruthy();
  });

  it("lets a keyboard user reach the lines table when it scrolls sideways on a phone", async () => {
    openClaim({ routes: { [DETAIL]: jsonAnswer(detail()) } });

    await screen.findByRole("table", { name: "Lines" });
    const scroller = screen.getByRole("region", { name: "Lines" });
    expect(scroller.tabIndex).toBe(0);
    expect(within(scroller).getByRole("table")).toBeTruthy();
  });

  it("says when the visit has changed since the claim was built", async () => {
    openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ revision: { builtFrom: 1, current: 2 } })) } });

    expect(await screen.findByText(/The visit is now at revision 2/)).toBeTruthy();
  });

  it("shows the history oldest first in plain words, with who did it and when in Singapore time (AC-3.6, S17)", async () => {
    const audit = [
      event(1, "built", { reason: "import" }, "2026-11-12T02:00:00.000Z"),
      { ...event(2, "approve", { label: "approved", warnings: 1, revision: 1 }, "2026-11-12T02:05:00.000Z"), actor: "reviewer@clinic.test" },
      event(3, "withdraw", { reason: "Patient paid in full", from: "approved" }, "2026-11-13T09:30:00.000Z"),
    ];
    openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ audit }, { status: "withdrawn" })) } });

    const history = await screen.findByRole("list", { name: "History" });
    const items = within(history).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("Built from the visit")).toBeTruthy();
    expect(within(items[1]!).getByText("Approved with 1 warning")).toBeTruthy();
    expect(within(items[1]!).getByText(/reviewer@clinic\.test/)).toBeTruthy();
    expect(within(items[1]!).getByText(/12 Nov 2026, 10:05/)).toBeTruthy();
    expect(within(items[2]!).getByText("Withdrawn: Patient paid in full")).toBeTruthy();
  });

  it("names a self-approval in the history", async () => {
    const audit = [event(1, "approve", { label: "approved (self-approval)", warnings: 0, revision: 1 })];
    openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ audit }, { status: "approved" })) } });

    expect(await screen.findByText("Approved (self-approval)")).toBeTruthy();
  });

  it("shows the waterfall across payers and links the visit's other claims (AC-3.7)", async () => {
    const split = {
      feeCents: cents(95000),
      segments: [
        { payer: "CHAS", label: "CHAS Blue", cents: cents(46250), claimId: "c-d01" },
        { payer: "MEDISAVE", label: "MediSave", cents: cents(40000), claimId: "c-d01-ms" },
        { payer: "patient", label: "Patient", cents: cents(8750) },
      ],
    };
    const siblings = [{ id: "c-d01-ms", payerId: "MEDISAVE", payerName: "MediSave", scheme: "medisave_tosp" as const, status: "ready" as const, claimedCents: cents(40000) }];
    openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ split, siblings })) } });

    const pays = await screen.findByRole("region", { name: "Who pays" });
    expect(within(pays).getByRole("img", { name: "CHAS Blue pays $462.50, MediSave $400.00, patient pays $87.50 of $950.00" })).toBeTruthy();
    const other = within(pays).getByRole("link", { name: /MediSave/ });
    expect(other.getAttribute("href")).toBe("/claims/c-d01-ms");
    expect(within(other.closest("li")!).getByText("Ready")).toBeTruthy();
  });

  it("keeps the patient masked until asked, and reveals through the audited route", async () => {
    const fetchStub = openClaim({
      routes: {
        [DETAIL]: jsonAnswer(detail()),
        [`${origin}/api/claims/c-d01/reveal`]: jsonAnswer({ value: "T9000000J" }),
      },
    });

    const patient = await screen.findByRole("region", { name: "Patient" });
    expect(within(patient).getByText("T••••567D")).toBeTruthy();
    expect(within(patient).getByText(/10 Nov 2026/)).toBeTruthy();
    fireEvent.click(within(patient).getByRole("button", { name: "Show NRIC/FIN" }));

    expect(await within(patient).findByText("T9000000J")).toBeTruthy();
    expect(sent(fetchStub, `${origin}/api/claims/c-d01/reveal`)).toEqual([{ field: "nric" }]);
  });

  it("lists each submission attempt: how it went, the channel, the reference or the failure, who and when", async () => {
    const attempt = { batchRef: null, packetHash: "a1b2c3d4e5f6", actor: "officer@clinic.test" };
    const submissions: Detail["submissions"] = [
      { ...attempt, id: "s-1", attempt: 1, channel: "api", result: "failed", portalReference: null, error: "The payer's service did not answer", at: "2026-11-13T01:00:00.000Z" },
      { ...attempt, id: "s-2", attempt: 2, channel: "assisted", result: "checklist", portalReference: "CHAS-2026-0042", error: null, at: "2026-11-13T03:15:00.000Z" },
    ];
    openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ submissions }, { status: "submitted" })) } });

    const list = await screen.findByRole("list", { name: "Submissions" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("Attempt 1 through the payer's API: it didn't go through")).toBeTruthy();
    expect(within(items[0]!).getByText("The payer's service did not answer")).toBeTruthy();
    expect(within(items[0]!).getByText(/13 Nov 2026, 9:00 am/)).toBeTruthy();
    expect(within(items[1]!).getByText("Attempt 2 by hand on the portal, reference CHAS-2026-0042")).toBeTruthy();
    expect(within(items[1]!).getByText(/officer@clinic\.test/)).toBeTruthy();
    expect(within(items[1]!).getByText(/13 Nov 2026, 11:15/)).toBeTruthy();
  });

  it("leaves the submissions out until there is one", async () => {
    openClaim({ routes: { [DETAIL]: jsonAnswer(detail()) } });

    await screen.findByRole("region", { name: "The claim" });
    expect(screen.queryByRole("list", { name: "Submissions" })).toBeNull();
  });

  describe("where the claim stands", () => {
    it("gives a rejected claim's reason from the payer", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({}, { status: "rejected", rejectionReason: "Card expired on visit date" })) } });

      expect(await screen.findByText("Card expired on visit date")).toBeTruthy();
      expect(screen.getByText(/The payer rejected this claim/)).toBeTruthy();
    });

    it("says how much of the accepted amount has been paid (AC-5.3)", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({}, { status: "accepted", acceptedCents: cents(59450), paidCents: cents(55000) })) } });

      expect(await screen.findByText("Paid $550.00 of $594.50")).toBeTruthy();
    });

    it("says how far short a paid claim closed of what was claimed (QA N8)", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ actions: [] }, { status: "paid", claimedCents: cents(10000), acceptedCents: cents(4000), paidCents: cents(4000) })) } });

      expect(await screen.findByText("Paid $40.00, $60.00 short of the $100.00 claimed")).toBeTruthy();
    });

    it("says nothing of a shortfall when a paid claim was paid in full", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ actions: [] }, { status: "paid", claimedCents: cents(10000), paidCents: cents(10000) })) } });

      await screen.findByRole("region", { name: "What the checks found" });
      expect(screen.queryByText(/short of/)).toBeNull();
    });

    it("flags an overpayment for a person to look at", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({}, { status: "paid", acceptedCents: cents(5050), paidCents: cents(6000), overpaid: true })) } });

      expect(await screen.findByText("Overpaid by $9.50")).toBeTruthy();
    });

    it("says the visit changed after submission and offers to acknowledge it (S7)", async () => {
      openClaim({
        routes: {
          [DETAIL]: jsonAnswer(detail({ actions: ["acknowledge_change"] }, { status: "submitted", changedAfterSubmission: true, portalReference: "MHCP-77" })),
        },
      });

      expect(await screen.findByText(/The visit changed after this claim was submitted/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Acknowledge the change" })).toBeTruthy();
    });

    it("says who is submitting the claim and until when (S6)", async () => {
      openClaim({
        routes: {
          [DETAIL]: jsonAnswer(detail({}, { status: "approved", checkoutBy: "other@clinic.test", checkoutUntil: "2026-11-12T02:20:00.000Z" })),
        },
      });

      expect(await screen.findByText("Being submitted by other@clinic.test until 12 Nov 2026, 10:20 am")).toBeTruthy();
    });

    it("shows nothing extra for a ready claim", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail()) } });

      await screen.findByRole("region", { name: "What to fix" });
      expect(screen.queryByText(/Paid \$|Overpaid|rejected|Being submitted|changed after/)).toBeNull();
    });
  });

  describe("once the claim is settled (D05, D07, D17)", () => {
    it("says an unsent claim with a blocking finding can't be submitted, whatever amount it shows", async () => {
      const missing = finding("unmapped_treatment", { clinicCode: "X99" });
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({}, { status: "needs_attention", findings: [missing] })) } });

      expect(await screen.findByText("$50.50", { selector: ".claim-amount__value" })).toBeTruthy();
      expect(screen.getByText("This claim can't be submitted until its blocking findings are fixed.")).toBeTruthy();
    });

    it("says the same of a blocked claim the scheme pays nothing on", async () => {
      const expired = finding("card_expired", { tier: "blue", expiry: "2026-10-02" });
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({}, { status: "needs_attention", claimedCents: cents(0), findings: [expired] })) } });

      expect(await screen.findByText("$0.00", { selector: ".claim-amount__value" })).toBeTruthy();
      expect(screen.getByText("This claim can't be submitted until its blocking findings are fixed.")).toBeTruthy();
    });

    it("says nothing of the kind for a claim with only warnings", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({}, { findings: [finding("deadline_approaching", { daysLeft: 2 })] })) } });

      await screen.findByRole("region", { name: "What to fix" });
      expect(screen.queryByText(/can't be submitted until/)).toBeNull();
    });

    it("no longer says a withdrawn claim's findings block submission", async () => {
      const expired = finding("card_expired", { tier: "blue", expiry: "2026-10-02" });
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ actions: [] }, { status: "withdrawn", findings: [expired] })) } });

      const findings = await screen.findByRole("region", { name: "What the checks found" });
      expect(within(findings).getByText(/card/i)).toBeTruthy();
      expect(within(findings).queryByText("Blocks submission")).toBeNull();
      expect(screen.queryByRole("region", { name: "What to fix" })).toBeNull();
      expect(screen.queryByText(/can't be submitted until/)).toBeNull();
    });

    it("offers a paid claim nothing to fix", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ actions: [] }, { status: "paid", acceptedCents: cents(5050), paidCents: cents(5050) })) } });

      const findings = await screen.findByRole("region", { name: "What the checks found" });
      expect(within(findings).getByText("The checks found nothing on this claim.")).toBeTruthy();
      expect(screen.queryByRole("region", { name: "What to fix" })).toBeNull();
    });

    it("keeps a rejected claim's findings as things to fix, since it can be reopened", async () => {
      const late = finding("past_submission_window", { windowDays: 30 });
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ actions: ["reopen", "write_off"] }, { status: "rejected", findings: [late] })) } });

      const findings = await screen.findByRole("region", { name: "What to fix" });
      expect(within(findings).getByText("Blocks submission")).toBeTruthy();
    });
  });

  describe("about this visit (D02)", () => {
    it("says a line was held and passes on the visit's own warnings", async () => {
      const visit: Detail["visit"] = {
        notes: [{ code: "held_until_complete", params: { clinicCode: "CRN01" } }],
        findings: [finding("pa_patient_balance", { balanceCents: 15000 })],
      };
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ visit })) } });

      const about = await screen.findByRole("region", { name: "About this visit" });
      expect(within(about).getByText("Treatment CRN01 is held until it's complete. It's claimed on the visit that completes it.")).toBeTruthy();
      expect(within(about).getByText(/A Public Assistance patient pays nothing for those, and this visit leaves \$150\.00\./)).toBeTruthy();
    });

    it("leaves the section out when the visit has nothing to say", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail()) } });

      await screen.findByRole("region", { name: "What to fix" });
      expect(screen.queryByRole("region", { name: "About this visit" })).toBeNull();
    });
  });

  describe("as built (D12)", () => {
    it("says a sent or closed claim's split is as built on the day it was built", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ frozenOn: day("2026-11-12"), revision: { builtFrom: 1, current: 2 } }, { status: "withdrawn" })) } });

      const pays = await screen.findByRole("region", { name: "Who pays" });
      expect(within(pays).getByText("As built on 12 Nov 2026. Later changes to the visit don't change these figures.")).toBeTruthy();
    });

    it("says nothing about when it was built while the claim can still change", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail()) } });

      const pays = await screen.findByRole("region", { name: "Who pays" });
      expect(within(pays).queryByText(/As built on/)).toBeNull();
    });
  });

  describe("where the figures came from (D03, D13)", () => {
    it("names the visit's branch from settings, not its code", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail()) } });

      const patient = await screen.findByRole("region", { name: "Patient" });
      expect(within(patient).getByText("at East branch")).toBeTruthy();
      expect(within(patient).queryByText(/BR-EAST/)).toBeNull();
    });

    it("names the rule set and source behind each scheme payer on the bill", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail()) } });

      const pays = await screen.findByRole("region", { name: "Who pays" });
      const priced = within(pays).getByRole("list", { name: "How each scheme priced its share" });
      const item = within(priced).getByRole("listitem");
      expect(item.textContent).toContain("CHAS Blue");
      expect(item.textContent).toContain("chas-2026-01");
      expect(within(item).getByRole("link", { name: "www.chas.sg/example-fee-table" }).getAttribute("href")).toBe("https://www.chas.sg/example-fee-table");
    });

    it("says nothing about a rule set on an insurer's claim, which no scheme rule set prices", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ ruleSet: null, pricedBy: [] }, { scheme: "insurance", payerId: "MERIDIAN", ruleSetId: "none" })) } });

      await screen.findByRole("region", { name: "Who pays" });
      expect(screen.queryByText(/No rule set covered this visit/)).toBeNull();
      expect(screen.queryByRole("region", { name: "Rule set" })).toBeNull();
      expect(screen.getByText(/Built from visit revision 1/)).toBeTruthy();
    });
  });

  it("says no rule set covered the visit when none applied", async () => {
    openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ ruleSet: null })) } });

    const rules = await screen.findByRole("region", { name: "Rule set" });
    expect(within(rules).getByText(/No rule set covered this visit/)).toBeTruthy();
  });

  describe("actions", () => {
    it("lets a reviewer approve a claim with no warnings in one click, sending the version it read (AC-3.3)", async () => {
      const approved = detail({ actions: ["unapprove", "withdraw"] }, { status: "approved", version: 4 });
      const fetchStub = openClaim({
        me: REVIEWER,
        routes: { [DETAIL]: jsonAnswer(detail({ actions: ["approve", "withdraw"] })), [ACTIONS]: jsonAnswer(approved) },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

      expect(await screen.findByText("Approved")).toBeTruthy();
      expect(sent(fetchStub, ACTIONS)).toEqual([{ action: { kind: "approve" }, expectedVersion: 3 }]);
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    });

    it("shows the reviewer every warning before an approval goes through (S17)", async () => {
      const soon = finding("deadline_approaching", { daysLeft: 2 });
      const ready = detail({ actions: ["approve", "withdraw"] }, { findings: [soon] });
      const approved = detail({ actions: ["unapprove"] }, { status: "approved", version: 4, findings: [soon] });
      const fetchStub = openClaim({ me: REVIEWER, routes: { [DETAIL]: jsonAnswer(ready), [ACTIONS]: jsonAnswer(approved) } });

      fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

      const dialog = screen.getByRole("dialog", { name: "Approve with 1 warning?" });
      expect(within(dialog).getByText("Last 3 days to submit. Approve and submit it soon.")).toBeTruthy();
      expect(sent(fetchStub, ACTIONS)).toEqual([]);

      fireEvent.click(within(dialog).getByRole("button", { name: "Approve anyway" }));

      expect(await screen.findByText("Approved")).toBeTruthy();
      expect(sent(fetchStub, ACTIONS)).toEqual([{ action: { kind: "approve" }, expectedVersion: 3 }]);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("withdraws a claim only with a reason (S8)", async () => {
      const withdrawn = detail({ actions: [] }, { status: "withdrawn", version: 4 });
      const fetchStub = openClaim({ routes: { [DETAIL]: jsonAnswer(detail()), [ACTIONS]: jsonAnswer(withdrawn) } });

      fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
      const dialog = screen.getByRole("dialog", { name: "Withdraw this claim" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));

      expect(within(dialog).getByText("Say why.")).toBeTruthy();
      expect(document.activeElement).toBe(within(dialog).getByLabelText("Reason"));
      expect(sent(fetchStub, ACTIONS)).toEqual([]);

      fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Patient paid in full" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));

      expect(await screen.findByText("Withdrawn")).toBeTruthy();
      expect(sent(fetchStub, ACTIONS)).toEqual([{ action: { kind: "withdraw", reason: "Patient paid in full" }, expectedVersion: 3 }]);
    });

    // QA defect D06 (qa-01.md; root in the read-only DS Dialog): the app's Dialog wrapper in
    // `src/ds.ts` moves focus inside. The trap and the return to the trigger are tested in
    // `src/dialog.test.tsx`.
    it("moves focus into the withdraw dialog when it opens", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail()) } });
      const trigger = await screen.findByRole("button", { name: "Withdraw" });
      trigger.focus();

      fireEvent.click(trigger);

      const dialog = screen.getByRole("dialog", { name: "Withdraw this claim" });
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it("offers withdrawal as the fix when the claim can never be paid (S8)", async () => {
      const green = finding("chas_green_no_dental");
      const withdrawn = detail({ actions: [] }, { status: "withdrawn", version: 4, findings: [green] });
      const fetchStub = openClaim({
        routes: { [DETAIL]: jsonAnswer(detail({ actions: ["withdraw"] }, { status: "needs_attention", findings: [green] })), [ACTIONS]: jsonAnswer(withdrawn) },
      });

      const findings = await screen.findByRole("region", { name: "What to fix" });
      fireEvent.click(within(findings).getByRole("button", { name: "Withdraw this claim" }));
      const dialog = screen.getByRole("dialog", { name: "Withdraw this claim" });

      fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "CHAS Green, no dental subsidy" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));

      expect(await screen.findByText("Withdrawn")).toBeTruthy();
      expect(sent(fetchStub, ACTIONS)).toEqual([{ action: { kind: "withdraw", reason: "CHAS Green, no dental subsidy" }, expectedVersion: 3 }]);
    });

    it("doesn't carry another action's refusal into the withdraw dialog the fix opens", async () => {
      const late = finding("past_submission_window", { windowDays: 30 });
      openClaim({
        routes: {
          [DETAIL]: jsonAnswer(detail({ actions: ["reopen", "withdraw"] }, { status: "rejected", findings: [late] })),
          [ACTIONS]: jsonAnswer({ error: "forbidden" }, 403),
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));
      fireEvent.click(within(screen.getByRole("dialog", { name: "Reopen this claim" })).getByRole("button", { name: "Reopen" }));
      expect((await screen.findByRole("alert")).textContent).toContain("You don't have access to do that.");

      fireEvent.click(within(screen.getByRole("region", { name: "What to fix" })).getByRole("button", { name: "Withdraw this claim" }));
      const dialog = screen.getByRole("dialog", { name: "Withdraw this claim" });
      expect(within(dialog).queryByRole("alert")).toBeNull();
    });

    it("offers no withdrawal fix for a finding that can be fixed, or when withdrawing isn't on offer (S8)", async () => {
      const expired = finding("card_expired", { tier: "blue", expiry: "2026-10-02" });
      const late = finding("past_submission_window", { windowDays: 30 });
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ actions: [] }, { status: "needs_attention", findings: [expired, late] })) } });

      const findings = await screen.findByRole("region", { name: "What to fix" });
      expect(within(findings).queryByRole("button")).toBeNull();
    });

    it("offers no withdrawal fix while every finding can still be fixed (S8)", async () => {
      const soon = finding("deadline_approaching", { daysLeft: 2 });
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ actions: ["approve", "withdraw"] }, { findings: [soon] })) } });

      const findings = await screen.findByRole("region", { name: "What to fix" });
      expect(within(findings).queryByRole("button")).toBeNull();
    });

    it("asks before reopening a rejected claim, and sends nothing until you confirm (D17)", async () => {
      const reopened = detail({ actions: ["withdraw"] }, { status: "ready", version: 5 });
      const fetchStub = openClaim({
        routes: { [DETAIL]: jsonAnswer(detail({ actions: ["reopen", "write_off"] }, { status: "rejected", version: 4, rejectionReason: "Yearly balance used up" })), [ACTIONS]: jsonAnswer(reopened) },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));
      const dialog = screen.getByRole("dialog", { name: "Reopen this claim" });
      expect(sent(fetchStub, ACTIONS)).toEqual([]);

      fireEvent.click(within(dialog).getByRole("button", { name: "Reopen" }));
      expect(await screen.findByText("Ready")).toBeTruthy();
      expect(sent(fetchStub, ACTIONS)).toEqual([{ action: { kind: "reopen" }, expectedVersion: 4 }]);
    });

    it("names how much short the claim closes before you accept a short payment (QA N8)", async () => {
      const short = detail({ actions: ["accept_short_payment"] }, { status: "accepted", version: 7, claimedCents: cents(10000), paidCents: cents(4000) });
      const fetchStub = openClaim({ routes: { [DETAIL]: jsonAnswer(short) } });

      fireEvent.click(await screen.findByRole("button", { name: "Accept the short payment" }));
      const dialog = screen.getByRole("dialog", { name: "Accept the short payment" });
      expect(within(dialog).getByText("This closes the claim $60.00 short of what was claimed. The difference is written off.")).toBeTruthy();
      expect(sent(fetchStub, ACTIONS)).toEqual([]);
    });

    it("measures the shortfall against what the payer accepted, when that was less than the claim", async () => {
      const short = detail(
        { actions: ["accept_short_payment"] },
        { status: "accepted", claimedCents: cents(10000), acceptedCents: cents(8000), paidCents: cents(4000) },
      );
      openClaim({ routes: { [DETAIL]: jsonAnswer(short) } });

      fireEvent.click(await screen.findByRole("button", { name: "Accept the short payment" }));
      const dialog = screen.getByRole("dialog", { name: "Accept the short payment" });
      expect(within(dialog).getByText("This closes the claim $40.00 short of the $80.00 the payer accepted. The difference is written off.")).toBeTruthy();
    });

    it("records a payment in dollars and a date, and refuses an amount it can't read", async () => {
      const accepted = detail({ actions: ["record_payment"] }, { status: "accepted", version: 7, acceptedCents: cents(5050) });
      const paid = detail({ actions: [] }, { status: "paid", version: 8, paidCents: cents(5050) });
      const fetchStub = openClaim({ routes: { [DETAIL]: jsonAnswer(accepted), [ACTIONS]: jsonAnswer(paid) } });

      fireEvent.click(await screen.findByRole("button", { name: "Record a payment" }));
      const dialog = screen.getByRole("dialog", { name: "Record a payment" });
      fireEvent.change(within(dialog).getByLabelText("Amount paid"), { target: { value: "50.5.0" } });
      fireEvent.change(within(dialog).getByLabelText("Paid on"), { target: { value: "2026-11-20" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Record the payment" }));

      expect(within(dialog).getByText(/Enter an amount in dollars/)).toBeTruthy();
      expect(document.activeElement).toBe(within(dialog).getByLabelText("Amount paid"));
      expect(sent(fetchStub, ACTIONS)).toEqual([]);

      fireEvent.change(within(dialog).getByLabelText("Amount paid"), { target: { value: "50.50" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Record the payment" }));

      expect(await screen.findByText("Paid")).toBeTruthy();
      expect(sent(fetchStub, ACTIONS)).toEqual([
        { action: { kind: "record_payment", cents: 5050, paidOn: "2026-11-20" }, expectedVersion: 7 },
      ]);
    });

    it("records acceptance in full when no amount is given", async () => {
      const submitted = detail({ actions: ["accept", "reject"] }, { status: "submitted", version: 6 });
      const accepted = detail({ actions: [] }, { status: "accepted", version: 7 });
      const fetchStub = openClaim({ routes: { [DETAIL]: jsonAnswer(submitted), [ACTIONS]: jsonAnswer(accepted) } });

      fireEvent.click(await screen.findByRole("button", { name: "Record acceptance" }));
      const dialog = screen.getByRole("dialog", { name: "Record acceptance" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Record acceptance" }));
      expect(await screen.findByText("Accepted")).toBeTruthy();

      expect(sent(fetchStub, ACTIONS)).toEqual([{ action: { kind: "accept" }, expectedVersion: 6 }]);
    });

    it("takes a lower accepted amount with its reason", async () => {
      const submitted = detail({ actions: ["accept"] }, { status: "submitted", version: 6 });
      const fetchStub = openClaim({ routes: { [DETAIL]: jsonAnswer(submitted), [ACTIONS]: jsonAnswer(detail({ actions: [] }, { status: "accepted" })) } });

      fireEvent.click(await screen.findByRole("button", { name: "Record acceptance" }));
      const dialog = screen.getByRole("dialog", { name: "Record acceptance" });
      fireEvent.change(within(dialog).getByLabelText("Amount accepted"), { target: { value: "40" } });
      fireEvent.change(within(dialog).getByLabelText("Reason for a lower amount"), { target: { value: "Capped at the scheme rate" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Record acceptance" }));
      await screen.findByText("Accepted");

      expect(sent(fetchStub, ACTIONS)).toEqual([
        { action: { kind: "accept", acceptedCents: 4000, reason: "Capped at the scheme rate" }, expectedVersion: 6 },
      ]);
    });

    it("sends an approved claim to the submit page", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ actions: ["submit", "unapprove", "withdraw"] }, { status: "approved" })) } });

      const submit = await screen.findByRole("link", { name: "Submit" });
      expect(submit.getAttribute("href")).toBe("/submit?claim=c-d01");
    });

    it("withdraws an approval in one click", async () => {
      const approved = detail({ actions: ["unapprove", "withdraw"] }, { status: "approved", version: 4 });
      const fetchStub = openClaim({ me: REVIEWER, routes: { [DETAIL]: jsonAnswer(approved), [ACTIONS]: jsonAnswer(detail({}, { version: 5 })) } });

      fireEvent.click(await screen.findByRole("button", { name: "Clear approval" }));

      expect(await screen.findByText("Ready")).toBeTruthy();
      expect(sent(fetchStub, ACTIONS)).toEqual([{ action: { kind: "unapprove" }, expectedVersion: 4 }]);
    });

    it("reloads a claim that changed while it was open and says so, instead of acting on it (stale)", async () => {
      let reads = 0;
      const before = detail({ actions: ["approve", "withdraw"] });
      const after = detail({ actions: ["unapprove"] }, { status: "approved", version: 4 });
      const fetchStub = openClaim({
        me: REVIEWER,
        routes: {
          [DETAIL]: () => jsonAnswer(reads++ === 0 ? before : after)(new Request(DETAIL)),
          [ACTIONS]: jsonAnswer({ error: "stale", currentVersion: 4 }, 409),
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

      expect((await screen.findByRole("alert")).textContent).toContain("This claim changed while you had it open.");
      expect(await screen.findByText("Approved")).toBeTruthy();
      expect(reads).toBe(2);
      expect(sent(fetchStub, ACTIONS)).toHaveLength(1);
    });

    it("keeps the dialog open with what was typed when an action fails, and says what went wrong", async () => {
      openClaim({
        routes: { [DETAIL]: jsonAnswer(detail()), [ACTIONS]: jsonAnswer({ error: "forbidden" }, 403) },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
      const dialog = screen.getByRole("dialog", { name: "Withdraw this claim" });
      fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Duplicate" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));

      expect((await within(dialog).findByRole("alert")).textContent).toContain("You don't have access to do that.");
      expect((within(dialog).getByLabelText("Reason") as HTMLTextAreaElement).value).toBe("Duplicate");
      expect(screen.getByText("Ready")).toBeTruthy();
    });

    it("says a portal refusal marks the claim rejected, to reopen before it is sent again", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ actions: ["portal_refused", "withdraw"] }, { status: "approved" })) } });

      fireEvent.click(await screen.findByRole("button", { name: "Record a portal refusal" }));

      const dialog = screen.getByRole("dialog", { name: "Record a portal refusal" });
      expect(within(dialog).getByText("The claim is marked rejected. Reopen it to fix it and send it again.")).toBeTruthy();
    });

    it("shows the server's reason next to the field it names when what was entered is refused", async () => {
      const submitted = detail({ actions: ["accept"] }, { status: "submitted", version: 6 });
      openClaim({
        routes: {
          [DETAIL]: jsonAnswer(submitted),
          [ACTIONS]: jsonAnswer({ error: "invalid", issues: [{ path: "acceptedCents", message: "The payer cannot accept more than was claimed." }] }, 400),
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Record acceptance" }));
      const dialog = screen.getByRole("dialog", { name: "Record acceptance" });
      fireEvent.change(within(dialog).getByLabelText("Amount accepted"), { target: { value: "60" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Record acceptance" }));

      const amount = within(dialog).getByLabelText("Amount accepted");
      await waitFor(() => expect(amount.getAttribute("aria-invalid")).toBe("true"));
      expect(within(dialog).getByText("The payer cannot accept more than was claimed.")).toBeTruthy();
      expect(within(dialog).queryByRole("alert", { name: /Check what you entered/ })).toBeNull();
      expect((amount as HTMLInputElement).value).toBe("60");
    });

    it("shows the server's reason in the alert when it names no field on the form", async () => {
      openClaim({
        routes: {
          [DETAIL]: jsonAnswer(detail()),
          [ACTIONS]: jsonAnswer({ error: "invalid", issues: [{ path: "action", message: "Choose what to do with the claim." }] }, 400),
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
      const dialog = screen.getByRole("dialog", { name: "Withdraw this claim" });
      fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Duplicate" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));

      expect((await within(dialog).findByRole("alert")).textContent).toContain("Choose what to do with the claim.");
    });

    it("says another person is submitting the claim when it is checked out", async () => {
      openClaim({
        me: REVIEWER,
        routes: {
          [DETAIL]: jsonAnswer(detail({ actions: ["unapprove"] }, { status: "approved", checkoutBy: "officer@clinic.test" })),
          [ACTIONS]: jsonAnswer({ error: "checked_out", by: "officer@clinic.test", until: "2026-11-12T02:20:00.000Z" }, 409),
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Clear approval" }));

      expect((await screen.findByRole("alert")).textContent).toBe(
        "officer@clinic.test is submitting this claim. Try again after 12 Nov 2026, 10:20 am.",
      );
    });

    it("says an action didn't go through when the network fails", async () => {
      openClaim({
        me: REVIEWER,
        routes: {
          [DETAIL]: jsonAnswer(detail({ actions: ["approve"] })),
          [ACTIONS]: () => Promise.reject(new TypeError("Failed to fetch")),
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

      expect((await screen.findByRole("alert")).textContent).toContain("That didn't go through. Try again.");
      expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("offers no approve button when the server doesn't offer it (an officer)", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer(detail({ actions: ["withdraw"] })) } });

      expect(await screen.findByRole("button", { name: "Withdraw" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    });
  });

  describe("justification and references", () => {
    it("saves the justification for a fee above the benchmark, sending the version it read", async () => {
      const above = finding("benchmark_exceeded", { minCents: 2100, maxCents: 3100 });
      const saved = detail({}, { version: 4, annotations: { justification: "Impacted lower molar, surgical removal." } });
      const fetchStub = openClaim({
        routes: { [DETAIL]: jsonAnswer(detail({}, { status: "needs_attention", findings: [above] })), [ANNOTATIONS]: jsonAnswer(saved) },
      });

      fireEvent.change(await screen.findByLabelText("Clinical justification"), {
        target: { value: "  Impacted lower molar, surgical removal. " },
      });
      fireEvent.change(screen.getByLabelText("MCAF reference"), { target: { value: "MCAF-0042" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(screen.getByRole("button", { name: "Saving…" }).getAttribute("aria-busy")).toBe("true");
      expect(await screen.findByText("Ready")).toBeTruthy();
      expect(sent(fetchStub, ANNOTATIONS)).toEqual([
        {
          annotations: { justification: "Impacted lower molar, surgical removal.", preAuthReference: null, mcafReference: "MCAF-0042" },
          expectedVersion: 3,
        },
      ]);
      expect(screen.queryByText(/Add a clinical justification/)).toBeNull();
      expect((screen.getByLabelText("Clinical justification") as HTMLTextAreaElement).value).toBe("Impacted lower molar, surgical removal.");
      expect((screen.getByLabelText("MCAF reference") as HTMLInputElement).value).toBe("");
    });

    it("shows what was sent, without fields to change it, once the claim is submitted", async () => {
      openClaim({
        routes: {
          [DETAIL]: jsonAnswer(
            detail({ actions: [] }, { status: "submitted", annotations: { justification: "Impacted lower molar, surgical removal." } }),
          ),
        },
      });

      expect(await screen.findByText("Impacted lower molar, surgical removal.")).toBeTruthy();
      expect(screen.queryByLabelText("Clinical justification")).toBeNull();
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    });

    it("keeps what was typed when the claim changed meanwhile, and saves it against the new version", async () => {
      let reads = 0;
      let saves = 0;
      const fetchStub = openClaim({
        routes: {
          [DETAIL]: (request) => jsonAnswer(detail({}, reads++ === 0 ? {} : { version: 5 }))(request),
          [ANNOTATIONS]: (request) =>
            saves++ === 0 ? jsonAnswer({ error: "stale" }, 409)(request) : jsonAnswer(detail({}, { version: 6 }))(request),
        },
      });

      fireEvent.change(await screen.findByLabelText("MCAF reference"), { target: { value: "MCAF-0042" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect((await screen.findByRole("alert")).textContent).toContain("This claim changed while you had it open.");
      await waitFor(() => expect(reads).toBe(2));
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByDisplayValue("MCAF-0042")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(sent(fetchStub, ANNOTATIONS)).toHaveLength(2));
      expect(sent(fetchStub, ANNOTATIONS)[1]).toMatchObject({ expectedVersion: 5 });
    });
  });

  describe("when the claim doesn't load", () => {
    it("says so and tries again when asked", async () => {
      let reads = 0;
      openClaim({
        routes: {
          [DETAIL]: (request) => (reads++ === 0 ? Promise.reject(new TypeError("Failed to fetch")) : jsonAnswer(detail())(request)),
        },
      });

      const alert = await screen.findByRole("alert");
      expect(within(alert).getByText("The claim didn't load.")).toBeTruthy();
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

      expect(await screen.findByText("Ready")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("says there is no such claim, with a way back to the queue, and offers no retry", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer({ error: "not_found" }, 404) } });

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("There is no claim at this address.");
      expect(within(alert).getByRole("link", { name: "Back to the claims" }).getAttribute("href")).toBe("/claims");
      expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
    });

    it("tells someone off the team list who to ask", async () => {
      openClaim({ routes: { [DETAIL]: jsonAnswer({ error: "forbidden" }, 403) } });

      expect((await screen.findByRole("alert")).textContent).toContain("Ask the clinic's administrator to add you.");
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });
  });
});

// QA N1 (qa-02.md): an action replaces the button that ran it. Focus goes to the claim's status
// line, which says what the claim is now, instead of falling to the body.
describe("ClaimDetail: focus after an action (QA N1)", () => {
  it("puts focus on the status line after Approve anyway", async () => {
    const soon = finding("deadline_approaching", { daysLeft: 2 });
    const ready = detail({ actions: ["approve", "withdraw"] }, { findings: [soon] });
    const approved = detail({ actions: ["unapprove"] }, { status: "approved", version: 4, findings: [soon] });
    openClaim({ me: REVIEWER, routes: { [DETAIL]: jsonAnswer(ready), [ACTIONS]: jsonAnswer(approved) } });

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve anyway" }));

    await screen.findByText("Approved");
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.textContent).toContain("Approved");
  });

  it("puts focus on the status line after an approval that sends without a dialog", async () => {
    const approved = detail({ actions: ["unapprove"] }, { status: "approved", version: 4 });
    openClaim({ me: REVIEWER, routes: { [DETAIL]: jsonAnswer(detail({ actions: ["approve"] })), [ACTIONS]: jsonAnswer(approved) } });

    const button = await screen.findByRole("button", { name: "Approve" });
    button.focus();
    fireEvent.click(button);

    await screen.findByRole("button", { name: "Clear approval" });
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.textContent).toContain("Approved");
  });

  it("puts focus on the status line after acknowledging a change", async () => {
    const changed = detail({ actions: ["acknowledge_change"] }, { status: "submitted", changedAfterSubmission: true, portalReference: "MHCP-77" });
    const acknowledged = detail({ actions: [] }, { status: "submitted", version: 4, portalReference: "MHCP-77" });
    openClaim({ routes: { [DETAIL]: jsonAnswer(changed), [ACTIONS]: jsonAnswer(acknowledged) } });

    fireEvent.click(await screen.findByRole("button", { name: "Acknowledge the change" }));
    const dialog = screen.getByRole("dialog", { name: "Acknowledge the change" });
    fireEvent.change(within(dialog).getByLabelText("Note"), { target: { value: "Checked with the front desk" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Acknowledge" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.textContent).toContain("Submitted");
  });

  // QA 03 D02c: Save is disabled while it runs, so focus would fall to the body.
  it("puts focus on what the annotation save did once it settles (QA 03 D02c)", async () => {
    const saved = detail({}, { version: 4, annotations: { mcafReference: "MCAF-0042" } });
    openClaim({ routes: { [DETAIL]: jsonAnswer(detail()), [ANNOTATIONS]: jsonAnswer(saved) } });

    fireEvent.change(await screen.findByLabelText("MCAF reference"), { target: { value: "MCAF-0042" } });
    const save = screen.getByRole("button", { name: "Save" });
    save.focus();
    fireEvent.click(save);

    const status = await screen.findByText("Saved. The checks ran again on what you entered.");
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(status.getAttribute("role")).toBe("status");

    // Changing a field again takes the word back: what is on screen is no longer what was saved.
    fireEvent.change(screen.getByLabelText("MCAF reference"), { target: { value: "MCAF-0043" } });
    expect(screen.queryByText("Saved. The checks ran again on what you entered.")).toBeNull();
  });

  // QA 03 D02g: a stale refusal reloads the claim; the refusal takes focus, not the body.
  it("puts focus on the refusal when an action finds the claim changed meanwhile (QA 03 D02g)", async () => {
    let reads = 0;
    const before = detail({ actions: ["approve", "withdraw"] });
    const after = detail({ actions: ["unapprove"] }, { status: "approved", version: 4 });
    openClaim({
      me: REVIEWER,
      routes: {
        [DETAIL]: () => jsonAnswer(reads++ === 0 ? before : after)(new Request(DETAIL)),
        [ACTIONS]: jsonAnswer({ error: "stale", currentVersion: 4 }, 409),
      },
    });

    const approve = await screen.findByRole("button", { name: "Approve" });
    approve.focus();
    fireEvent.click(approve);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This claim changed while you had it open.");
    await screen.findByText("Approved");
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.contains(screen.getByRole("alert"))).toBe(true);
  });

  it("puts focus on the refusal when an annotation save finds the claim changed meanwhile (QA 03 D02g)", async () => {
    let reads = 0;
    openClaim({
      routes: {
        [DETAIL]: (request) => jsonAnswer(detail({}, reads++ === 0 ? {} : { version: 5 }))(request),
        [ANNOTATIONS]: jsonAnswer({ error: "stale" }, 409),
      },
    });

    fireEvent.change(await screen.findByLabelText("MCAF reference"), { target: { value: "MCAF-0042" } });
    const save = screen.getByRole("button", { name: "Save" });
    save.focus();
    fireEvent.click(save);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This claim changed while you had it open.");
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.contains(screen.getByRole("alert"))).toBe(true);
  });

  it("leaves focus alone when the claim first loads", async () => {
    openClaim({ routes: { [DETAIL]: jsonAnswer(detail()) } });

    await screen.findByRole("button", { name: "Withdraw" });
    expect(document.activeElement).toBe(document.body);
  });
});
