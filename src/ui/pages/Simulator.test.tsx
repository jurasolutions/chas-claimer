// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { jsonAnswer, stubNetwork, type Answer } from "../../../tests/helpers/network";
import type { MeResponse } from "../../api/common";
import type { SimulatorItem } from "../../api/submissions";
import { MeContext } from "../me";
import { Simulator } from "./Simulator";

const origin = window.location.origin;
const INBOX = `${origin}/api/simulator/inbox`;
const DECIDE = `${origin}/api/simulator/inbox/sim-1`;

const OFFICER: MeResponse = { email: "b@clinic.test", roles: ["officer"], aiConfigured: false, demoMode: true };

/** A synthetic D10-like TOSP claim as the simulator received it, masked as it was sent. */
const item = (overrides: Partial<SimulatorItem> = {}): SimulatorItem => ({
  id: "sim-1",
  claimId: "c-d10",
  payerId: "MEDISAVE_TOSP",
  payerName: "MediSave (TOSP)",
  simReference: "SIM-000001",
  state: "received",
  reason: null,
  paidCents: null,
  claimedCents: 60000,
  acceptedCents: null,
  claimStatus: "submitted",
  fields: [
    { key: "visit_date", label: "Visit date", text: "2026-11-09", masked: false, revealField: null },
    { key: "patient_nric", label: "Patient NRIC/FIN", text: "T••••567D", masked: true, revealField: "nric" },
    { key: "claim_amount", label: "Claim amount", text: "600.00", masked: false, revealField: null },
  ],
  updatedAt: "2026-11-14T02:00:00.000Z",
  ...overrides,
});

function open(routes: Record<string, Answer>) {
  window.history.replaceState(null, "", "/simulator");
  const fetchStub = stubNetwork(routes);
  render(
    <MeContext.Provider value={OFFICER}>
      <Simulator />
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

describe("Simulator: the simulated payer's inbox (AC-4.7)", () => {
  it("lists what it received, masked as sent, with its reference, amount and a link to the claim", async () => {
    open({ [INBOX]: jsonAnswer({ items: [item()] }) });

    const entry = await screen.findByRole("article", { name: "SIM-000001" });
    expect(within(entry).getByText("Received")).toBeTruthy();
    expect(within(entry).getByText("$600.00")).toBeTruthy();
    expect(within(entry).getByText("T••••567D")).toBeTruthy();
    expect(within(entry).getByRole("link", { name: "Open the claim for SIM-000001" }).getAttribute("href")).toBe("/claims/c-d10");
    expect(within(entry).getByRole("button", { name: "Accept SIM-000001" })).toBeTruthy();
    expect(within(entry).getByRole("button", { name: "Reject SIM-000001" })).toBeTruthy();
    expect(within(entry).queryByRole("button", { name: "Pay SIM-000001" })).toBeNull();
  });

  it("draws no banner of its own and never names or brands a real payer", async () => {
    open({ [INBOX]: jsonAnswer({ items: [item()] }) });

    await screen.findByRole("article", { name: "SIM-000001" });
    expect(screen.queryByText(/Nothing here reaches a real payer/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/MOH|CPF|MediSave|Meridian|Harbour|Ministry of Health/i);
  });

  it("says when nothing has arrived yet", async () => {
    open({ [INBOX]: jsonAnswer({ items: [] }) });

    expect(await screen.findByText("Nothing has been sent to the simulator yet")).toBeTruthy();
  });

  it("says the inbox didn't load, and loads it again on request", async () => {
    let calls = 0;
    open({ [INBOX]: () => (++calls === 1 ? new Response("{}", { status: 500 }) : jsonAnswer({ items: [item()] })(new Request(INBOX))) });

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("article", { name: "SIM-000001" })).toBeTruthy();
  });

  it("accepts at $550.00 with a reason, then shows the claim as accepted with Pay offered", async () => {
    const fetchStub = open({
      [INBOX]: jsonAnswer({ items: [item()] }),
      [DECIDE]: jsonAnswer(item({ state: "accepted", acceptedCents: 55000, reason: "Capped at the scheme limit.", claimStatus: "accepted" })),
    });

    fireEvent.click(within(await screen.findByRole("article", { name: "SIM-000001" })).getByRole("button", { name: "Accept SIM-000001" }));
    const dialog = await screen.findByRole("dialog", { name: "Accept this claim" });
    fireEvent.change(within(dialog).getByLabelText(/Amount accepted/), { target: { value: "550.00" } });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Capped at the scheme limit." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Accept the claim" }));

    await waitFor(() => expect(sent(fetchStub, DECIDE)).toEqual([{ decision: "accept", amount: 55000, reason: "Capped at the scheme limit." }]));
    const entry = await screen.findByRole("article", { name: "SIM-000001" });
    await waitFor(() => expect(within(entry).getByText("Accepted")).toBeTruthy());
    expect(within(entry).getByText("$550.00")).toBeTruthy();
    expect(within(entry).getByText("Capped at the scheme limit.")).toBeTruthy();
    expect(within(entry).getByRole("button", { name: "Pay SIM-000001" })).toBeTruthy();
  });

  it("accepts in full when no amount is given, and refuses an amount it can't read without asking the server", async () => {
    const fetchStub = open({
      [INBOX]: jsonAnswer({ items: [item()] }),
      [DECIDE]: jsonAnswer(item({ state: "accepted", acceptedCents: 60000, claimStatus: "accepted" })),
    });

    fireEvent.click(within(await screen.findByRole("article", { name: "SIM-000001" })).getByRole("button", { name: "Accept SIM-000001" }));
    const dialog = await screen.findByRole("dialog", { name: "Accept this claim" });
    fireEvent.change(within(dialog).getByLabelText(/Amount accepted/), { target: { value: "five fifty" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Accept the claim" }));
    expect(await within(dialog).findByText("Enter an amount like 550.00.")).toBeTruthy();
    expect(sent(fetchStub, DECIDE)).toEqual([]);

    fireEvent.change(within(dialog).getByLabelText(/Amount accepted/), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Accept the claim" }));
    await waitFor(() => expect(sent(fetchStub, DECIDE)).toEqual([{ decision: "accept" }]));
  });

  it("rejects only with a reason, and sends it", async () => {
    const fetchStub = open({
      [INBOX]: jsonAnswer({ items: [item()] }),
      [DECIDE]: jsonAnswer(item({ state: "rejected", reason: "Procedure code not covered.", claimStatus: "rejected" })),
    });

    fireEvent.click(within(await screen.findByRole("article", { name: "SIM-000001" })).getByRole("button", { name: "Reject SIM-000001" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject this claim" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject the claim" }));
    expect(await within(dialog).findByText("Give a reason.")).toBeTruthy();
    expect(sent(fetchStub, DECIDE)).toEqual([]);

    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Procedure code not covered." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject the claim" }));

    await waitFor(() => expect(sent(fetchStub, DECIDE)).toEqual([{ decision: "reject", reason: "Procedure code not covered." }]));
    const entry = await screen.findByRole("article", { name: "SIM-000001" });
    await waitFor(() => expect(within(entry).getByText("Rejected")).toBeTruthy());
    expect(within(entry).queryByRole("button", { name: "Accept SIM-000001" })).toBeNull();
  });

  it("pays what is still owed when no amount is given", async () => {
    const fetchStub = open({
      [INBOX]: jsonAnswer({ items: [item({ state: "accepted", acceptedCents: 55000, claimStatus: "accepted" })] }),
      [DECIDE]: jsonAnswer(item({ state: "paid", acceptedCents: 55000, paidCents: 55000, claimStatus: "paid" })),
    });

    fireEvent.click(within(await screen.findByRole("article", { name: "SIM-000001" })).getByRole("button", { name: "Pay SIM-000001" }));
    const dialog = await screen.findByRole("dialog", { name: "Pay this claim" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record the payment" }));

    await waitFor(() => expect(sent(fetchStub, DECIDE)).toEqual([{ decision: "pay" }]));
    const entry = await screen.findByRole("article", { name: "SIM-000001" });
    await waitFor(() => expect(within(entry).getByText("Paid")).toBeTruthy());
    expect(within(entry).queryByRole("button", { name: "Pay SIM-000001" })).toBeNull();
  });

  it("says when another decision landed first, and reloads the inbox", async () => {
    let inboxCalls = 0;
    const fetchStub = open({
      [INBOX]: () => jsonAnswer({ items: [item(++inboxCalls === 1 ? {} : { state: "rejected", reason: "Duplicate." })] })(new Request(INBOX)),
      [DECIDE]: jsonAnswer({ error: "not_allowed", detail: "The simulated payer has already rejected this claim." }, 409),
    });

    fireEvent.click(within(await screen.findByRole("article", { name: "SIM-000001" })).getByRole("button", { name: "Accept SIM-000001" }));
    const dialog = await screen.findByRole("dialog", { name: "Accept this claim" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Accept the claim" }));

    expect(await screen.findByText("The simulated payer has already rejected this claim.")).toBeTruthy();
    await waitFor(() => expect(inboxCalls).toBe(2));
    expect(sent(fetchStub, DECIDE)).toEqual([{ decision: "accept" }]);
    expect(await screen.findByText("Duplicate.")).toBeTruthy();
  });
});

describe("Simulator: focus once a decision settles (QA 03 D02d)", () => {
  /** Press the dialog's send button by keyboard: focus it first, so where focus goes next is the page's doing. */
  function sendByKeyboard(dialog: HTMLElement, name: string) {
    const button = within(dialog).getByRole("button", { name });
    button.focus();
    fireEvent.click(button);
  }

  it.each([
    { decision: "accept", opens: "Accept SIM-000001", title: "Accept this claim", send: "Accept the claim", from: {}, after: { state: "accepted", acceptedCents: 60000, claimStatus: "accepted" }, words: "Accepted" },
    { decision: "reject", opens: "Reject SIM-000001", title: "Reject this claim", send: "Reject the claim", from: {}, after: { state: "rejected", reason: "Procedure code not covered.", claimStatus: "rejected" }, words: "Rejected" },
    { decision: "pay", opens: "Pay SIM-000001", title: "Pay this claim", send: "Record the payment", from: { state: "accepted", acceptedCents: 55000, claimStatus: "accepted" }, after: { state: "paid", acceptedCents: 55000, paidCents: 55000, claimStatus: "paid" }, words: "Paid" },
  ] as const)("puts focus on the claim once $decision goes through", async ({ decision, opens, title, send, from, after, words }) => {
    open({ [INBOX]: jsonAnswer({ items: [item(from)] }), [DECIDE]: jsonAnswer(item(after)) });

    fireEvent.click(within(await screen.findByRole("article", { name: "SIM-000001" })).getByRole("button", { name: opens }));
    const dialog = await screen.findByRole("dialog", { name: title });
    if (decision === "reject") fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Procedure code not covered." } });
    sendByKeyboard(dialog, send);

    const entry = await screen.findByRole("article", { name: "SIM-000001" });
    await waitFor(() => expect(within(entry).getByText(words)).toBeTruthy());
    await waitFor(() => expect(document.activeElement).toBe(entry));
  });

  it("puts focus on the notice when another decision landed first, each time it happens", async () => {
    open({
      [INBOX]: jsonAnswer({ items: [item()] }),
      [DECIDE]: jsonAnswer({ error: "not_allowed", detail: "The simulated payer has already rejected this claim." }, 409),
    });

    for (let round = 0; round < 2; round++) {
      const accept = within(await screen.findByRole("article", { name: "SIM-000001" })).getByRole("button", { name: "Accept SIM-000001" });
      accept.focus();
      fireEvent.click(accept);
      sendByKeyboard(await screen.findByRole("dialog", { name: "Accept this claim" }), "Accept the claim");

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const notice = await screen.findByRole("alert");
      expect(notice.textContent).toContain("The simulated payer has already rejected this claim.");
      await waitFor(() => expect((document.activeElement as HTMLElement).contains(notice)).toBe(true));
    }
  });
});
