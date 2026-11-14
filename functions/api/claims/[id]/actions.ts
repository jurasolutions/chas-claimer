/**
 * `POST /api/claims/:id/actions`: one lifecycle action on one claim (technical §6, AC-3.1 to AC-3.5).
 * The lifecycle decides whether the action is allowed now and by whom, so an officer's approve is
 * 403 here as it is on the page. Answers the claim's detail as it now stands. The body's text (a
 * reason, a payer's message) is never echoed or logged.
 */
import { actProblem } from "../../../../server/claim-http";
import { json, problem, readJson, route } from "../../../../server/http";
import { act, claimDetail } from "../../../../server/services/claims";
import { parseActionRequest } from "../../../../src/api/claim-actions";

const MAX_BYTES = 16 * 1024;

export const onRequestPost = route<{ id: string }>(
  { auth: "access", roles: ["officer", "reviewer"], maxBytes: MAX_BYTES },
  async ({ request, env, params, actor, now }) => {
    const body = await readJson(request, parseActionRequest, MAX_BYTES);
    if (!body.ok) return body.error;
    const deps = { db: env.DB, now };
    const done = await act(deps, params.id, body.value.action, body.value.expectedVersion, actor);
    if (!done.ok) return actProblem(done.error);
    const detail = await claimDetail(deps, params.id, actor);
    return detail ? json(detail) : problem(404, "not_found");
  },
);
