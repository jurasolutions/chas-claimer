/**
 * Made-up identities for the synthetic clinic, drawn from a seeded generator. Every NRIC is in the
 * T9 block (decisions-g2 section 1), which can never have been issued; the generator throws rather
 * than emit one outside it (technical F13). Names, phones and member IDs are visibly fictional.
 */
import { isSynthetic, nricCheckLetter, type Nric } from "../../src/domain/nric";

/** mulberry32: a small, fast, seedable generator. The same seed gives the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = ["Alex", "Bailey", "Casey", "Devon", "Emery", "Finley", "Harper", "Jordan", "Kai", "Logan", "Morgan", "Noor", "Quinn", "Reese", "Rowan", "Sage", "Taylor", "Wren"];
/** Surnames that say what they are. */
const SURNAMES = ["Example", "Sample", "Placeholder", "Specimen", "Dummy", "Fixture", "Testcase", "Mockup"];

export interface Identities {
  /** A fresh T9 NRIC with a valid check letter, never repeated. */
  nric(): Nric;
  /** A fresh "First Surname" pair from the made-up lists, never repeated. */
  name(): string;
  /** A phone number no Singapore line can have: no Singapore number starts with 0. */
  phone(): string;
  /** A member ID in the TEST- range, never repeated. */
  memberId(): string;
}

export function createIdentities(seed: number): Identities {
  const rng = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;
  const used = new Set<string>();
  const fresh = (draw: () => string): string => {
    for (let i = 0; i < 10_000; i++) {
      const v = draw();
      if (!used.has(v)) {
        used.add(v);
        return v;
      }
    }
    throw new Error("ran out of synthetic values");
  };
  let phones = 0;
  return {
    nric() {
      const nric = fresh(() => {
        const digits = `9${String(Math.floor(rng() * 1_000_000)).padStart(6, "0")}`;
        return `T${digits}${nricCheckLetter("T", digits)}`;
      }) as Nric;
      if (!isSynthetic(nric)) throw new Error("the synthetic clinic generated an identifier outside the T9 block");
      return nric;
    },
    name: () => fresh(() => `${pick(FIRST_NAMES)} ${pick(SURNAMES)}`),
    phone: () => `+65 0000 ${String(++phones).padStart(4, "0")}`,
    memberId: () => fresh(() => `TEST-${String(Math.floor(rng() * 1_000_000)).padStart(6, "0")}`),
  };
}
