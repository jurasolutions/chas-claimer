import fc from "fast-check";
import { arbDate } from "../../tests/helpers/arbitraries";
import { addDays, ageOn, daysBetween, parseIsoDate, sgtDay } from "./dates";

const d = (s: string) => {
  const parsed = parseIsoDate(s);
  if (!parsed) throw new Error(`bad fixture date ${s}`);
  return parsed;
};

describe("dates", () => {
  it("accepts real calendar dates only", () => {
    expect(parseIsoDate("2026-11-13")).toBe("2026-11-13");
    expect(parseIsoDate("2028-02-29")).toBe("2028-02-29");
    for (const bad of ["2026-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "26-11-13", "2026-1-13", "2026-11-13T00:00", ""]) {
      expect(parseIsoDate(bad)).toBeNull();
    }
  });

  it("gives the Singapore calendar day of an instant", () => {
    // 2026-11-12T16:30Z is 00:30 on 13 Nov in Singapore
    expect(sgtDay(Date.UTC(2026, 10, 12, 16, 30))).toBe("2026-11-13");
    expect(sgtDay(Date.UTC(2026, 10, 12, 15, 59))).toBe("2026-11-12");
    expect(sgtDay(Date.UTC(2026, 11, 31, 16, 0))).toBe("2027-01-01");
  });

  it("adds days across month, year and leap-day boundaries", () => {
    expect(addDays(d("2026-11-13"), 30)).toBe("2026-12-13");
    expect(addDays(d("2026-12-20"), 30)).toBe("2027-01-19");
    expect(addDays(d("2028-02-28"), 1)).toBe("2028-02-29");
    expect(addDays(d("2026-03-01"), -1)).toBe("2026-02-28");
  });

  it("counts whole days between two dates", () => {
    expect(daysBetween(d("2026-10-14"), d("2026-11-13"))).toBe(30);
    expect(daysBetween(d("2026-11-13"), d("2026-10-14"))).toBe(-30);
  });

  it("gives the age on a date, a year older on the birthday itself", () => {
    expect(ageOn(d("1966-11-13"), d("2026-11-13"))).toBe(60);
    expect(ageOn(d("1966-11-14"), d("2026-11-13"))).toBe(59);
    // 29 Feb birthdays turn a year older on 1 Mar in a non-leap year
    expect(ageOn(d("1964-02-29"), d("2025-02-28"))).toBe(60);
    expect(ageOn(d("1964-02-29"), d("2026-02-28"))).toBe(61);
    expect(ageOn(d("1964-02-29"), d("2027-02-28"))).toBe(62);
    expect(ageOn(d("1964-02-29"), d("2027-03-01"))).toBe(63);
  });

  it("addDays and daysBetween agree", () => {
    fc.assert(
      fc.property(arbDate, fc.integer({ min: -800, max: 800 }), (date, n) => daysBetween(date, addDays(date, n)) === n),
    );
  });
});
