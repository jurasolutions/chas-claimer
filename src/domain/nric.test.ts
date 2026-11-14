import fc from "fast-check";
import { arbSyntheticNric } from "../../tests/helpers/arbitraries";
import { isSynthetic, maskNric, nricCheckLetter, parseNric, type Nric } from "./nric";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";

describe("NRIC and FIN", () => {
  // The repo holds no NRIC-shaped string outside the synthetic T9 block (SC7.6), so the
  // published check-letter examples for digits 1234567 are written as prefix, digits, letter.
  it("gives the published check letter for digits 1234567 under each prefix", () => {
    expect(nricCheckLetter("S", "1234567")).toBe("D");
    expect(nricCheckLetter("T", "1234567")).toBe("J");
    expect(nricCheckLetter("F", "1234567")).toBe("N");
    expect(nricCheckLetter("G", "1234567")).toBe("X");
    expect(nricCheckLetter("M", "1234567")).toBe("K");
  });

  it("accepts a synthetic number worked by hand", () => {
    // 4 (T offset) + 9 x 2 = 22; 22 mod 11 = 0; the S/T table starts with J
    expect(parseNric("T9000000J")).toBe("T9000000J");
  });

  it("trims and upper-cases before checking", () => {
    expect(parseNric("  t9000000j ")).toBe("T9000000J");
  });

  it("refuses wrong check letters, unknown prefixes and wrong lengths", () => {
    for (const bad of ["T9000000A", "A9000000J", "T900000J", "T90000000J", "", "T9000000", "9000000J", "T90000 0J"]) {
      expect(parseNric(bad)).toBeNull();
    }
  });

  it("round-trips the check letter for every prefix", () => {
    fc.assert(
      fc.property(fc.constantFrom("S", "T", "F", "G", "M"), fc.stringMatching(/^\d{7}$/), (prefix, digits) => {
        const letter = nricCheckLetter(prefix, digits);
        const valid = [...ALPHABET].filter((c) => parseNric(`${prefix}${digits}${c}`) !== null);
        return valid.length === 1 && valid[0] === letter;
      }),
    );
  });

  it("calls only valid T9 numbers synthetic", () => {
    expect(isSynthetic(parseNric("T9000000" + nricCheckLetter("T", "9000000"))!)).toBe(true);
    expect(isSynthetic(parseNric("T8999999" + nricCheckLetter("T", "8999999"))!)).toBe(false);
    expect(isSynthetic(parseNric("S9000000" + nricCheckLetter("S", "9000000"))!)).toBe(false);
    expect(isSynthetic("T9000000A" as Nric)).toBe(false);
  });

  it("generates synthetic numbers that the validator accepts and calls synthetic", () => {
    fc.assert(
      fc.property(arbSyntheticNric, (raw) => {
        const parsed = parseNric(raw);
        return parsed !== null && /^T9\d{6}[A-Z]$/.test(parsed) && isSynthetic(parsed);
      }),
    );
  });

  it("rejects every single-character change of a valid number", () => {
    fc.assert(
      fc.property(arbSyntheticNric, fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 25 }), (raw, at, pick) => {
        const pool = at >= 1 && at <= 7 ? DIGITS : ALPHABET;
        const replacement = pool[pick % pool.length]!;
        if (replacement === raw[at]) return true;
        const mutated = raw.slice(0, at) + replacement + raw.slice(at + 1);
        return parseNric(mutated) === null;
      }),
    );
  });

  it("normalising twice equals normalising once", () => {
    fc.assert(
      fc.property(arbSyntheticNric, fc.constantFrom("", " ", "  "), fc.boolean(), (raw, pad, lower) => {
        const input = pad + (lower ? raw.toLowerCase() : raw) + pad;
        const once = parseNric(input);
        return once !== null && parseNric(once) === once;
      }),
    );
  });

  it("masks all but the last three digits and the check letter", () => {
    expect(maskNric(parseNric("T9000000J")!)).toBe("T••••000J");
    fc.assert(
      fc.property(arbSyntheticNric, (raw) => {
        const masked = maskNric(parseNric(raw)!);
        const shownDigits = masked.replace(/\D/g, "");
        return shownDigits === raw.slice(5, 8) && masked.endsWith(raw.slice(8)) && !masked.includes(raw.slice(1, 5));
      }),
    );
  });
});
