/**
 * `GET /api/remittances/:id`: one payment statement with each line's claim, or why the line waits for
 * a person, and the payer's open claims to match by hand (AC-5.1 to AC-5.6). Masked: no identifier
 * and no patient hash leave the server.
 */
import { json, problem, route } from "../../../../server/http";
import { remittanceDetail } from "../../../../server/services/remittances";

export const onRequestGet = route<{ id: string }>({ auth: "access", roles: ["officer", "reviewer"] }, async ({ env, params }) => {
  const detail = await remittanceDetail(env.DB, params.id);
  return detail ? json(detail) : problem(404, "not_found");
});
