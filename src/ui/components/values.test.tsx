// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IsoDate } from "../../domain/dates";
import type { Cents } from "../../domain/money";
import { CLAIM_STATUSES } from "../../domain/types";
import { DeadlineText } from "./DeadlineText";
import { MoneyCell } from "./MoneyCell";
import { StatusBadge } from "./StatusBadge";

const day = (s: string) => s as IsoDate;

describe("MoneyCell", () => {
  it("formats the cents it is given as dollars, in tabular figures", () => {
    render(<MoneyCell cents={123450 as Cents} />);
    const cell = screen.getByText("$1,234.50");
    expect(cell.className).toContain("money");
  });
});

describe("DeadlineText", () => {
  it.each([
    ["2026-11-17", 4, true, "Due in 4 days", "warning"],
    ["2026-11-14", 1, true, "Due tomorrow", "warning"],
    ["2026-11-13", 0, true, "Due today", "warning"],
    ["2026-11-12", -1, false, "Past the 30-day window", "danger"],
    ["2026-12-01", 18, false, "Due in 18 days", "none"],
  ])("says a deadline of %s, %i days off, in words", (deadline, daysLeft, warning, words, tone) => {
    render(<DeadlineText deadline={day(deadline)} daysLeft={daysLeft} warning={warning} windowDays={30} />);
    const text = screen.getByText(words);
    expect(text.closest("time")?.getAttribute("datetime")).toBe(deadline);
    expect(text.closest("[data-tone]")?.getAttribute("data-tone") ?? "none").toBe(tone);
  });

  it("takes the warning from the server, not from a threshold of its own", () => {
    const { unmount } = render(<DeadlineText deadline={day("2026-11-15")} daysLeft={2} warning={false} />);
    expect(screen.getByText("Due in 2 days").closest("[data-tone]")).toBeNull();
    unmount();
    render(<DeadlineText deadline={day("2026-12-11")} daysLeft={28} warning />);
    expect(screen.getByText("Due in 28 days").closest("[data-tone]")?.getAttribute("data-tone")).toBe("warning");
  });

  it("uses the days the server counted, whatever the device clock says", () => {
    vi.useFakeTimers({ now: new Date("2030-01-01T00:00:00Z") });
    try {
      render(<DeadlineText deadline={day("2026-11-17")} daysLeft={4} warning />);
      expect(screen.getByText("Due in 4 days")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the deadline passed when there is no named window", () => {
    render(<DeadlineText deadline={day("2026-11-01")} daysLeft={-12} warning={false} />);
    expect(screen.getByText("Past the deadline")).toBeTruthy();
  });

  it("gives the date itself in text, not only on hover", () => {
    render(<DeadlineText deadline={day("2026-11-17")} daysLeft={4} warning />);
    expect(screen.getByText("Due in 4 days").closest("time")?.textContent).toContain("17 Nov 2026");
  });
});

describe("StatusBadge", () => {
  it.each([
    ["needs_attention", "Needs attention", "warning"],
    ["rejected", "Rejected", "danger"],
    ["paid", "Paid", "success"],
    ["submitted", "Submitted", "info"],
    ["written_off", "Written off", "neutral"],
  ] as const)("shows %s as %s in the %s tone", (status, words, tone) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(words).closest("[data-tone]")?.getAttribute("data-tone")).toBe(tone);
  });

  it("has words for every claim status", () => {
    for (const status of CLAIM_STATUSES) {
      const { container, unmount } = render(<StatusBadge status={status} />);
      expect(container.textContent).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
      unmount();
    }
  });
});
