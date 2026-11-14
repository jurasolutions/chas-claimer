/**
 * The MediSave dental rule sets: the Table of Surgical Procedures (dental subset) with CPF's
 * withdrawal limits per table, and Outpatient Flexi-MediSave for patients 60 and over. As with
 * CHAS, the figures are data in `data/*.json` with their sources; this module validates them at
 * load and answers questions about them. A TOSP table the desk has not confirmed is null.
 */
import { z } from "zod";
import type { IsoDate } from "../dates";
import type { Cents } from "../money";
import flexi20260701 from "./data/medisave-flexi-2026-07-01.json";
import tosp20240101 from "./data/medisave-tosp-2024-01-01.json";
import { CentsValue, covers, IsoDateString, load, type RuleSource, SourceSchema } from "./shared";

const TableCode = z.string().regex(/^[1-7][ABC]$/);

const Dated = {
  id: z.string().min(1),
  effectiveFrom: IsoDateString,
  effectiveTo: IsoDateString.nullable(),
  sources: z.array(SourceSchema).min(1),
  note: z.string().min(1),
};

const TospRuleSetSchema = z.strictObject({
  ...Dated,
  scheme: z.literal("medisave_tosp"),
  maxProcedures: z.number().int().positive(),
  maxSystems: z.number().int().positive(),
  /** The most procedures MediSave pays in any one anatomical system on one claim. */
  maxPerSystem: z.number().int().positive(),
  tableLimitsCents: z.record(TableCode, CentsValue),
  /** `MSP` is the minor surgical procedure table, which MediSave does not pay; null is a table not yet confirmed. */
  procedures: z.record(z.string().regex(/^S[A-Z]\d{3}[A-Z]$/), z.strictObject({ table: z.union([TableCode, z.literal("MSP")]).nullable() })),
});

const FlexiRuleSetSchema = z.strictObject({
  ...Dated,
  scheme: z.literal("medisave_flexi"),
  minAge: z.number().int().positive(),
  yearlyCapCents: CentsValue,
  /** CHAS procedure codes Flexi-MediSave pays for: crowns and root canal treatment. */
  coveredChasProcedures: z.array(z.string().min(1)).min(1),
});

type TospData = z.output<typeof TospRuleSetSchema>;
type FlexiData = z.output<typeof FlexiRuleSetSchema>;

export const TOSP_RULE_SETS: readonly TospData[] = [load(TospRuleSetSchema, "TOSP", tosp20240101)];
export const FLEXI_RULE_SETS: readonly FlexiData[] = [load(FlexiRuleSetSchema, "Flexi-MediSave", flexi20260701)];

for (const data of TOSP_RULE_SETS) {
  for (const [code, p] of Object.entries(data.procedures)) {
    if (p.table !== null && p.table !== "MSP" && data.tableLimitsCents[p.table] === undefined) {
      throw new Error(`TOSP rule set data is invalid at procedures.${code}: no limit for table ${p.table}`);
    }
  }
}

export interface TospProcedure {
  code: string;
  /** The TOSP table, `MSP` for a minor surgical procedure, or null where the desk has not confirmed it. */
  table: string | null;
  /** CPF's withdrawal limit for the table; null for MSP and unconfirmed tables. */
  limitCents: Cents | null;
  /** The body system: the code's first two letters (SF for the face and mouth, SB for bone). */
  system: string;
}

export interface TospRuleSet {
  id: string;
  scheme: "medisave_tosp";
  effectiveFrom: string;
  effectiveTo: string | null;
  sources: RuleSource[];
  note: string;
  maxProcedures: number;
  maxSystems: number;
  maxPerSystem: number;
  /** A code in this edition's dental subset, or null if it is not in the rule set. */
  procedure(code: string): TospProcedure | null;
}

export interface FlexiRuleSet {
  id: string;
  scheme: "medisave_flexi";
  effectiveFrom: string;
  effectiveTo: string | null;
  sources: RuleSource[];
  note: string;
  minAge: number;
  yearlyCapCents: Cents;
  /** Whether Flexi-MediSave pays for this CHAS procedure. */
  covers(chasProcedureCode: string): boolean;
}

export function tospRuleSetFor(date: IsoDate): TospRuleSet | null {
  const data = TOSP_RULE_SETS.find((d) => covers(d, date));
  if (!data) return null;
  return {
    id: data.id,
    scheme: "medisave_tosp",
    effectiveFrom: data.effectiveFrom,
    effectiveTo: data.effectiveTo,
    sources: data.sources.map((s) => ({ ...s })),
    note: data.note,
    maxProcedures: data.maxProcedures,
    maxSystems: data.maxSystems,
    maxPerSystem: data.maxPerSystem,
    procedure(code) {
      const p = data.procedures[code];
      if (!p) return null;
      const limit = p.table === null || p.table === "MSP" ? null : (data.tableLimitsCents[p.table] ?? null);
      return { code, table: p.table, limitCents: limit as Cents | null, system: code.slice(0, 2) };
    },
  };
}

export function flexiRuleSetFor(date: IsoDate): FlexiRuleSet | null {
  const data = FLEXI_RULE_SETS.find((d) => covers(d, date));
  if (!data) return null;
  const covered = new Set(data.coveredChasProcedures);
  return {
    id: data.id,
    scheme: "medisave_flexi",
    effectiveFrom: data.effectiveFrom,
    effectiveTo: data.effectiveTo,
    sources: data.sources.map((s) => ({ ...s })),
    note: data.note,
    minAge: data.minAge,
    yearlyCapCents: data.yearlyCapCents as Cents,
    covers: (code) => covered.has(code),
  };
}
