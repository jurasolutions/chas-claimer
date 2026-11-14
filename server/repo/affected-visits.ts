/**
 * The visits a settings or code-map change can move, a page at a time (technical §6).
 *
 * A candidate is a visit with a claim still on the desk (needs attention, ready or approved), or
 * with no claims at all (a change can make it claimable). Visits whose claims are all sent or closed
 * are left alone: a sent claim is a fixed input and a closed one never comes back.
 *
 * Pages run in clinic order (date, start time, visit key), so a patient's earlier visit is rebuilt
 * before a later one that counts its claims against a limit. The cursor is that order's key.
 */
import type { RebuildScope } from "../../src/api/settings";
import { UNSENT_STATUSES } from "../../src/domain/claims/state";

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** `orderKey` (src/domain/claims/plan.ts) in SQL: `date|startTime|visitKey`. */
const ORDER_KEY = "(v.visit_date || '|' || COALESCE(json_extract(r.clinical_json, '$.startTime'), '') || '|' || v.visit_key)";

function scopeClause(scope: RebuildScope): { sql: string; params: unknown[] } {
  switch (scope.kind) {
    case "all":
      return { sql: "", params: [] };
    case "dentists":
      return { sql: `AND json_extract(r.clinical_json, '$.dentistId') IN (${marks(scope.ids.length)})`, params: scope.ids };
    case "branches":
      return { sql: `AND v.branch_id IN (${marks(scope.ids.length)})`, params: scope.ids };
    case "clinic_code":
      return {
        sql: "AND EXISTS (SELECT 1 FROM json_each(r.clinical_json, '$.treatments') t WHERE json_extract(t.value, '$.code') = ?)",
        params: [scope.clinicCode],
      };
  }
}

function candidates(scope: RebuildScope): { from: string; params: unknown[] } {
  const unsent = [...UNSENT_STATUSES];
  const s = scopeClause(scope);
  return {
    from: `FROM visits v JOIN visit_revisions r ON r.visit_key = v.visit_key AND r.revision = v.current_revision
      WHERE ${ORDER_KEY} > ?
        AND (EXISTS (SELECT 1 FROM claims c WHERE c.visit_key = v.visit_key AND c.status IN (${marks(unsent.length)}))
             OR NOT EXISTS (SELECT 1 FROM claims c WHERE c.visit_key = v.visit_key))
        ${s.sql}`,
    params: [...unsent, ...s.params],
  };
}

/**
 * Up to `limit` candidate visit keys whose order key comes after `after`, in clinic order, the last
 * one's order key to continue from, and how many remain beyond it.
 */
export async function page(
  db: D1Database,
  scope: RebuildScope,
  after: string,
  limit: number,
): Promise<{ keys: string[]; last: string | null; remaining: number }> {
  if ((scope.kind === "dentists" || scope.kind === "branches") && scope.ids.length === 0) return { keys: [], last: null, remaining: 0 };
  const c = candidates(scope);
  const { results } = await db
    .prepare(`SELECT v.visit_key, ${ORDER_KEY} AS order_key ${c.from} ORDER BY order_key LIMIT ?`)
    .bind(after, ...c.params, limit)
    .all<{ visit_key: string; order_key: string }>();
  const keys = results.map((r) => r.visit_key);
  const last = results.at(-1)?.order_key ?? null;
  if (keys.length < limit || last === null) return { keys, last, remaining: 0 };
  const count = await db
    .prepare(`SELECT COUNT(*) AS n ${c.from}`)
    .bind(last, ...c.params)
    .first<{ n: number }>();
  return { keys, last, remaining: count?.n ?? 0 };
}
