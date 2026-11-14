/**
 * SC7.9: every UAT case (uat-script 2.2) is in the `cases` map, and each named visit has the
 * feature it promises. Expected claim amounts are not checked here: they belong to 02 and 03.
 */
import { describe, expect, it } from "vitest";
import { addDays, ageOn, parseIsoDate, yearOf, type IsoDate } from "../../src/domain/dates";
import type { SourceVisit } from "../../src/domain/source-visit";
import { CASE_NAMES, generateClinic } from "./generate";

const T = parseIsoDate("2026-11-13") as IsoDate;
const clinic = generateClinic({ seed: 7, asOf: T });
const byKey = new Map(clinic.visits.map((v) => [v.visitKey, v]));

function visitsOf(name: (typeof CASE_NAMES)[number]): SourceVisit[] {
  return clinic.cases[name].map((key) => {
    const v = byKey.get(key);
    if (!v) throw new Error(`case ${name} names a visit that is not generated: ${key}`);
    return v;
  });
}
function only(name: (typeof CASE_NAMES)[number]): SourceVisit {
  const vs = visitsOf(name);
  expect(vs).toHaveLength(1);
  return vs[0]!;
}
const daysAgo = (n: number) => addDays(T, -n);
const age = (v: SourceVisit) => ageOn(v.patient.dateOfBirth, v.date);
const tiers = (v: SourceVisit) => v.chasCards.map((c) => c.tier);
const lines = (v: SourceVisit) =>
  v.treatments.map((t) => [t.code, t.feeCents, t.gstCents, t.completion, t.completedOn, t.tooth]);
const recordsOf = (v: SourceVisit) => {
  const patient = clinic.records.patients.find((p) => p.nric === v.patient.nric)!;
  const appointment = clinic.records.appointments.find((a) => a.visitKey === v.visitKey)!;
  return {
    patient,
    appointment,
    cards: clinic.records.chasCards.filter((c) => c.patientId === patient.patientId),
    policies: clinic.records.policies.filter((p) => p.patientId === patient.patientId),
  };
};

describe("generateClinic: the cases map (SC7.9)", () => {
  it("names every UAT case D01-D27 and the extra cases, each pointing at generated visits", () => {
    expect(Object.keys(clinic.cases).sort()).toEqual([...CASE_NAMES].sort());
    for (const keys of Object.values(clinic.cases)) {
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) expect(byKey.has(key)).toBe(true);
    }
  });

  it("D01: a Blue patient of 45 at East with Dr A, a consultation and a scaling with GST", () => {
    const v = only("D01");
    expect([v.branchId, v.dentistId, v.date, tiers(v), age(v)]).toEqual(["BR-EAST", "DR-A", daysAgo(3), ["Blue"], 45]);
    expect(lines(v)).toEqual([
      ["CON", 2800, 252, "complete", daysAgo(3), null],
      ["SCL", 6000, 540, "complete", daysAgo(3), null],
    ]);
  });

  it("D02: one consultation each for PG, MG, Blue, Orange, PA and Green at West, no GST", () => {
    const vs = visitsOf("D02");
    expect(vs.map((v) => [tiers(v), age(v)])).toEqual([
      [["PG"], 85],
      [["MG"], 70],
      [["Blue"], 40],
      [["Orange"], 35],
      [["PA"], 50],
      [["Green"], 45],
    ]);
    for (const v of vs) {
      expect([v.branchId, v.dentistId, v.date]).toEqual(["BR-WEST", "DR-B", daysAgo(2)]);
      expect(lines(v)).toEqual([["CON", 2800, null, "complete", daysAgo(2), null]]);
    }
  });

  it("D03: the PG patient's completed molar root canal under a standing MCAF", () => {
    const v = only("D03");
    expect(v.patient.nric).toBe(visitsOf("D02")[0]!.patient.nric);
    expect([v.branchId, v.dentistId, v.date]).toEqual(["BR-EAST", "DR-A", daysAgo(5)]);
    expect(v.medisave).toMatchObject({ accountHolder: { relationship: "self" }, mcaf: { type: "standing" } });
    expect(lines(v)).toEqual([["RCT-M", 90000, 8100, "complete", daysAgo(5), null]]);
  });

  it("D04a and D04b: the unfinished crown, held at T-18 and completed at T-4, with Meridian's $1,000 limit", () => {
    const [a, b] = [only("D04a"), only("D04b")];
    expect(a.patient.nric).toBe(b.patient.nric);
    expect([tiers(a), age(a), a.date, b.date]).toEqual([["MG"], 70, daysAgo(18), daysAgo(4)]);
    expect(a.policies).toEqual([expect.objectContaining({ payerId: "MERIDIAN", limitCents: 100000 })]);
    expect(a.medisave?.mcaf.type).toBe("standing");
    expect(lines(a)).toEqual([
      ["CON", 2800, 252, "complete", daysAgo(18), null],
      ["XR", 3000, 270, "complete", daysAgo(18), null],
      ["CRN", 0, null, "in_progress", null, null],
    ]);
    expect(lines(b)).toEqual([["CRN", 120000, 10800, "complete", daysAgo(4), null]]);
  });

  it("D05: a crown left in progress beside a claimable consultation", () => {
    const v = only("D05");
    expect([tiers(v), age(v), v.branchId, v.date]).toEqual([["Orange"], 45, "BR-WEST", daysAgo(10)]);
    expect(lines(v)).toEqual([
      ["CON", 2800, null, "complete", daysAgo(10), null],
      ["CRN", 0, null, "in_progress", null, null],
    ]);
  });

  it("D06: a Green patient of 63 with an MCAF and a premolar root canal", () => {
    const v = only("D06");
    expect([tiers(v), age(v), v.medisave?.mcaf.type]).toEqual([["Green"], 63, "standing"]);
    expect(lines(v)).toEqual([["RCT-P", 70000, 6300, "complete", daysAgo(6), null]]);
  });

  it("D07 has a card that expired 34 days before the visit; D07b's expires on the visit date", () => {
    const [expired, lastDay] = [only("D07"), only("D07b")];
    expect([expired.date, expired.chasCards]).toEqual([daysAgo(6), [{ tier: "Orange", expiry: daysAgo(40) }]]);
    expect([lastDay.date, lastDay.chasCards]).toEqual([daysAgo(6), [{ tier: "Orange", expiry: daysAgo(6) }]]);
  });

  it("D08 is one day past the 30-day window and D08b is on its last day", () => {
    expect([only("D08").date, only("D08b").date]).toEqual([daysAgo(31), daysAgo(30)]);
    expect(lines(only("D08"))).toEqual([["SCL", 5000, null, "complete", daysAgo(31), null]]);
  });

  it("D09a and D09b: one patient at both branches on the same day", () => {
    const [am, pm] = [only("D09a"), only("D09b")];
    expect(am.patient.nric).toBe(pm.patient.nric);
    expect([am.branchId, am.date, am.startTime]).toEqual(["BR-EAST", daysAgo(7), "09:30"]);
    expect([pm.branchId, pm.date, pm.startTime]).toEqual(["BR-WEST", daysAgo(7), "16:00"]);
  });

  it("D10-D13: the TOSP cases, with a single-visit MCAF, an MSP code, no MCAF and an unaccredited dentist", () => {
    const [d10, d11, d12, d13] = [only("D10"), only("D11"), only("D12"), only("D13")];
    expect(d10.medisave?.mcaf).toMatchObject({ type: "single_visit", validFrom: d10.date, validTo: d10.date });
    expect(lines(d10)).toEqual([["SURG-WT", 150000, 13500, "complete", daysAgo(8), "38"]]);
    expect(lines(d11)).toEqual([["SURG-WTS", 40000, 3600, "complete", daysAgo(8), null]]);
    expect(d11.medisave).not.toBeNull();
    expect(d12.medisave).toBeNull();
    expect(lines(d12)).toEqual([["PRS", 90000, 8100, "complete", daysAgo(9), null]]);
    expect([d13.branchId, d13.dentistId, d13.medisave?.mcaf.type]).toEqual(["BR-WEST", "DR-C", "standing"]);
    expect(lines(d13)).toEqual([["IMP", 300000, null, "complete", daysAgo(9), null]]);
  });

  it("D14 is 59 on the visit and turns 60 at T+20; D14b turns 60 on the visit date", () => {
    const [d14, d14b] = [only("D14"), only("D14b")];
    expect([age(d14), ageOn(d14.patient.dateOfBirth, addDays(T, 20)), ageOn(d14.patient.dateOfBirth, addDays(T, 19))]).toEqual([59, 60, 59]);
    expect([age(d14b), ageOn(d14b.patient.dateOfBirth, addDays(d14b.date, -1))]).toEqual([60, 59]);
    expect(d14b.medisave?.mcaf.type).toBe("standing");
    for (const v of [d14, d14b]) expect(lines(v)).toEqual([["RCT-A", 50000, null, "complete", daysAgo(4), null]]);
  });

  it("D15: a Blue patient of 70 with an MCAF and only a scaling", () => {
    const v = only("D15");
    expect([tiers(v), age(v), v.medisave?.mcaf.type]).toEqual([["Blue"], 70, "standing"]);
    expect(lines(v)).toEqual([["SCL", 5000, null, "complete", daysAgo(4), null]]);
  });

  it("D16: a Harbour crown prepared at T-19 and fitted at T-5, with no pre-authorisation on record", () => {
    const [prep, fit] = visitsOf("D16");
    expect([prep!.date, fit!.date]).toEqual([daysAgo(19), daysAgo(5)]);
    expect(lines(prep!)).toEqual([["CRN", 0, null, "in_progress", null, null]]);
    expect(lines(fit!)).toEqual([["CRN", 100000, 9000, "complete", daysAgo(5), null]]);
    expect(fit!.policies.map((p) => [p.payerId, p.preAuths])).toEqual([["HARBOUR", []]]);
    expect(clinic.records.preauthorisations).toEqual([]);
  });

  it("D17: a Harbour policy that ended at T-60, still on the patient's file", () => {
    const v = only("D17");
    expect(v.policies.map((p) => [p.payerId, p.validFrom, p.validTo])).toEqual([["HARBOUR", daysAgo(425), daysAgo(60)]]);
    expect(recordsOf(v).policies).toEqual([expect.objectContaining({ payerId: "HARBOUR", validTo: daysAgo(60) })]);
    expect(lines(v)).toEqual([["FIL-S", 8000, null, "complete", daysAgo(5), null]]);
  });

  it("D18 and D18b: above-benchmark consultations whose dentist notes carry the patient's identity", () => {
    const [d18, d18b] = [only("D18"), only("D18b")];
    expect(lines(d18)).toEqual([["CON", 3500, 315, "complete", daysAgo(3), null]]);
    expect(lines(d18b)).toEqual([["CON", 2900, 261, "complete", daysAgo(3), null]]);
    expect(d18.notes).toBe(recordsOf(d18).appointment.dentistNote);
    expect(d18b.notes).toBe(recordsOf(d18b).appointment.dentistNote);
    const note18 = d18.notes ?? "";
    expect(note18).toContain(d18.patient.name);
    expect(note18).toContain(d18.patient.phone);
    expect(note18).not.toContain(d18.patient.nric);
    const note18b = d18b.notes ?? "";
    for (const field of [d18b.patient.name, d18b.patient.nric, d18b.patient.phone]) expect(note18b).toContain(field);
  });

  it("D19: three scalings at West, all in the calendar year of T", () => {
    const vs = visitsOf("D19");
    expect(vs.map((v) => v.date)).toEqual([daysAgo(28), daysAgo(14), daysAgo(2)]);
    for (const v of vs) {
      expect([v.branchId, yearOf(v.date), lines(v)[0]?.[0]]).toEqual(["BR-WEST", yearOf(T), "SCL"]);
    }
  });

  it("D20: a laser line under the new code NEW-99, which the code map leaves out", () => {
    const v = only("D20");
    expect(lines(v)).toEqual([
      ["CON", 2800, 252, "complete", daysAgo(2), null],
      ["NEW-99", 20000, 1800, "complete", daysAgo(2), null],
    ]);
    expect(v.treatments[1]?.description).toBe("Laser gum contouring");
    expect(clinic.codeMap.some((e) => e.clinicCode === "NEW-99")).toBe(false);
  });

  it("D21: a patient of 70 holding an MG card first and a Blue card second", () => {
    const v = only("D21");
    expect([tiers(v), age(v), v.branchId]).toEqual([["MG", "Blue"], 70, "BR-WEST"]);
    expect(recordsOf(v).cards.map((c) => c.tier)).toEqual(["MG", "Blue"]);
  });

  it("D22: GST charged at West, which is not GST-registered", () => {
    expect(lines(only("D22"))).toEqual([["CON", 2800, 252, "complete", daysAgo(2), null]]);
    expect(only("D22").branchId).toBe("BR-WEST");
  });

  it("D23: a visit on 15 Sep 2025, before any CHAS rule set", () => {
    const v = only("D23");
    expect([v.branchId, v.date]).toEqual(["BR-EAST", "2025-09-15"]);
    expect(lines(v)).toEqual([["CON", 2800, 252, "complete", "2025-09-15", null]]);
  });

  it("D24: the PA patient from D02 back for whitening", () => {
    const v = only("D24");
    expect(v.patient.nric).toBe(visitsOf("D02")[4]!.patient.nric);
    expect([tiers(v), v.date]).toEqual([["PA"], daysAgo(1)]);
    expect(lines(v)).toEqual([["WHT", 15000, null, "complete", daysAgo(1), null]]);
  });

  it("D25: a crown prepared at West and fitted at East", () => {
    const [prep, fit] = visitsOf("D25");
    expect([prep!.branchId, prep!.date, fit!.branchId, fit!.date]).toEqual(["BR-WEST", daysAgo(20), "BR-EAST", daysAgo(6)]);
    expect(lines(prep!)).toEqual([["CRN", 0, null, "in_progress", null, null]]);
    expect(lines(fit!)).toEqual([["CRN", 100000, 9000, "complete", daysAgo(6), null]]);
  });

  it("D26: a Blue patient of 65 paying from a spouse's account, the spouse aged 66", () => {
    const v = only("D26");
    expect([tiers(v), age(v)]).toEqual([["Blue"], 65]);
    expect(v.medisave?.accountHolder).toMatchObject({ relationship: "spouse", age: 66 });
    expect(v.medisave?.accountHolder.nric).not.toBe(v.patient.nric);
  });

  it("D27: a molar root canal on tooth 14 under Meridian's $1,000 limit", () => {
    const v = only("D27");
    expect(v.policies).toEqual([expect.objectContaining({ payerId: "MERIDIAN", limitCents: 100000 })]);
    expect(lines(v)).toEqual([["RCT-M", 80000, 7200, "complete", daysAgo(6), "14"]]);
  });

  it("partlyUsedLimit: two earlier Meridian-covered visits in T's year", () => {
    const vs = visitsOf("partlyUsedLimit");
    expect(vs).toHaveLength(2);
    expect(vs[0]!.patient.nric).toBe(vs[1]!.patient.nric);
    for (const v of vs) {
      expect(v.policies).toEqual([expect.objectContaining({ payerId: "MERIDIAN", limitCents: 100000 })]);
      expect(yearOf(v.date)).toBe(yearOf(T));
    }
  });

  it("multiTosp: two wisdom-tooth surgeries in one visit, on teeth 38 and 48", () => {
    expect(lines(only("multiTosp")).map((l) => [l[0], l[5]])).toEqual([
      ["SURG-WT", "38"],
      ["SURG-WT", "48"],
    ]);
  });

  it("reimport: a revision of the same visit with the scaling fee changed", () => {
    const v = only("reimport");
    expect(lines(v)).toEqual([["SCL", 5000, null, "complete", daysAgo(12), null]]);
    const revised = clinic.revisions.find((r) => r.visitKey === v.visitKey);
    expect(revised && lines(revised)).toEqual([["SCL", 5500, null, "complete", daysAgo(12), null]]);
    expect({ ...revised, treatments: [] }).toEqual({ ...v, treatments: [] });
  });
});
