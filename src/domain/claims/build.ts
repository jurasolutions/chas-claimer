/**
 * The claim builder: one de-identified visit in, the claims each payer should receive out, with
 * their findings, the bill split and the notes that say why a line was held or a claim not built.
 * Pure and deterministic: the clock arrives as `today`, history as data.
 *
 * Each scheme makes a plan (`plan.ts`): the lines it may claim and what each is entitled to out of
 * what is left of it. The payer waterfall then runs the plans in the clinic's order, so each payer
 * pays from what the payers above it left, and the patient pays the rest.
 */
import { addDays, daysBetween, type IsoDate, yearOf } from "../dates";
import { add, type Cents, cents, min, subtract } from "../money";
import { type ChasRuleSet, ruleSetFor } from "../rules";
import { CHAS_RULE_SETS } from "../rules/chas";
import type { DeskSettings } from "../settings";
import type { ClinicalVisit } from "../source-visit";
import type { ChasTier, ClaimStatus, CodeMapEntry, Finding, FindingCode, PayerId, Scheme, SplitSegment, VisitNote } from "../types";
import { finding } from "./findings";
import { planInsurance } from "./insurance";
import { planFlexi, planTosp, tospLines } from "./medisave";
import { chasCodeOf, claimDateOf, claimYear, considered, earlierCounted, type HistoryClaim, levelOf, orderKey, type Plan, type PlanLine, type Treatment } from "./plan";

export type CodeMap = readonly CodeMapEntry[];

/** This clinic's earlier visits and claims for the patient: the current revision of each. */
export interface PatientHistory {
  visits: {
    visitKey: string;
    date: IsoDate;
    startTime: string | null;
    branchId: string;
    /** Clinic codes started but not finished at that visit. */
    inProgressCodes: string[];
  }[];
  claims: {
    visitKey: string;
    visitDate: IsoDate;
    visitStartTime: string | null;
    scheme: Scheme;
    status: ClaimStatus;
    lines: { schemeCode: string | null; quantity: number }[];
    /** Which payer, for limits kept per payer (insurance). */
    payerId?: PayerId;
    /** What the claim asked for, for yearly caps (Flexi-MediSave, insurance). Missing counts as $0. */
    claimedCents?: Cents;
    /** The claim's own date when it differs from the visit's (a held line completed later). */
    claimDate?: IsoDate;
  }[];
}

/** The longest frequency-limit period across the CHAS rule sets, in calendar years. */
const LONGEST_PERIOD_YEARS = Math.max(1, ...CHAS_RULE_SETS.flatMap((r) => Object.values(r.procedures).map((p) => p.limit.periodYears)));

/**
 * The visit dates whose claims a build on `date` reads: back to the start of the earliest year the
 * longest limit counts, one year further for a visit completed in the following year, up to `date`.
 */
export function historyWindow(date: IsoDate): { from: IsoDate; to: IsoDate } {
  return { from: `${yearOf(date) - LONGEST_PERIOD_YEARS}-01-01` as IsoDate, to: date };
}

/** The last visit date whose build reads a claim from a visit on `date`: the inverse of `historyWindow`. */
export function laterReach(date: IsoDate): IsoDate {
  return `${yearOf(date) + LONGEST_PERIOD_YEARS}-12-31` as IsoDate;
}

/** A claim of this visit already sent to its payer: its amount is not recomputed (F5). */
export interface FixedClaim {
  payerId: PayerId;
  scheme: Scheme;
  claimedCents: Cents;
}

/** What the desk has entered against a payer's claim on this visit. */
export type ClaimAnnotations = Record<PayerId, { justification?: string; preAuthReference?: string; mcafReference?: string }>;

export interface DraftLine {
  lineNo: number;
  /** The treatment's index in the visit. */
  treatmentRef: number;
  /** The scheme's procedure code (CHAS) or TOSP / benefit code. */
  schemeCode: string;
  tooth: string | null;
  quantity: number;
  feeCents: Cents;
  /** Fee plus GST: what the scheme considers. */
  consideredCents: Cents;
  claimedCents: Cents;
}

export interface DraftClaim {
  payerId: PayerId;
  scheme: Scheme;
  ruleSetId: string | null;
  lines: DraftLine[];
  feeCents: Cents;
  claimedCents: Cents;
  findings: Finding[];
  /** The last day to submit, or null when no rule set or payer setting says. */
  deadline: IsoDate | null;
  /** The date the claim is made on: the latest completion among its scheme's lines, else the visit date. */
  claimDate: IsoDate;
  status: "needs_attention" | "ready";
}

export interface BuildInput {
  visit: ClinicalVisit;
  settings: DeskSettings;
  codeMap: CodeMap;
  history: PatientHistory;
  fixed: FixedClaim[];
  annotations: ClaimAnnotations;
  today: IsoDate;
}

export interface BuildOutput {
  /** The claims to send; a claim already sent (`fixed`) is not rebuilt and is not listed. */
  claims: DraftClaim[];
  /** Payers in waterfall order, the patient last; the segments sum to the visit's fee including GST. */
  split: SplitSegment[];
  visitFindings: Finding[];
  visitNotes: VisitNote[];
}

/**
 * The deadline as the desk sees it on `today` (decisions-g2 #5): the queue and the detail show this,
 * worked out on the server, so the page never reads the clock. `daysLeft` is negative once the
 * window has passed; `warning` holds from five days out.
 */
export function deadlineView(
  deadline: IsoDate,
  today: IsoDate,
  windowDays?: number,
): { deadline: IsoDate; daysLeft: number; warning: boolean; windowDays?: number } {
  const daysLeft = daysBetween(today, deadline);
  return { deadline, daysLeft, warning: daysLeft <= DEADLINE_WARNING_DAYS, ...(windowDays === undefined ? {} : { windowDays }) };
}

/** The deadline finding a CHAS claim carries on `today`. */
export type DeadlineState = { code: "past_submission_window" } | { code: "deadline_approaching"; daysLeft: number } | null;

/**
 * What the deadline says on `today` (decisions-g2 #5): past the window once `today` is after it, the
 * last days from five days out, otherwise nothing. The build and the queue's re-check both use it.
 */
export function deadlineState(deadline: IsoDate, today: IsoDate): DeadlineState {
  const daysLeft = daysBetween(today, deadline);
  if (daysLeft < 0) return { code: "past_submission_window" };
  if (daysLeft <= DEADLINE_WARNING_DAYS) return { code: "deadline_approaching", daysLeft };
  return null;
}

/** Any blocking finding stops a claim; warnings do not. */
export function statusAfterBuild(findings: readonly Finding[]): "needs_attention" | "ready" {
  return findings.some((f) => f.severity === "blocking") ? "needs_attention" : "ready";
}

/** Most generous first: Public Assistance pays the full fee. */
const TIER_ORDER: readonly ChasTier[] = ["PA", "PG", "MG", "Blue", "Orange", "Green"];

const JUSTIFICATION_MIN = 20;
/** The "last N days" warning starts this many days before the deadline. */
export const DEADLINE_WARNING_DAYS = 5;

/**
 * Findings that mean the payer will never pay this visit, however the desk fixes it: the claim
 * contributes $0 and the payers below go ahead without waiting for it (decisions-g2 #4).
 */
const NEVER_PAYABLE: ReadonlySet<FindingCode> = new Set<FindingCode>([
  "card_expired",
  "past_submission_window",
  "chas_green_no_dental",
  "no_rule_set",
  "tosp_msp_ranked",
]);

function hasAnyMapping(codeMap: CodeMap, code: string): boolean {
  return codeMap.some((e) => e.clinicCode === code);
}

export function buildVisitClaims(input: BuildInput): BuildOutput {
  const { visit, settings } = input;
  if (visit.voided) {
    return { claims: [], split: [], visitFindings: [], visitNotes: [{ code: "voided_in_clinic", params: {} }] };
  }

  const visitNotes: VisitNote[] = [];
  const visitFindings: Finding[] = [];
  for (const t of visit.treatments) {
    if (t.completion === "in_progress") visitNotes.push({ code: "held_until_complete", params: { clinicCode: t.code } });
    else if (!hasAnyMapping(input.codeMap, t.code)) visitFindings.push(finding("unmapped_treatment", { clinicCode: t.code }));
  }

  const plans: Plan[] = [];
  const payerFor = (scheme: Scheme) => settings.payers.find((p) => p.scheme === scheme);
  const chasPayer = payerFor("chas");
  if (chasPayer) {
    const chas = planChas(input, chasPayer.id, visitFindings);
    if (chas) plans.push(chas);
  }
  const tospPayer = payerFor("medisave_tosp");
  if (tospPayer) {
    const tosp = planTosp(input, tospPayer.id);
    if (tosp) plans.push(tosp);
  }
  const flexiPayer = payerFor("medisave_flexi");
  if (flexiPayer) {
    const flexi = planFlexi(input, flexiPayer.id, tospLines(input).length > 0);
    if (flexi.plan) plans.push(flexi.plan);
    visitNotes.push(...flexi.notes);
  }
  for (const policy of visit.policies) {
    const insurance = planInsurance(input, policy);
    if (insurance.plan) plans.push(insurance.plan);
    visitNotes.push(...insurance.notes);
  }
  for (const f of input.fixed) {
    if (!plans.some((p) => p.payerId === f.payerId)) {
      plans.push({
        payerId: f.payerId,
        scheme: f.scheme,
        ruleSetId: null,
        lines: [],
        capCents: null,
        findings: [],
        deadline: null,
        claimDate: visit.date,
        keepAtZero: true,
      });
    }
  }

  const { claims, split, sentOverFee } = runWaterfall(input, plans);
  if (sentOverFee) visitFindings.push(finding("sent_claims_exceed_fee", sentOverFee));
  crossPayerChecks(input, claims);
  const patient = split[split.length - 1]!.cents;
  const paidOn = claimDateOf(
    visit,
    visit.treatments.filter((t) => t.completion === "complete"),
  );
  if (patient > 0 && visit.chasCards.some((c) => c.tier === "PA" && c.expiry >= paidOn)) {
    // Public Assistance is a CHAS tier, so the CHAS rule set is the warning's source: the claim's
    // own when there is one, else the one in force on the day the visit was paid.
    const ruleRef =
      claims.find((c) => c.scheme === "chas")?.ruleSetId ?? ruleSetFor("chas", paidOn, settings.benchmarkOverrides)?.id;
    visitFindings.push(finding("pa_patient_balance", { balanceCents: patient }, ruleRef ? { ruleRef } : {}));
  }

  const finished = claims.map((c) => {
    const ruleSetId = c.ruleSetId;
    const findings = ruleSetId === null ? c.findings : c.findings.map((f) => ({ ...f, ruleRef: f.ruleRef ?? ruleSetId }));
    return { ...c, findings, status: statusAfterBuild(findings) };
  });
  return { claims: finished, split, visitFindings, visitNotes };
}

/** Where a scheme sits in the clinic's waterfall; a level the settings leave out goes last. */
function rankOf(settings: DeskSettings, scheme: Scheme): number {
  const i = settings.waterfall.indexOf(levelOf(scheme));
  return i < 0 ? settings.waterfall.length : i;
}

/**
 * Runs the plans in waterfall order over what is left of each treatment. A payer's claim is what its
 * lines are entitled to out of that, up to its cap. A sent claim keeps its amount: every sent claim
 * comes off the visit first, in waterfall order, each from its own lines first, so a claim still to be
 * sent can never take what one already sent was paid for (QA 03 D01). A payer other than CHAS that ends
 * up claiming nothing, with nothing for the desk to fix, is dropped: there is nothing to send. A claim
 * its cap brought to $0 stays, so the officer sees the limit warning and can check the true balance
 * with the payer (ADR 0003).
 *
 * When a claim below an unsent one in the waterfall was sent first, the unsent claim gets less than the
 * waterfall would give it, and it says so, so the desk checks the amounts before it goes. When the sent
 * claims add up to more than the visit's fee, `sentOverFee` carries the two totals, and every unsent
 * claim stays on the desk with a blocking `sent_claims_exceed_fee` until the sent ones are amended
 * (QA 03 B1).
 */
function runWaterfall(
  input: BuildInput,
  plans: readonly Plan[],
): { claims: DraftClaim[]; split: SplitSegment[]; sentOverFee: { sentCents: Cents; feeCents: Cents } | null } {
  const { visit, settings } = input;
  const ordered = [...plans].sort((a, b) => rankOf(settings, a.scheme) - rankOf(settings, b.scheme));
  const remainder = visit.treatments.map(considered);
  const total = add(cents(0), ...remainder);
  const nameOf = (payerId: PayerId) => settings.payers.find((p) => p.id === payerId)?.name ?? payerId;
  const fixedOf = (plan: Plan) => input.fixed.find((f) => f.payerId === plan.payerId);

  // The waterfall as it ran in order, each sent claim taking its amount on its own turn: what each
  // unsent claim would get in turn.
  const inTurn = new Map<PayerId, Cents>();
  const inOrder = [...remainder];
  for (const plan of ordered) {
    const fixed = fixedOf(plan);
    if (fixed) takeFixed(plan, inOrder, fixed.claimedCents);
    else inTurn.set(plan.payerId, add(cents(0), ...allocate(plan, inOrder).amounts));
  }

  const sentCents = add(cents(0), ...ordered.map((p) => fixedOf(p)?.claimedCents ?? cents(0)));
  const sentOverFee = sentCents > total ? { sentCents, feeCents: total } : null;
  const taken = new Map<PayerId, Cents>();
  for (const plan of ordered) {
    const fixed = fixedOf(plan);
    if (fixed) taken.set(plan.payerId, takeFixed(plan, remainder, fixed.claimedCents));
  }

  const claims: DraftClaim[] = [];
  const split: SplitSegment[] = [];
  for (const plan of ordered) {
    const sent = taken.get(plan.payerId);
    if (sent !== undefined) {
      split.push({ payer: plan.payerId, label: nameOf(plan.payerId), cents: sent });
      continue;
    }

    const available = add(cents(0), ...plan.lines.map((l) => remainder[l.treatmentRef]!));
    const { amounts, capped } = allocate(plan, remainder);
    const claimed = add(cents(0), ...amounts);
    const findings = [...plan.findings];
    if (plan.softLimit && claimed > plan.softLimit.leftCents) findings.push(plan.softLimit.finding);
    if (claimed < (inTurn.get(plan.payerId) ?? claimed)) {
      const below = ordered.filter((p) => rankOf(settings, p.scheme) > rankOf(settings, plan.scheme) && (taken.get(p.payerId) ?? cents(0)) > cents(0));
      for (const scheme of new Set(below.map((p) => p.scheme))) findings.push(finding("lower_payer_sent_first", { scheme }));
    }
    if (sentOverFee) findings.push(finding("sent_claims_exceed_fee", sentOverFee));
    const blocked = findings.some((f) => f.severity === "blocking");
    // A claim that says the sent ones got in its way stays, so the desk sees why it claims less.
    const flagged = findings.some((f) => f.code === "lower_payer_sent_first" || f.code === "sent_claims_exceed_fee");
    if (!plan.keepAtZero && !flagged && (available === 0 || (claimed === 0 && !blocked && !capped))) continue;

    const lines: DraftLine[] = plan.lines.map((l, i) => ({
      lineNo: i + 1,
      treatmentRef: l.treatmentRef,
      schemeCode: l.schemeCode,
      tooth: l.t.tooth,
      quantity: l.t.quantity,
      feeCents: l.t.feeCents,
      consideredCents: considered(l.t),
      claimedCents: amounts[i]!,
    }));
    claims.push({
      payerId: plan.payerId,
      scheme: plan.scheme,
      ruleSetId: plan.ruleSetId,
      lines,
      feeCents: add(cents(0), ...lines.map((l) => l.consideredCents)),
      claimedCents: claimed,
      findings,
      deadline: plan.deadline,
      claimDate: plan.claimDate,
      status: statusAfterBuild(findings),
    });
    split.push({ payer: plan.payerId, label: nameOf(plan.payerId), cents: claimed });
  }

  split.push({ payer: "patient", label: "Patient", cents: add(cents(0), ...remainder) });
  if (add(cents(0), ...split.map((s) => s.cents)) !== total) throw new Error("the split does not add up to the visit's total");
  return { claims, split, sentOverFee };
}

/** Each line takes what it is entitled to out of what is left of it, up to what is left of the cap. Mutates `remainder`. */
function allocate(plan: Plan, remainder: Cents[]): { amounts: Cents[]; capped: boolean } {
  let capLeft = plan.capCents;
  let capped = false;
  const amounts = plan.lines.map((l) => {
    const left = remainder[l.treatmentRef]!;
    const wanted = min(l.entitled(left), left);
    const amount = capLeft === null ? wanted : min(wanted, capLeft);
    if (amount < wanted) capped = true;
    if (capLeft !== null) capLeft = subtract(capLeft, amount);
    remainder[l.treatmentRef] = subtract(left, amount);
    return amount;
  });
  return { amounts, capped };
}

/** A sent claim's amount comes off its own lines first, then off the rest of the visit. Mutates `remainder`. */
function takeFixed(plan: Plan, remainder: Cents[], amount: Cents): Cents {
  let left = amount;
  const order = [...plan.lines.map((l) => l.treatmentRef), ...remainder.keys()];
  for (const ref of order) {
    const take = min(remainder[ref]!, left);
    remainder[ref] = subtract(remainder[ref]!, take);
    left = subtract(left, take);
  }
  return subtract(amount, left);
}

/**
 * What one payer's claim means for the payers below it (decisions-g2 #4). While an upper claim has
 * something the desk can fix, the lower ones wait, because its amount could still change theirs.
 * A rejection upstream means the lower amounts were worked out on a payment that won't come.
 * And a sent bill that doesn't match the claim is worth a look before it goes.
 */
function crossPayerChecks(input: BuildInput, claims: DraftClaim[]): void {
  const { visit, settings, history } = input;
  const rank = (scheme: Scheme) => rankOf(settings, scheme);
  const fixable = claims.filter((c) => statusAfterBuild(c.findings) === "needs_attention" && !c.findings.some((f) => NEVER_PAYABLE.has(f.code)));
  const rejectedUpstream = history.claims.filter((c) => c.visitKey === visit.visitKey && c.status === "rejected");
  const nameOf = (payerId: PayerId) => settings.payers.find((p) => p.id === payerId)?.name ?? payerId;

  for (const claim of claims) {
    const added: Finding[] = [];
    const waitingOn = new Set(fixable.filter((u) => rank(u.scheme) < rank(claim.scheme)).map((u) => u.scheme));
    for (const scheme of waitingOn) added.push(finding("waiting_on_upper_payer", { scheme }));
    const rejected = new Set(rejectedUpstream.filter((r) => rank(r.scheme) < rank(claim.scheme)).map((r) => r.scheme));
    for (const scheme of rejected) added.push(finding("upstream_rejected", { scheme }));
    const billed = visit.billedCents[claim.payerId];
    if (billed !== undefined && billed !== claim.claimedCents) {
      added.push(finding("billed_amount_differs", { payer: nameOf(claim.payerId), billedCents: billed, claimedCents: claim.claimedCents }));
    }
    claim.findings.push(...added);
  }
}

/** The card CHAS pays on: the most generous tier among the cards valid on the claim date. */
function pickCard(visit: ClinicalVisit, claimDate: IsoDate, findings: Finding[]): ChasTier {
  const valid = visit.chasCards.filter((c) => c.expiry >= claimDate);
  if (valid.length === 0) {
    const latest = [...visit.chasCards].sort((a, b) => (a.expiry < b.expiry ? 1 : -1))[0]!;
    findings.push(finding("card_expired", { expiry: latest.expiry }));
    return latest.tier;
  }
  const tiers = [...new Set(valid.map((c) => c.tier))].sort((a, b) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b));
  const tier = tiers[0]!;
  if (tiers.length > 1) findings.push(finding("tier_chosen_from_several", { count: tiers.length, tier }));
  return tier;
}

function planChas(input: BuildInput, payerId: PayerId, visitFindings: readonly Finding[]): Plan | null {
  const { visit, settings, history, annotations, today } = input;
  if (visit.chasCards.length === 0) return null;

  // The lines the code map sends to CHAS, completed. Their latest completion is the claim date.
  const mapped: { t: Treatment; index: number; schemeCode: string }[] = [];
  visit.treatments.forEach((t, index) => {
    if (t.completion === "in_progress") return;
    const schemeCode = chasCodeOf(input, t.code);
    if (schemeCode) mapped.push({ t, index, schemeCode });
  });
  const claimDate = claimDateOf(
    visit,
    mapped.map((m) => m.t),
  );
  const ruleSet = ruleSetFor("chas", claimDate, settings.benchmarkOverrides);
  const findings: Finding[] = [];

  // The lines this scheme can claim: those whose procedure the rule set knows.
  const claimable = mapped.filter(({ t, schemeCode }) => {
    if (!ruleSet || schemeCode in ruleSet.procedures) return true;
    findings.push(finding("unmapped_treatment", { clinicCode: t.code }));
    return false;
  });
  const unmapped = visitFindings.filter((f) => f.code === "unmapped_treatment");
  // Nothing to claim and nothing waiting on the code map: CHAS has no part in this visit. A code
  // still to be mapped could be CHAS's, though, so the claim stays, with no lines, holding the payers
  // below until it is fixed (functional B5). The card and window checks below still say whether CHAS
  // could ever pay it; if it never can, they don't wait.
  if (claimable.length === 0 && unmapped.length === 0 && findings.length === 0) return null;
  findings.unshift(...unmapped);

  const tier = pickCard(visit, claimDate, findings);
  const basis = ruleSet?.tierBasis[tier] ?? "none";
  if (basis === "none" && tier === "Green") findings.push(finding("chas_green_no_dental"));

  const branch = settings.branches.find((b) => b.id === visit.branchId);
  if (branch && !branch.chasRegistered) findings.push(finding("branch_not_chas_registered"));
  if (branch && !branch.gstRegistered && claimable.some(({ t }) => (t.gstCents ?? 0) > 0)) findings.push(finding("gst_not_registered"));

  let deadline: IsoDate | null = null;
  if (!ruleSet) {
    findings.push(finding("no_rule_set", { scheme: "chas", date: claimDate }));
  } else {
    deadline = addDays(claimDate, ruleSet.windowDays);
    const state = deadlineState(deadline, today);
    if (state?.code === "past_submission_window") findings.push(finding("past_submission_window", { windowDays: ruleSet.windowDays, deadline }));
    else if (state) findings.push(finding("deadline_approaching", { daysLeft: state.daysLeft }));
  }

  const here = orderKey(visit.date, visit.startTime, visit.visitKey);
  const earlierClaims = earlierCounted(input).filter((c) => c.scheme === "chas");
  if (earlierClaims.some((c) => (c.claimDate ?? c.visitDate) === claimDate)) findings.push(finding("same_day_duplicate"));

  const earlierVisits = history.visits.filter((v) => v.visitKey !== visit.visitKey && orderKey(v.date, v.startTime, v.visitKey) < here);
  const justification = annotations[payerId]?.justification?.trim() ?? "";
  // CHAS will never pay a visit on an expired card or past its window, so it claims nothing and the
  // fee falls to the payers below and the patient (decisions-g2 #4). Green and a missing rule set
  // already come to $0 through the basis.
  const neverPayable = findings.some((f) => f.code === "card_expired" || f.code === "past_submission_window");

  const lines: PlanLine[] = claimable.map(({ t, index, schemeCode }, i) => {
    const lineNo = i + 1;
    const consideredCents = considered(t);
    const procedure = ruleSet?.procedures[schemeCode];
    let subsidy: Cents = cents(0);
    if (ruleSet && procedure) {
      if (neverPayable) subsidy = cents(0);
      else if (basis === "full_fee") subsidy = consideredCents;
      else if (basis === "table" && tier !== "Green" && tier !== "PA") subsidy = cents(procedure.subsidyCents[tier] * t.quantity);
      lineChecks(ruleSet, schemeCode, t, lineNo, consideredCents, justification, findings);
      frequencyCheck(ruleSet, schemeCode, claimable.slice(0, i), earlierClaims, claimDateOf(visit, [t]), t.quantity, lineNo, findings);
    }
    const startedAt = earlierVisits.find((v) => v.branchId !== visit.branchId && v.inProgressCodes.includes(t.code));
    if (startedAt) {
      const name = settings.branches.find((b) => b.id === startedAt.branchId)?.name ?? startedAt.branchId;
      findings.push(finding("started_at_other_branch", { branch: name }, { lineNo }));
    }
    return { t, treatmentRef: index, schemeCode, entitled: (remaining: Cents) => min(subsidy, remaining) };
  });

  return { payerId, scheme: "chas", ruleSetId: ruleSet?.id ?? null, lines, capCents: null, findings, deadline, claimDate, keepAtZero: true };
}

function lineChecks(
  ruleSet: ChasRuleSet,
  schemeCode: string,
  t: Treatment,
  lineNo: number,
  consideredCents: Cents,
  justification: string,
  findings: Finding[],
): void {
  const benchmark = ruleSet.benchmarkFor(schemeCode);
  if (benchmark === null) return;
  if (benchmark.kind === "not_set") {
    findings.push(finding("benchmark_not_set", {}, { lineNo }));
    return;
  }
  const perUnit = Math.round(consideredCents / Math.max(1, t.quantity));
  if (perUnit > benchmark.maxCents && justification.length < JUSTIFICATION_MIN) {
    // A benchmark from settings carries its source so the officer can see where the range came from.
    const source: Record<string, string> = benchmark.source.override ? { sourceUrl: benchmark.source.url, asOf: benchmark.source.asOf } : {};
    findings.push(
      finding("benchmark_exceeded", { minCents: benchmark.minCents, maxCents: benchmark.maxCents, ...source }, { lineNo }),
    );
  }
}

function frequencyCheck(
  ruleSet: ChasRuleSet,
  schemeCode: string,
  earlierInVisit: readonly { t: Treatment; schemeCode: string }[],
  earlierClaims: readonly HistoryClaim[],
  date: IsoDate,
  quantity: number,
  lineNo: number,
  findings: Finding[],
): void {
  const limit = ruleSet.procedures[schemeCode]?.limit;
  if (!limit) return;
  const inGroup = (code: string | null) => code !== null && ruleSet.procedures[code]?.limit.group === limit.group;
  const year = claimYear({ claimDate: date, visitDate: date });
  const fromYear = year - limit.periodYears + 1;
  let used = 0;
  for (const c of earlierClaims) {
    const y = claimYear(c);
    if (y < fromYear || y > year) continue;
    for (const l of c.lines) if (inGroup(l.schemeCode)) used += l.quantity;
  }
  for (const l of earlierInVisit) if (inGroup(l.schemeCode)) used += l.t.quantity;
  if (used + quantity > limit.count) {
    findings.push(finding("frequency_over_limit", { group: limit.group, count: limit.count, periodYears: limit.periodYears }, { lineNo }));
  }
}

/** A stored claim on the visit as the bill split reads it; the segment carries `claimId` when it has one. */
export interface SplitClaim {
  payerId: PayerId;
  scheme: Scheme;
  claimedCents: Cents;
  id?: string;
}

/**
 * The visit's bill (fee plus GST) across claims the build already sized, in the same waterfall order
 * the build uses, the patient last: each payer takes what it claims, up to what is left. The claim
 * page splits the stored claims this way so it ranks payers exactly as the build did.
 */
export function splitAcross(treatments: readonly Treatment[], settings: DeskSettings, claims: readonly SplitClaim[]): SplitSegment[] {
  const total = add(cents(0), ...treatments.map(considered));
  const nameOf = (payerId: PayerId) => settings.payers.find((p) => p.id === payerId)?.name ?? payerId;
  const segments: SplitSegment[] = [];
  let left = total;
  for (const c of [...claims].sort((a, b) => rankOf(settings, a.scheme) - rankOf(settings, b.scheme))) {
    const share = min(c.claimedCents, left);
    segments.push({ payer: c.payerId, label: nameOf(c.payerId), cents: share, ...(c.id === undefined ? {} : { claimId: c.id }) });
    left = subtract(left, share);
  }
  segments.push({ payer: "patient", label: "Patient", cents: left });
  return segments;
}

/**
 * The bill as a frozen claim was built (D12, N3): the claim keeps its own amount whatever the
 * waterfall says today, and the other frozen claims built with it keep theirs, up to what is left,
 * in waterfall order. The remainder is the patient's when nothing else on the visit is open;
 * otherwise it is the rest of the bill, which open claims rebuilt since may share with the patient.
 */
export function frozenSplit(
  treatments: readonly Treatment[],
  settings: DeskSettings,
  own: SplitClaim,
  frozenWith: readonly SplitClaim[],
  othersOpen: boolean,
): SplitSegment[] {
  const total = add(cents(0), ...treatments.map(considered));
  const nameOf = (payerId: PayerId) => settings.payers.find((p) => p.id === payerId)?.name ?? payerId;
  const ownCents = min(own.claimedCents, total);
  let left = subtract(total, ownCents);
  const shares = new Map<SplitClaim, Cents>([[own, ownCents]]);
  for (const c of [...frozenWith].sort((a, b) => rankOf(settings, a.scheme) - rankOf(settings, b.scheme))) {
    const share = min(c.claimedCents, left);
    shares.set(c, share);
    left = subtract(left, share);
  }
  const segments: SplitSegment[] = [...shares]
    .sort(([a], [b]) => rankOf(settings, a.scheme) - rankOf(settings, b.scheme))
    .filter(([c, share]) => c === own || share > 0)
    .map(([c, share]) => ({ payer: c.payerId, label: nameOf(c.payerId), cents: share, ...(c.id === undefined ? {} : { claimId: c.id }) }));
  segments.push(othersOpen ? { payer: "rest", label: "Rest of the bill", cents: left } : { payer: "patient", label: "Patient", cents: left });
  return segments;
}
