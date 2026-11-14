import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildRemittances } from "../../mock/synthetic-clinic/remittances";
import { toCsv } from "./csv";
import type { IsoDate } from "./dates";
import type { RemittanceColumns } from "./settings";
import type { SourceVisit } from "./source-visit";
import { parseStatement } from "./statement";

const CHAS: RemittanceColumns = { reference: "reference", patientNric: "identifier", visitDate: "visit date", amount: "amount", paidOn: null };
const MERIDIAN: RemittanceColumns = { reference: "Claim Ref", patientNric: null, visitDate: "Service Date", amount: "Paid Amount", paidOn: "Paid On" };
const OPTS = { maxLines: 100 };

describe("parseStatement", () => {
  it("SC5.5: reads each line through the payer's columns, amounts in cents", () => {
    const csv = "reference,identifier,visit date,amount\r\nMHCP-0001,T9000001I,2026-11-10,50.50\r\n,t9000001i ,2026-11-11,20.5\r\n";
    expect(parseStatement(csv, CHAS, OPTS)).toEqual({
      ok: true,
      value: [
        { lineNo: 1, portalReference: "MHCP-0001", patientNric: "T9000001I", visitDate: "2026-11-10", amountCents: 5050, paidOn: null },
        { lineNo: 2, portalReference: null, patientNric: "T9000001I", visitDate: "2026-11-11", amountCents: 2050, paidOn: null },
      ],
    });
  });

  it("SC5.5: copes with a BOM, quoted commas, LF endings, blank lines, thousands separators, a $ and a minus", () => {
    const csv = '﻿Paid On,Claim Ref,Service Date,Paid Amount\n\n2026-11-13,"MDP-0001, part",2026-11-01,"$1,288.00"\n,,,\n2026-11-13,MDP-0002,,-$12.5\n';
    expect(parseStatement(csv, MERIDIAN, OPTS)).toEqual({
      ok: true,
      value: [
        { lineNo: 1, portalReference: "MDP-0001, part", patientNric: null, visitDate: "2026-11-01", amountCents: 128800, paidOn: "2026-11-13" },
        { lineNo: 2, portalReference: "MDP-0002", patientNric: null, visitDate: null, amountCents: -1250, paidOn: "2026-11-13" },
      ],
    });
  });

  it("matches headers whatever their case or surrounding spaces", () => {
    const result = parseStatement(" Claim ref ,SERVICE DATE,paid amount,Paid On\nMDP-1,2026-11-01,1.00,\n", MERIDIAN, OPTS);
    expect(result.ok && result.value[0]).toMatchObject({ portalReference: "MDP-1", amountCents: 100, paidOn: null });
  });

  it("AC-5.7: a file with headers only has no lines", () => {
    expect(parseStatement("reference,identifier,visit date,amount\r\n", CHAS, OPTS)).toEqual({ ok: true, value: [] });
  });

  it("names the mapped headers the file lacks", () => {
    expect(parseStatement("reference,amount\n", CHAS, OPTS)).toEqual({ ok: false, error: { kind: "missing_columns", headers: ["identifier", "visit date"] } });
    expect(parseStatement("", CHAS, OPTS)).toEqual({
      ok: false,
      error: { kind: "missing_columns", headers: ["reference", "identifier", "visit date", "amount"] },
    });
  });

  it("refuses unreadable lines by line number and column, never by value", () => {
    // T9000001Z carries the wrong check letter (T9000001I is right), so line 1's identifier is unreadable.
    const csv = "reference,identifier,visit date,amount\nR1,T9000001Z,2026-11-10,1.00\nR2,,10/11/2026,abc\nR3,,,\n";
    const result = parseStatement(csv, CHAS, OPTS);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "bad_lines",
        lines: [
          { lineNo: 1, column: "identifier" },
          { lineNo: 2, column: "visit date" },
          { lineNo: 2, column: "amount" },
          { lineNo: 3, column: "amount" },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("T9000001Z");
  });

  it("refuses a file that is not CSV, or is too long", () => {
    expect(parseStatement('reference,identifier,visit date,amount\n"R1,x,2026-11-10,1.00\n', CHAS, OPTS)).toEqual({ ok: false, error: { kind: "malformed" } });
    const long = "reference,identifier,visit date,amount\n" + "R,,,1.00\n".repeat(3);
    expect(parseStatement(long, CHAS, { maxLines: 2 })).toEqual({ ok: false, error: { kind: "too_many_lines", maxLines: 2 } });
  });

  it("reads the UAT's R1 and R2 as the payers send them", () => {
    const visits = [
      { visitKey: "SC-D01", date: "2026-11-03", nric: "T9000001I" },
      { visitKey: "SC-D03", date: "2026-11-04", nric: "T9000003E" },
      { visitKey: "SC-D02-P04", date: "2026-11-11", nric: "T9000004C" },
      { visitKey: "SC-D04b", date: "2026-11-05", nric: "T9000005A" },
    ].map((v) => ({ visitKey: v.visitKey, date: v.date, patient: { nric: v.nric } })) as unknown as SourceVisit[];
    const { r1Chas, r2Meridian } = buildRemittances("2026-11-13" as IsoDate, visits);
    const r1 = parseStatement(r1Chas, CHAS, OPTS);
    expect(r1.ok && r1.value.map((l) => [l.lineNo, l.portalReference, l.amountCents])).toEqual([
      [1, "MHCP-0001", 5050],
      [2, "MHCP-0002", 55000],
      [3, null, 2050],
      [4, "UNKNOWN-1", 9999],
      [5, "MHCP-0001", 5050],
    ]);
    expect(r1.ok && r1.value[2]).toMatchObject({ patientNric: "T9000004C", visitDate: "2026-11-11" });
    expect(parseStatement(r2Meridian, MERIDIAN, OPTS)).toEqual({
      ok: true,
      value: [{ lineNo: 1, portalReference: "MDP-0001", patientNric: null, visitDate: "2026-11-05", amountCents: 28800, paidOn: "2026-11-13" }],
    });
  });

  it("SC5.5: any amount and reference written to a statement reads back unchanged", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: -10_000_000, max: 10_000_000 }), fc.string({ minLength: 1, maxLength: 12 })), { maxLength: 20 }), (rows) => {
        const refs = rows.map(([, r], i) => `R${r}${i}`);
        const csv = toCsv(
          [
            { key: "ref", header: "Claim Ref" },
            { key: "amount", header: "Paid Amount" },
            { key: "date", header: "Service Date" },
            { key: "paidOn", header: "Paid On" },
          ],
          rows.map(([c], i) => ({ ref: refs[i]!, amount: { cents: c }, date: null, paidOn: null })),
        );
        const result = parseStatement(csv, MERIDIAN, OPTS);
        expect(result.ok && result.value.map((l) => l.amountCents)).toEqual(rows.map(([c]) => c));
        expect(result.ok && result.value.map((l) => l.portalReference)).toEqual(refs);
      }),
    );
  });
});
