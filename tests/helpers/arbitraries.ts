import fc from "fast-check";
import { parseIsoDate, type IsoDate } from "../../src/domain/dates";
import { cents, type Cents } from "../../src/domain/money";
import { nricCheckLetter, parseNric } from "../../src/domain/nric";
import type { VisitIdentity } from "../../src/domain/source-visit";
import type { MatchCandidate, RemittanceLine } from "../../src/domain/matcher";
import { CLAIM_STATUSES, type Actor, type ClaimAction, type ClaimStatus } from "../../src/domain/types";

/**
 * The only arbitrary that makes identifiers. Every NRIC a test sees comes from the reserved
 * synthetic block T9000000-T9999999 with a valid check letter (GLOSSARY: synthetic NRIC).
 */
export const arbSyntheticNric: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 999_999 })
  .map((n) => {
    const digits = `9${n.toString().padStart(6, "0")}`;
    return `T${digits}${nricCheckLetter("T", digits)}`;
  });

export const arbCents: fc.Arbitrary<Cents> = fc.integer({ min: 0, max: 10_000_000 }).map((n) => cents(n));

const FIRST_DAY = Date.UTC(2025, 0, 1);
const LAST_DAY = Date.UTC(2027, 11, 31);

export const arbDate: fc.Arbitrary<IsoDate> = fc
  .integer({ min: 0, max: Math.round((LAST_DAY - FIRST_DAY) / 86_400_000) })
  .map((days) => parseIsoDate(new Date(FIRST_DAY + days * 86_400_000).toISOString().slice(0, 10))!);

/** A synthetic patient's identity: a T9 NRIC, and names, phones and member IDs that are plainly made up. */
export const arbVisitIdentity: fc.Arbitrary<VisitIdentity> = fc.record({
  nric: arbSyntheticNric.map((n) => parseNric(n)!),
  name: fc.constantFrom("Test Patient One", "Tan Synthetic", "Lim Example", "Ng Placeholder"),
  phone: fc.integer({ min: 0, max: 9999 }).map((n) => `+65 9000 ${n.toString().padStart(4, "0")}`),
  dateOfBirth: arbDate,
  address: fc.option(fc.constant("1 Example Street, Singapore 000001"), { nil: null }),
  memberIds: fc.array(fc.record({ payerId: fc.constantFrom("MERIDIAN", "HARBOUR"), memberId: fc.stringMatching(/^TEST-[0-9]{6}$/) }), { maxLength: 2 }),
  accountHolderNric: fc.option(arbSyntheticNric.map((n) => parseNric(n)!), { nil: null }),
  notes: fc.option(fc.constant("Test Patient One asked for a longer consultation."), { nil: null }),
  preAuthRefs: fc.array(
    fc.record({ payerId: fc.constantFrom("MERIDIAN", "HARBOUR"), benefitCode: fc.constant("HTPA-CRN"), reference: fc.stringMatching(/^PA-[0-9]{4}$/) }),
    { maxLength: 2 },
  ),
});

const arbReason = fc.constantFrom("", "  ", "Payer's reason", "Patient paid in cash");

/** Any claim action, with a payload that may or may not be acceptable. */
export const arbClaimAction: fc.Arbitrary<ClaimAction> = fc.oneof(
  fc.constant<ClaimAction>({ kind: "approve" }),
  fc.constant<ClaimAction>({ kind: "unapprove" }),
  fc.option(fc.constantFrom("", "REF-1", " REF-2 "), { nil: undefined }).map((portalReference): ClaimAction => ({ kind: "submit", portalReference })),
  arbReason.map((message): ClaimAction => ({ kind: "portal_refused", message })),
  fc
    .record({ acceptedCents: fc.option(fc.integer({ min: 0, max: 20_000 }).map((n) => cents(n)), { nil: undefined }), reason: fc.option(arbReason, { nil: undefined }) })
    .map((p): ClaimAction => ({ kind: "accept", ...p })),
  arbReason.map((reason): ClaimAction => ({ kind: "reject", reason })),
  fc
    .record({ cents: fc.integer({ min: 0, max: 20_000 }).map((n) => cents(n)), paidOn: arbDate, remittanceLineId: fc.option(fc.constant("RL-1"), { nil: undefined }) })
    .map((p): ClaimAction => ({ kind: "record_payment", ...p })),
  arbReason.map((reason): ClaimAction => ({ kind: "accept_short_payment", reason })),
  fc.constant<ClaimAction>({ kind: "reopen" }),
  arbReason.map((reason): ClaimAction => ({ kind: "withdraw", reason })),
  arbReason.map((reason): ClaimAction => ({ kind: "write_off", reason })),
  arbReason.map((note): ClaimAction => ({ kind: "acknowledge_change", note })),
);

/** Who takes each action: people in either role or both, and the system actors. */
export const arbActor: fc.Arbitrary<Actor> = fc.constantFrom<Actor>(
  { kind: "person", email: "reviewer@example.com", roles: ["reviewer"] },
  { kind: "person", email: "officer@example.com", roles: ["officer"] },
  { kind: "person", email: "both@example.com", roles: ["reviewer", "officer"] },
  { kind: "system", name: "simulator" },
  { kind: "system", name: "remittance" },
  { kind: "system", name: "connector" },
);

/** A run of actions against one claim, each with the actor taking it (SC4.2). */
export const arbActionSequence: fc.Arbitrary<Array<{ action: ClaimAction; actor: Actor }>> = fc.array(
  fc.record({ action: arbClaimAction, actor: arbActor }),
  { minLength: 1, maxLength: 30 },
);

// ---------------------------------------------------------------- remittance matching (ticket 08)

/**
 * Small pools so that references, patients, dates and amounts collide often: the matcher's
 * interesting cases are ties, repeats and claims that two lines both fit.
 */
const arbMatchRef = fc.constantFrom("R-1", "R-2", "R-3", "R-4", "UNKNOWN-1");
const arbMatchPatient = fc.constantFrom("v1:p1", "v1:p2");
const arbMatchDate = fc.constantFrom("2026-11-10", "2026-11-11").map((d) => parseIsoDate(d)!);
const arbMatchAmount = fc.constantFrom(2050, 5050);

/** Claims of one payer with distinct ids and distinct portal references, in every status. */
export const arbClaims: fc.Arbitrary<MatchCandidate[]> = fc
  .uniqueArray(
    fc.record({
      portalReference: fc.option(arbMatchRef, { nil: null }),
      status: fc.oneof(
        { arbitrary: fc.constantFrom<ClaimStatus>("submitted", "accepted"), weight: 3 },
        { arbitrary: fc.constantFrom<ClaimStatus>(...CLAIM_STATUSES), weight: 1 },
      ),
      patientHash: arbMatchPatient,
      visitDate: arbMatchDate,
      outstandingCents: arbMatchAmount.map((n) => cents(n)),
    }),
    { maxLength: 8, selector: (c) => c.portalReference ?? Symbol() },
  )
  .map((claims) => claims.map((c, i) => ({ claimId: `C${i + 1}`, ...c })));

/** A payer's file: numbered lines, some with a reference, some negative or zero, some repeated. */
export const arbRemittance: fc.Arbitrary<RemittanceLine[]> = fc
  .array(
    fc.record({
      portalReference: fc.oneof(fc.constant(null), arbMatchRef),
      patientHash: fc.option(arbMatchPatient, { nil: null, freq: 8 }),
      visitDate: fc.option(arbMatchDate, { nil: null, freq: 8 }),
      amountCents: fc.oneof({ arbitrary: arbMatchAmount, weight: 4 }, { arbitrary: fc.constantFrom(0, -5050), weight: 1 }),
    }),
    { minLength: 1, maxLength: 10 },
  )
  .map((lines) => lines.map((l, i) => ({ lineNo: i + 1, ...l })));
