import { describe, expect, it } from "vitest";
import { formatDateTime, inSentence, plural } from "./format";

describe("plural", () => {
  it("counts one thing in the singular and any other number in the plural", () => {
    expect(plural(1, "claim")).toBe("1 claim");
    expect(plural(0, "warning")).toBe("0 warnings");
    expect(plural(3, "claim")).toBe("3 claims");
  });
});

describe("inSentence", () => {
  it("lowercases a field label's first word for use mid-sentence, and leaves an acronym alone", () => {
    expect(inSentence("Claim amount")).toBe("claim amount");
    expect(inSentence("Patient NRIC/FIN")).toBe("patient NRIC/FIN");
    expect(inSentence("NRIC/FIN")).toBe("NRIC/FIN");
    expect(inSentence("CHAS procedure")).toBe("CHAS procedure");
    expect(inSentence("")).toBe("");
  });
});

describe("formatDateTime", () => {
  it("reads a recorded moment in Singapore time, with plain spaces whatever the ICU build uses", () => {
    expect(formatDateTime("2026-11-12T02:05:00.000Z")).toBe("12 Nov 2026, 10:05 am");
    expect(formatDateTime("2026-11-13T09:30:00.000Z")).toBe("13 Nov 2026, 5:30 pm");
    expect(formatDateTime("2026-11-12T02:05:00.000Z")).not.toMatch(/[\u00a0\u202f]/);
  });
});
