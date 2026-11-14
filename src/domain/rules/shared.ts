/**
 * What every scheme's rule-set data shares: the field shapes its JSON is checked against, loading
 * it (a file that fails its schema stops the desk at start-up rather than paying on a bad figure),
 * and which edition covers a date.
 */
import { z } from "zod";
import type { IsoDate } from "../dates";
import { validate } from "../validation";

export const IsoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const CentsValue = z.number().int().nonnegative();
export const SourceSchema = z.strictObject({ url: z.url({ protocol: /^https$/ }), retrieved: IsoDateString });

export interface RuleSource {
  url: string;
  retrieved: string;
}

/** Validates one rule-set file, or throws naming the scheme and the first path that failed. */
export function load<S extends z.ZodType>(schema: S, name: string, input: unknown): z.output<S> {
  const parsed = validate(schema, input);
  if (!parsed.ok) {
    const first = parsed.error[0];
    throw new Error(`${name} rule set data is invalid at ${first?.path ?? ""}: ${first?.message ?? "unknown"}`);
  }
  return parsed.value as z.output<S>;
}

/** Whether an edition is in force on `date`: from its start, through its end if it has one. */
export function covers(data: { effectiveFrom: string; effectiveTo: string | null }, date: IsoDate): boolean {
  return data.effectiveFrom <= date && (data.effectiveTo === null || date <= data.effectiveTo);
}
