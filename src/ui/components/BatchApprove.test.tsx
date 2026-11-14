// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import type { ClaimRow } from "../../api/claims";
import { finding } from "../../domain/claims/findings";
import type { IsoDate } from "../../domain/dates";
import { cents } from "../../domain/money";
import { BatchApprove } from "./BatchApprove";

const day = (s: string) => s as IsoDate;

/** A synthetic ready claim carrying one warning; masked patient only. */
const warned = (n: number): ClaimRow => ({
  id: `c-w${n}`,
  visitKey: `SC-W0${n}`,
  status: "ready",
  scheme: "chas",
  payerId: "CHAS",
  payerName: "CHAS Blue",
  branchId: "BR-EAST",
  branchName: "East branch",
  patientMask: `T••••00${n}A`,
  visitDate: day("2026-11-10"),
  feeCents: cents(9000),
  claimedCents: cents(5000),
  deadline: { deadline: day("2026-11-16"), daysLeft: 2, warning: true, windowDays: 30 },
  changedAfterSubmission: false,
  blockingCount: 0,
  findings: [finding("deadline_approaching", { daysLeft: 2 })],
  version: 1,
});

// jsdom does no layout, so the test reads the desk's own stylesheet into the document and checks
// what the cascade gives the dialog: a height bounded by the viewport and a body that scrolls.
let sheet: HTMLStyleElement;
beforeAll(() => {
  sheet = document.createElement("style");
  sheet.textContent = readFileSync(join(process.cwd(), "src/ui/app.css"), "utf8");
  document.head.appendChild(sheet);
  return () => sheet.remove();
});

describe("BatchApprove confirmation (QA N2)", () => {
  it("keeps the dialog inside the viewport: its height is bounded and the warnings scroll between a fixed header and footer", () => {
    render(<BatchApprove chosen={[warned(1), warned(2), warned(3)]} onSettled={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve 3 claims" }));

    const dialog = screen.getByRole("dialog", { name: "Approve 3 claims with 3 warnings?" });
    expect(getComputedStyle(dialog).maxHeight).toMatch(/^calc\(100d?vh - /);

    const list = dialog.querySelector(".batch-warnings");
    const body = list?.parentElement;
    expect(body).not.toBe(dialog);
    expect(getComputedStyle(body!).overflowY).toBe("auto");
    expect(getComputedStyle(body!).minHeight).toBe("0");

    // The way out and the way forward sit outside the scrolling part.
    expect(body!.contains(screen.getByRole("button", { name: "Close" }))).toBe(false);
    expect(body!.contains(within(dialog).getByRole("button", { name: "Cancel" }))).toBe(false);
    expect(body!.contains(within(dialog).getByRole("button", { name: "Approve anyway" }))).toBe(false);
  });
});
