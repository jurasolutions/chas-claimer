import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { VisitIdentity } from "../../src/domain/source-visit";
import { arbSyntheticNric, arbVisitIdentity } from "../../tests/helpers/arbitraries";
import { deidentify } from "./deidentify";

/** Ways people write the same value: as it is, upper or lower case, spaced out, or run together. */
const arbSpelling = (value: string): fc.Arbitrary<string> =>
  fc.constantFrom(
    value,
    value.toUpperCase(),
    value.toLowerCase(),
    value.replace(/\s+/g, ""),
    value.replace(/\s+/g, "  "),
    value.split("").join(" "),
  );

/** Every identity value of a visit that may turn up in free text. */
function identityValues(identity: VisitIdentity): string[] {
  return [
    identity.nric,
    identity.name,
    ...identity.name.split(/\s+/),
    identity.phone,
    identity.dateOfBirth,
    ...(identity.address ? [identity.address] : []),
    ...identity.memberIds.map((m) => m.memberId),
    ...(identity.accountHolderNric ? [identity.accountHolderNric] : []),
    ...identity.preAuthRefs.map((p) => p.reference),
  ];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The ways a clinic writes a date of birth: day first with / - or ., with or without leading zeros, or with the month in words. */
function dobRenderings(iso: string): string[] {
  const [y, m, d] = iso.split("-");
  const day = String(Number(d));
  const month = String(Number(m));
  const name = MONTHS[Number(m) - 1]!;
  return [
    `${d}/${m}/${y}`,
    `${day}/${month}/${y}`,
    `${d}-${m}-${y}`,
    `${d}.${m}.${y}`,
    `${day} ${name.slice(0, 3)} ${y}`,
    `${day} ${name} ${y}`,
    `${d}-${name.slice(0, 3)}-${y}`,
  ];
}

/** Words a dentist or a payer writes that identify no one. None contains a synthetic name token. */
const arbFiller = fc.constantFrom(
  "extended consultation at the patient's request",
  "crown on tooth 14",
  "above the benchmark fee",
  "the payer refused the claim",
  "S$800.00",
  ":",
  ",",
  "(",
  ")",
);

const arbOtherIdentifier = fc.oneof(
  arbSyntheticNric,
  arbSyntheticNric.map((n) => n.toLowerCase()),
  fc.integer({ min: 0, max: 9999 }).map((n) => `9000 ${n.toString().padStart(4, "0")}`),
  fc.integer({ min: 0, max: 9999 }).map((n) => `8000-${n.toString().padStart(4, "0")}`),
  fc.integer({ min: 0, max: 9999 }).map((n) => `+65 0000 ${n.toString().padStart(4, "0")}`),
  fc.constantFrom("someone@example.test", "a.b+c@clinic.example.com"),
  fc.constantFrom("Singapore 000001", "S(123456)"),
);

/** Free text carrying the visit's own identifiers, spelt any way, and identifiers of other people. */
const arbIdentifierLadenText = (identity: VisitIdentity): fc.Arbitrary<string> =>
  fc
    .array(
      fc.oneof(
        arbFiller,
        arbOtherIdentifier,
        fc.constantFrom(...identityValues(identity)).chain(arbSpelling),
        fc.constantFrom(...dobRenderings(identity.dateOfBirth)).chain(arbSpelling),
      ),
      { minLength: 1, maxLength: 12 },
    )
    .map((parts) => parts.join(" "));

/** The test's own detectors, written apart from the module's. */
const squash = (s: string) => s.toLowerCase().replace(/[\s.\-+]/g, "");
const NRIC = /[STFGM]\s?\d{7}\s?[A-Z]/i;
const EMAIL = /\S@\S/;
const LONG_DIGITS = /\d(?:[ -]?\d){5,}/;

describe("deidentify", () => {
  it("leaves no identity value of the visit, and no NRIC, phone, email or postal code, in what it returns", () => {
    fc.assert(
      fc.property(
        arbVisitIdentity.chain((identity) => fc.tuple(fc.constant(identity), arbIdentifierLadenText(identity))),
        ([identity, text]) => {
          const result = deidentify(text, identity);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const out = result.value;
          for (const value of identityValues(identity)) {
            if (value.length < 2) continue;
            if (/\s/.test(value) || value.length >= 5) expect(squash(out)).not.toContain(squash(value));
            else expect(out).not.toMatch(new RegExp(`(?<![a-z])${value}(?![a-z])`, "i"));
          }
          for (const dob of dobRenderings(identity.dateOfBirth)) expect(squash(out)).not.toContain(squash(dob));
          expect(out).not.toMatch(NRIC);
          expect(out).not.toMatch(EMAIL);
          expect(out).not.toMatch(LONG_DIGITS);
        },
      ),
    );
  });

  it("keeps the clinical words around what it redacts", () => {
    const identity: VisitIdentity = {
      nric: "T9000018H" as VisitIdentity["nric"],
      name: "Test Patient One",
      phone: "+65 0000 0018",
      dateOfBirth: "1960-04-02" as VisitIdentity["dateOfBirth"],
      address: null,
      memberIds: [],
      accountHolderNric: null,
      notes: null,
      preAuthRefs: [],
    };
    const result = deidentify("Mdm Test Patient One, T9000018H, +65 0000 0018: extended consultation at the patient's request.", identity);

    expect(result).toEqual({ ok: true, value: "Mdm [redacted], [redacted], [redacted]: extended consultation at the [redacted]'s request." });
  });

  it("redacts the visit's own date of birth however the clinic wrote it", () => {
    const identity: VisitIdentity = {
      nric: "T9000018H" as VisitIdentity["nric"],
      name: "Test Patient One",
      phone: "+65 0000 0018",
      dateOfBirth: "1960-03-04" as VisitIdentity["dateOfBirth"],
      address: null,
      memberIds: [],
      accountHolderNric: null,
      notes: null,
      preAuthRefs: [],
    };
    const written = ["04/03/1960", "4/3/1960", "04-03-1960", "4.3.1960", "4 Mar 1960", "4 March 1960", "04-Mar-1960", "4th March, 1960", "March 4, 1960", "4/3/60"];

    for (const dob of written) {
      expect(deidentify(`Elderly patient, born ${dob}, seen 2026-11-14 for scaling.`, identity)).toEqual({
        ok: true,
        value: "Elderly [redacted], born [redacted], seen 2026-11-14 for scaling.",
      });
    }
  });

  it("fails closed on a date of birth it does not know, labelled as one", () => {
    for (const text of ["DOB: 05/06/1971, scaling", "D.O.B. 5 June 1971", "born on 5-Jun-1971", "Date of birth 1971-06-05", "born June 5, 1971"]) {
      expect(deidentify(text)).toEqual({ ok: false, error: "identifiers_remain" });
    }
  });

  it("redacts patterns when it has no visit to match against", () => {
    const result = deidentify("Laser gum contouring for +65 0000 0042, a.b@example.test, Singapore 000001");

    expect(result).toEqual({ ok: true, value: "Laser gum contouring for [redacted], [redacted], Singapore [redacted]" });
  });

  it("fails closed when something that looks like an identifier is left after redaction", () => {
    expect(deidentify("Call 9 0 0 0 0 0 1 8 after the visit")).toEqual({ ok: false, error: "identifiers_remain" });
    expect(deidentify("Write to tan@clinic")).toEqual({ ok: false, error: "identifiers_remain" });
  });

  it("leaves clinical text with no identifiers as it is", () => {
    const text = "RCT-M on tooth 14, S$800.00 against a benchmark of S$650.00, seen 2026-11-02.";
    expect(deidentify(text)).toEqual({ ok: true, value: text });
  });
});
