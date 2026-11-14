// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Cents } from "../../domain/money";
import type { SplitSegment } from "../../domain/types";
import { BillSplit } from "./BillSplit";

const c = (n: number) => n as Cents;
const chas: SplitSegment = { payer: "CHAS", label: "CHAS", cents: c(46250), claimId: "claim-chas" };
const medisave: SplitSegment = { payer: "MEDISAVE_FLEXI", label: "MediSave", cents: c(40000), claimId: "claim-ms" };
const patient: SplitSegment = { payer: "patient", label: "Patient", cents: c(8750) };

const payersInOrder = (bar: HTMLElement) => [...bar.querySelectorAll("[data-payer]")].map((el) => el.getAttribute("data-payer"));

describe("BillSplit", () => {
  it("draws the waterfall in order with the patient last, and says it as one sentence", () => {
    render(<BillSplit segments={[patient, chas, medisave]} feeCents={c(95000)} size="detail" />);

    const bar = screen.getByRole("img", { name: "CHAS pays $462.50, MediSave $400.00, patient pays $87.50 of $950.00" });
    expect(payersInOrder(bar)).toEqual(["CHAS", "MEDISAVE_FLEXI", "patient"]);
  });

  it("labels every segment underneath on the claim detail", () => {
    render(<BillSplit segments={[chas, medisave, patient]} feeCents={c(95000)} size="detail" />);

    const legend = screen.getByRole("list");
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "CHAS$462.50",
      "MediSave$400.00",
      "Patient$87.50",
    ]);
  });

  it("is a thin unlabelled bar in a queue row, with the row's own claim drawn solid", () => {
    render(<BillSplit segments={[chas, medisave, patient]} feeCents={c(95000)} size="row" highlightClaimId="claim-ms" />);

    expect(screen.queryByRole("list")).toBeNull();
    const bar = screen.getByRole("img");
    const own = [...bar.querySelectorAll("[data-own]")].map((el) => el.getAttribute("data-payer"));
    expect(own).toEqual(["MEDISAVE_FLEXI"]);
  });

  it("says a visit no payer covers as the patient paying it all", () => {
    render(<BillSplit segments={[{ ...patient, cents: c(12000) }]} feeCents={c(12000)} size="checklist" />);

    expect(screen.getByRole("img", { name: "Patient pays $120.00 of $120.00" })).toBeTruthy();
  });
  it("draws a frozen claim's rest of the bill last, in its own neutral fill, and says it plainly (N3)", () => {
    const rest: SplitSegment = { payer: "rest", label: "Rest of the bill", cents: c(48750) };
    render(<BillSplit segments={[rest, chas]} feeCents={c(95000)} size="detail" />);

    const bar = screen.getByRole("img", { name: "CHAS pays $462.50, and the rest of the bill is $487.50 of $950.00" });
    expect(payersInOrder(bar)).toEqual(["CHAS", "rest"]);
    expect(bar.querySelector('[data-payer="rest"]')?.className).toContain("bill-split__segment--rest");
  });
});
