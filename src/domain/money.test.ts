import fc from "fast-check";
import { arbCents } from "../../tests/helpers/arbitraries";
import { add, cents, formatDecimal, formatSgd, min, parseDollars, subtract, type Cents } from "./money";

describe("money", () => {
  it("parses dollar text into integer cents", () => {
    expect(parseDollars("462.50")).toEqual({ ok: true, value: 46250 });
    expect(parseDollars("21")).toEqual({ ok: true, value: 2100 });
    expect(parseDollars(" 1,400.05 ")).toEqual({ ok: true, value: 140005 });
    expect(parseDollars("0.5")).toEqual({ ok: true, value: 50 });
  });

  it("refuses text that is not a non-negative amount with at most two decimals", () => {
    for (const bad of ["", "abc", "-1.00", "1.234", "1e3", "$5", "NaN", "Infinity", ".5.", "1..0", ",", "1,00"]) {
      expect(parseDollars(bad)).toEqual({ ok: false, error: "invalid" });
    }
  });

  it("refuses fractions, negatives and unsafe numbers as cents", () => {
    expect(() => cents(1.5)).toThrow();
    expect(() => cents(-1)).toThrow();
    expect(() => cents(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => cents(Number.NaN)).toThrow();
    expect(cents(0)).toBe(0);
  });

  it("formats cents as Singapore dollars", () => {
    expect(formatSgd(cents(46250))).toBe("$462.50");
    expect(formatSgd(cents(5))).toBe("$0.05");
    expect(formatSgd(cents(140000))).toBe("$1,400.00");
    expect(formatSgd(cents(123456789))).toBe("$1,234,567.89");
    expect(formatSgd(cents(0))).toBe("$0.00");
  });

  it("puts a negative amount's sign before the dollar sign", () => {
    expect(formatSgd(-50 as Cents)).toBe("-$0.50");
    expect(formatSgd(-12345 as Cents)).toBe("-$123.45");
    expect(formatSgd(-123456789 as Cents)).toBe("-$1,234,567.89");
  });

  it("takes cents only, never a plain number such as a dollar value", () => {
    // @ts-expect-error a bare number is not Cents
    expect(() => formatSgd(462.5)).toThrow(RangeError);
    // A cast past the type still can't print a fraction of a cent.
    expect(() => formatSgd(1.5 as Cents)).toThrow(RangeError);
  });

  it("adds, subtracts and takes the minimum", () => {
    expect(add(cents(2100), cents(3100), cents(5))).toBe(5205);
    expect(add()).toBe(0);
    expect(subtract(cents(3100), cents(2100))).toBe(1000);
    expect(() => subtract(cents(100), cents(101))).toThrow();
    expect(min(cents(75000), cents(46250), cents(140000))).toBe(46250);
  });

  it("never gives a fraction or a negative from add, subtract or min", () => {
    const isWhole = (c: Cents) => Number.isSafeInteger(c) && c >= 0;
    fc.assert(
      fc.property(fc.array(arbCents, { minLength: 1, maxLength: 20 }), (xs) => {
        const first = xs[0]!;
        const sum = add(...xs);
        const low = min(...xs);
        const diff = subtract(sum, first);
        return isWhole(sum) && isWhole(low) && isWhole(diff) && low <= first && diff <= sum;
      }),
    );
  });

  it("round-trips formatted amounts through parseDollars", () => {
    fc.assert(
      fc.property(arbCents, (c) => {
        const parsed = parseDollars(formatSgd(c).slice(1));
        return parsed.ok && parsed.value === c;
      }),
    );
  });
});

describe("formatDecimal", () => {
  it("writes cents as plain dollars with two decimals: no sign, no separators, minus for a negative", () => {
    expect(formatDecimal(5050)).toBe("50.50");
    expect(formatDecimal(0)).toBe("0.00");
    expect(formatDecimal(7)).toBe("0.07");
    expect(formatDecimal(140005)).toBe("1400.05");
    expect(formatDecimal(-50)).toBe("-0.50");
  });

  it("reads back as the same cents for any amount", () => {
    fc.assert(
      fc.property(arbCents, (c) => {
        expect(parseDollars(formatDecimal(c))).toEqual({ ok: true, value: c });
      }),
    );
  });

  it("refuses a fraction of a cent", () => {
    expect(() => formatDecimal(10.5)).toThrow(RangeError);
  });
});
