/**
 * The CHAS dental rule set: subsidy caps per tier, frequency limits, the submission window and
 * the MOH fee benchmarks. The figures are data in `data/*.json`, each file carrying its sources
 * and retrieval date; this module validates them at load and answers questions about them.
 */
import { z } from "zod";
import type { IsoDate } from "../dates";
import type { Cents } from "../money";
import type { ChasTier } from "../types";
import chas20251001 from "./data/chas-2025-10-01.json";
import { CentsValue, covers, IsoDateString, load, type RuleSource, SourceSchema } from "./shared";

export type { RuleSource } from "./shared";

const ProcedureSchema = z.strictObject({
  subsidyCents: z.strictObject({ PG: CentsValue, MG: CentsValue, Blue: CentsValue, Orange: CentsValue }),
  limit: z.strictObject({ group: z.string().min(1), count: z.number().int().positive(), periodYears: z.number().int().positive() }),
  /** The published MOH benchmark range, or null where MOH has not published one. */
  benchmark: z.strictObject({ minCents: CentsValue, maxCents: CentsValue }).nullable(),
});

const ChasRuleSetSchema = z.strictObject({
  id: z.string().min(1),
  scheme: z.literal("chas"),
  effectiveFrom: IsoDateString,
  effectiveTo: IsoDateString.nullable(),
  sources: z.array(SourceSchema).min(1),
  note: z.string().optional(),
  windowDays: z.number().int().positive(),
  tierBasis: z.strictObject({
    PG: z.enum(["table", "none", "full_fee"]),
    MG: z.enum(["table", "none", "full_fee"]),
    Blue: z.enum(["table", "none", "full_fee"]),
    Orange: z.enum(["table", "none", "full_fee"]),
    Green: z.enum(["table", "none", "full_fee"]),
    PA: z.enum(["table", "none", "full_fee"]),
  }),
  /** Visits on or after this date are checked against benchmarks; earlier visits are not. */
  benchmarksFrom: IsoDateString.nullable(),
  procedures: z.record(z.string(), ProcedureSchema),
});

type ChasRuleSetData = z.output<typeof ChasRuleSetSchema>;

export type TableTier = "PG" | "MG" | "Blue" | "Orange";
/** How a tier is paid: from the subsidy table, not at all (Green), or the full fee (Public Assistance). */
export type TierBasis = "table" | "none" | "full_fee";

export interface ChasProcedure {
  subsidyCents: Record<TableTier, Cents>;
  /** Visits sharing a `group` share the limit: `count` per `periodYears` calendar years. */
  limit: { group: string; count: number; periodYears: number };
}

/** A benchmark override from the desk settings: fills a procedure MOH has not published a range for. */
export interface BenchmarkOverrideInput {
  procedureCode: string;
  minCents: number;
  maxCents: number;
  sourceUrl: string;
  asOf: string;
}

export type Benchmark =
  | {
      kind: "range";
      minCents: Cents;
      maxCents: Cents;
      source: { override: false; ruleSetId: string } | { override: true; url: string; asOf: string };
    }
  | { kind: "not_set" };

export interface ChasRuleSet {
  id: string;
  scheme: "chas";
  effectiveFrom: string;
  effectiveTo: string | null;
  sources: RuleSource[];
  note?: string;
  windowDays: number;
  tierBasis: Record<ChasTier, TierBasis>;
  procedures: Record<string, ChasProcedure>;
  /** The benchmark for a procedure on this visit's date: null before benchmarks apply. */
  benchmarkFor(procedureCode: string): Benchmark | null;
}

/** Every CHAS rule set, oldest first. Validated once, at module load. */
export const CHAS_RULE_SETS: readonly ChasRuleSetData[] = [load(ChasRuleSetSchema, "CHAS", chas20251001)];

export function chasRuleSetFor(
  visitDate: IsoDate,
  overrides: readonly BenchmarkOverrideInput[] = [],
): ChasRuleSet | null {
  const data = CHAS_RULE_SETS.find((d) => covers(d, visitDate));
  if (!data) return null;
  const benchmarksApply = data.benchmarksFrom !== null && data.benchmarksFrom <= visitDate;
  const procedures: Record<string, ChasProcedure> = {};
  for (const [code, p] of Object.entries(data.procedures)) {
    procedures[code] = {
      subsidyCents: p.subsidyCents as Record<TableTier, Cents>,
      limit: { ...p.limit },
    };
  }
  return {
    id: data.id,
    scheme: "chas",
    effectiveFrom: data.effectiveFrom,
    effectiveTo: data.effectiveTo,
    sources: data.sources.map((s) => ({ ...s })),
    ...(data.note === undefined ? {} : { note: data.note }),
    windowDays: data.windowDays,
    tierBasis: { ...data.tierBasis },
    procedures,
    benchmarkFor(procedureCode) {
      if (!benchmarksApply) return null;
      const published = data.procedures[procedureCode]?.benchmark;
      if (published) {
        return {
          kind: "range",
          minCents: published.minCents as Cents,
          maxCents: published.maxCents as Cents,
          source: { override: false, ruleSetId: data.id },
        };
      }
      const override = overrides.find((o) => o.procedureCode === procedureCode);
      if (override) {
        return {
          kind: "range",
          minCents: override.minCents as Cents,
          maxCents: override.maxCents as Cents,
          source: { url: override.sourceUrl, asOf: override.asOf, override: true },
        };
      }
      return { kind: "not_set" };
    },
  };
}
