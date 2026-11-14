/**
 * The finding catalogue: each code's severity and the sentence a person reads. Every message says
 * what is wrong, then what the officer does about it. Params carry only the values a message
 * needs, never identity; a missing param falls back to plain words, never "undefined" and never a
 * figure: every figure comes from the rule set, settings or the visit (the numbers rule).
 */
import { cents, formatSgd } from "../money";
import { type Finding, type FindingCode, SCHEME_NAMES, type Severity, type VisitNote, type VisitNoteCode } from "../types";

type Params = Finding["params"];
type Param = string | number | undefined;

interface CatalogueEntry {
  severity: Severity;
  message: (p: Params) => string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2025-09-15" -> "15 Sep 2025". Fixed month names, so the text does not drift with the runtime's locale data. */
export function formatDay(date: string): string {
  const [y, m, d] = date.split("-");
  const month = MONTHS[Number(m) - 1];
  if (!y || !month || !d) return date;
  return `${Number(d)} ${month} ${y}`;
}

/**
 * Scheme names inside a sentence: the desk's names, except surgical MediSave goes by plain
 * "MediSave" and insurance takes a lower-case i mid-sentence. Keyed by string, since a finding's
 * scheme param arrives as one.
 */
const SCHEME_IN_TEXT: Readonly<Record<string, string>> = {
  ...SCHEME_NAMES,
  medisave_tosp: "MediSave",
  insurance: "insurance",
};

/** Limit groups in the plural, as a person counts them. */
const LIMIT_NOUNS: Record<string, string> = {
  CONSULTATION: "consultations",
  POLISHING: "polishings",
  SCALING: "scalings",
  TOPICAL_FLUORIDE: "fluoride applications",
  XRAY: "X-rays",
  EXTRACTION: "extractions",
  FILLING: "fillings",
  RECEMENTATION: "recementations",
  DENTURE_RELINE_REPAIR: "denture relines or repairs",
  CROWN_PERMANENT: "crowns",
  COMPLETE_DENTURE: "complete dentures",
  PARTIAL_DENTURE: "partial dentures",
  RCT: "root canal treatments",
};

const str = (v: Param, fallback = ""): string => (v === undefined ? fallback : String(v));
const num = (v: Param): number => (typeof v === "number" ? v : Number(v ?? 0));
const sgd = (v: Param): string => formatSgd(cents(num(v)));
/** " on 3 Nov 2026", or nothing when the date is not known. */
const onDay = (v: Param): string => (v === undefined ? "" : ` on ${formatDay(str(v))}`);
const schemeName = (v: Param): string => SCHEME_IN_TEXT[str(v)] ?? "CHAS";
/** An amount after `lead` (", $1,120.00"), or nothing when the amount is not known. */
const moneyOr = (v: Param, lead: string): string => (v === undefined ? "" : `${lead}${sgd(v)}`);
/** A count, or a word when the count is not known. */
const countOr = (v: Param, word: string): string => (v === undefined ? word : String(num(v)));

const OTHERS_GO_AHEAD = "Withdraw this claim; the visit's other claims go ahead.";
const REIMPORT_DATE = "Check the visit date in the clinic system, then re-import.";

const CATALOGUE: Record<FindingCode, CatalogueEntry> = {
  // ---- CHAS
  card_expired: {
    severity: "blocking",
    message: (p) =>
      (p.expiry === undefined
        ? "The CHAS card had expired by the visit date."
        : `The CHAS card expired on ${formatDay(str(p.expiry))}, before the visit.`) + " Ask the patient for their new card, then re-import.",
  },
  chas_green_no_dental: { severity: "blocking", message: () => `CHAS Green has no dental subsidy. ${OTHERS_GO_AHEAD}` },
  past_submission_window: {
    severity: "blocking",
    message: (p) =>
      (p.windowDays === undefined ? "Past the submission window." : `Past the ${num(p.windowDays)}-day window.`) +
      (p.deadline === undefined ? "" : ` The last day to submit was ${formatDay(str(p.deadline))}.`) +
      ` ${OTHERS_GO_AHEAD}`,
  },
  deadline_approaching: {
    severity: "warning",
    message: (p) =>
      num(p.daysLeft) <= 0
        ? "Last day to submit. Approve and submit it today."
        : `Last ${num(p.daysLeft) + 1} days to submit. Approve and submit it soon.`,
  },
  same_day_duplicate: {
    severity: "blocking",
    message: () => "A second CHAS claim on the same day. CHAS pays one claim a day, so combine the visits in the clinic system.",
  },
  branch_not_chas_registered: {
    severity: "blocking",
    message: () => "This branch isn't registered for CHAS. Mark it registered in settings if it is, or withdraw this claim.",
  },
  frequency_over_limit: {
    severity: "warning",
    message: (p) => {
      const noun = LIMIT_NOUNS[str(p.group)] ?? "of these procedures";
      const years = num(p.periodYears);
      const period = years <= 1 ? "per calendar year" : `every ${years} calendar years`;
      return `May exceed ${countOr(p.count, "the limit of")} ${noun} ${period}. Check the balance in the portal.`;
    },
  },
  benchmark_exceeded: {
    severity: "blocking",
    message: (p) => {
      const range = p.minCents === undefined || p.maxCents === undefined ? null : `${sgd(p.minCents)}–${sgd(p.maxCents)}`;
      const source = p.asOf === undefined ? `from ${p.sourceUrl}` : `from ${p.sourceUrl} as of ${p.asOf}`;
      const benchmark =
        p.sourceUrl === undefined
          ? `the MOH benchmark${range ? ` (${range})` : ""}`
          : `the benchmark set in settings (${range ? `${range}, ` : ""}${source})`;
      return `Fee is above ${benchmark}. Add a clinical justification.`;
    },
  },
  benchmark_not_set: { severity: "warning", message: () => "Benchmark not set. Add one in settings, with its source, to check this fee." },

  // ---- MediSave
  branch_not_medisave_registered: {
    severity: "blocking",
    message: () => "This branch isn't registered for MediSave. Mark it registered in settings if it is, or withdraw this claim.",
  },
  dentist_not_medisave_accredited: {
    severity: "blocking",
    message: () => "The dentist isn't MediSave-accredited. Mark them accredited in settings if they are, or withdraw this claim.",
  },
  medisave_no_mcaf: {
    severity: "blocking",
    message: (p) => `No MediSave authorisation (MCAF) is valid${onDay(p.date)}. Have the account holder sign one, then re-import.`,
  },
  tosp_not_in_rule_set: {
    severity: "blocking",
    message: (p) =>
      `${str(p.tospCode, "This surgical code")} isn't in the TOSP rule set, or its table isn't confirmed. Check the code against the MOH list, then fix the code map.`,
  },
  tosp_msp_ranked: {
    severity: "blocking",
    message: (p) =>
      `${str(p.tospCode, "This procedure")} is a minor surgical procedure, which MediSave doesn't pay. Withdraw this claim; the patient pays this part.`,
  },
  tosp_too_many_procedures: {
    severity: "blocking",
    message: (p) =>
      (p.max === undefined
        ? "MediSave limits how many surgical procedures it pays on one claim"
        : `MediSave pays at most ${num(p.max)} surgical procedures a claim`) +
      `, and this visit has ${countOr(p.count, "more")}. Check the codes in the clinic system.`,
  },
  tosp_too_many_systems: {
    severity: "blocking",
    message: (p) =>
      (p.max === undefined
        ? "MediSave limits how many body systems it pays procedures in on one claim"
        : `MediSave pays procedures in at most ${num(p.max)} body systems a claim`) +
      `, and this visit has ${countOr(p.count, "more")}. Check the codes in the clinic system.`,
  },
  tosp_too_many_in_system: {
    severity: "blocking",
    message: (p) =>
      (p.max === undefined
        ? "MediSave limits how many surgical procedures it pays in one body system on one claim"
        : `MediSave pays at most ${num(p.max)} surgical procedures in one body system a claim`) +
      `, and this visit has ${countOr(p.count, "more")}${p.system === undefined ? "" : ` in system ${str(p.system, "")}`}. Check the codes in the clinic system.`,
  },
  tosp_multiple_codes: {
    severity: "warning",
    message: (p) =>
      `${countOr(p.count, "Several")} surgical procedures on one claim. MediSave pays up to the highest table's limit${moneyOr(p.capCents, ", ")}. Check the amount in the portal.`,
  },
  flexi_yearly_amount_exceeded: {
    severity: "warning",
    message: (p) =>
      "Check the patient's yearly Flexi-MediSave balance in the portal. " +
      (p.capCents === undefined ? "Flexi-MediSave pays up to a yearly limit." : `Flexi-MediSave pays up to ${sgd(p.capCents)} a year.`),
  },

  // ---- insurance
  pre_auth_missing: {
    severity: "blocking",
    message: (p) =>
      `${str(p.payer, "The insurer")} needs pre-authorisation for ${str(p.benefitCode, "this benefit")}, and none is recorded. Get the approval, then add its reference to this claim, or record it in the clinic system and re-import.`,
  },
  policy_not_active: {
    severity: "blocking",
    message: (p) =>
      `The ${str(p.payer, "insurance")} policy wasn't active${onDay(p.date)}. Check the patient's cover, then re-import or withdraw this claim.`,
  },
  insurance_annual_limit_exceeded: {
    severity: "warning",
    message: (p) =>
      (p.limitCents === undefined
        ? "This claim takes this clinic's claims on the policy past its yearly limit."
        : `This claim takes this clinic's claims on the policy past its yearly limit of ${sgd(p.limitCents)}.`) +
      " It is billed in full. Check the remaining benefit with the insurer.",
  },
  insurance_deadline_passed: {
    severity: "blocking",
    message: (p) => `Past ${str(p.payer, "the insurer")}'s submission deadline. Check with the insurer, or withdraw this claim.`,
  },

  // ---- any scheme
  no_rule_set: {
    severity: "blocking",
    message: (p) =>
      `No ${SCHEME_IN_TEXT[str(p.scheme)] ?? "scheme"} rule set covers ${p.date === undefined ? "the visit date" : formatDay(str(p.date))}. ${REIMPORT_DATE}`,
  },
  unmapped_treatment: {
    severity: "blocking",
    message: (p) => `Treatment code ${str(p.clinicCode, "?")} isn't in the code map. Map it in settings, or mark it not claimable.`,
  },
  gst_not_registered: {
    severity: "blocking",
    message: () =>
      "GST charged at a branch that isn't GST-registered. Correct the bill in the clinic system, or the branch's GST setting, then re-import.",
  },
  waiting_on_upper_payer: {
    severity: "blocking",
    message: (p) => `Waiting on the ${schemeName(p.scheme)} claim; amounts may change. Fix the ${schemeName(p.scheme)} claim first.`,
  },
  upstream_rejected: {
    severity: "warning",
    message: (p) =>
      `${schemeName(p.scheme)} rejected this visit's claim. The MediSave and insurance amounts were based on it. Check them before submitting.`,
  },
  lower_payer_sent_first: {
    severity: "warning",
    message: (p) =>
      `The ${schemeName(p.scheme)} claim comes after this one in the payer waterfall, but it was sent first, so this claim covers only what it left. Check the amounts before you send it.`,
  },
  sent_claims_exceed_fee: {
    severity: "blocking",
    message: (p) =>
      (p.sentCents === undefined || p.feeCents === undefined
        ? "The claims already sent add up to more than the visit's fee."
        : `The claims already sent add up to ${sgd(p.sentCents)}, more than the visit's fee of ${sgd(p.feeCents)}.`) +
      " Compare them with the portal, and amend them there.",
  },
  billed_amount_differs: {
    severity: "warning",
    message: (p) =>
      (p.billedCents === undefined || p.claimedCents === undefined
        ? `Billed ${str(p.payer, "this payer")} a different amount from what the rules give.`
        : `Billed ${str(p.payer, "this payer")} ${sgd(p.billedCents)}, rules give ${sgd(p.claimedCents)}.`) + " Check the bill in the clinic system.",
  },
  pa_patient_balance: {
    severity: "warning",
    message: (p) =>
      "Check this fee isn't for a CHAS-covered procedure. A Public Assistance patient pays nothing for those" +
      (p.balanceCents === undefined ? "." : `, and this visit leaves ${sgd(p.balanceCents)}.`),
  },
  tier_chosen_from_several: {
    severity: "warning",
    message: (p) =>
      `The patient holds ${countOr(p.count, "several")} CHAS tiers, and this claim uses ${str(p.tier, "the one")} with the higher subsidy. Check the card in the portal if unsure.`,
  },
  started_at_other_branch: {
    severity: "warning",
    message: (p) => `Treatment started at ${str(p.branch, "another branch")}. Check the portal accepts the claim from this branch.`,
  },
  changed_after_submission: {
    severity: "blocking",
    message: () => "Changed in the clinic system after submission. Compare it with the portal, and amend the claim there.",
  },
};

export function severityOf(code: FindingCode): Severity {
  return CATALOGUE[code].severity;
}

export function finding(code: FindingCode, params: Params = {}, at: { lineNo?: number; ruleRef?: string } = {}): Finding {
  return {
    code,
    severity: severityOf(code),
    params,
    ...(at.lineNo === undefined ? {} : { lineNo: at.lineNo }),
    ...(at.ruleRef === undefined ? {} : { ruleRef: at.ruleRef }),
  };
}

/** The sentence a person reads for a finding. Wired to `FindingList`'s `describe`. */
export function describeFinding(f: Finding): string {
  return CATALOGUE[f.code].message(f.params);
}

const NOTES: Record<VisitNoteCode, (p: VisitNote["params"]) => string> = {
  held_until_complete: (p) =>
    `Treatment ${str(p.clinicCode, "in progress")} is held until it's complete. It's claimed on the visit that completes it.`,
  flexi_patient_under_60: (p) =>
    p.age === undefined || p.minAge === undefined
      ? "No Flexi-MediSave claim: the patient is under its minimum age."
      : `No Flexi-MediSave claim: the patient is ${num(p.age)}, and Flexi-MediSave starts at ${num(p.minAge)}.`,
  flexi_treatment_not_covered: () => "No Flexi-MediSave claim: none of this visit's treatments is on its list of covered procedures.",
  flexi_no_rule_set: (p) =>
    `No Flexi-MediSave claim: no Flexi-MediSave rule set covers ${p.date === undefined ? "the visit date" : formatDay(str(p.date))}. ${REIMPORT_DATE}`,
  insurer_not_on_panel: (p) =>
    `No claim to ${str(p.payer, "the insurer")}: the clinic isn't on its panel, so the patient claims it back themselves.`,
  withdrawn_not_rebuilt: () => "A claim for this visit was withdrawn, so the desk doesn't build it again.",
  voided_in_clinic: () => "Voided in the clinic system. No claims are built.",
};

/** The sentence a person reads for a visit note: why a claim was not built, or a line was held. */
export function describeVisitNote(n: VisitNote): string {
  return NOTES[n.code](n.params);
}
