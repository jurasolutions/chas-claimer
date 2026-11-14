// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { syntheticSettings } from "../../../mock/synthetic-clinic/config";
import { jsonAnswer, stubNetwork, type Answer } from "../../../tests/helpers/network";
import type { MeResponse } from "../../api/common";
import type { LineClaim, OpenClaimOption, RemittanceDetail, RemittanceLineView, RemittanceListItem } from "../../api/remittances";
import type { IsoDate } from "../../domain/dates";
import { cents } from "../../domain/money";
import type { SettingsResponse } from "../../api/settings";
import { MeContext } from "../me";
import { Remittances } from "./Remittances";

const ORIGIN = window.location.origin;
const LIST = `${ORIGIN}/api/remittances`;
const SETTINGS = `${ORIGIN}/api/settings`;

const officer: MeResponse = { email: "officer@clinic.test", roles: ["officer"], aiConfigured: false, demoMode: false };
const reviewer: MeResponse = { ...officer, email: "reviewer@clinic.test", roles: ["reviewer"] };

const settings: SettingsResponse = {
  version: 4,
  settings: { ...syntheticSettings(), benchmarkOverrides: [] },
  roles: { reviewers: ["reviewer@clinic.test"], officers: ["officer@clinic.test"] },
  ruleSets: [],
  approvedByChannel: [],
};

const r1: RemittanceListItem = {
  id: "rem-1",
  payerId: "CHAS",
  fileName: "r1-chas.csv",
  importedAt: "2026-11-13T02:00:00.000Z",
  actor: "officer@clinic.test",
  lines: 5,
  matched: 3,
};
const r2: RemittanceListItem = { ...r1, id: "rem-2", payerId: "MERIDIAN", fileName: "r2-meridian.csv", importedAt: "2026-11-12T09:30:00.000Z", lines: 1, matched: 1 };

const R1_CSV = "reference,identifier,visit date,amount\nMHCP-0001,T9000001I,2026-10-02,50.50\n";

/** Picks a payer once the payers load. */
async function choosePayer(payer: string) {
  await screen.findByRole("option", { name: settings.settings.payers.find((p) => p.id === payer)!.name });
  fireEvent.change(screen.getByLabelText("Payer"), { target: { value: payer } });
}

/** Chooses a CSV file, then presses the one primary action. */
function send(csv: string, name: string) {
  fireEvent.change(screen.getByLabelText("Statement file"), { target: { files: [new File([csv], name, { type: "text/csv" })] } });
  fireEvent.click(screen.getByRole("button", { name: "Upload statement" }));
}

/** Picks a payer, then a CSV file, then presses the one primary action. */
async function upload(payer: string, csv: string, name = "r1-chas.csv") {
  await choosePayer(payer);
  send(csv, name);
}

/** A POST route that keeps each body it was sent and answers with the next of `answers`. */
function postRoute(bodies: unknown[], ...answers: Answer[]): Answer {
  return async (request) => {
    if (request.method === "GET") return jsonAnswer({ items: [] })(request);
    bodies.push(await request.json());
    return (answers.shift() ?? answers.at(-1)!)(request);
  };
}

function openPayments({ me = officer, routes }: { me?: MeResponse; routes: Record<string, Answer> }) {
  stubNetwork({ [SETTINGS]: jsonAnswer(settings), ...routes });
  render(
    <MeContext.Provider value={me}>
      <Remittances />
    </MeContext.Provider>,
  );
}

describe("Payments", () => {
  it("lists recent statements with the payer, when they came in and how many lines paid a claim", async () => {
    openPayments({ routes: { [LIST]: jsonAnswer({ items: [r1, r2] }) } });

    const row = (await screen.findByRole("link", { name: "r1-chas.csv" })).closest("li") as HTMLElement;
    expect(within(row).getByRole("link", { name: "r1-chas.csv" }).getAttribute("href")).toBe("/payments/rem-1");
    expect(within(row).getByText("CHAS")).toBeTruthy();
    expect(within(row).getByText("13 Nov 2026, 10:00 am")).toBeTruthy();
    expect(within(row).getByText("3 of 5 lines matched")).toBeTruthy();
    const second = screen.getByRole("link", { name: "r2-meridian.csv" }).closest("li") as HTMLElement;
    expect(within(second).getByText("Meridian Dental Plan")).toBeTruthy();
  });

  it("uploads an officer's statement against the saved columns and says what it recorded", async () => {
    const bodies: unknown[] = [];
    openPayments({ routes: { [LIST]: postRoute(bodies, jsonAnswer({ outcome: "imported", remittanceId: "rem-1", lines: 5, matched: 3, forPerson: 2 })) } });

    await upload("CHAS", R1_CSV);

    const status = await screen.findByText(/Read 5 payment lines/);
    expect(status.closest("[role=status]")?.textContent).toBe("Read 5 payment lines: 3 recorded as paid, 2 to match by hand. Open the statement");
    expect(within(status.closest("[role=status]") as HTMLElement).getByRole("link", { name: "Open the statement" }).getAttribute("href")).toBe("/payments/rem-1");
    expect(bodies).toEqual([{ payerId: "CHAS", fileName: "r1-chas.csv", csv: R1_CSV }]);
  });

  it("AC-5.7: says a headers-only file has no payment lines and changed nothing", async () => {
    openPayments({ routes: { [LIST]: postRoute([], jsonAnswer({ outcome: "empty" })) } });

    await upload("CHAS", "reference,identifier,visit date,amount\n", "headers-only.csv");

    const status = screen.getByRole("status");
    await waitFor(() => expect(status.textContent).toBe("No payment lines in this file. Nothing was changed."));
  });

  it("AC-5.6: says a statement imported before added nothing, and links to it", async () => {
    openPayments({ routes: { [LIST]: postRoute([], jsonAnswer({ outcome: "already_imported", remittanceId: "rem-1", added: 0 })) } });

    await upload("CHAS", R1_CSV);

    const status = screen.getByRole("status");
    await waitFor(() => expect(status.textContent).toBe("This statement was imported before. Nothing was added. Open the statement"));
    expect(within(status).getByRole("link").getAttribute("href")).toBe("/payments/rem-1");
  });

  it.each([
    [409, { error: "columns_not_mapped", payerId: "CHAS" }, "CHAS's statement columns aren't mapped yet. Ask a reviewer to map them, then upload again."],
    [422, { error: "statement_unreadable", problem: { kind: "missing_columns", headers: ["amount", "visit date"] } }, "The file has no amount or visit date column. Check you chose the right payer, or ask a reviewer to update the column names."],
    [422, { error: "statement_unreadable", problem: { kind: "bad_lines", lines: [{ lineNo: 2, column: "amount" }, { lineNo: 4, column: "visit date" }] } }, "Some lines don't read: line 2 (amount), line 4 (visit date). Correct them in the file, then upload it again. Dates are YYYY-MM-DD."],
    [422, { error: "statement_unreadable", problem: { kind: "malformed" } }, "The file isn't a CSV the desk can read. Save it from the payer's portal as CSV, then upload it again."],
    [422, { error: "statement_unreadable", problem: { kind: "too_many_lines", maxLines: 50 } }, "The file has more than 50 payment lines. Split it into smaller files, then upload each."],
    [422, { error: "real_identifier_refused", lines: [1, 3] }, "Lines 1 and 3 carry real NRICs. This desk takes synthetic records only, so nothing was imported."],
    [413, { error: "too_large" }, "The file is too large to upload. Split it into smaller files, then upload each."],
    [403, { error: "forbidden" }, "Only a reviewer can change a payer's statement columns."],
    [500, { error: "internal" }, "The statement didn't upload. Nothing was changed. Try again in a moment."],
  ])("names what to do when the upload answers %i %j", async (status, body, words) => {
    openPayments({ routes: { [LIST]: postRoute([], jsonAnswer(body, status)) } });

    await upload("CHAS", R1_CSV);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(words);
    expect(alert.textContent).not.toContain("T9000001I");
  });

  describe("a statement that looks like one taken in before the identifier key changed (review B1)", () => {
    const duplicate = jsonAnswer({ error: "possible_duplicate", remittanceId: "rem-1" }, 409);

    it("tells an officer nothing was imported, links the earlier statement, and asks for a reviewer", async () => {
      openPayments({ routes: { [LIST]: postRoute([], duplicate) } });

      await upload("CHAS", R1_CSV);

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(
        "CHAS already has a statement called r1-chas.csv with the same number of lines, taken in before the identifier key changed. The desk can't tell whether this is the same file, so nothing was imported.",
      );
      expect(alert.textContent).toContain("If this one is different, ask a reviewer to import it.");
      expect(within(alert).getByRole("link", { name: "Open the earlier statement" }).getAttribute("href")).toBe("/payments/rem-1");
      expect(within(alert).queryByRole("button", { name: "Import anyway" })).toBeNull();
    });

    it("lets a reviewer import it anyway, sending the confirmation with the same file", async () => {
      const bodies: unknown[] = [];
      openPayments({ me: reviewer, routes: { [LIST]: postRoute(bodies, duplicate, jsonAnswer({ outcome: "imported", remittanceId: "rem-3", lines: 1, matched: 1, forPerson: 0 })) } });
      await upload("CHAS", R1_CSV);

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("If this one is different, you can import it anyway.");
      fireEvent.click(within(alert).getByRole("button", { name: "Import anyway" }));

      await screen.findByText(/Read 1 payment line:/);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toMatchObject({ payerId: "CHAS", fileName: "r1-chas.csv", csv: R1_CSV, confirmPossibleDuplicate: true });
      expect(bodies[0]).not.toHaveProperty("confirmPossibleDuplicate");
    });

    it("says only a reviewer can import a possible duplicate when the confirmation is refused", async () => {
      openPayments({ me: reviewer, routes: { [LIST]: postRoute([], duplicate, jsonAnswer({ error: "forbidden" }, 403)) } });
      await upload("CHAS", R1_CSV);
      fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Import anyway" }));

      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Only a reviewer can import a possible duplicate."));
    });
  });

  // QA 03 D02e: Upload statement is disabled while it runs, so focus would fall to the body.
  describe("focus once an upload settles (QA 03 D02e)", () => {
    /** Chooses a CSV file, then presses Upload statement from the keyboard's point of view: it has focus first. */
    async function uploadByKeyboard(csv: string) {
      await choosePayer("CHAS");
      fireEvent.change(screen.getByLabelText("Statement file"), { target: { files: [new File([csv], "r1-chas.csv", { type: "text/csv" })] } });
      const button = screen.getByRole("button", { name: "Upload statement" });
      button.focus();
      fireEvent.click(button);
    }

    it("puts focus on what the upload recorded", async () => {
      openPayments({ routes: { [LIST]: postRoute([], jsonAnswer({ outcome: "imported", remittanceId: "rem-1", lines: 5, matched: 3, forPerson: 2 })) } });

      await uploadByKeyboard(R1_CSV);

      const status = (await screen.findByText(/Read 5 payment lines/)).closest("[role=status]");
      await waitFor(() => expect(document.activeElement).toBe(status));
    });

    it("puts focus on why the upload was refused", async () => {
      openPayments({ routes: { [LIST]: postRoute([], jsonAnswer({ error: "too_large" }, 413)) } });

      await uploadByKeyboard(R1_CSV);

      const alert = await screen.findByRole("alert");
      await waitFor(() => expect(document.activeElement).not.toBe(document.body));
      expect(document.activeElement?.contains(alert)).toBe(true);
    });

    it("puts focus on a possible duplicate, then on the refusal of Import anyway", async () => {
      const duplicate = jsonAnswer({ error: "possible_duplicate", remittanceId: "rem-1" }, 409);
      openPayments({ me: reviewer, routes: { [LIST]: postRoute([], duplicate, jsonAnswer({ error: "forbidden" }, 403)) } });

      await uploadByKeyboard(R1_CSV);

      const lookalike = await screen.findByRole("alert");
      await waitFor(() => expect(document.activeElement?.contains(lookalike)).toBe(true));

      const anyway = within(lookalike).getByRole("button", { name: "Import anyway" });
      anyway.focus();
      fireEvent.click(anyway);

      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Only a reviewer can import a possible duplicate."));
      await waitFor(() => expect(document.activeElement?.contains(screen.getByRole("alert"))).toBe(true));
    });
  });

  it("lets a reviewer correct a payer's statement columns and saves them with the upload", async () => {
    const bodies: unknown[] = [];
    openPayments({ me: reviewer, routes: { [LIST]: postRoute(bodies, jsonAnswer({ outcome: "imported", remittanceId: "rem-2", lines: 1, matched: 1, forPerson: 0 })) } });
    await choosePayer("MERIDIAN");

    expect((screen.getByLabelText("Claim reference column") as HTMLInputElement).value).toBe("Claim Ref");
    expect((screen.getByLabelText("Patient NRIC column") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Visit date column") as HTMLInputElement).value).toBe("Service Date");
    expect((screen.getByLabelText("Paid on column") as HTMLInputElement).value).toBe("Paid On");
    fireEvent.change(screen.getByLabelText("Amount column"), { target: { value: "Amount Paid" } });
    fireEvent.change(screen.getByLabelText("Paid on column"), { target: { value: "  " } });
    send("Claim Ref,Service Date,Amount Paid\nMDP-0001,2026-10-20,288.00\n", "r2-meridian.csv");

    await screen.findByText(/Read 1 payment line:/);
    expect(bodies).toEqual([
      {
        payerId: "MERIDIAN",
        fileName: "r2-meridian.csv",
        csv: "Claim Ref,Service Date,Amount Paid\nMDP-0001,2026-10-20,288.00\n",
        columns: { reference: "Claim Ref", patientNric: null, visitDate: "Service Date", amount: "Amount Paid", paidOn: null },
      },
    ]);
  });

  it("holds a reviewer's upload until the amount column is named", async () => {
    openPayments({ me: reviewer, routes: { [LIST]: postRoute([]) } });
    await choosePayer("HARBOUR");
    fireEvent.change(screen.getByLabelText("Statement file"), { target: { files: [new File(["x"], "h.csv", { type: "text/csv" })] } });

    expect((screen.getByRole("button", { name: "Upload statement" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Amount column"), { target: { value: "Paid" } });
    expect((screen.getByRole("button", { name: "Upload statement" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("tells an officer a reviewer maps an unmapped payer first, and shows no column fields", async () => {
    openPayments({ routes: { [LIST]: postRoute([]) } });
    await choosePayer("HARBOUR");
    fireEvent.change(screen.getByLabelText("Statement file"), { target: { files: [new File(["x"], "h.csv", { type: "text/csv" })] } });

    expect(screen.getByText("A reviewer maps this payer's statement columns before its first upload.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Upload statement" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Amount column")).toBeNull();
  });
});

const day = (s: string) => s as IsoDate;
const DETAIL = `${ORIGIN}/api/remittances/rem-1`;
const MATCH_4 = `${ORIGIN}/api/remittances/rem-1/lines/4/match`;

const d01: LineClaim = { claimId: "c-d01", visitKey: "SC-D01", scheme: "chas", status: "paid" };
const d03: LineClaim = { claimId: "c-d03", visitKey: "SC-D03", scheme: "chas", status: "accepted" };
const d02: LineClaim = { claimId: "c-d02", visitKey: "SC-D02-P04", scheme: "chas", status: "paid" };
const d05: OpenClaimOption = {
  claimId: "c-d05",
  visitKey: "SC-D05",
  scheme: "chas",
  status: "submitted",
  version: 3,
  visitDate: day("2026-10-09"),
  portalReference: null,
  patientMask: "T****006J",
  claimedCents: cents(9999),
  acceptedCents: null,
  paidCents: cents(0),
};
const d06: OpenClaimOption = { ...d05, claimId: "c-d06", visitKey: "SC-D06", version: 1, portalReference: "MHCP-0006", patientMask: "T****007H" };

const line = (lineNo: number, rest: Partial<RemittanceLineView>): RemittanceLineView => ({
  lineNo,
  portalReference: null,
  visitDate: day("2026-10-02"),
  amountCents: 5050,
  paidOn: day("2026-11-10"),
  match: null,
  note: null,
  ...rest,
});

/** R1 as the server shows it after import (spec §5). */
const r1Detail: RemittanceDetail = {
  remittance: r1,
  lines: [
    line(1, { portalReference: "MHCP-0001", match: { kind: "reference", ...d01 } }),
    line(2, { portalReference: "MHCP-0002", amountCents: 55000, match: { kind: "reference", ...d03 } }),
    line(3, { amountCents: 2050, match: { kind: "patient_date_amount", ...d02 } }),
    line(4, { portalReference: "UNKNOWN-1", amountCents: 9999, note: { kind: "no_claim" } }),
    line(5, { portalReference: "MHCP-0001", note: { kind: "closed", ...d01 } }),
  ],
  openClaims: [d05, d06],
};

function openStatement({ routes }: { routes: Record<string, Answer> }) {
  stubNetwork({ [SETTINGS]: jsonAnswer(settings), ...routes });
  render(
    <MeContext.Provider value={officer}>
      <Remittances remittanceId="rem-1" />
    </MeContext.Provider>,
  );
}

const waiting = (lineNo: number) => screen.getByRole("group", { name: `Line ${lineNo}` });

describe("A payment statement", () => {
  it("shows each line that paid a claim, how it matched, and the claim's status", async () => {
    openStatement({ routes: { [DETAIL]: jsonAnswer(r1Detail) } });

    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("r1-chas.csv");
    expect(screen.getByRole("link", { name: "All payments" }).getAttribute("href")).toBe("/payments");
    const table = screen.getByRole("table", { name: "Paid claims" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "1MHCP-0001$50.50SC-D01By referencePaid",
      "2MHCP-0002$550.00SC-D03By referenceAcceptedPaid less than accepted for SC-D03",
      "3—$20.50SC-D02-P04By patient, date and amountPaid",
    ]);
    expect(within(rows[0]!).getByRole("link", { name: "SC-D01" }).getAttribute("href")).toBe("/claims/c-d01");
  });

  it("AC-5.3: points a short payment to the claim, where a person accepts it", async () => {
    openStatement({ routes: { [DETAIL]: jsonAnswer(r1Detail) } });

    const short = await screen.findByRole("link", { name: "Paid less than accepted for SC-D03" });
    expect(short.getAttribute("href")).toBe("/claims/c-d03");
  });

  it("AC-5.5, AC-5.6: lists the lines left for a person, each with why", async () => {
    openStatement({ routes: { [DETAIL]: jsonAnswer(r1Detail) } });

    await screen.findByRole("heading", { name: "Match by hand" });
    expect(waiting(4).textContent).toContain("UNKNOWN-1");
    expect(waiting(4).textContent).toContain("$99.99");
    expect(waiting(4).textContent).toContain("No CHAS claim carries this reference.");
    expect(waiting(5).textContent).toContain("SC-D01 is already paid.");
    expect(screen.queryByRole("group", { name: "Line 1" })).toBeNull();
  });

  it("AC-5.5: matches a waiting line to the claim a person chooses", async () => {
    const bodies: unknown[] = [];
    const after: RemittanceDetail = {
      remittance: { ...r1, matched: 4 },
      lines: r1Detail.lines.map((l) => (l.lineNo === 4 ? { ...l, note: null, match: { kind: "manual", ...d05, status: "paid" } } : l)),
      openClaims: [d06],
    };
    openStatement({ routes: { [DETAIL]: jsonAnswer(r1Detail), [MATCH_4]: postRoute(bodies, jsonAnswer(after)) } });

    await screen.findByRole("heading", { name: "Match by hand" });
    fireEvent.change(within(waiting(4)).getByLabelText("Claim line 4 pays"), { target: { value: "c-d05" } });
    fireEvent.click(within(waiting(4)).getByRole("button", { name: "Match line 4" }));
    fireEvent.click(within(waiting(4)).getByRole("button", { name: "Confirm match" }));

    expect((await screen.findByText("Line 4 now pays SC-D05.")).closest("[role=status]")).toBeTruthy();
    expect(bodies).toEqual([{ claimId: "c-d05", expectedVersion: 3 }]);
    expect(screen.queryByRole("group", { name: "Line 4" })).toBeNull();
    const rows = within(screen.getByRole("table", { name: "Paid claims" })).getAllByRole("row");
    expect(rows.at(-1)!.textContent).toBe("4UNKNOWN-1$99.99SC-D05By handPaid");
  });

  it("QA N1: moves focus to the result once a confirmed match takes the line away", async () => {
    const after: RemittanceDetail = {
      remittance: { ...r1, matched: 4 },
      lines: r1Detail.lines.map((l) => (l.lineNo === 4 ? { ...l, note: null, match: { kind: "manual", ...d05, status: "paid" } } : l)),
      openClaims: [d06],
    };
    openStatement({ routes: { [DETAIL]: jsonAnswer(r1Detail), [MATCH_4]: postRoute([], jsonAnswer(after)) } });

    await screen.findByRole("heading", { name: "Match by hand" });
    fireEvent.change(within(waiting(4)).getByLabelText("Claim line 4 pays"), { target: { value: "c-d05" } });
    fireEvent.click(within(waiting(4)).getByRole("button", { name: "Match line 4" }));
    fireEvent.click(within(waiting(4)).getByRole("button", { name: "Confirm match" }));

    const result = await screen.findByText("Line 4 now pays SC-D05.");
    expect(document.activeElement).toBe(result);
  });

  it("QA N1: leaves focus alone when the statement first loads", async () => {
    openStatement({ routes: { [DETAIL]: jsonAnswer(r1Detail) } });

    await screen.findByRole("heading", { name: "Match by hand" });
    expect(document.activeElement).toBe(document.body);
  });

  it.each([
    [409, { error: "stale", currentVersion: 4 }, "SC-D05 changed while you were looking. The statement has been reloaded: check the claim, then match again.", 2],
    [409, { error: "not_allowed", detail: "paid" }, "Line 4 can't pay SC-D05 as things stand. The statement has been reloaded.", 2],
    [409, { error: "checked_out", by: "officer2@clinic.test", until: "2026-11-13T02:30:00.000Z" }, "officer2@clinic.test is submitting SC-D05. Try again after 13 Nov 2026, 10:30 am.", 1],
    [403, { error: "forbidden" }, "You don't have access to do that.", 1],
    [500, { error: "internal" }, "Line 4 wasn't matched. Check your connection, then try again.", 1],
  ])("says why a match answered %i %j, and reloads when the claim moved on", async (status, body, words, loads) => {
    let gets = 0;
    const detail: Answer = (request) => {
      gets += 1;
      return jsonAnswer(r1Detail)(request);
    };
    openStatement({ routes: { [DETAIL]: detail, [MATCH_4]: jsonAnswer(body, status) } });

    await screen.findByRole("heading", { name: "Match by hand" });
    fireEvent.change(within(waiting(4)).getByLabelText("Claim line 4 pays"), { target: { value: "c-d05" } });
    fireEvent.click(within(waiting(4)).getByRole("button", { name: "Match line 4" }));
    fireEvent.click(within(waiting(4)).getByRole("button", { name: "Confirm match" }));

    expect((await within(waiting(4)).findByRole("alert")).textContent).toBe(words);
    await waitFor(() => expect(gets).toBe(loads));
    expect(within(waiting(4)).getByRole("button", { name: "Match line 4" })).toBeTruthy();
  });

  it("AC-5.5: names the claim and the amount, and sends nothing until a person confirms", async () => {
    const bodies: unknown[] = [];
    openStatement({ routes: { [DETAIL]: jsonAnswer(r1Detail), [MATCH_4]: postRoute(bodies, jsonAnswer(r1Detail)) } });

    await screen.findByRole("heading", { name: "Match by hand" });
    fireEvent.change(within(waiting(4)).getByLabelText("Claim line 4 pays"), { target: { value: "c-d05" } });
    fireEvent.click(within(waiting(4)).getByRole("button", { name: "Match line 4" }));

    const question = within(waiting(4)).getByText(/^Record line 4/);
    expect(question.textContent).toBe("Record line 4's $99.99 as paid to SC-D05?");
    expect(document.activeElement).toBe(question);
    expect(within(waiting(4)).getByText(/^SC-D05 is for/).textContent).toBe("SC-D05 is for T****006J's visit on 9 Oct 2026, with $99.99 still owed.");
    expect(within(waiting(4)).getByLabelText("Claim line 4 pays")).toHaveProperty("disabled", true);
    expect(within(waiting(4)).queryByRole("button", { name: "Match line 4" })).toBeNull();
    expect(bodies).toEqual([]);
  });

  it("AC-5.5: leaves the line waiting when a person cancels", async () => {
    const bodies: unknown[] = [];
    openStatement({ routes: { [DETAIL]: jsonAnswer(r1Detail), [MATCH_4]: postRoute(bodies, jsonAnswer(r1Detail)) } });

    await screen.findByRole("heading", { name: "Match by hand" });
    fireEvent.change(within(waiting(4)).getByLabelText("Claim line 4 pays"), { target: { value: "c-d05" } });
    fireEvent.click(within(waiting(4)).getByRole("button", { name: "Match line 4" }));
    fireEvent.click(within(waiting(4)).getByRole("button", { name: "Cancel" }));

    const again = within(waiting(4)).getByRole("button", { name: "Match line 4" });
    expect(document.activeElement).toBe(again);
    expect(within(waiting(4)).queryByText(/^Record line 4/)).toBeNull();
    expect(within(waiting(4)).getByLabelText("Claim line 4 pays")).toHaveProperty("value", "c-d05");
    expect(bodies).toEqual([]);
  });

  it("says it is matching while the match is on its way, and takes no second press", async () => {
    const bodies: unknown[] = [];
    let answer!: (r: Response) => void;
    const slow: Answer = async (request) => {
      bodies.push(await request.json());
      return new Promise<Response>((resolve) => (answer = resolve));
    };
    openStatement({ routes: { [DETAIL]: jsonAnswer(r1Detail), [MATCH_4]: slow } });

    await screen.findByRole("heading", { name: "Match by hand" });
    fireEvent.change(within(waiting(4)).getByLabelText("Claim line 4 pays"), { target: { value: "c-d05" } });
    fireEvent.click(within(waiting(4)).getByRole("button", { name: "Match line 4" }));
    fireEvent.click(within(waiting(4)).getByRole("button", { name: "Confirm match" }));

    const sending = await within(waiting(4)).findByRole("button", { name: "Matching…" });
    expect((sending as HTMLButtonElement).disabled).toBe(true);
    expect((within(waiting(4)).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sending);
    await waitFor(() => expect(bodies).toHaveLength(1));
    answer(new Response(JSON.stringify({ error: "internal" }), { status: 500, headers: { "Content-Type": "application/json" } }));
    expect((await within(waiting(4)).findByRole("alert")).textContent).toBe("Line 4 wasn't matched. Check your connection, then try again.");
    expect(bodies).toHaveLength(1);
  });

  it("offers no match for a line that pays nothing", async () => {
    const refund = { ...r1Detail, lines: [line(6, { portalReference: "MHCP-0001", amountCents: -5050, note: { kind: "not_a_payment" } })] };
    openStatement({ routes: { [DETAIL]: jsonAnswer(refund) } });

    await screen.findByRole("heading", { name: "Match by hand" });
    expect(waiting(6).textContent).toContain("This line pays nothing or takes money back. Settle it with CHAS outside the desk.");
    expect(within(waiting(6)).queryByRole("button")).toBeNull();
  });

  it("offers another try when the statement didn't load", async () => {
    let gets = 0;
    const flaky: Answer = (request) => {
      gets += 1;
      return gets === 1 ? jsonAnswer({ error: "internal" }, 500)(request) : jsonAnswer(r1Detail)(request);
    };
    openStatement({ routes: { [DETAIL]: flaky } });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The statement didn't load.Check your connection, then try again.Try again");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    await screen.findByRole("heading", { name: "Match by hand" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    [404, { error: "not_found" }, "The statement didn't load.There is no payment statement at this address. Back to all payments"],
    [403, { error: "forbidden" }, "The statement didn't load.Your account isn't on the desk's team list. Ask the clinic's administrator to add you."],
  ])("says why the statement didn't load on %i, with no point trying again", async (status, body, words) => {
    openStatement({ routes: { [DETAIL]: jsonAnswer(body, status) } });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(words);
    expect(within(alert).queryByRole("button")).toBeNull();
  });
});
