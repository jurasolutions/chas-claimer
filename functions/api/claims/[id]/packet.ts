/**
 * `GET /api/claims/:id/packet`: the claim as its payer's template asks for it, masked, in the
 * template's order (AC-4.1, AC-4.2). The submission checklist reads it. An identifier is shown only
 * through the audited reveal route, never here.
 */
import { json, problem, route } from "../../../../server/http";
import { packetView } from "../../../../server/services/submissions";

export const onRequestGet = route<{ id: string }>({ auth: "access", roles: ["officer", "reviewer"] }, async ({ env, params, now }) => {
  const view = await packetView({ db: env.DB, now }, params.id);
  return view ? json(view) : problem(404, "not_found");
});
