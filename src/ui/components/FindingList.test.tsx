// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Finding } from "../../domain/types";
import { FindingList } from "./FindingList";

const expired: Finding = { code: "card_expired", severity: "blocking", params: { expiredOn: "2026-10-02" }, ruleRef: "CHAS 2026 §4.1" };
const soon: Finding = { code: "card_expired", severity: "warning", params: { daysLeft: 3 }, lineNo: 2 };

const describeFinding = (f: Finding) =>
  f.severity === "blocking"
    ? "The CHAS Orange card expired on 2 Oct, before this visit. Ask the patient for their new card, then re-import."
    : `The card expires in ${f.params.daysLeft} days.`;

describe("FindingList", () => {
  it("lists what blocks the claim before what only needs a look, each in words with its source", () => {
    render(<FindingList findings={[soon, expired]} describe={describeFinding} />);

    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Blocks submission");
    expect(items[0]?.textContent).toContain("Ask the patient for their new card, then re-import.");
    expect(items[0]?.textContent).toContain("CHAS 2026 §4.1");
    expect(items[1]?.textContent).toContain("Check before submitting");
    expect(items[1]?.textContent).toContain("Line 2");
  });

  it("says plainly when there is nothing to fix", () => {
    render(<FindingList findings={[]} describe={describeFinding} />);

    expect(screen.getByText("Nothing to fix on this claim.")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
