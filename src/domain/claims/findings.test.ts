import { describe, expect, it } from "vitest";
import { FINDING_CODES, VISIT_NOTE_CODES, type Finding, type FindingCode, type VisitNoteCode } from "../types";
import { describeFinding, describeVisitNote, finding, severityOf } from "./findings";

const f = (code: FindingCode, params: Finding["params"] = {}): Finding => ({ code, severity: severityOf(code), params });

/** The fallback for a code the catalogue does not describe: the code in words, one sentence. */
const humanised = (code: string) => {
  const words = code.replace(/_/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
};

describe("finding catalogue", () => {
  it.each<[FindingCode, Finding["params"], string]>([
    ["no_rule_set", { scheme: "chas", date: "2025-09-15" }, "No CHAS rule set covers 15 Sep 2025. Check the visit date in the clinic system, then re-import."],
    ["chas_green_no_dental", {}, "CHAS Green has no dental subsidy. Withdraw this claim; the visit's other claims go ahead."],
    ["benchmark_exceeded", { minCents: 2100, maxCents: 3100 }, "Fee is above the MOH benchmark ($21.00–$31.00). Add a clinical justification."],
    [
      "benchmark_exceeded",
      { minCents: 2100, maxCents: 3100, sourceUrl: "https://example.test/benchmarks", asOf: "2026-11-01" },
      "Fee is above the benchmark set in settings ($21.00–$31.00, from https://example.test/benchmarks as of 2026-11-01). Add a clinical justification.",
    ],
    ["frequency_over_limit", { group: "SCALING", count: 2, periodYears: 1 }, "May exceed 2 scalings per calendar year. Check the balance in the portal."],
    ["frequency_over_limit", { group: "COMPLETE_DENTURE", count: 2, periodYears: 3 }, "May exceed 2 complete dentures every 3 calendar years. Check the balance in the portal."],
    ["deadline_approaching", { daysLeft: 0 }, "Last day to submit. Approve and submit it today."],
    ["deadline_approaching", { daysLeft: 3 }, "Last 4 days to submit. Approve and submit it soon."],
    [
      "past_submission_window",
      { windowDays: 30, deadline: "2026-10-13" },
      "Past the 30-day window. The last day to submit was 13 Oct 2026. Withdraw this claim; the visit's other claims go ahead.",
    ],
    ["unmapped_treatment", { clinicCode: "NEW-99" }, "Treatment code NEW-99 isn't in the code map. Map it in settings, or mark it not claimable."],
    [
      "gst_not_registered",
      {},
      "GST charged at a branch that isn't GST-registered. Correct the bill in the clinic system, or the branch's GST setting, then re-import.",
    ],
    ["card_expired", { expiry: "2026-10-04" }, "The CHAS card expired on 4 Oct 2026, before the visit. Ask the patient for their new card, then re-import."],
    [
      "branch_not_chas_registered",
      {},
      "This branch isn't registered for CHAS. Mark it registered in settings if it is, or withdraw this claim.",
    ],
    [
      "dentist_not_medisave_accredited",
      {},
      "The dentist isn't MediSave-accredited. Mark them accredited in settings if they are, or withdraw this claim.",
    ],
    [
      "medisave_no_mcaf",
      { date: "2026-11-03" },
      "No MediSave authorisation (MCAF) is valid on 3 Nov 2026. Have the account holder sign one, then re-import.",
    ],
    [
      "tosp_msp_ranked",
      { tospCode: "SF811T" },
      "SF811T is a minor surgical procedure, which MediSave doesn't pay. Withdraw this claim; the patient pays this part.",
    ],
    [
      "tosp_too_many_in_system",
      { max: 2, count: 3, system: "SF" },
      "MediSave pays at most 2 surgical procedures in one body system a claim, and this visit has 3 in system SF. Check the codes in the clinic system.",
    ],
    [
      "tosp_multiple_codes",
      { count: 2, capCents: 112000 },
      "2 surgical procedures on one claim. MediSave pays up to the highest table's limit, $1,120.00. Check the amount in the portal.",
    ],
    [
      "flexi_yearly_amount_exceeded",
      { capCents: 40000 },
      "Check the patient's yearly Flexi-MediSave balance in the portal. Flexi-MediSave pays up to $400.00 a year.",
    ],
    [
      "pre_auth_missing",
      { payer: "Harbour TPA", benefitCode: "H-CRN" },
      "Harbour TPA needs pre-authorisation for H-CRN, and none is recorded. Get the approval, then add its reference to this claim, or record it in the clinic system and re-import.",
    ],
    [
      "policy_not_active",
      { payer: "Harbour TPA", date: "2026-10-01" },
      "The Harbour TPA policy wasn't active on 1 Oct 2026. Check the patient's cover, then re-import or withdraw this claim.",
    ],
    ["waiting_on_upper_payer", { scheme: "chas" }, "Waiting on the CHAS claim; amounts may change. Fix the CHAS claim first."],
    [
      "upstream_rejected",
      { scheme: "chas" },
      "CHAS rejected this visit's claim. The MediSave and insurance amounts were based on it. Check them before submitting.",
    ],
    [
      "lower_payer_sent_first",
      { scheme: "medisave_flexi" },
      "The Flexi-MediSave claim comes after this one in the payer waterfall, but it was sent first, so this claim covers only what it left. Check the amounts before you send it.",
    ],
    [
      "sent_claims_exceed_fee",
      { sentCents: 142000, feeCents: 130800 },
      "The claims already sent add up to $1,420.00, more than the visit's fee of $1,308.00. Compare them with the portal, and amend them there.",
    ],
    [
      "billed_amount_differs",
      { payer: "CHAS", billedCents: 2000, claimedCents: 2050 },
      "Billed CHAS $20.00, rules give $20.50. Check the bill in the clinic system.",
    ],
    [
      "pa_patient_balance",
      { balanceCents: 15000 },
      "Check this fee isn't for a CHAS-covered procedure. A Public Assistance patient pays nothing for those, and this visit leaves $150.00.",
    ],
  ])("describes %s in plain words", (code, params, text) => {
    expect(describeFinding(f(code, params))).toBe(text);
  });

  it.each(FINDING_CODES.map((c) => [c]))("describes %s with the problem and what to do about it", (code) => {
    const text = describeFinding(f(code, {}));
    expect(text).not.toBe(humanised(code));
    expect(text).not.toContain("_");
    expect(text).not.toContain("undefined");
    // At least two sentences: what's wrong, then what to do.
    expect(text.split(/(?<=[.;])\s+/).length).toBeGreaterThanOrEqual(2);
  });

  it.each(FINDING_CODES.map((c) => [c]))("states no figure for %s that its params don't carry", (code) => {
    // A figure comes from the rule set or the visit, never from a default in the catalogue.
    expect(describeFinding(f(code, {}))).not.toMatch(/\d/);
  });

  it.each<[FindingCode, string]>([
    ["past_submission_window", "Past the submission window. Withdraw this claim; the visit's other claims go ahead."],
    ["tosp_too_many_procedures", "MediSave limits how many surgical procedures it pays on one claim, and this visit has more. Check the codes in the clinic system."],
    [
      "tosp_too_many_in_system",
      "MediSave limits how many surgical procedures it pays in one body system on one claim, and this visit has more. Check the codes in the clinic system.",
    ],
    ["flexi_yearly_amount_exceeded", "Check the patient's yearly Flexi-MediSave balance in the portal. Flexi-MediSave pays up to a yearly limit."],
  ])("describes %s in words when its figures are missing", (code, text) => {
    expect(describeFinding(f(code, {}))).toBe(text);
  });

  it("marks the claim-stopping codes blocking and the rest warnings", () => {
    const blocking: FindingCode[] = [
      "same_day_duplicate",
      "benchmark_exceeded",
      "branch_not_medisave_registered",
      "dentist_not_medisave_accredited",
      "medisave_no_mcaf",
      "tosp_not_in_rule_set",
      "tosp_msp_ranked",
      "tosp_too_many_procedures",
      "tosp_too_many_systems",
      "tosp_too_many_in_system",
      "pre_auth_missing",
      "policy_not_active",
      "waiting_on_upper_payer",
      "sent_claims_exceed_fee",
    ];
    const warnings: FindingCode[] = [
      "frequency_over_limit",
      "benchmark_not_set",
      "tier_chosen_from_several",
      "tosp_multiple_codes",
      "flexi_yearly_amount_exceeded",
      "insurance_annual_limit_exceeded",
      "upstream_rejected",
      "lower_payer_sent_first",
      "billed_amount_differs",
      "pa_patient_balance",
      "started_at_other_branch",
      "deadline_approaching",
    ];
    for (const c of blocking) expect(severityOf(c), c).toBe("blocking");
    for (const c of warnings) expect(severityOf(c), c).toBe("warning");
  });

  it("builds a finding with the catalogue's severity", () => {
    expect(finding("past_submission_window", { windowDays: 30, deadline: "2026-10-13" }, { lineNo: 2, ruleRef: "chas-2025-10-01" })).toEqual({
      code: "past_submission_window",
      severity: "blocking",
      params: { windowDays: 30, deadline: "2026-10-13" },
      lineNo: 2,
      ruleRef: "chas-2025-10-01",
    });
  });
});

describe("visit notes", () => {
  it.each<[VisitNoteCode, Record<string, string | number>, string]>([
    ["held_until_complete", { clinicCode: "CRN" }, "Treatment CRN is held until it's complete. It's claimed on the visit that completes it."],
    ["flexi_patient_under_60", { age: 59, minAge: 60 }, "No Flexi-MediSave claim: the patient is 59, and Flexi-MediSave starts at 60."],
    ["flexi_treatment_not_covered", {}, "No Flexi-MediSave claim: none of this visit's treatments is on its list of covered procedures."],
    [
      "flexi_no_rule_set",
      { date: "2026-06-15" },
      "No Flexi-MediSave claim: no Flexi-MediSave rule set covers 15 Jun 2026. Check the visit date in the clinic system, then re-import.",
    ],
    [
      "insurer_not_on_panel",
      { payer: "Acme Life" },
      "No claim to Acme Life: the clinic isn't on its panel, so the patient claims it back themselves.",
    ],
  ])("describes %s", (code, params, text) => {
    expect(describeVisitNote({ code, params })).toBe(text);
  });

  it.each(VISIT_NOTE_CODES.map((c) => [c]))("describes %s in words, never as a code", (code) => {
    const text = describeVisitNote({ code, params: {} });
    expect(text).not.toBe(humanised(code));
    expect(text).not.toContain("_");
    expect(text).not.toContain("undefined");
  });

  it.each(VISIT_NOTE_CODES.map((c) => [c]))("states no figure for %s that its params don't carry", (code) => {
    expect(describeVisitNote({ code, params: {} })).not.toMatch(/\d/);
  });
});
