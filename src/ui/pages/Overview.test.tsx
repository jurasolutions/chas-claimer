// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { jsonAnswer, stubNetwork, type Answer } from "../../../tests/helpers/network";
import type { MeResponse } from "../../api/common";
import type { OverviewResponse } from "../../api/overview";
import { MeContext } from "../me";
import { Overview } from "./Overview";

const OVERVIEW = `${window.location.origin}/api/overview`;
const officer: MeResponse = { email: "officer@clinic.test", roles: ["officer"], aiConfigured: false, demoMode: false };

const zeros: OverviewResponse = {
  byStatus: { needs_attention: 0, ready: 0, approved: 0, submitted: 0, accepted: 0, rejected: 0, paid: 0, withdrawn: 0, written_off: 0 },
  chasDueSoon: { days: 5, count: 0 },
  outstandingByPayer: [],
  paymentStatements: 0,
  unmatchedRemittanceLines: 0,
};
const busy: OverviewResponse = {
  byStatus: { ...zeros.byStatus, needs_attention: 4, ready: 12, submitted: 7, accepted: 2, paid: 30 },
  chasDueSoon: { days: 5, count: 3 },
  outstandingByPayer: [
    { payerId: "CHAS", payerName: "CHAS", claims: 6, cents: 46250 },
    { payerId: "MERIDIAN", payerName: "Meridian Dental Plan", claims: 3, cents: 120000 },
  ],
  paymentStatements: 2,
  unmatchedRemittanceLines: 2,
};

function openToday(answer: Answer) {
  stubNetwork({ [OVERVIEW]: answer });
  render(
    <MeContext.Provider value={officer}>
      <Overview />
    </MeContext.Provider>,
  );
}

const hrefOf = (name: string | RegExp) => screen.getByRole("link", { name }).getAttribute("href");

describe("Today", () => {
  it("AC-8.3: opens with a sentence of counts, each a link into the filtered queue", async () => {
    openToday(jsonAnswer(busy));

    const sentence = await screen.findByText((_, el) => el?.classList.contains("page-header__lede") ?? false);
    expect(sentence.textContent).toBe("4 need attention, 12 ready, 3 CHAS claims due in 5 days.");
    expect(within(sentence).getByRole("link", { name: "4 need attention" }).getAttribute("href")).toBe("/claims?status=needs_attention");
    expect(within(sentence).getByRole("link", { name: "12 ready" }).getAttribute("href")).toBe("/claims?status=ready");
    expect(within(sentence).getByRole("link", { name: "3 CHAS claims due in 5 days" }).getAttribute("href")).toBe("/claims?scheme=chas&due=5");
  });

  it("AC-8.3: counts every status, what each payer still owes, and remittance lines that matched no claim", async () => {
    openToday(jsonAnswer(busy));

    const statuses = await screen.findByRole("region", { name: "Claims by status" });
    expect(within(statuses).getByRole("link", { name: "Submitted 7" }).getAttribute("href")).toBe("/claims?status=submitted");
    expect(within(statuses).getByRole("link", { name: "Written off 0" }).getAttribute("href")).toBe("/claims?status=written_off");

    const payers = screen.getByRole("region", { name: "Waiting on payers" });
    const [chas, meridian] = within(payers).getAllByRole("listitem") as [HTMLElement, HTMLElement];
    expect(within(chas).getByRole("link", { name: "CHAS" }).getAttribute("href")).toBe("/claims?payer=CHAS&status=submitted%2Caccepted");
    expect(within(chas).getByText("6 claims")).toBeTruthy();
    expect(within(chas).getByText("$462.50").classList.contains("money")).toBe(true);
    expect(within(meridian).getByText("Meridian Dental Plan")).toBeTruthy();
    expect(within(meridian).getByText("$1,200.00")).toBeTruthy();

    expect(hrefOf("2 remittance lines matched no claim")).toBe("/payments");
  });

  it("AC-8.3: an empty desk shows zeros, not errors", async () => {
    openToday(jsonAnswer(zeros));

    expect(await screen.findByRole("link", { name: "0 need attention" })).toBeTruthy();
    expect(hrefOf("0 CHAS claims due in 5 days")).toBe("/claims?scheme=chas&due=5");
    expect(screen.getByText("Nothing is waiting on a payer.")).toBeTruthy();
    expect(screen.getByText("No payment statements yet.")).toBeTruthy();
    expect(screen.queryByText(/Every remittance line matched/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says every remittance line matched only once a payment statement is on file (QA D04)", async () => {
    openToday(jsonAnswer({ ...zeros, paymentStatements: 1 }));

    expect(await screen.findByText("Every remittance line matched a claim.")).toBeTruthy();
    expect(screen.queryByText("No payment statements yet.")).toBeNull();
  });

  it("speaks in the singular for one", async () => {
    openToday(jsonAnswer({ ...zeros, byStatus: { ...zeros.byStatus, needs_attention: 1 }, chasDueSoon: { days: 5, count: 1 }, paymentStatements: 1, unmatchedRemittanceLines: 1 }));

    expect(await screen.findByRole("link", { name: "1 needs attention" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "1 CHAS claim due in 5 days" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "1 remittance line matched no claim" })).toBeTruthy();
  });

  it("says the counts didn't load and tries again", async () => {
    let calls = 0;
    openToday(() => (++calls === 1 ? jsonAnswer({ error: "unavailable" }, 503) : jsonAnswer(busy))(new Request(OVERVIEW)));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Today's counts didn't load.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("link", { name: "4 need attention" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
