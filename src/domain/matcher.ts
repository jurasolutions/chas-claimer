/**
 * Remittance matching (spec §5, S12): which claim each line of a payer's payment statement pays.
 * Pure. The server hashes each line's identifier with the match key before calling this, so no
 * identifier ever reaches it.
 */
import type { IsoDate } from "./dates";
import type { Cents } from "./money";
import type { ClaimStatus } from "./types";

/** One payment line, as the payer's file states it. A negative amount is a clawback or a recovery. */
export interface RemittanceLine {
  lineNo: number;
  portalReference: string | null;
  patientHash: string | null;
  visitDate: IsoDate | null;
  amountCents: number;
}

/** A claim of the file's payer. `outstandingCents` is what the payer still owes on it. */
export interface MatchCandidate {
  claimId: string;
  status: ClaimStatus;
  portalReference: string | null;
  patientHash: string;
  visitDate: IsoDate;
  outstandingCents: Cents;
}

/** Why a line was left for a person. */
export type UnmatchedReason =
  | { kind: "no_claim" }
  | { kind: "not_a_payment" }
  | { kind: "taken"; claimId: string }
  | { kind: "closed"; claimId: string; status: ClaimStatus };

export type LineMatch = { lineNo: number } & (
  | { kind: "reference" | "patient_date_amount"; claimId: string }
  | { kind: "ambiguous"; claimIds: string[] }
  | { kind: "unmatched"; reason: UnmatchedReason }
);

export interface MatchOptions {
  /** Claims already paid by a line of this file (a person's match, or an earlier pass). */
  taken?: readonly string[];
}

/** A payment can be recorded against these; any other status leaves the line for a person. */
const OPEN: ReadonlySet<ClaimStatus> = new Set(["submitted", "accepted"]);

/**
 * The key two portal references are compared on: the same reference whatever its case or the
 * spaces around it (N5). The schema compares on `upper(trim(...))`, the same key.
 */
export function referenceKey(reference: string): string {
  return reference.trim().toUpperCase();
}

/**
 * One result per line, in the lines' order. References are matched first, across the whole file;
 * then a line with no reference is matched on patient, visit date and the amount still owed, only
 * when exactly one open claim fits. A line never matches two claims and no claim takes two lines.
 */
export function matchRemittance(
  lines: readonly RemittanceLine[],
  candidates: readonly MatchCandidate[],
  options: MatchOptions = {},
): LineMatch[] {
  const taken = new Set(options.taken);
  const results = new Map<number, LineMatch>();
  const unmatched = (l: RemittanceLine, reason: UnmatchedReason): LineMatch => ({ lineNo: l.lineNo, kind: "unmatched", reason });

  for (const l of lines) {
    if (l.amountCents <= 0) results.set(l.lineNo, unmatched(l, { kind: "not_a_payment" }));
  }

  for (const l of lines) {
    if (results.has(l.lineNo) || l.portalReference === null) continue;
    const key = referenceKey(l.portalReference);
    const c = candidates.find((x) => x.portalReference !== null && referenceKey(x.portalReference) === key);
    if (!c) results.set(l.lineNo, unmatched(l, { kind: "no_claim" }));
    else if (!OPEN.has(c.status)) results.set(l.lineNo, unmatched(l, { kind: "closed", claimId: c.claimId, status: c.status }));
    else if (taken.has(c.claimId)) results.set(l.lineNo, unmatched(l, { kind: "taken", claimId: c.claimId }));
    else {
      taken.add(c.claimId);
      results.set(l.lineNo, { lineNo: l.lineNo, kind: "reference", claimId: c.claimId });
    }
  }

  for (const l of lines) {
    if (results.has(l.lineNo)) continue;
    results.set(l.lineNo, matchByPatient(l, candidates, taken, unmatched));
  }

  return lines.map((l) => results.get(l.lineNo) as LineMatch);
}

function matchByPatient(
  l: RemittanceLine,
  candidates: readonly MatchCandidate[],
  taken: Set<string>,
  unmatched: (l: RemittanceLine, reason: UnmatchedReason) => LineMatch,
): LineMatch {
  if (l.patientHash === null || l.visitDate === null) return unmatched(l, { kind: "no_claim" });
  const sameVisit = candidates.filter((c) => c.patientHash === l.patientHash && c.visitDate === l.visitDate);
  const open = sameVisit.filter((c) => OPEN.has(c.status) && c.outstandingCents === l.amountCents);
  const free = open.filter((c) => !taken.has(c.claimId));
  const [only] = free;
  if (only && free.length === 1) {
    taken.add(only.claimId);
    return { lineNo: l.lineNo, kind: "patient_date_amount", claimId: only.claimId };
  }
  if (free.length > 1) return { lineNo: l.lineNo, kind: "ambiguous", claimIds: free.map((c) => c.claimId) };
  const [first] = open;
  if (first) return unmatched(l, { kind: "taken", claimId: first.claimId });
  const closed = sameVisit.find((c) => !OPEN.has(c.status));
  if (closed && !sameVisit.some((c) => OPEN.has(c.status))) return unmatched(l, { kind: "closed", claimId: closed.claimId, status: closed.status });
  return unmatched(l, { kind: "no_claim" });
}
