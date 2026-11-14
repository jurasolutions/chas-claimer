import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateClinic } from "../../../mock/synthetic-clinic/generate";
import { arbCents } from "../../../tests/helpers/arbitraries";
import { type IsoDate, yearOf } from "../dates";
import { cents } from "../money";
import { ruleSetFor } from "../rules";
import { splitVisit } from "../source-visit";
import { buildVisitClaims, type PatientHistory } from "./build";
import { considered } from "./plan";

const TODAY = "2026-11-13" as IsoDate;
const clinic = generateClinic({ seed: 7, asOf: TODAY });
const visits = clinic.visits.map((v) => splitVisit(v).clinical).filter((v) => v.treatments.length > 0);
const fee = arbCents.map((c) => cents(c % 500_000));
const withMedisave = visits.flatMap((v, i) => (v.medisave ? [i] : []));
// Half the cases come from visits with MediSave on file, so Flexi-MediSave and TOSP claims come up often.
const arbVisitIndex = fc.oneof(fc.nat({ max: visits.length - 1 }), fc.constantFrom(...withMedisave));

const arbCase = fc
  .record({
    visitIndex: arbVisitIndex,
    fees: fc.array(fc.record({ feeCents: fee, gstCents: fc.option(fee.map((c) => cents(c % 50_000)), { nil: null }) }), { minLength: 12, maxLength: 12 }),
    age: fc.oneof(fc.integer({ min: 0, max: 95 }), fc.integer({ min: 60, max: 95 })),
    limitCents: fc.option(fee, { nil: null }),
    usedInsurance: fc.option(fee, { nil: null }),
    usedFlexi: fc.option(fee.map((c) => cents(c % 60_000)), { nil: null }),
    fixedChas: fc.option(fee, { nil: null }),
  })
  .map((c) => {
    const base = visits[c.visitIndex]!;
    const visit = {
      ...base,
      ageAtVisit: c.age,
      treatments: base.treatments.map((t, i) => ({ ...t, ...c.fees[i % c.fees.length]! })),
      policies: base.policies.map((p) => ({ ...p, limitCents: c.limitCents })),
    };
    const earlier = `${yearOf(visit.date)}-01-01` as IsoDate;
    const history: PatientHistory = { visits: [], claims: [] };
    if (earlier < visit.date) {
      for (const p of visit.policies) {
        if (c.usedInsurance !== null) {
          history.claims.push({ visitKey: "SC-EARLIER", visitDate: earlier, visitStartTime: null, scheme: "insurance", status: "paid", lines: [], payerId: p.payerId, claimedCents: c.usedInsurance });
        }
      }
      if (c.usedFlexi !== null) {
        history.claims.push({ visitKey: "SC-EARLIER", visitDate: earlier, visitStartTime: null, scheme: "medisave_flexi", status: "paid", lines: [], payerId: "MEDISAVE_FLEXI", claimedCents: c.usedFlexi });
      }
    }
    const fixed = c.fixedChas === null ? [] : [{ payerId: "CHAS", scheme: "chas" as const, claimedCents: c.fixedChas }];
    return { visit, history, fixed };
  });

const usedBy = (history: PatientHistory, payerId: string, year: number) =>
  history.claims.filter((h) => h.payerId === payerId && yearOf(h.claimDate ?? h.visitDate) === year).reduce((s, h) => s + (h.claimedCents ?? 0), 0);

describe("the payer waterfall, for any fees, limits and history", () => {
  it("splits the whole fee, never below zero, never paying a line twice, never past a cap, and warns past an insurer's limit", () => {
    fc.assert(
      fc.property(arbCase, ({ visit, history, fixed }) => {
        const out = buildVisitClaims({ visit, settings: clinic.settings, codeMap: clinic.codeMap, history, fixed, annotations: {}, today: TODAY });
        if (out.visitNotes.some((n) => n.code === "voided_in_clinic")) return;

        const total = visit.treatments.reduce((s, t) => s + considered(t), 0);
        expect(out.split.reduce((s, seg) => s + seg.cents, 0)).toBe(total);
        for (const seg of out.split) expect(seg.cents).toBeGreaterThanOrEqual(0);

        const paidPerTreatment = visit.treatments.map(() => 0);
        for (const claim of out.claims) {
          expect(claim.claimedCents).toBe(claim.lines.reduce((s, l) => s + l.claimedCents, 0));
          for (const line of claim.lines) {
            expect(line.claimedCents).toBeGreaterThanOrEqual(0);
            expect(line.claimedCents).toBeLessThanOrEqual(line.consideredCents);
            paidPerTreatment[line.treatmentRef]! += line.claimedCents;
          }
          const year = yearOf(claim.claimDate);
          if (claim.scheme === "insurance") {
            const payer = clinic.settings.payers.find((p) => p.id === claim.payerId)!;
            const limit = visit.policies.find((p) => p.payerId === claim.payerId)?.limitCents ?? payer.annualLimitCents;
            // Billed in full past the limit, with a warning: this clinic's count can't see other clinics' claims (decisions-g2 #8).
            if (limit !== null && claim.claimedCents > Math.max(0, limit - usedBy(history, claim.payerId, year))) {
              expect(claim.findings.map((f) => f.code)).toContain("insurance_annual_limit_exceeded");
            }
          }
          if (claim.scheme === "medisave_flexi") {
            const cap = ruleSetFor("medisave_flexi", claim.claimDate)!.yearlyCapCents;
            expect(claim.claimedCents).toBeLessThanOrEqual(Math.max(0, cap - usedBy(history, "MEDISAVE_FLEXI", year)));
          }
        }
        visit.treatments.forEach((t, i) => expect(paidPerTreatment[i]).toBeLessThanOrEqual(considered(t)));
      }),
      { numRuns: 300 },
    );
  });
});

const LEVELS = ["chas", "medisave", "insurance"] as const;
const arbResend = fc.record({
  base: arbCase,
  waterfall: fc.shuffledSubarray([...LEVELS], { minLength: LEVELS.length, maxLength: LEVELS.length }),
  sent: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
  // Now and then a sent claim was paid more than the rules give, so the sent claims can pass the fee.
  over: fc.option(fee, { nil: null, freq: 4 }),
});

describe("claims already sent, after the waterfall is reordered (QA 03 D01)", () => {
  it("keeps every sent amount, never claims past the fee, and blocks when the sent claims already do", () => {
    fc.assert(
      fc.property(arbResend, ({ base: { visit, history }, waterfall, sent, over }) => {
        const common = { visit, codeMap: clinic.codeMap, history, annotations: {}, today: TODAY };
        const first = buildVisitClaims({ ...common, settings: clinic.settings, fixed: [] });
        if (first.visitNotes.some((n) => n.code === "voided_in_clinic")) return;
        const fixed = first.claims
          .filter((_, i) => sent[i % sent.length])
          .map((c, i) => ({ payerId: c.payerId, scheme: c.scheme, claimedCents: i === 0 && over !== null ? cents(c.claimedCents + over) : c.claimedCents }));

        const out = buildVisitClaims({ ...common, settings: { ...clinic.settings, waterfall: [...waterfall] }, fixed });
        const total = visit.treatments.reduce((s, t) => s + considered(t), 0);
        const sentTotal = fixed.reduce((s, f) => s + f.claimedCents, 0);
        expect(out.split.reduce((s, seg) => s + seg.cents, 0)).toBe(total);
        for (const seg of out.split) expect(seg.cents).toBeGreaterThanOrEqual(0);
        for (const f of fixed) expect(out.claims.some((c) => c.payerId === f.payerId)).toBe(false);

        const overFee = out.visitFindings.filter((f) => f.code === "sent_claims_exceed_fee");
        const onClaims = out.claims.map((c) => c.findings.filter((f) => f.code === "sent_claims_exceed_fee"));
        if (sentTotal <= total) {
          expect(overFee).toEqual([]);
          expect(onClaims.flat()).toEqual([]);
          for (const f of fixed) expect(out.split.find((seg) => seg.payer === f.payerId)?.cents).toBe(f.claimedCents);
          expect(out.claims.reduce((s, c) => s + c.claimedCents, 0) + sentTotal).toBeLessThanOrEqual(total);
        } else {
          expect(overFee).toEqual([expect.objectContaining({ severity: "blocking", params: { sentCents: sentTotal, feeCents: total } })]);
          // Every claim still to send is held until the sent ones are amended (QA 03 B1).
          for (const [i, c] of out.claims.entries()) {
            expect(c.status).toBe("needs_attention");
            expect(onClaims[i]).toEqual([expect.objectContaining({ severity: "blocking", params: { sentCents: sentTotal, feeCents: total } })]);
          }
          for (const c of first.claims) {
            if (!fixed.some((f) => f.payerId === c.payerId)) expect(out.claims.some((u) => u.payerId === c.payerId), c.payerId).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
