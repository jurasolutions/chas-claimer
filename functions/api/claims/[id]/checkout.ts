/**
 * `POST /api/claims/:id/checkout`: an officer opens an approved claim's checklist and holds it for 30
 * minutes, so two officers do not submit the same claim (AC-4.8). While someone else holds it the
 * answer is 409 `checked_out` naming them; `{ takeOver: true }`, sent once the officer confirms,
 * takes it over and the audit trail records from whom. Answers the claim's masked `PacketView`.
 */
import { actProblem } from "../../../../server/claim-http";
import { json, readJson, route } from "../../../../server/http";
import { holdForChecklist } from "../../../../server/services/submissions";
import { parseCheckoutRequest } from "../../../../src/api/submissions";

const MAX_BYTES = 1024;

export const onRequestPost = route<{ id: string }>(
  { auth: "access", roles: ["officer", "reviewer"], maxBytes: MAX_BYTES },
  async ({ request, env, params, actor, now }) => {
    const body = await readJson(request, parseCheckoutRequest, MAX_BYTES);
    if (!body.ok) return body.error;
    const held = await holdForChecklist({ db: env.DB, now }, params.id, actor, { takeOver: body.value.takeOver === true });
    return held.ok ? json(held.value) : actProblem(held.error);
  },
);
