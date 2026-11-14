/**
 * `PUT /api/claims/:id/annotations`: replaces a claim's justification and payer references, then
 * answers the rebuilt claim (AC-2.8). Only an unsent claim takes annotations. The audit trail names
 * the fields that changed, never what they say, and the body is never echoed or logged.
 */
import { actProblem } from "../../../../server/claim-http";
import { json, problem, readJson, route } from "../../../../server/http";
import { claimDetail, saveAnnotations } from "../../../../server/services/claims";
import { parseAnnotationsRequest } from "../../../../src/api/claim-actions";

const MAX_BYTES = 16 * 1024;

export const onRequestPut = route<{ id: string }>(
  { auth: "access", roles: ["officer", "reviewer"], maxBytes: MAX_BYTES },
  async ({ request, env, params, actor, now }) => {
    const body = await readJson(request, parseAnnotationsRequest, MAX_BYTES);
    if (!body.ok) return body.error;
    const deps = { db: env.DB, now };
    const saved = await saveAnnotations(deps, params.id, body.value.annotations, body.value.expectedVersion, actor);
    if (!saved.ok) return actProblem(saved.error);
    const detail = await claimDetail(deps, params.id, actor);
    return detail ? json(detail) : problem(404, "not_found");
  },
);
