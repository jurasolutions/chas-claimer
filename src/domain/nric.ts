/**
 * Singapore NRIC and FIN numbers: a prefix letter, seven digits and a check letter.
 * This file never logs or echoes a number; callers mask before display.
 */
export type Nric = string & { readonly __brand: "Nric" };

export type NricPrefix = "S" | "T" | "F" | "G" | "M";

const WEIGHTS = [2, 7, 6, 5, 4, 3, 2] as const;
const OFFSET: Record<NricPrefix, number> = { S: 0, T: 4, F: 0, G: 4, M: 3 };
const LETTERS: Record<NricPrefix, string> = {
  S: "JZIHGFEDCBA",
  T: "JZIHGFEDCBA",
  F: "XWUTRQPNMLK",
  G: "XWUTRQPNMLK",
  M: "XWUTRQPNJLK",
};
const SHAPE = /^([STFGM])(\d{7})([A-Z])$/;
const SYNTHETIC = /^T9\d{6}[A-Z]$/;

/** The check letter for a prefix and seven digits. */
export function nricCheckLetter(prefix: NricPrefix | string, digits: string): string {
  if (!(prefix in OFFSET) || !/^\d{7}$/.test(digits)) {
    throw new RangeError("nricCheckLetter needs a known prefix and seven digits");
  }
  const p = prefix as NricPrefix;
  let total = OFFSET[p];
  for (let i = 0; i < 7; i += 1) total += Number(digits[i]) * WEIGHTS[i]!;
  return LETTERS[p][total % 11]!;
}

/** Trims, upper-cases and checks the check letter. Null for anything that is not a valid number. */
export function parseNric(raw: string): Nric | null {
  const normalised = raw.trim().toUpperCase();
  const match = SHAPE.exec(normalised);
  if (!match) return null;
  return nricCheckLetter(match[1]!, match[2]!) === match[3] ? (normalised as Nric) : null;
}

/** True only for the reserved synthetic block: T9000000-T9999999 with a valid check letter. */
export function isSynthetic(n: Nric): boolean {
  return SYNTHETIC.test(n) && parseNric(n) === n;
}

/** "T9000000J" -> "T••••000J": the prefix, the last three digits and the check letter only. */
export function maskNric(n: Nric): string {
  return `${n[0]}••••${n.slice(5)}`;
}
