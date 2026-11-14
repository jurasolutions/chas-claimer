/**
 * SC2.12 and SC2.13: properties of the checks as a whole, over synthetic visits and histories.
 *
 * SC2.12 is ADR 0003: this clinic's count of a patient's earlier claims is only part of the picture,
 * so what it says can only ever warn. The history here is earlier claims on earlier days. A claim
 * on the same day is the one history fact ADR 0003 lets block (`same_day_duplicate`), and a
 * rejection of this visit's own claim is not an earlier claim; both have their own example tests.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateClinic } from "../../../mock/synthetic-clinic/generate";
import { arbCents } from "../../../tests/helpers/arbitraries";
import { addDays, daysBetween, type IsoDate, yearOf } from "../dates";
import { cents } from "../money";
import { ruleSetFor } from "../rules";
import tospData from "../rules/data/medisave-tosp-2024-01-01.json";
import { splitVisit, type ClinicalVisit } from "../source-visit";
import { CLAIM_STATUSES, SCHEMES, type Finding, type Scheme } from "../types";
import { buildVisitClaims, historyWindow, type BuildOutput, type PatientHistory } from "./build";

const TODAY = "2026-11-13" as IsoDate;
const clinic = generateClinic({ seed: 11, asOf: TODAY });
const visits = clinic.visits.map((v) => splitVisit(v).clinical).filter((v) => v.treatments.length > 0 && !v.voided);
const withMedisave = visits.flatMap((v, i) => (v.medisave ? [i] : []));
const withPolicy = visits.flatMap((v, i) => (v.policies.length > 0 ? [i] : []));
const fee = arbCents.map((c) => cents(c % 500_000));

/**
 * A synthetic clinic visit with its fees, the patient's age and the insurers' limits varied. A third
 * have MediSave on file, a third an insurance policy, and half the patients are 60 or over, so
 * Flexi-MediSave and the insurers' yearly limits come up often.
 */
const arbVisit: fc.Arbitrary<ClinicalVisit> = fc
  .record({
    index: fc.oneof(fc.nat({ max: visits.length - 1 }), fc.constantFrom(...withMedisave), fc.constantFrom(...withPolicy)),
    fees: fc.array(fee, { minLength: 12, maxLength: 12 }),
    age: fc.oneof(fc.integer({ min: 0, max: 95 }), fc.integer({ min: 60, max: 95 })),
    limitCents: fc.option(fee, { nil: null }),
  })
  .map(({ index, fees, age, limitCents }) => {
    const base = visits[index]!;
    return {
      ...base,
      ageAtVisit: age,
      treatments: base.treatments.map((t, i) => ({ ...t, feeCents: fees[i % fees.length]! })),
      policies: base.policies.map((p) => ({ ...p, limitCents })),
    };
  });

const payerOf = (scheme: Scheme, insurers: readonly string[]) =>
  scheme === "chas" ? fc.constant("CHAS") : scheme === "medisave_flexi" ? fc.constant("MEDISAVE_FLEXI") : scheme === "medisave_tosp" ? fc.constant("MEDISAVE_TOSP") : fc.constantFrom(...insurers);

/**
 * Any history this clinic could hold for the patient before the visit: earlier claims of every
 * scheme and status on codes the visit uses (so frequency and yearly limits come into play), and
 * earlier visits with treatment left in progress at any branch. Every date is before the visit's day.
 */
const arbHistory = (visit: ClinicalVisit): fc.Arbitrary<PatientHistory> => {
  const from = historyWindow(visit.date).from;
  const days = daysBetween(from, visit.date);
  if (days === 0) return fc.constant({ visits: [], claims: [] });
  // Half the earlier days fall in the visit's own year, where the yearly limits count them.
  const sinceNewYear = Math.min(days, daysBetween(`${yearOf(visit.date)}-01-01` as IsoDate, visit.date));
  const arbEarlier = fc
    .oneof(fc.integer({ min: 1, max: days }), fc.integer({ min: 1, max: Math.max(1, sinceNewYear) }))
    .map((n) => addDays(visit.date, -n));
  const chasCodes = Object.keys(ruleSetFor("chas", visit.date)?.procedures ?? {});
  const tospCodes = Object.keys(tospData.procedures).filter((code) => ruleSetFor("medisave_tosp", visit.date)?.procedure(code));
  const codes = [...chasCodes, ...tospCodes, ...clinic.codeMap.map((e) => e.targetCode)].filter(Boolean);
  const insurers = clinic.settings.payers.filter((p) => p.scheme === "insurance").map((p) => p.id);
  const visitCodes = visit.treatments.map((t) => t.code);

  const arbClaim = fc.constantFrom(...SCHEMES.filter((s) => s !== "insurance" || insurers.length > 0)).chain((scheme) =>
    fc.record({
      visitKey: fc.integer({ min: 1, max: 6 }).map((n) => `SC-EARLIER-${n}`),
      visitDate: arbEarlier,
      visitStartTime: fc.option(fc.constantFrom("09:00", "14:30"), { nil: null }),
      scheme: fc.constant(scheme),
      status: fc.constantFrom(...CLAIM_STATUSES),
      lines: fc.array(fc.record({ schemeCode: fc.option(fc.constantFrom(...codes), { nil: null }), quantity: fc.integer({ min: 1, max: 3 }) }), { maxLength: 4 }),
      payerId: payerOf(scheme, insurers),
      claimedCents: fee,
    }),
  );
  const arbEarlierVisit = fc.record({
    visitKey: fc.integer({ min: 1, max: 6 }).map((n) => `SC-EARLIER-${n}`),
    date: arbEarlier,
    startTime: fc.option(fc.constantFrom("09:00", "14:30"), { nil: null }),
    branchId: fc.constantFrom(...clinic.settings.branches.map((b) => b.id)),
    inProgressCodes: fc.subarray(visitCodes),
  });
  return fc.record({ visits: fc.array(arbEarlierVisit, { maxLength: 4 }), claims: fc.array(arbClaim, { maxLength: 10 }) });
};

const arbCase = arbVisit.chain((visit) => fc.tuple(fc.constant(visit), arbHistory(visit)));

const build = (visit: ClinicalVisit, history: PatientHistory): BuildOutput =>
  buildVisitClaims({ visit, settings: clinic.settings, codeMap: clinic.codeMap, history, fixed: [], annotations: {}, today: TODAY });

/** Every blocking finding of a build, by where it sits: the visit, or the payer's claim. */
const blocking = (out: BuildOutput): string[] => {
  const keep = (fs: readonly Finding[], at: string) => fs.filter((f) => f.severity === "blocking").map((f) => `${at} ${f.code} ${f.lineNo ?? ""}`);
  return [...keep(out.visitFindings, "visit"), ...out.claims.flatMap((c) => keep(c.findings, c.payerId))].sort();
};

describe("the checks, for any visit and any earlier history (SC2.12, ADR 0003)", () => {
  it("never add or remove a blocking finding because of this clinic's earlier claims", () => {
    fc.assert(
      fc.property(arbCase, ([visit, history]) => {
        expect(blocking(build(visit, history))).toEqual(blocking(build(visit, { visits: [], claims: [] })));
      }),
      { numRuns: 300 },
    );
  });
});

describe("the checks, run twice (SC2.13)", () => {
  it("give the same findings in the same order for the same visit, rule set and clock", () => {
    fc.assert(
      fc.property(arbCase, ([visit, history]) => {
        const first = build(visit, history);
        const again = build(structuredClone(visit), structuredClone(history));
        const findings = (out: BuildOutput) => [out.visitFindings, out.visitNotes, out.claims.map((c) => [c.payerId, c.findings, c.status])];
        expect(findings(again)).toEqual(findings(first));
      }),
      { numRuns: 200 },
    );
  });
});
