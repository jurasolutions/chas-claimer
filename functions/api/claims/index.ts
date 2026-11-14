/**
 * `GET /api/claims`: the queue, filtered by status, scheme, payer, branch, days to the deadline
 * and changed-after-submission, a page at a time (technical §6). Rows carry the masked patient
 * only, and the deadline already worked out for today in SGT.
 *
 * Before reading, the load re-checks CHAS deadlines (decisions-g2 #5): a claim that has come into
 * its last days or out of its window since it was built is rebuilt first, attributed to the viewer
 * with the reason `deadline`, so the status filters see it. See `server/services/deadlines.ts`.
 */
import { json, problem, route } from "../../../server/http";
import * as claims from "../../../server/repo/claims";
import { recheckDeadlines } from "../../../server/services/deadlines";
import { parseClaimQuery } from "../../../src/api/claims";

export const onRequestGet = route({ auth: "access", roles: ["officer", "reviewer"] }, async ({ request, env, actor, now }) => {
  const filter = parseClaimQuery(new URL(request.url).searchParams);
  if (!filter.ok) return problem(400, "invalid", { issues: filter.error });
  try {
    await recheckDeadlines({ db: env.DB, now }, actor);
    return json(await claims.list(env.DB, filter.value, { now }));
  } catch (e) {
    if (e instanceof claims.InvalidCursorError) return problem(400, "invalid", { issues: [{ path: "cursor", message: "not a cursor this queue gave out" }] });
    throw e;
  }
});
