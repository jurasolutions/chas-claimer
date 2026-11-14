/**
 * Scheme rule sets by visit date. Each scheme registers its rule-set type in `RuleSetOf`; ticket 03
 * added the MediSave schemes to the same map. A visit date no rule set covers returns null, which the
 * claim builder turns into a `no_rule_set` finding rather than guessing.
 */
import type { IsoDate } from "../dates";
import { type BenchmarkOverrideInput, CHAS_RULE_SETS, type ChasRuleSet, chasRuleSetFor, type RuleSource } from "./chas";
import { FLEXI_RULE_SETS, type FlexiRuleSet, flexiRuleSetFor, TOSP_RULE_SETS, type TospRuleSet, tospRuleSetFor } from "./medisave";

export type { Benchmark, BenchmarkOverrideInput, ChasProcedure, ChasRuleSet, RuleSource, TableTier, TierBasis } from "./chas";
export type { FlexiRuleSet, TospProcedure, TospRuleSet } from "./medisave";

export interface RuleSetOf {
  chas: ChasRuleSet;
  medisave_tosp: TospRuleSet;
  medisave_flexi: FlexiRuleSet;
}

export type RuleScheme = keyof RuleSetOf;

export function ruleSetFor<S extends RuleScheme>(
  scheme: S,
  visitDate: IsoDate,
  overrides: readonly BenchmarkOverrideInput[] = [],
): RuleSetOf[S] | null {
  switch (scheme) {
    case "chas":
      return chasRuleSetFor(visitDate, overrides) as RuleSetOf[S] | null;
    case "medisave_tosp":
      return tospRuleSetFor(visitDate) as RuleSetOf[S] | null;
    case "medisave_flexi":
      return flexiRuleSetFor(visitDate) as RuleSetOf[S] | null;
    default:
      return null;
  }
}

export interface RuleSetSummary {
  id: string;
  scheme: RuleScheme;
  effectiveFrom: string;
  effectiveTo: string | null;
  sources: RuleSource[];
  note?: string;
}

/** Every rule set the desk knows, for the settings screen: what applies when, and where it came from. */
export function listRuleSets(): RuleSetSummary[] {
  return [...CHAS_RULE_SETS, ...TOSP_RULE_SETS, ...FLEXI_RULE_SETS].map((d) => ({
    id: d.id,
    scheme: d.scheme,
    effectiveFrom: d.effectiveFrom,
    effectiveTo: d.effectiveTo,
    sources: d.sources.map((s) => ({ ...s })),
    ...(d.note === undefined ? {} : { note: d.note }),
  }));
}
