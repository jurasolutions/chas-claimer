/**
 * The deadline re-check when the queue loads (decisions-g2 #5, technical F10).
 *
 * A claim is built with the deadline finding of the day it was built. As days pass, a CHAS claim
 * comes into its last five days and then out of its window, and that changes its findings, its
 * status and, once the window has passed, what the payers below it are asked for (decisions-g2 #4).
 * So a claim whose stored finding no longer matches today is rebuilt with the reason `deadline`,
 * through the same rebuild as any other change, which keeps status, findings, approval and audit
 * consistent and lets the queue's status filters see the result.
 *
 * - Only unsent CHAS claims within five days of their deadline, or past it, are looked at.
 * - At most `DEADLINE_RECHECKS_PER_LOAD` visits are rebuilt per load, soonest deadline first, so one
 *   queue read stays well inside D1's per-invocation query limit; the next load carries on. The
 *   queue's own countdown is worked out for today on every read regardless.
 * - A visit whose claims keep moving under the rebuild is left for the next load.
 */
import { DEADLINE_WARNING_DAYS, deadlineState, type DeadlineState } from "../../src/domain/claims/build";
import { addDays, sgtDay } from "../../src/domain/dates";
import type { Actor } from "../../src/domain/types";
import * as claims from "../repo/claims";
import { RebuildConflictError, type RebuildDeps, rebuildVisits } from "./rebuild";

/** About seven queries a visit, so 50 visits keep a queue read to a few hundred. */
export const DEADLINE_RECHECKS_PER_LOAD = 50;

export interface DeadlineRecheck {
  /** Visits whose claims were rebuilt on this load. */
  rebuilt: number;
  /** More visits were due than one load rebuilds; the next load carries on. */
  more: boolean;
}

/** Whether two deadline findings say the same thing: the same code and, when approaching, the same days left. */
export const same = (a: DeadlineState, b: DeadlineState): boolean =>
  a?.code === b?.code && (a?.code !== "deadline_approaching" || a.daysLeft === (b as { daysLeft: number }).daysLeft);

export async function recheckDeadlines(deps: RebuildDeps, actor: Actor): Promise<DeadlineRecheck> {
  const today = sgtDay(deps.now);
  const due = new Set<string>();
  for (const check of await claims.deadlineChecks(deps.db, addDays(today, DEADLINE_WARNING_DAYS))) {
    if (!same(check.stored, deadlineState(check.deadline, today))) due.add(check.visitKey);
  }
  const now = [...due].slice(0, DEADLINE_RECHECKS_PER_LOAD);
  let rebuilt = 0;
  for (const key of now) {
    try {
      rebuilt += (await rebuildVisits(deps, [key], actor, "deadline")).rebuilt;
    } catch (e) {
      if (!(e instanceof RebuildConflictError)) throw e;
    }
  }
  return { rebuilt, more: due.size > now.length };
}
