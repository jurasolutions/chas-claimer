// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonAnswer, stubNetwork, type Answer } from "../../../tests/helpers/network";
import type { ClaimRow } from "../../api/claims";
import type { MeResponse } from "../../api/common";
import type { PacketView, SubmitResponse } from "../../api/submissions";
import type { IsoDate } from "../../domain/dates";
import { cents } from "../../domain/money";
import { MeContext } from "../me";
import { AssistedSubmit } from "./AssistedSubmit";

const day = (s: string) => s as IsoDate;
const origin = window.location.origin;
const CHECKOUT = `${origin}/api/claims/c-d01/checkout`;
const DETAIL = `${origin}/api/claims/c-d01`;
const ACTIONS = `${origin}/api/claims/c-d01/actions`;
const APPROVED = `${origin}/api/claims?status=approved&limit=100`;
const SUBMIT = `${origin}/api/submissions`;
const CONFIRM = `${origin}/api/submissions/confirm`;

const OFFICER_B: MeResponse = { email: "b@clinic.test", roles: ["officer"], aiConfigured: false, demoMode: true };

/** A synthetic D01-like CHAS packet, masked as the route sends it. */
const packet = (overrides: Partial<PacketView> = {}): PacketView => ({
  claimId: "c-d01",
  payerId: "CHAS",
  payerName: "CHAS Blue",
  channel: "assisted",
  status: "approved",
  version: 4,
  portalReference: null,
  portalUrl: null,
  checkout: { by: "b@clinic.test", until: "2026-11-14T03:00:00.000Z" },
  fields: [
    { key: "visit_date", label: "Visit date", text: "2026-11-10", masked: false, revealField: null },
    { key: "patient_nric", label: "Patient NRIC/FIN", text: "T••••567D", masked: true, revealField: "nric" },
    { key: "patient_name", label: "Patient name", text: null, masked: true, revealField: "name" },
    { key: "treatment_code", label: "Treatment code", text: "EXT01", masked: false, revealField: null },
    { key: "claim_amount", label: "Claim amount", text: "50.50", masked: false, revealField: null },
  ],
  ...overrides,
});

const split = {
  split: {
    feeCents: cents(9592),
    segments: [
      { payer: "CHAS", label: "CHAS Blue", cents: cents(5050), claimId: "c-d01" },
      { payer: "patient", label: "Patient", cents: cents(4542) },
    ],
  },
};

/** A synthetic approved row; every patient is masked. */
const row = (id: string, payerId: string, payerName: string, version = 2): ClaimRow => ({
  id,
  visitKey: `SC-${id}`,
  status: "approved",
  scheme: payerId === "CHAS" ? "chas" : "insurance",
  payerId,
  payerName,
  branchId: "BR-EAST",
  branchName: "East branch",
  patientMask: `T••••${id.slice(-3)}D`,
  visitDate: day("2026-11-10"),
  feeCents: cents(30000),
  claimedCents: cents(28800),
  deadline: null,
  changedAfterSubmission: false,
  blockingCount: 0,
  findings: [],
  version,
});

function open(path: string, routes: Record<string, Answer>) {
  window.history.replaceState(null, "", path);
  const fetchStub = stubNetwork(routes);
  render(
    <MeContext.Provider value={OFFICER_B}>
      <AssistedSubmit />
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

describe("AssistedSubmit: one claim's checklist", () => {
  it("holds the claim, then lists the payer's fields in portal order with a copy button each and the identifier masked (AC-4.2)", async () => {
    const fetchStub = open("/submit?claim=c-d01", { [CHECKOUT]: jsonAnswer(packet()), [DETAIL]: jsonAnswer(split) });

    const facts = await screen.findByRole("region", { name: "What to enter in the portal" });
    const labels = within(facts)
      .getAllByRole("term")
      .map((term) => term.textContent);
    expect(labels).toEqual(["Visit date", "Patient NRIC/FIN", "Patient name", "Treatment code", "Claim amount"]);
    expect(screen.getByRole("button", { name: "Copy visit date" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy claim amount" })).toBeTruthy();
    expect(screen.getByText("T••••567D")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show patient NRIC/FIN" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy patient NRIC/FIN" })).toBeNull();
    expect(sent(fetchStub, CHECKOUT)).toEqual([{}]);
    expect(await screen.findByRole("img", { name: /CHAS Blue pays \$50\.50/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record portal reference" })).toBeTruthy();
  });

  it("links to the payer's portal in a new tab only when settings name one", async () => {
    open("/submit?claim=c-d01", { [CHECKOUT]: jsonAnswer(packet()), [DETAIL]: jsonAnswer(split) });
    await screen.findByRole("region", { name: "What to enter in the portal" });
    expect(screen.queryByRole("link", { name: /Open portal/ })).toBeNull();
  });

  it("opens the portal URL from settings in a new tab, with no opener", async () => {
    const portalUrl = "https://portal.chas.example/claims";
    open("/submit?claim=c-d01", { [CHECKOUT]: jsonAnswer(packet({ portalUrl })), [DETAIL]: jsonAnswer(split) });

    const link = await screen.findByRole("link", { name: /^Open portal/ });

    expect(link.getAttribute("href")).toBe(portalUrl);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("copies a field's text and says so", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    open("/submit?claim=c-d01", { [CHECKOUT]: jsonAnswer(packet()), [DETAIL]: jsonAnswer(split) });

    fireEvent.click(await screen.findByRole("button", { name: "Copy claim amount" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("50.50"));
    expect(await screen.findByText("Copied claim amount.")).toBeTruthy();
  });

  it("refuses an empty reference without asking the server, then records MHCP-0001 at the version it read (AC-4.3)", async () => {
    const fetchStub = open("/submit?claim=c-d01", {
      [CHECKOUT]: jsonAnswer(packet()),
      [DETAIL]: jsonAnswer(split),
      [ACTIONS]: jsonAnswer({}),
    });
    const reference = await screen.findByLabelText("Portal reference");

    fireEvent.click(screen.getByRole("button", { name: "Record portal reference" }));
    expect(await screen.findByText("Enter the reference the portal gave you.")).toBeTruthy();
    expect(sent(fetchStub, ACTIONS)).toEqual([]);

    fireEvent.change(reference, { target: { value: " MHCP-0001 " } });
    fireEvent.click(screen.getByRole("button", { name: "Record portal reference" }));

    expect(await screen.findByText(/Submitted with portal reference/)).toBeTruthy();
    expect(screen.getByText("MHCP-0001")).toBeTruthy();
    expect(sent(fetchStub, ACTIONS)).toEqual([{ action: { kind: "submit", portalReference: "MHCP-0001" }, expectedVersion: 4 }]);
  });

  it("says a reference already on another claim to this payer is taken (AC-4.3)", async () => {
    open("/submit?claim=c-d01", {
      [CHECKOUT]: jsonAnswer(packet()),
      [DETAIL]: jsonAnswer(split),
      [ACTIONS]: jsonAnswer({ error: "reference_taken", portalReference: "MHCP-0001" }, 409),
    });
    fireEvent.change(await screen.findByLabelText("Portal reference"), { target: { value: "MHCP-0001" } });
    fireEvent.click(screen.getByRole("button", { name: "Record portal reference" }));

    expect(await screen.findByText(/MHCP-0001 is already on another claim to this payer/)).toBeTruthy();
    expect(screen.queryByText(/Submitted with portal reference/)).toBeNull();
  });

  it("links the reference error to its input, so a screen reader reads it with the field (QA D20)", async () => {
    open("/submit?claim=c-d01", {
      [CHECKOUT]: jsonAnswer(packet()),
      [DETAIL]: jsonAnswer(split),
    });
    const reference = await screen.findByLabelText("Portal reference");

    fireEvent.click(screen.getByRole("button", { name: "Record portal reference" }));
    await screen.findByText("Enter the reference the portal gave you.");

    const described = (reference.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    const notes = described.map((noteId) => document.getElementById(noteId)?.textContent);
    expect(notes).toContain("Enter the reference the portal gave you.");
  });

  it("opens the refusal dialog clean after the reference form failed, without sending the reference again (QA D10)", async () => {
    const fetchStub = open("/submit?claim=c-d01", {
      [CHECKOUT]: jsonAnswer(packet()),
      [DETAIL]: jsonAnswer(split),
      [ACTIONS]: jsonAnswer({ error: "reference_taken", portalReference: "MHCP-0001" }, 409),
    });
    fireEvent.change(await screen.findByLabelText("Portal reference"), { target: { value: "MHCP-0001" } });
    fireEvent.click(screen.getByRole("button", { name: "Record portal reference" }));
    await screen.findByText(/MHCP-0001 is already on another claim to this payer/);

    fireEvent.click(screen.getByRole("button", { name: "Portal refused" }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).queryByText(/already on another claim/)).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(sent(fetchStub, ACTIONS)).toEqual([{ action: { kind: "submit", portalReference: "MHCP-0001" }, expectedVersion: 4 }]);
  });

  it("records what the portal said when it refused the claim (AC-4.4)", async () => {
    const fetchStub = open("/submit?claim=c-d01", {
      [CHECKOUT]: jsonAnswer(packet()),
      [DETAIL]: jsonAnswer(split),
      [ACTIONS]: jsonAnswer({}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Portal refused" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Record the refusal" }));
    expect(await within(dialog).findByText("Enter the portal's message.")).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("What the portal said"), { target: { value: "Annual balance used" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record the refusal" }));

    expect(await screen.findByText(/Recorded as refused by the portal/)).toBeTruthy();
    expect(sent(fetchStub, ACTIONS)).toEqual([{ action: { kind: "portal_refused", message: "Annual balance used" }, expectedVersion: 4 }]);
  });

  it("tells officer B that A is submitting the claim, and takes it over only after B confirms (AC-4.8)", async () => {
    let calls = 0;
    const fetchStub = open("/submit?claim=c-d01", {
      [CHECKOUT]: (request) => {
        calls += 1;
        return calls === 1
          ? jsonAnswer({ error: "checked_out", by: "a@clinic.test", until: "2026-11-14T03:00:00.000Z" }, 409)(request)
          : jsonAnswer(packet())(request);
      },
      [DETAIL]: jsonAnswer(split),
    });

    expect(await screen.findByText("Being submitted by a@clinic.test")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "What to enter in the portal" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    const dialog = await screen.findByRole("dialog");
    expect(sent(fetchStub, CHECKOUT)).toEqual([{}]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Take over the claim" }));

    expect(await screen.findByRole("region", { name: "What to enter in the portal" })).toBeTruthy();
    expect(sent(fetchStub, CHECKOUT)).toEqual([{}, { takeOver: true }]);
  });

  it("says when the claim isn't waiting to be submitted, and links to it", async () => {
    open("/submit?claim=c-d01", {
      [CHECKOUT]: jsonAnswer({ error: "not_allowed", detail: "This claim isn't waiting to be submitted." }, 409),
      [DETAIL]: jsonAnswer(split),
    });

    expect(await screen.findByText("This claim isn't waiting to be submitted.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the claim" }).getAttribute("href")).toBe("/claims/c-d01");
  });
});

describe("AssistedSubmit: sending approved claims", () => {
  const harbour = [row("c-h01", "HARBOUR", "Harbour TPA"), row("c-h02", "HARBOUR", "Harbour TPA"), row("c-h03", "HARBOUR", "Harbour TPA")];

  it("exports three Harbour claims to one file and submits them only once the officer confirms the upload (AC-4.5)", async () => {
    const answer: SubmitResponse = {
      groups: [
        {
          kind: "file",
          payerId: "HARBOUR",
          payerName: "Harbour TPA",
          claimIds: ["c-h01", "c-h02", "c-h03"],
          filename: "harbour-2026-11-14.csv",
          csv: "claim_ref,fee\r\nSC-c-h01,300.00\r\n",
          batchRef: "b-1",
        },
      ],
      refused: [],
    };
    const fetchStub = open("/submit", {
      [APPROVED]: jsonAnswer({ items: harbour, next: null }),
      [SUBMIT]: jsonAnswer(answer),
      [CONFIRM]: jsonAnswer({ done: harbour.map((r) => ({ id: r.id, version: 3 })), failed: [] }),
    });

    expect(await screen.findByRole("heading", { name: "Harbour TPA" })).toBeTruthy();
    for (const r of harbour) fireEvent.click(screen.getByRole("checkbox", { name: `Select ${r.patientMask} Harbour TPA` }));
    fireEvent.click(screen.getByRole("button", { name: "Send selected" }));

    const download = await screen.findByRole("link", { name: /Download harbour-2026-11-14\.csv/ });
    expect(download.getAttribute("download")).toBe("harbour-2026-11-14.csv");
    expect(decodeURIComponent(download.getAttribute("href")!)).toContain("claim_ref,fee");
    expect(sent(fetchStub, SUBMIT)).toEqual([{ items: harbour.map((r) => ({ id: r.id, version: 2 })) }]);
    expect(sent(fetchStub, CONFIRM)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "I've uploaded the file" }));

    expect(await screen.findByText("3 claims marked submitted.")).toBeTruthy();
    expect(sent(fetchStub, CONFIRM)).toEqual([{ batchRef: "b-1", items: harbour.map((r) => ({ id: r.id, version: 2 })) }]);
  });

  it("D17: once the officer confirms the upload, the list drops the submitted claims so they can't go in a second file", async () => {
    const answer: SubmitResponse = {
      groups: [
        {
          kind: "file",
          payerId: "HARBOUR",
          payerName: "Harbour TPA",
          claimIds: ["c-h01", "c-h02", "c-h03"],
          filename: "harbour-2026-11-14.csv",
          csv: "claim_ref,fee\r\nSC-c-h01,300.00\r\n",
          batchRef: "b-1",
        },
      ],
      refused: [],
    };
    // Exported claims stay approved until the upload is confirmed; after that the server lists none.
    let confirmed = false;
    const fetchStub = open("/submit", {
      [APPROVED]: () => jsonAnswer({ items: confirmed ? [] : harbour, next: null })(new Request(APPROVED)),
      [SUBMIT]: jsonAnswer(answer),
      [CONFIRM]: () => {
        confirmed = true;
        return jsonAnswer({ done: harbour.map((r) => ({ id: r.id, version: 3 })), failed: [] })(new Request(CONFIRM));
      },
    });

    expect(await screen.findByRole("heading", { name: "Harbour TPA" })).toBeTruthy();
    for (const r of harbour) fireEvent.click(screen.getByRole("checkbox", { name: `Select ${r.patientMask} Harbour TPA` }));
    fireEvent.click(screen.getByRole("button", { name: "Send selected" }));
    fireEvent.click(await screen.findByRole("button", { name: "I've uploaded the file" }));

    expect(await screen.findByText("3 claims marked submitted.")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "No approved claims waiting" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Select T••••h01D/ })).toBeNull();
    const listed = fetchStub.mock.calls.filter(([input]) => String(input) === APPROVED);
    expect(listed).toHaveLength(3);
  });

  it("says what happened to each claim sent to a payer's API, and why a claim wasn't sent (AC-4.6)", async () => {
    const rows = [row("c-m01", "MERIDIAN", "Meridian Dental Plan"), row("c-m02", "MERIDIAN", "Meridian Dental Plan"), row("c-d01", "CHAS", "CHAS Blue")];
    const answer: SubmitResponse = {
      groups: [
        {
          kind: "sent",
          payerId: "MERIDIAN",
          payerName: "Meridian Dental Plan",
          results: [
            { claimId: "c-m01", ok: true, portalReference: "MDP-7781" },
            { claimId: "c-m02", ok: false, error: "timeout" },
            { claimId: "c-m03", ok: false, error: "stale", portalReference: "MDP-7790" },
          ],
        },
        { kind: "checklist", payerId: "CHAS", payerName: "CHAS Blue", claimIds: ["c-d01"] },
      ],
      refused: [],
    };
    const sentRows = [...rows, row("c-m03", "MERIDIAN", "Meridian Dental Plan")];
    open("/submit", { [APPROVED]: jsonAnswer({ items: sentRows, next: null }), [SUBMIT]: jsonAnswer(answer) });

    await screen.findByRole("heading", { name: "Meridian Dental Plan" });
    for (const r of sentRows) fireEvent.click(screen.getByRole("checkbox", { name: `Select ${r.patientMask} ${r.payerName}` }));
    fireEvent.click(screen.getByRole("button", { name: "Send selected" }));

    const result = await screen.findByRole("region", { name: "What was sent" });
    expect(within(result).getByText("MDP-7781")).toBeTruthy();
    expect(within(result).getByText(/didn't answer in time\. The claim is still approved/)).toBeTruthy();
    const unrecorded = within(result).getByText("MDP-7790").closest("li")!;
    expect(unrecorded.textContent).toMatch(/reached the payer with reference MDP-7790, but the desk couldn't record it/);
    expect(unrecorded.textContent).not.toMatch(/wasn't sent/);
    expect(within(result).getByRole("link", { name: /Open the checklist for T••••d01D/ }).getAttribute("href")).toBe("/submit?claim=c-d01");
  });

  it("shows the server's reason for a claim it refused to send (AC-4.6)", async () => {
    const rows = [row("c-m01", "MERIDIAN", "Meridian Dental Plan")];
    const answer: SubmitResponse = {
      groups: [],
      refused: [{ id: "c-m01", status: 409, error: { error: "not_allowed", detail: "This payer's API token is not set." } }],
    };
    open("/submit", { [APPROVED]: jsonAnswer({ items: rows, next: null }), [SUBMIT]: jsonAnswer(answer) });

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select T••••m01D Meridian Dental Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Send selected" }));

    expect(await screen.findByText(/This payer's API token is not set\./)).toBeTruthy();
  });

  it("says when no claims are waiting", async () => {
    open("/submit", { [APPROVED]: jsonAnswer({ items: [], next: null }) });
    expect(await screen.findByText("No approved claims waiting")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send selected" })).toBeNull();
  });

  it("marks the list busy while the approved claims load (SP-4)", async () => {
    open("/submit", { [APPROVED]: jsonAnswer({ items: [], next: null }) });

    expect(screen.getByText("Loading approved claims…").getAttribute("aria-busy")).toBe("true");
    await screen.findByText("No approved claims waiting");
  });
});

// QA N1 (qa-02.md): an action replaces the button that ran it. Focus goes to the line that says
// what happened instead of falling to the body.
describe("AssistedSubmit: focus after an action (QA N1)", () => {
  it("puts focus on the confirmation after recording a portal reference", async () => {
    open("/submit?claim=c-d01", { [CHECKOUT]: jsonAnswer(packet()), [DETAIL]: jsonAnswer(split), [ACTIONS]: jsonAnswer({}) });
    fireEvent.change(await screen.findByLabelText("Portal reference"), { target: { value: "MHCP-0001" } });
    fireEvent.click(screen.getByRole("button", { name: "Record portal reference" }));

    await screen.findByText(/Submitted with portal reference/);
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.textContent).toContain("Submitted with portal reference MHCP-0001.");
  });

  it("puts focus on the confirmation after recording a portal refusal", async () => {
    open("/submit?claim=c-d01", { [CHECKOUT]: jsonAnswer(packet()), [DETAIL]: jsonAnswer(split), [ACTIONS]: jsonAnswer({}) });
    fireEvent.click(await screen.findByRole("button", { name: "Portal refused" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("What the portal said"), { target: { value: "Annual balance used" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record the refusal" }));

    await screen.findByText(/Recorded as refused by the portal/);
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.textContent).toContain("Recorded as refused by the portal.");
  });

  it("puts focus on the result after the officer says the file is uploaded", async () => {
    const harbour = [row("c-h01", "HARBOUR", "Harbour TPA")];
    const answer: SubmitResponse = {
      groups: [
        {
          kind: "file",
          payerId: "HARBOUR",
          payerName: "Harbour TPA",
          claimIds: ["c-h01"],
          filename: "harbour-2026-11-14.csv",
          csv: "claim_ref,fee\r\nSC-c-h01,100.00\r\n",
          batchRef: "b-1",
        },
      ],
      refused: [],
    };
    open("/submit", {
      [APPROVED]: jsonAnswer({ items: harbour, next: null }),
      [SUBMIT]: jsonAnswer(answer),
      [CONFIRM]: jsonAnswer({ done: [{ id: "c-h01", version: 3 }], failed: [] }),
    });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select T••••h01D Harbour TPA" }));
    fireEvent.click(screen.getByRole("button", { name: "Send selected" }));
    const uploaded = await screen.findByRole("button", { name: "I've uploaded the file" });
    uploaded.focus();
    fireEvent.click(uploaded);

    const said = await screen.findByText("1 claim marked submitted.");
    await waitFor(() => expect(document.activeElement).toBe(said));
  });
});
