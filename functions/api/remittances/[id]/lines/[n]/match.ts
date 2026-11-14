/**
 * `POST /api/remittances/:id/lines/:n/match`: a person matches a waiting statement line to an open
 * claim of the statement's payer (AC-5.5). The payment is recorded through the claim lifecycle at the
 * version the person saw, so a claim that moved on answers 409 `stale`. Answers the statement as it
 * now reads.
 */
import { actProblem } from "../../../../../../server/claim-http";
import { json, problem, readJson, route } from "../../../../../../server/http";
import { matchByHand } from "../../../../../../server/services/remittances";
import { parseManualMatchRequest } from "../../../../../../src/api/remittances";

const MAX_BYTES = 1024;

/** A line number as the page links it: a positive integer, no sign, no leading zero. */
const LINE_NO = /^[1-9]\d{0,5}$/;

export const onRequestPost = route<{ id: string; n: string }>(
  { auth: "access", roles: ["officer", "reviewer"], maxBytes: MAX_BYTES },
  async ({ request, env, params, actor, now }) => {
    if (!LINE_NO.test(params.n)) return problem(404, "not_found");
    const body = await readJson(request, parseManualMatchRequest, MAX_BYTES);
    if (!body.ok) return body.error;
    const matched = await matchByHand({ db: env.DB, now }, params.id, Number(params.n), body.value, actor);
    return matched.ok ? json(matched.value) : actProblem(matched.error);
  },
);
