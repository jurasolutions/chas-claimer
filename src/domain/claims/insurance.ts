/**
 * The insurance plans: one per policy on the visit whose insurer the clinic is on the panel of.
 * An insurer is billed what is left of each mapped benefit after the payers above it, less the
 * co-pay. A claim that takes this clinic's claims on the policy this year past its yearly limit is
 * still billed in full, with a warning: only the insurer sees every clinic's claims (decisions-g2 #8).
 */
import { addDays, daysBetween, type IsoDate } from "../dates";
import { type Cents, cents } from "../money";
import type { ClinicalPolicy } from "../source-visit";
import type { Finding, VisitNote } from "../types";
import type { BuildInput } from "./build";
import { finding } from "./findings";
import { claimDateOf, claimYear, type Plan, type PlanLine, targetCodeOf, usedThisYear } from "./plan";

function policyActive(policy: ClinicalPolicy, date: IsoDate): boolean {
  if (policy.validFrom !== null && policy.validFrom > date) return false;
  return policy.validTo === null || policy.validTo >= date;
}

export function planInsurance(input: BuildInput, policy: ClinicalPolicy): { plan: Plan | null; notes: VisitNote[] } {
  const { visit, settings, today } = input;
  const payer = settings.payers.find((p) => p.id === policy.payerId && p.scheme === "insurance");
  if (!payer) return { plan: null, notes: [] };
  if (!payer.panel) return { plan: null, notes: [{ code: "insurer_not_on_panel", params: { payer: payer.name } }] };

  const findings: Finding[] = [];
  // A reference the officer recorded on the claim covers it, as it does in the packet (QA 02 N7).
  const annotatedPreAuth = (input.annotations[payer.id]?.preAuthReference?.trim() ?? "") !== "";
  const share = 100 - (payer.copayPercent ?? 0);
  const lines: PlanLine[] = [];
  visit.treatments.forEach((t, treatmentRef) => {
    if (t.completion === "in_progress") return;
    const benefitCode = targetCodeOf(input, t.code, "benefit", payer.id);
    if (!benefitCode) return;
    if (!annotatedPreAuth && payer.preAuthBenefitCodes.includes(benefitCode) && !policy.preAuths.some((a) => a.benefitCode === benefitCode)) {
      findings.push(finding("pre_auth_missing", { payer: payer.name, benefitCode }, { lineNo: lines.length + 1 }));
    }
    lines.push({ t, treatmentRef, schemeCode: benefitCode, entitled: (remaining: Cents) => cents(Math.floor((remaining * share) / 100)) });
  });
  if (lines.length === 0) return { plan: null, notes: [] };

  // Everything below is judged on the claim date: the latest completion among the claimed lines.
  const claimDate = claimDateOf(
    visit,
    lines.map((l) => l.t),
  );
  if (!policyActive(policy, claimDate)) findings.push(finding("policy_not_active", { payer: payer.name, date: claimDate }));

  let deadline: IsoDate | null = null;
  if (payer.deadlineDays !== null) {
    deadline = addDays(claimDate, payer.deadlineDays);
    if (daysBetween(today, deadline) < 0) findings.push(finding("insurance_deadline_passed", { payer: payer.name }));
  }

  const limit = policy.limitCents ?? payer.annualLimitCents;
  let softLimit: Plan["softLimit"];
  if (limit !== null) {
    const used = usedThisYear(input, (c) => c.payerId === payer.id, claimYear({ claimDate, visitDate: visit.date }));
    softLimit = { leftCents: cents(Math.max(0, limit - used)), finding: finding("insurance_annual_limit_exceeded", { limitCents: limit }) };
  }

  return {
    plan: { payerId: payer.id, scheme: "insurance", ruleSetId: null, lines, capCents: null, softLimit, findings, deadline, claimDate, keepAtZero: false },
    notes: [],
  };
}

