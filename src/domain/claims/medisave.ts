/**
 * The MediSave plans: a TOSP claim for the visit's surgical procedures and a Flexi-MediSave claim
 * for crowns and root canal treatment at 60 and over. Both need a MediSave-registered branch, an
 * accredited dentist and a valid MCAF; the waterfall in `build.ts` turns the plans into amounts.
 */
import type { IsoDate } from "../dates";
import { type Cents, cents } from "../money";
import { ruleSetFor } from "../rules";
import type { ClinicalVisit } from "../source-visit";
import type { Finding, PayerId, VisitNote } from "../types";
import type { BuildInput } from "./build";
import { finding } from "./findings";
import { chasCodeOf, claimDateOf, claimYear, type Plan, type PlanLine, targetCodeOf, usedThisYear } from "./plan";

/** Whether the MCAF on file covers the claim date and has not been revoked by then. */
function mcafValid(visit: ClinicalVisit, date: IsoDate): boolean {
  const mcaf = visit.medisave?.mcaf;
  if (!mcaf) return false;
  if (mcaf.validFrom > date) return false;
  if (mcaf.validTo !== null && mcaf.validTo < date) return false;
  return mcaf.revokedOn === null || mcaf.revokedOn > date;
}

/** What every MediSave claim needs, whichever scheme: a registered branch, an accredited dentist, an MCAF valid on the claim date. */
function medisaveChecks(input: BuildInput, claimDate: IsoDate): Finding[] {
  const { visit, settings } = input;
  const findings: Finding[] = [];
  const branch = settings.branches.find((b) => b.id === visit.branchId);
  if (branch && !branch.medisaveRegistered) findings.push(finding("branch_not_medisave_registered"));
  const dentist = settings.dentists.find((d) => d.id === visit.dentistId);
  if (dentist && !dentist.medisaveAccredited) findings.push(finding("dentist_not_medisave_accredited"));
  if (!mcafValid(visit, claimDate)) findings.push(finding("medisave_no_mcaf", { date: claimDate }));
  return findings;
}

/** The visit's completed treatments the code map sends to TOSP. */
export function tospLines(input: BuildInput): { t: ClinicalVisit["treatments"][number]; treatmentRef: number; tospCode: string }[] {
  const out: { t: ClinicalVisit["treatments"][number]; treatmentRef: number; tospCode: string }[] = [];
  input.visit.treatments.forEach((t, treatmentRef) => {
    if (t.completion === "in_progress") return;
    const tospCode = targetCodeOf(input, t.code, "tosp");
    if (tospCode) out.push({ t, treatmentRef, tospCode });
  });
  return out;
}

/**
 * MediSave pays each surgical procedure up to its table's limit, and a claim with several up to the
 * highest of them (decisions-g2 #7). A minor surgical procedure is never paid; a code the rule set
 * doesn't know, or whose table isn't confirmed, pays nothing until the code map is fixed.
 */
export function planTosp(input: BuildInput, payerId: PayerId): Plan | null {
  const { visit } = input;
  const candidates = tospLines(input);
  if (candidates.length === 0) return null;
  const claimDate = claimDateOf(
    visit,
    candidates.map((c) => c.t),
  );
  const ruleSet = ruleSetFor("medisave_tosp", claimDate);
  const findings: Finding[] = [];
  if (!ruleSet) findings.push(finding("no_rule_set", { scheme: "medisave_tosp", date: claimDate }));
  findings.push(...medisaveChecks(input, claimDate));

  const limits: Cents[] = [];
  const perSystem = new Map<string, number>();
  const lines: PlanLine[] = candidates.map(({ t, treatmentRef, tospCode }, i) => {
    const lineNo = i + 1;
    const procedure = ruleSet?.procedure(tospCode) ?? null;
    let limit = cents(0);
    if (ruleSet) {
      if (procedure?.table === "MSP") findings.push(finding("tosp_msp_ranked", { tospCode }, { lineNo }));
      else if (!procedure || procedure.limitCents === null) findings.push(finding("tosp_not_in_rule_set", { tospCode }, { lineNo }));
      else limit = procedure.limitCents;
    }
    const system = procedure?.system ?? tospCode.slice(0, 2);
    perSystem.set(system, (perSystem.get(system) ?? 0) + 1);
    limits.push(limit);
    return { t, treatmentRef, schemeCode: tospCode, entitled: (remaining: Cents) => (limit < remaining ? limit : remaining) };
  });

  const capCents = cents(Math.max(0, ...limits));
  if (ruleSet) {
    if (lines.length > ruleSet.maxProcedures) {
      findings.push(finding("tosp_too_many_procedures", { max: ruleSet.maxProcedures, count: lines.length }));
    }
    if (perSystem.size > ruleSet.maxSystems) findings.push(finding("tosp_too_many_systems", { max: ruleSet.maxSystems, count: perSystem.size }));
    for (const [system, count] of perSystem) {
      if (count > ruleSet.maxPerSystem) findings.push(finding("tosp_too_many_in_system", { max: ruleSet.maxPerSystem, count, system }));
    }
    if (lines.length > 1) findings.push(finding("tosp_multiple_codes", { count: lines.length, capCents }));
  }

  return { payerId, scheme: "medisave_tosp", ruleSetId: ruleSet?.id ?? null, lines, capCents, findings, deadline: null, claimDate, keepAtZero: false };
}

/** The age Flexi-MediSave checks: the patient's, or the account holder's when that is lower (spec F3). */
function flexiAge(visit: ClinicalVisit): number {
  const holder = visit.medisave?.accountHolder.ageAtVisit;
  return holder === undefined ? visit.ageAtVisit : Math.min(visit.ageAtVisit, holder);
}

/**
 * Flexi-MediSave pays the rest of a covered treatment's fee, up to the yearly cap less what earlier
 * claims this year used. The portal holds the true balance, so the claim always says to check it.
 * A visit Flexi-MediSave can't pay gets a note saying why, not a claim.
 */
export function planFlexi(input: BuildInput, payerId: PayerId, hasTosp: boolean): { plan: Plan | null; notes: VisitNote[] } {
  const { visit } = input;
  // The claim date is the latest completion among the lines Flexi-MediSave could pay: the completed
  // ones with a CHAS procedure. Which of those it covers is the rule set's call, so the date comes first.
  const claimDate = claimDateOf(
    visit,
    visit.treatments.filter((t) => t.completion !== "in_progress" && chasCodeOf(input, t.code) !== null),
  );
  const ruleSet = ruleSetFor("medisave_flexi", claimDate);
  if (!ruleSet) {
    // Said only for a visit with MediSave details and no TOSP claim, the same visits the other
    // Flexi-MediSave notes speak to; anything else was never going to be a Flexi claim.
    const notes: VisitNote[] = visit.medisave && !hasTosp ? [{ code: "flexi_no_rule_set", params: { date: claimDate } }] : [];
    return { plan: null, notes };
  }

  const coveredCode = (code: string) => {
    const chas = chasCodeOf(input, code);
    return chas !== null && ruleSet.covers(chas);
  };
  const covered = visit.treatments
    .map((t, treatmentRef) => ({ t, treatmentRef }))
    .filter(({ t }) => t.completion !== "in_progress" && coveredCode(t.code));
  const age = flexiAge(visit);

  if (covered.length === 0) {
    const anyCovered = visit.treatments.some((t) => coveredCode(t.code));
    const notes: VisitNote[] =
      visit.medisave && !anyCovered && !hasTosp ? [{ code: "flexi_treatment_not_covered", params: {}, ruleRef: ruleSet.id }] : [];
    return { plan: null, notes };
  }
  if (age < ruleSet.minAge) {
    return { plan: null, notes: [{ code: "flexi_patient_under_60", params: { age, minAge: ruleSet.minAge }, ruleRef: ruleSet.id }] };
  }

  const lines: PlanLine[] = covered.map(({ t, treatmentRef }) => ({
    t,
    treatmentRef,
    schemeCode: chasCodeOf(input, t.code)!,
    entitled: (remaining: Cents) => remaining,
  }));
  const used = usedThisYear(input, (c) => c.scheme === "medisave_flexi", claimYear({ claimDate, visitDate: visit.date }));
  const capCents = cents(Math.max(0, ruleSet.yearlyCapCents - used));

  const findings: Finding[] = [...medisaveChecks(input, claimDate), finding("flexi_yearly_amount_exceeded", { capCents: ruleSet.yearlyCapCents })];
  return {
    plan: { payerId, scheme: "medisave_flexi", ruleSetId: ruleSet.id, lines, capCents, findings, deadline: null, claimDate, keepAtZero: false },
    notes: [],
  };
}
