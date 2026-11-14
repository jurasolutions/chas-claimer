/** The remittance files R1 and R2 (uat-script 2.3), generated alongside the clinic. */
import { describe, expect, it } from "vitest";
import { addDays, parseIsoDate, type IsoDate } from "../../src/domain/dates";
import { parseCsv } from "../../src/domain/csv";
import { generateClinic } from "./generate";

const T = parseIsoDate("2026-11-13") as IsoDate;
const clinic = generateClinic({ seed: 7, asOf: T });
const visit = (key: string) => clinic.visits.find((v) => v.visitKey === key)!;
const rows = (csv: string) => {
  const parsed = parseCsv(csv, { maxRows: 100 });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
};

describe("generateClinic: remittance files (UAT 2.3)", () => {
  it("R1, the CHAS statement: a match by reference, a part payment, a reference-less line, an unknown line and a duplicate", () => {
    const d01 = visit("SC-D01");
    const d03 = visit("SC-D03");
    const p04 = visit("SC-D02-P04");
    expect(rows(clinic.remittances.r1Chas)).toEqual([
      ["reference", "identifier", "visit date", "amount"],
      ["MHCP-0001", d01.patient.nric, d01.date, "50.50"],
      ["MHCP-0002", d03.patient.nric, d03.date, "550.00"],
      ["", p04.patient.nric, addDays(T, -2), "20.50"],
      ["UNKNOWN-1", "", "", "99.99"],
      ["MHCP-0001", d01.patient.nric, d01.date, "50.50"],
    ]);
  });

  it("R2, the Meridian statement: D04b's crown paid at $288.00", () => {
    expect(rows(clinic.remittances.r2Meridian)).toEqual([
      ["Claim Ref", "Service Date", "Paid Amount", "Paid On"],
      ["MDP-0001", visit("SC-D04b").date, "288.00", T],
    ]);
  });

  it("writes CRLF line endings, as a payer portal's export does", () => {
    expect(clinic.remittances.r1Chas.endsWith("\r\n")).toBe(true);
    expect(clinic.remittances.r2Meridian.split("\r\n")).toHaveLength(3);
  });
});
