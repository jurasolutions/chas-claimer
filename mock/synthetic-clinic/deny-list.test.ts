/**
 * The repo is public, so the synthetic clinic names only fictional payers (decisions-g2 §11).
 * This deny list catches a real Singapore insurer, TPA or dental network, or a real-looking
 * benefit code, slipping into the generated data or the generator's source.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseIsoDate, type IsoDate } from "../../src/domain/dates";
import { generateClinic } from "./generate";

const T = parseIsoDate("2026-11-13") as IsoDate;

/** Matched as whole words, case-sensitively, so "Income" does not flag "income" or "Incomes". */
const DENIED = [
  "Singlife",
  "AIA",
  "Great Eastern",
  "Prudential",
  "NTUC Income",
  "Income",
  "Allianz",
  "AXA",
  "Cigna",
  "IHP",
  "Fullerton",
  "MHC Asia",
  "Alliance Healthcare",
  "Parkway Shenton",
  "iXchange",
  "Aon",
  "Denticare",
  "A01",
  "N01",
];

const hits = (text: string) => DENIED.filter((name) => new RegExp(`(?<![A-Za-z0-9])${name}(?![A-Za-z0-9])`).test(text));

describe("synthetic clinic: no real payer names (decisions-g2 §11)", () => {
  it("the deny list matches whole words only", () => {
    expect(hits("Paid by AIA Singapore")).toEqual(["AIA"]);
    expect(hits("Daonia, MAIAN, Incomes, low income, A012")).toEqual([]);
  });

  it("names no real insurer, TPA or benefit code in the generated clinic", () => {
    for (const seed of [1, 7, 42]) expect(hits(JSON.stringify(generateClinic({ seed, asOf: T })))).toEqual([]);
  });

  it("names none in the generator's source either", () => {
    const dir = __dirname;
    const sources = readdirSync(dir).filter((f) => !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(0);
    for (const f of sources) expect([f, hits(readFileSync(join(dir, f), "utf8"))]).toEqual([f, []]);
  });

  it("insures patients through the fictional payers only", () => {
    const clinic = generateClinic({ seed: 7, asOf: T });
    const names = new Map(clinic.settings.payers.map((p) => [p.id, p.name]));
    const insurers = new Set(clinic.visits.flatMap((v) => v.policies.map((p) => names.get(p.payerId))));
    expect([...insurers].sort()).toEqual(["Harbour TPA", "Meridian Dental Plan"]);
  });
});
