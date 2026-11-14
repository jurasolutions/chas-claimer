/**
 * The real-identifier guard (decisions-g2 #1), shared by every way NRICs reach the desk: until
 * `ALLOW_REAL_IDENTIFIERS=yes`, an NRIC outside the synthetic `T9` block is refused.
 */
import { isSynthetic, type Nric } from "../src/domain/nric";
import type { Env } from "./env";

/**
 * The positions (a visit's index, a statement's line number) carrying an NRIC this deployment refuses.
 * Empty when real identifiers are allowed. Positions only, never the value: each caller records its
 * own refusal.
 */
export function refusedIdentifierPositions<P>(env: Pick<Env, "ALLOW_REAL_IDENTIFIERS">, items: Iterable<readonly [P, readonly (Nric | null)[]]>): P[] {
  if (env.ALLOW_REAL_IDENTIFIERS === "yes") return [];
  const refused: P[] = [];
  for (const [position, nrics] of items) if (nrics.some((n) => n !== null && !isSynthetic(n))) refused.push(position);
  return refused;
}
