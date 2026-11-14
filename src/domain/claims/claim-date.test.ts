/**
 * A held line completed after its visit is claimed on its completion date (decisions-g2 §3,
 * functional B1 and S2): the window, card validity, tier, same-day rule, rule-set lookups, MCAF
 * validity, policy dates and the insurer's deadline all read the claim date, not the visit date.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateClinic } from "../../../mock/synthetic-clinic/generate";
import { addDays, type IsoDate } from "../dates";
import { type ClinicalVisit, splitVisit } from "../source-visit";
import { type BuildInput, buildVisitClaims, type PatientHistory } from "./build";

const EMPTY_HISTORY: PatientHistory = { visits: [], claims: [] };

const TODAY = "2026-11-13" as IsoDate;
const clinic = generateClinic({ seed: 7, asOf: TODAY });

function clinicalOf(key: string): ClinicalVisit {
  const v = clinic.visits.find((x) => x.visitKey === key);
  if (!v) throw new Error(`no visit ${key}`);
  return splitVisit(v).clinical;
}

function build(visit: ClinicalVisit, over: Partial<BuildInput> = {}) {
  return buildVisitClaims({ visit, settings: clinic.settings, codeMap: clinic.codeMap, history: EMPTY_HISTORY, fixed: [], annotations: {}, today: TODAY, ...over });
}
const splitOf = (out: ReturnType<typeof build>) => Object.fromEntries(out.split.map((s) => [s.payer, s.cents]));
const claimOf = (out: ReturnType<typeof build>, payerId: string) => out.claims.find((c) => c.payerId === payerId)!;
const codesOf = (out: ReturnType<typeof build>, payerId: string) => claimOf(out, payerId).findings.map((f) => f.code);

const PREP = "2026-09-20" as IsoDate;
const FIT = "2026-11-10" as IsoDate;

/** D04b's crown, recorded on a prep visit and completed at a later fit (the re-imported prep visit). */
function prepVisit(date: IsoDate = PREP, completedOn: IsoDate = FIT): ClinicalVisit {
  const d04b = clinicalOf("SC-D04b");
  return { ...d04b, date, treatments: d04b.treatments.map((t) => ({ ...t, completion: "complete", completedOn })) };
}

describe("a held line completed later is claimed on its completion date", () => {
  it("reviewer repro: the prep visit's crown, fitted on 10 Nov, bills as the separate fit visit does", () => {
    const out = build(prepVisit());
    expect(splitOf(out)).toEqual({ CHAS: 62000, MEDISAVE_FLEXI: 40000, MERIDIAN: 28800, patient: 0 });
    const chas = claimOf(out, "CHAS");
    expect(chas.status).toBe("ready");
    expect(chas.claimDate).toBe(FIT);
    expect(chas.deadline).toBe("2026-12-10");
    expect(codesOf(out, "CHAS")).not.toContain("past_submission_window");
  });

  it.each([
    ["2026-10-14", "deadline_approaching"],
    ["2026-10-13", "past_submission_window"],
  ] as const)("the 30-day window runs from the completion date (%s gives %s)", (completedOn, code) => {
    const out = build(prepVisit("2026-08-01" as IsoDate, completedOn as IsoDate));
    expect(claimOf(out, "CHAS").deadline).toBe(addDays(completedOn as IsoDate, 30));
    expect(codesOf(out, "CHAS")).toContain(code);
  });

  it("a card valid at the prep visit but expired by the fit cannot be claimed", () => {
    const visit = prepVisit();
    const out = build({ ...visit, chasCards: [{ tier: "MG", expiry: "2026-10-31" as IsoDate }] });
    expect(codesOf(out, "CHAS")).toContain("card_expired");
    expect(claimOf(out, "CHAS").claimedCents).toBe(0);
  });

  it("the tier is chosen from the cards valid on the claim date", () => {
    const visit = prepVisit();
    const out = build({
      ...visit,
      chasCards: [
        { tier: "PG", expiry: "2026-10-31" as IsoDate },
        { tier: "Blue", expiry: "2027-11-13" as IsoDate },
      ],
    });
    expect(codesOf(out, "CHAS")).not.toContain("tier_chosen_from_several");
    expect(codesOf(out, "CHAS")).not.toContain("card_expired");
  });

  it("Flexi-MediSave's rule set is the one in force on the completion date", () => {
    const out = build(prepVisit("2026-06-20" as IsoDate, "2026-07-10" as IsoDate), { today: "2026-07-15" as IsoDate });
    const flexi = claimOf(out, "MEDISAVE_FLEXI");
    expect(flexi.ruleSetId).toBe("medisave-flexi-2026-07-01");
    expect(flexi.claimDate).toBe("2026-07-10");
  });

  it("the CHAS rule set is the one in force on the completion date", () => {
    const out = build(prepVisit("2025-09-20" as IsoDate, "2025-10-10" as IsoDate), { today: "2025-10-15" as IsoDate });
    expect(claimOf(out, "CHAS").ruleSetId).toBe("chas-2025-10-01");
    expect(codesOf(out, "CHAS")).not.toContain("no_rule_set");
  });

  it("an MCAF that starts after the prep visit covers the fit", () => {
    const visit = prepVisit();
    const out = build({ ...visit, medisave: { ...visit.medisave!, mcaf: { ...visit.medisave!.mcaf!, validFrom: "2026-11-01" as IsoDate } } });
    expect(codesOf(out, "MEDISAVE_FLEXI")).not.toContain("medisave_no_mcaf");
  });

  it("an MCAF revoked between the prep and the fit does not, and the finding names the claim date", () => {
    const visit = prepVisit();
    const out = build({ ...visit, medisave: { ...visit.medisave!, mcaf: { ...visit.medisave!.mcaf!, revokedOn: "2026-10-01" as IsoDate } } });
    expect(claimOf(out, "MEDISAVE_FLEXI").findings).toContainEqual(expect.objectContaining({ code: "medisave_no_mcaf", params: { date: FIT } }));
  });

  it("a policy that starts after the prep visit covers the fit", () => {
    const visit = prepVisit();
    const out = build({ ...visit, policies: visit.policies.map((p) => ({ ...p, validFrom: "2026-11-01" as IsoDate })) });
    expect(codesOf(out, "MERIDIAN")).not.toContain("policy_not_active");
  });

  it("a policy that ended between the prep and the fit is not active on the claim date", () => {
    const visit = prepVisit();
    const out = build({ ...visit, policies: visit.policies.map((p) => ({ ...p, validTo: "2026-10-31" as IsoDate })) });
    expect(claimOf(out, "MERIDIAN").findings).toContainEqual(expect.objectContaining({ code: "policy_not_active", params: { payer: "Meridian Dental Plan", date: FIT } }));
  });

  it("the insurer's deadline runs from the completion date", () => {
    const settings = { ...clinic.settings, payers: clinic.settings.payers.map((p) => (p.id === "MERIDIAN" ? { ...p, deadlineDays: 30 } : p)) };
    const out = build(prepVisit(), { settings });
    expect(claimOf(out, "MERIDIAN").deadline).toBe("2026-12-10");
    expect(codesOf(out, "MERIDIAN")).not.toContain("insurance_deadline_passed");
  });

  it("the same-day rule compares claim dates", () => {
    const earlier = (claimDate: IsoDate | undefined): PatientHistory => ({
      visits: [],
      claims: [{ visitKey: "SC-EARLIER", visitDate: "2026-09-01" as IsoDate, visitStartTime: null, scheme: "chas", status: "submitted", lines: [], ...(claimDate ? { claimDate } : {}) }],
    });
    expect(codesOf(build(prepVisit(), { history: earlier(FIT) }), "CHAS")).toContain("same_day_duplicate");
    const samePrepDate: PatientHistory = {
      visits: [],
      claims: [{ visitKey: "SC-EARLIER", visitDate: PREP, visitStartTime: null, scheme: "chas", status: "submitted", lines: [] }],
    };
    expect(codesOf(build(prepVisit(), { history: samePrepDate }), "CHAS")).not.toContain("same_day_duplicate");
  });

  it("a Public Assistance card expired by the claim date does not make the balance a PA finding", () => {
    const visit = prepVisit();
    const out = build({ ...visit, chasCards: [{ tier: "PA", expiry: "2026-10-31" as IsoDate }], medisave: null });
    expect(out.visitFindings.map((f) => f.code)).not.toContain("pa_patient_balance");
  });
});

const completedVisits = clinic.visits
  .map((v) => splitVisit(v).clinical)
  .filter((v) => !v.voided && v.treatments.length > 0 && v.treatments.every((t) => t.completion === "complete"));

describe("for any completed visit", () => {
  it("building it on its own date is the same as building it as a prep visit completed on that date", () => {
    fc.assert(
      fc.property(fc.constantFrom(...completedVisits), fc.integer({ min: 1, max: 400 }), (visit, k) => {
        const onTheDay: ClinicalVisit = { ...visit, treatments: visit.treatments.map((t) => ({ ...t, completedOn: visit.date })) };
        const prep: ClinicalVisit = { ...onTheDay, date: addDays(visit.date, -k) };
        expect(build(prep)).toEqual(build(onTheDay));
      }),
      { numRuns: 200 },
    );
  });
});
