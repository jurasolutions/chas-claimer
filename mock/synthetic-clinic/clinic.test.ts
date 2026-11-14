/**
 * The clinic as a whole: its size, determinism (SC7.10), every visit a valid source visit, and
 * every identifier synthetic (SC7.7), checked over seeds.
 */
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, parseIsoDate, yearOf, type IsoDate } from "../../src/domain/dates";
import { isSynthetic, parseNric } from "../../src/domain/nric";
import { parseSourceVisit } from "../../src/domain/source-visit";
import { generateClinic } from "./generate";

const T = parseIsoDate("2026-11-13") as IsoDate;

function identifiersOf(clinic: ReturnType<typeof generateClinic>): string[] {
  return [
    ...clinic.records.patients.map((p) => p.nric),
    ...clinic.visits.flatMap((v) => [v.patient.nric, v.medisave?.accountHolder.nric ?? null]),
  ].filter((n): n is NonNullable<typeof n> => n !== null);
}

describe("generateClinic: the whole clinic", () => {
  const clinic = generateClinic({ seed: 7, asOf: T });

  it("has about 60 patients and 200 visits", () => {
    expect(clinic.records.patients).toHaveLength(60);
    expect(clinic.visits).toHaveLength(200);
    expect(new Set(clinic.visits.map((v) => v.visitKey)).size).toBe(200);
  });

  it("gives every patient a different identifier, name and phone number", () => {
    const ps = clinic.records.patients;
    for (const field of ["nric", "name", "phone"] as const) expect(new Set(ps.map((p) => p[field])).size).toBe(ps.length);
  });

  it("fills in the year with visits from the last 180 days, none after the as-of date", () => {
    const routine = clinic.visits.filter((v) => v.visitKey.startsWith("SC-F"));
    expect(routine.length).toBeGreaterThan(100);
    for (const v of routine) {
      expect(v.date >= addDays(T, -180) && v.date <= T).toBe(true);
      expect(["BR-EAST", "BR-WEST"]).toContain(v.branchId);
    }
    expect(clinic.visits.every((v) => v.date <= T)).toBe(true);
  });

  it("puts each routine visit with a dentist who works at its branch (uat-script 2.1)", () => {
    const worksAt: Record<string, string[]> = { "BR-EAST": ["DR-A"], "BR-WEST": ["DR-B", "DR-C"] };
    const routine = clinic.visits.filter((v) => v.visitKey.startsWith("SC-F"));
    for (const v of routine) expect(worksAt[v.branchId], `${v.visitKey} at ${v.branchId}`).toContain(v.dentistId);
  });

  it("gives every visit in a shape the desk accepts, unchanged by parsing", () => {
    for (const v of [...clinic.visits, ...clinic.revisions]) {
      const parsed = parseSourceVisit(v);
      if (!parsed.ok) throw new Error(`${v.visitKey}: ${JSON.stringify(parsed.error)}`);
      expect(parsed.value).toEqual(v);
    }
  });

  it("gives byte-identical output for the same seed and as-of date (SC7.10)", () => {
    expect(JSON.stringify(generateClinic({ seed: 7, asOf: T }))).toBe(JSON.stringify(clinic));
  });

  it("gives different patients for a different seed", () => {
    const other = generateClinic({ seed: 8, asOf: T });
    expect(other.records.patients.map((p) => p.nric)).not.toEqual(clinic.records.patients.map((p) => p.nric));
  });

  it("only ever emits T9-block identifiers with a valid check letter, whatever the seed (SC7.7)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        for (const n of identifiersOf(generateClinic({ seed, asOf: T }))) {
          const parsed = parseNric(n);
          expect(parsed).not.toBeNull();
          expect(isSynthetic(parsed!)).toBe(true);
          expect(n).toMatch(/^T9\d{6}[A-Z]$/);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("keeps D19's three scalings in the calendar year of an early-January as-of date", () => {
    for (const asOf of ["2027-01-10", "2027-01-04", "2027-01-01"]) {
      const c = generateClinic({ seed: 7, asOf: asOf as IsoDate });
      const dates = c.cases.D19.map((k) => c.visits.find((v) => v.visitKey === k)!.date);
      expect(dates).toHaveLength(3);
      for (const d of dates) expect([yearOf(d), d <= asOf]).toEqual([2027, true]);
      for (const k of c.cases.partlyUsedLimit) expect(yearOf(c.visits.find((v) => v.visitKey === k)!.date)).toBe(2027);
    }
  });
});

describe("the procedure keys the README lists for the rule sets", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = readme.slice(readme.indexOf("### Procedure keys"), readme.indexOf("### Writing the clinic's database"));
  const rows = new Set(
    section
      .split("\n")
      .filter((l) => l.startsWith("| `"))
      .map((l) => l.split("|").slice(1, 4).map((c) => c.trim().replace(/`/g, "")).join(" ")),
  );

  it("match the synthetic code map, row for row", () => {
    const expected = generateClinic({ seed: 7, asOf: T }).codeMap.map((e) =>
      [e.clinicCode, e.target === "benefit" ? `benefit (${e.payerId})` : e.target, e.targetCode ?? "not claimable"].join(" "),
    );
    expect([...rows].sort()).toEqual([...expected].sort());
  });
});
