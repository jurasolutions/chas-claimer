import { describe, expect, it } from "vitest";
import type { IsoDate } from "../dates";
import tospData from "./data/medisave-tosp-2024-01-01.json";
import { listRuleSets, ruleSetFor } from "./index";

const d = (s: string) => s as IsoDate;

/** functional §1.5, CHAS dental subsidy caps from 1 Oct 2025, in cents: [PG, MG, Blue, Orange]. */
const SUBSIDIES: Record<string, [number, number, number, number]> = {
  CONSULTATION: [3050, 2550, 2050, 1350],
  POLISHING: [3050, 2550, 2050, 1350],
  SCALING: [4000, 3500, 3000, 2000],
  TOPICAL_FLUORIDE: [3050, 2550, 2050, 1350],
  XRAY: [2100, 1600, 1100, 750],
  EXTRACTION_ANTERIOR: [3850, 3350, 2850, 1900],
  EXTRACTION_POSTERIOR: [7850, 7350, 6850, 4550],
  FILLING_COMPLEX: [6000, 5500, 5000, 3350],
  FILLING_SIMPLE: [4000, 3500, 3000, 2000],
  RECEMENTATION: [4500, 4000, 3500, 2350],
  DENTURE_RELINE_REPAIR: [8500, 8000, 7500, 5000],
  CROWN_PERMANENT: [62500, 62000, 61500, 41000],
  COMPLETE_DENTURE: [41850, 41350, 40850, 27250],
  PARTIAL_COMPLEX_DENTURE: [39550, 39050, 38550, 25700],
  PARTIAL_SIMPLE_DENTURE: [31400, 30900, 30400, 20250],
  RCT_ANTERIOR: [33600, 33100, 32600, 21750],
  RCT_MOLAR: [59450, 58950, 58450, 38950],
  RCT_PREMOLAR: [47250, 46750, 46250, 30850],
};

/**
 * docs/research/sg-dental-claims.md §2.1, transcribed by hand from the note, not from the rule set
 * file (SC7.2). Day-surgery withdrawal limits in dollars, CPF "Last updated on 1 April 2025".
 * The note's $830-a-day ward limit is not here: the desk claims no ward charges, so no rule set
 * ships it.
 */
const TOSP_TABLE_LIMITS: Record<string, number> = {
  "1A": 240, "1B": 420, "1C": 490,
  "2A": 760, "2B": 1120, "2C": 1120,
  "3A": 1390, "3B": 1740, "3C": 1920,
  "4A": 2380, "4B": 2440, "4C": 2540,
  "5A": 2610, "5B": 2660, "5C": 2770,
  "6A": 3260, "6B": 3610, "6C": 3960,
  "7A": 4340, "7B": 4830, "7C": 5290,
};

/**
 * The note's TOSP dental subset and rankings (TOSP edition 1 Jan 2024). Where the note gives only a
 * range across several codes (SF701T–SF705T "1C–4A", SB807M–SB810M "2B–4A"), no code's own ranking
 * is known, so each is null and is not claimable until it is.
 */
const TOSP_RANKINGS: Record<string, string | null> = {
  SF812T: "1B",
  SF813T: "2C",
  SF810T: "3A",
  SF801T: "3B",
  SF800T: "3C",
  SF803T: "4A",
  SF802T: "4B",
  SF811T: "MSP",
  SF816T: "2C",
  SF817T: "4A",
  ...Object.fromEntries(["SF701T", "SF702T", "SF703T", "SF704T", "SF705T"].map((c) => [c, null])),
  SF708T: "2C",
  SF818T: "3A",
  SF814T: "3A",
  SB816M: "2C",
  SB702M: "1C",
  SB802M: "3A",
  SB803M: "2C",
  ...Object.fromEntries(["SB807M", "SB808M", "SB809M", "SB810M"].map((c) => [c, null])),
  SF703M: "1B",
  SF706M: "2A",
  SF709M: "2C",
  SF710M: "2A",
  SF701M: "1B",
};

describe("ruleSetFor chas", () => {
  it("has no rule set before 1 Oct 2025", () => {
    expect(ruleSetFor("chas", d("2025-09-30"))).toBeNull();
  });

  it("covers 1 Oct 2025 onwards with a 30-day window and dated sources", () => {
    const rs = ruleSetFor("chas", d("2025-10-01"));
    expect(rs?.id).toBe("chas-2025-10-01");
    expect(rs?.windowDays).toBe(30);
    expect(rs?.sources.map((s) => s.url)).toContain("https://www.chas.sg/chas-dental-subsidies");
    expect(rs?.sources.every((s) => s.retrieved === "2026-11-13")).toBe(true);
    expect(ruleSetFor("chas", d("2026-11-13"))?.id).toBe("chas-2025-10-01");
  });

  it.each(Object.entries(SUBSIDIES))("matches the published %s caps for every tier", (code, [pg, mg, blue, orange]) => {
    const proc = ruleSetFor("chas", d("2026-01-01"))!.procedures[code];
    expect(proc?.subsidyCents).toEqual({ PG: pg, MG: mg, Blue: blue, Orange: orange });
  });

  it("lists exactly the published procedures", () => {
    expect(Object.keys(ruleSetFor("chas", d("2026-01-01"))!.procedures).sort()).toEqual(Object.keys(SUBSIDIES).sort());
  });

  it("gives Green no dental subsidy and Public Assistance the full fee", () => {
    const rs = ruleSetFor("chas", d("2026-01-01"))!;
    expect(rs.tierBasis).toEqual({ PG: "table", MG: "table", Blue: "table", Orange: "table", Green: "none", PA: "full_fee" });
  });

  it("holds the published frequency limits, shared where the scheme shares them", () => {
    const p = ruleSetFor("chas", d("2026-01-01"))!.procedures;
    expect(p.SCALING?.limit).toEqual({ group: "SCALING", count: 2, periodYears: 1 });
    expect(p.XRAY?.limit).toEqual({ group: "XRAY", count: 6, periodYears: 1 });
    expect(p.EXTRACTION_ANTERIOR?.limit).toEqual({ group: "EXTRACTION", count: 4, periodYears: 1 });
    expect(p.EXTRACTION_POSTERIOR?.limit).toEqual(p.EXTRACTION_ANTERIOR?.limit);
    expect(p.FILLING_SIMPLE?.limit).toEqual({ group: "FILLING", count: 6, periodYears: 1 });
    expect(p.CROWN_PERMANENT?.limit).toEqual({ group: "CROWN_PERMANENT", count: 4, periodYears: 1 });
    expect(p.RCT_MOLAR?.limit).toEqual({ group: "RCT", count: 2, periodYears: 1 });
    expect(p.COMPLETE_DENTURE?.limit).toEqual({ group: "COMPLETE_DENTURE", count: 2, periodYears: 3 });
    expect(p.PARTIAL_SIMPLE_DENTURE?.limit).toEqual({ group: "PARTIAL_DENTURE", count: 2, periodYears: 3 });
  });

  it("applies MOH benchmarks only to visits from 1 Sep 2026, and only the two it publishes", () => {
    const before = ruleSetFor("chas", d("2026-08-31"))!;
    expect(before.benchmarkFor("CONSULTATION")).toBeNull();
    const after = ruleSetFor("chas", d("2026-09-01"))!;
    expect(after.benchmarkFor("CONSULTATION")).toMatchObject({ minCents: 2100, maxCents: 3100 });
    expect(after.benchmarkFor("CROWN_PERMANENT")).toMatchObject({ minCents: 75000, maxCents: 140000 });
    expect(after.benchmarkFor("SCALING")).toEqual({ kind: "not_set" });
  });

  it("lets a settings override fill a blank benchmark, shown with its source, never replace a published one", () => {
    const overrides = [
      { procedureCode: "SCALING", minCents: 5000, maxCents: 9000, sourceUrl: "https://example.test/b", asOf: d("2026-10-01") },
      { procedureCode: "CONSULTATION", minCents: 1, maxCents: 2, sourceUrl: "https://example.test/c", asOf: d("2026-10-01") },
    ];
    const rs = ruleSetFor("chas", d("2026-10-02"), overrides)!;
    expect(rs.benchmarkFor("SCALING")).toEqual({
      kind: "range",
      minCents: 5000,
      maxCents: 9000,
      source: { url: "https://example.test/b", asOf: "2026-10-01", override: true },
    });
    expect(rs.benchmarkFor("CONSULTATION")).toMatchObject({ minCents: 2100, maxCents: 3100, source: { override: false } });
  });
});

describe("listRuleSets", () => {
  it("lists each rule set with its scheme, dates and sources", () => {
    const sets = listRuleSets();
    expect(sets).toContainEqual(
      expect.objectContaining({ id: "chas-2025-10-01", scheme: "chas", effectiveFrom: "2025-10-01", effectiveTo: null }),
    );
    expect(sets.find((s) => s.id === "chas-2025-10-01")?.sources.length).toBeGreaterThan(0);
  });
});

describe("ruleSetFor medisave_tosp", () => {
  it("covers visits from the 1 Jan 2024 TOSP edition, with the table and limit sources", () => {
    expect(ruleSetFor("medisave_tosp", d("2023-12-31"))).toBeNull();
    const rs = ruleSetFor("medisave_tosp", d("2026-11-13"))!;
    expect(rs.id).toBe("medisave-tosp-2024-01-01");
    expect(rs.sources.map((s) => s.url)).toContain(
      "https://www.moh.gov.sg/docs/librariesprovider5/medisave/table-of-surgical-procedures-(as-of-1-jan-2024).pdf",
    );
    expect(rs.maxProcedures).toBe(3);
    expect(rs.maxSystems).toBe(2);
    expect(rs.maxPerSystem).toBe(2);
  });

  it("gives each dental code its table and limit, MSP as unclaimable, and unknown tables as null", () => {
    const rs = ruleSetFor("medisave_tosp", d("2026-11-13"))!;
    expect(rs.procedure("SF813T")).toEqual({ code: "SF813T", table: "2C", limitCents: 112000, system: "SF" });
    expect(rs.procedure("SF812T")?.limitCents).toBe(42000);
    expect(rs.procedure("SB702M")).toEqual({ code: "SB702M", table: "1C", limitCents: 49000, system: "SB" });
    expect(rs.procedure("SF811T")).toEqual({ code: "SF811T", table: "MSP", limitCents: null, system: "SF" });
    expect(rs.procedure("SF701T")).toEqual({ code: "SF701T", table: null, limitCents: null, system: "SF" });
    expect(rs.procedure("XX999X")).toBeNull();
  });

  it.each(Object.entries(TOSP_TABLE_LIMITS))("ships the research note's day-surgery limit for table %s (SC7.2)", (table, dollars) => {
    expect(tospData.tableLimitsCents[table as keyof typeof tospData.tableLimitsCents]).toBe(dollars * 100);
  });

  it("ships exactly the 21 tables 1A to 7C", () => {
    expect(Object.keys(tospData.tableLimitsCents).sort()).toEqual(Object.keys(TOSP_TABLE_LIMITS).sort());
  });

  it.each(Object.entries(TOSP_RANKINGS))("ranks %s as the research note does, with that table's limit (SC7.2)", (code, table) => {
    const rs = ruleSetFor("medisave_tosp", d("2026-11-13"))!;
    const limit = table === null || table === "MSP" ? null : TOSP_TABLE_LIMITS[table]! * 100;
    expect(rs.procedure(code)).toEqual({ code, table, limitCents: limit, system: code.slice(0, 2) });
  });

  it("lists exactly the dental codes in the research note", () => {
    expect(Object.keys(tospData.procedures).sort()).toEqual(Object.keys(TOSP_RANKINGS).sort());
  });
});

describe("ruleSetFor medisave_flexi", () => {
  it("starts 1 Jul 2026, flagged as unconfirmed, for 60 and over at $400 a year on crowns and RCT", () => {
    expect(ruleSetFor("medisave_flexi", d("2026-06-30"))).toBeNull();
    const rs = ruleSetFor("medisave_flexi", d("2026-07-01"))!;
    expect(rs.id).toBe("medisave-flexi-2026-07-01");
    expect(rs.note).toMatch(/^Start date unconfirmed/);
    expect(rs.minAge).toBe(60);
    expect(rs.yearlyCapCents).toBe(40000);
    expect(rs.covers("CROWN_PERMANENT")).toBe(true);
    expect(rs.covers("RCT_MOLAR")).toBe(true);
    expect(rs.covers("SCALING")).toBe(false);
  });
});

describe("listRuleSets for MediSave", () => {
  it("lists the TOSP edition and the unconfirmed Flexi start with their notes", () => {
    const sets = listRuleSets();
    const tosp = sets.find((s) => s.id === "medisave-tosp-2024-01-01");
    expect(tosp).toMatchObject({ scheme: "medisave_tosp", effectiveFrom: "2024-01-01" });
    expect(tosp?.note).toContain("1 Jan 2024");
    expect(tosp?.note).toContain("MOH FCM No. 1/2026");
    const flexi = sets.find((s) => s.id === "medisave-flexi-2026-07-01");
    expect(flexi).toMatchObject({ scheme: "medisave_flexi", effectiveFrom: "2026-07-01" });
    expect(flexi?.note).toContain("Start date unconfirmed");
    expect(sets.every((s) => s.sources.every((src) => src.url.startsWith("https://") && src.retrieved.length === 10))).toBe(true);
  });
});
