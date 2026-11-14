/**
 * `POST /api/claims/:id/reveal`: one identity field of the claim's patient, in full (S11). Officers
 * and reviewers may reveal. The reveal is on the audit trail before the value is answered; if that
 * write fails the service throws and the spine answers 500 with no value. The answer is never cached.
 */
import { actProblem } from "../../../../server/claim-http";
import { json, readJson, route } from "../../../../server/http";
import { reveal } from "../../../../server/services/claims";
import { parseRevealRequest, type RevealResponse } from "../../../../src/api/claim-actions";

const MAX_BYTES = 1024;

export const onRequestPost = route<{ id: string }>(
  { auth: "access", roles: ["officer", "reviewer"], maxBytes: MAX_BYTES, identity: true },
  async ({ request, env, params, actor, now, keys }) => {
    const body = await readJson(request, parseRevealRequest, MAX_BYTES);
    if (!body.ok) return body.error;
    const value = await reveal({ db: env.DB, now, keys }, params.id, body.value.field, actor);
    if (!value.ok) return actProblem(value.error);
    const answer: RevealResponse = { value: value.value };
    return json(answer);
  },
);
