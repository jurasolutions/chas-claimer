import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbClaims, arbRemittance } from "../../tests/helpers/arbitraries";
import type { IsoDate } from "./dates";
import { cents } from "./money";
import { matchRemittance, type MatchCandidate, type RemittanceLine } from "./matcher";

const T = "2026-11-11" as IsoDate;

function line(lineNo: number, over: Partial<RemittanceLine> = {}): RemittanceLine {
  return { lineNo, portalReference: null, patientHash: null, visitDate: null, amountCents: 5050, ...over };
}

function claim(claimId: string, over: Partial<MatchCandidate> = {}): MatchCandidate {
  return { claimId, status: "submitted", portalReference: null, patientHash: "v1:p1", visitDate: T, outstandingCents: cents(5050), ...over };
}

describe("matchRemittance", () => {
  it("SC5.1: matches a line to the claim with its portal reference", () => {
    const result = matchRemittance([line(1, { portalReference: "MHCP-0001" })], [claim("D02"), claim("D01", { portalReference: "MHCP-0001" })]);
    expect(result).toEqual([{ lineNo: 1, kind: "reference", claimId: "D01" }]);
  });

  it("N5: matches a portal reference whatever its case or surrounding spaces", () => {
    const result = matchRemittance([line(1, { portalReference: " mhcp-0001" })], [claim("D02"), claim("D01", { portalReference: "MHCP-0001" })]);
    expect(result).toEqual([{ lineNo: 1, kind: "reference", claimId: "D01" }]);
  });

  it("SC5.2: with no reference, matches the one claim with the same patient, visit date and amount owed", () => {
    const result = matchRemittance(
      [line(3, { patientHash: "v1:p4", visitDate: T, amountCents: 2050 })],
      [claim("other-patient", { patientHash: "v1:p5", outstandingCents: cents(2050) }), claim("P04-D02", { patientHash: "v1:p4", outstandingCents: cents(2050) })],
    );
    expect(result).toEqual([{ lineNo: 3, kind: "patient_date_amount", claimId: "P04-D02" }]);
  });

  it("SC5.2: leaves a line that ties two claims on patient, date and amount for a person", () => {
    const result = matchRemittance([line(1, { patientHash: "v1:p1", visitDate: T })], [claim("A"), claim("B")]);
    expect(result).toEqual([{ lineNo: 1, kind: "ambiguous", claimIds: ["A", "B"] }]);
  });

  it("SC5.3: guesses nothing for an unknown reference, a different amount or a part payment without a reference", () => {
    const result = matchRemittance(
      [
        line(1, { portalReference: "UNKNOWN-1", patientHash: "v1:p1", visitDate: T, amountCents: 5050 }),
        line(2, { patientHash: "v1:p1", visitDate: T, amountCents: 5000 }),
        line(3, { patientHash: "v1:p1", visitDate: T, amountCents: 9999 }),
        line(4, { patientHash: "v1:p1", visitDate: "2026-11-10" as IsoDate, amountCents: 5050 }),
      ],
      [claim("A")],
    );
    expect(result.map((m) => m.kind)).toEqual(["unmatched", "unmatched", "unmatched", "unmatched"]);
    expect(result.every((m) => m.kind !== "unmatched" || m.reason.kind === "no_claim")).toBe(true);
  });

  it("AC-5.3: a reference match takes a part payment or an overpayment as it comes", () => {
    const result = matchRemittance(
      [line(2, { portalReference: "MHCP-0002", amountCents: 55000 }), line(6, { portalReference: "MHCP-0006", amountCents: 9000 })],
      [claim("D03", { status: "accepted", portalReference: "MHCP-0002", outstandingCents: cents(59450) }), claim("D06", { portalReference: "MHCP-0006", outstandingCents: cents(8000) })],
    );
    expect(result).toEqual([
      { lineNo: 2, kind: "reference", claimId: "D03" },
      { lineNo: 6, kind: "reference", claimId: "D06" },
    ]);
  });

  it("AC-5.6: a second line for a claim already matched in the file is left for a person", () => {
    const result = matchRemittance([line(1, { portalReference: "MHCP-0001" }), line(5, { portalReference: "MHCP-0001" })], [claim("D01", { portalReference: "MHCP-0001" })]);
    expect(result).toEqual([
      { lineNo: 1, kind: "reference", claimId: "D01" },
      { lineNo: 5, kind: "unmatched", reason: { kind: "taken", claimId: "D01" } },
    ]);
  });

  it("SC5.1: references claim their claims before any line is matched by patient, date and amount", () => {
    const result = matchRemittance([line(1, { patientHash: "v1:p1", visitDate: T }), line(2, { portalReference: "R-A" })], [claim("A", { portalReference: "R-A" })]);
    expect(result).toEqual([
      { lineNo: 1, kind: "unmatched", reason: { kind: "taken", claimId: "A" } },
      { lineNo: 2, kind: "reference", claimId: "A" },
    ]);
  });

  it("S12: leaves a line for a paid, withdrawn or written-off claim for a person, saying which", () => {
    const result = matchRemittance(
      [line(1, { portalReference: "R-P" }), line(2, { portalReference: "R-W" }), line(3, { patientHash: "v1:p9", visitDate: T })],
      [claim("P", { status: "paid", portalReference: "R-P", outstandingCents: cents(0) }), claim("W", { status: "withdrawn", portalReference: "R-W" }), claim("O", { status: "written_off", patientHash: "v1:p9" })],
    );
    expect(result).toEqual([
      { lineNo: 1, kind: "unmatched", reason: { kind: "closed", claimId: "P", status: "paid" } },
      { lineNo: 2, kind: "unmatched", reason: { kind: "closed", claimId: "W", status: "withdrawn" } },
      { lineNo: 3, kind: "unmatched", reason: { kind: "closed", claimId: "O", status: "written_off" } },
    ]);
  });

  it("S12: leaves a negative or zero line for a person, even with a matching reference", () => {
    const result = matchRemittance([line(1, { portalReference: "R-A", amountCents: -5050 }), line(2, { portalReference: "R-A", amountCents: 0 })], [claim("A", { portalReference: "R-A" })]);
    expect(result).toEqual([
      { lineNo: 1, kind: "unmatched", reason: { kind: "not_a_payment" } },
      { lineNo: 2, kind: "unmatched", reason: { kind: "not_a_payment" } },
    ]);
  });

  it("treats claims a person or an earlier file already matched to this file as taken", () => {
    const result = matchRemittance([line(4, { portalReference: "R-A" })], [claim("A", { portalReference: "R-A" })], { taken: ["A"] });
    expect(result).toEqual([{ lineNo: 4, kind: "unmatched", reason: { kind: "taken", claimId: "A" } }]);
  });

  it("SC5.4: a line never pays two claims, a claim never takes two lines, and only open claims are paid", () => {
    fc.assert(
      fc.property(arbClaims, arbRemittance, (claims, lines) => {
        const result = matchRemittance(lines, claims);
        expect(result.map((m) => m.lineNo)).toEqual(lines.map((l) => l.lineNo));
        const paid = result.flatMap((m) => (m.kind === "reference" || m.kind === "patient_date_amount" ? [m.claimId] : []));
        expect(new Set(paid).size).toBe(paid.length);
        for (const id of paid) expect(["submitted", "accepted"]).toContain(claims.find((c) => c.claimId === id)?.status);
        for (const [i, m] of result.entries()) {
          if (m.kind === "reference" || m.kind === "patient_date_amount") expect(lines[i]!.amountCents).toBeGreaterThan(0);
        }
      }),
    );
  });

  it("SC5.4: running the matcher again with its own matches taken matches nothing more", () => {
    fc.assert(
      fc.property(arbClaims, arbRemittance, (claims, lines) => {
        const first = matchRemittance(lines, claims);
        const taken = first.flatMap((m) => (m.kind === "reference" || m.kind === "patient_date_amount" ? [m.claimId] : []));
        const again = matchRemittance(lines, claims, { taken });
        expect(again.filter((m) => m.kind === "reference" || m.kind === "patient_date_amount")).toEqual([]);
      }),
    );
  });
});
