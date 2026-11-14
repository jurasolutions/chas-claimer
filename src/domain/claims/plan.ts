/**
 * What the builder knows about one payer's claim before the waterfall runs: the lines it may claim,
 * how much each line is entitled to out of what is left of it, the payer's cap and its findings.
 * The waterfall in `build.ts` turns plans into amounts; the scheme modules make the plans.
 */
import type { IsoDate } from "../dates";
import { yearOf } from "../dates";
import { add, type Cents, cents } from "../money";
import type { WaterfallLevel } from "../settings";
import type { ClinicalVisit } from "../source-visit";
import type { ClaimStatus, CodeMapTarget, Finding, PayerId, Scheme } from "../types";
import type { BuildInput, PatientHistory } from "./build";

export type Treatment = ClinicalVisit["treatments"][number];
export type HistoryClaim = PatientHistory["claims"][number];

export interface PlanLine {
  t: Treatment;
  /** The treatment's index in the visit. */
  treatmentRef: number;
  schemeCode: string;
  /** What the payer would pay for this line out of `remaining`, before its cap. Never above `remaining`. */
  entitled: (remaining: Cents) => Cents;
}

export interface Plan {
  payerId: PayerId;
  scheme: Scheme;
  ruleSetId: string | null;
  lines: PlanLine[];
  /** The most the payer pays across the visit's lines, or null when it has no cap. */
  capCents: Cents | null;
  /**
   * A limit the payer is billed past in full, with a warning when the claim goes over what is left
   * of it. It comes from this clinic's own count, which can't see other clinics' claims, so it never
   * cuts the amount (decisions-g2 #8, ADR 0003).
   */
  softLimit?: { leftCents: Cents; finding: Finding };
  findings: Finding[];
  deadline: IsoDate | null;
  /**
   * The date the claim is made on: the latest completion among the lines the code map sends to this
   * scheme, else the visit date. The window, card, tier, rule set, MCAF, policy dates and deadlines
   * all read it (decisions-g2 #3); the order of visits and the history still go by the visit date.
   */
  claimDate: IsoDate;
  /** CHAS keeps its claim at $0 so the officer sees why; other payers' $0 claims are dropped. */
  keepAtZero: boolean;
}

/** History that no longer counts against a limit or a same-day rule. */
export const NOT_COUNTED: ReadonlySet<ClaimStatus> = new Set(["withdrawn", "written_off", "rejected"]);

export const orderKey = (date: string, startTime: string | null, visitKey: string): string => `${date}|${startTime ?? ""}|${visitKey}`;

export function considered(t: Treatment): Cents {
  return add(t.feeCents, t.gstCents ?? cents(0));
}

export function levelOf(scheme: Scheme): WaterfallLevel {
  return scheme === "medisave_tosp" || scheme === "medisave_flexi" ? "medisave" : scheme;
}

/** The year a claim counts in: its claim date (a held line's completion), else its visit date. */
export function claimYear(c: Pick<HistoryClaim, "claimDate" | "visitDate">): number {
  return yearOf(c.claimDate ?? c.visitDate);
}

/** The claim date of a set of lines: the latest completion among them, else the visit date. */
export function claimDateOf(visit: ClinicalVisit, ts: readonly Treatment[]): IsoDate {
  const dates = ts.map((t) => t.completedOn).filter((d): d is IsoDate => d !== null);
  return dates.length === 0 ? visit.date : dates.reduce((a, b) => (a > b ? a : b));
}

/** The patient's earlier claims on other visits that still count against a limit. */
export function earlierCounted(input: BuildInput): HistoryClaim[] {
  const { visit, history } = input;
  const here = orderKey(visit.date, visit.startTime, visit.visitKey);
  return history.claims.filter(
    (c) => !NOT_COUNTED.has(c.status) && c.visitKey !== visit.visitKey && orderKey(c.visitDate, c.visitStartTime, c.visitKey) < here,
  );
}

/**
 * The code the code map gives a clinic code for one target: a CHAS or TOSP code (no payer), or one
 * insurer's benefit code. Null when the clinic code has no such mapping.
 */
export function targetCodeOf(input: BuildInput, clinicCode: string, target: CodeMapTarget, payerId: PayerId | "" = ""): string | null {
  const entry = input.codeMap.find((e) => e.clinicCode === clinicCode && e.target === target && e.payerId === payerId);
  return entry?.targetCode || null;
}

/** The CHAS procedure code the code map gives a clinic code, if any. */
export function chasCodeOf(input: BuildInput, clinicCode: string): string | null {
  return targetCodeOf(input, clinicCode, "chas");
}

/** What the patient's earlier claims that still count, and match `which`, claimed in `year`. */
export function usedThisYear(input: BuildInput, which: (c: HistoryClaim) => boolean, year: number): Cents {
  return cents(
    earlierCounted(input)
      .filter((c) => which(c) && claimYear(c) === year)
      .reduce((s, c) => s + (c.claimedCents ?? 0), 0),
  );
}
