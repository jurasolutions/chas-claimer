/**
 * `GET /api/claims/:id`: one claim with its lines, findings, bill split, sibling claims, submissions
 * and audit trail (technical §6, AC-3.7). The patient is masked; the actions on offer are worked out
 * for this viewer's roles, so an officer is never offered approve.
 */
import { json, problem, route } from "../../../../server/http";
import { claimDetail } from "../../../../server/services/claims";

export const onRequestGet = route<{ id: string }>({ auth: "access", roles: ["officer", "reviewer"] }, async ({ env, params, actor, now }) => {
  const detail = await claimDetail({ db: env.DB, now }, params.id, actor);
  return detail ? json(detail) : problem(404, "not_found");
});
