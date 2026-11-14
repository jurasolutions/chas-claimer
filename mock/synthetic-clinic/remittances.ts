/**
 * The remittance files of uat-script 2.3, as the payers would send them. References follow the
 * MHCP-000n / MDP-000n pattern the UAT uses; the tester can swap in the references a run records.
 * Amounts are the UAT's, not computed here: whether they match a claim is what reconciliation tests.
 */
import { addDays, type IsoDate } from "../../src/domain/dates";
import { toCsv } from "../../src/domain/csv";
import type { SourceVisit } from "../../src/domain/source-visit";

export interface Remittances {
  /** R1, the CHAS statement. */
  r1Chas: string;
  /** R2, the Meridian statement. */
  r2Meridian: string;
}

export function buildRemittances(asOf: IsoDate, visits: SourceVisit[]): Remittances {
  const visit = (key: string) => {
    const v = visits.find((x) => x.visitKey === key);
    if (!v) throw new Error(`remittances name a visit that is not generated: ${key}`);
    return v;
  };
  const d01 = visit("SC-D01");
  const d03 = visit("SC-D03");
  const p04 = visit("SC-D02-P04");
  const d04b = visit("SC-D04b");

  const r1Line = (reference: string, v: SourceVisit | null, cents: number) => ({
    reference,
    identifier: v?.patient.nric ?? null,
    date: v?.date ?? null,
    amount: { cents },
  });
  const r1Chas = toCsv(
    [
      { key: "reference", header: "reference" },
      { key: "identifier", header: "identifier" },
      { key: "date", header: "visit date" },
      { key: "amount", header: "amount" },
    ],
    [
      r1Line("MHCP-0001", d01, 5050),
      r1Line("MHCP-0002", d03, 55000),
      { ...r1Line("", p04, 2050), reference: null, date: addDays(asOf, -2) },
      r1Line("UNKNOWN-1", null, 9999),
      r1Line("MHCP-0001", d01, 5050),
    ],
  );

  const r2Meridian = toCsv(
    [
      { key: "ref", header: "Claim Ref" },
      { key: "date", header: "Service Date" },
      { key: "amount", header: "Paid Amount" },
      { key: "paidOn", header: "Paid On" },
    ],
    [{ ref: "MDP-0001", date: d04b.date, amount: { cents: 28800 }, paidOn: asOf }],
  );

  return { r1Chas, r2Meridian };
}
