/**
 * `POST /api/remittances`: an officer or reviewer uploads a payer's payment statement; the desk
 * matches its lines and records the payments (spec §5). A reviewer may send the payer's column
 * mapping with it, which is saved to settings first.
 * `GET /api/remittances`: recent statements with their counts.
 *
 * The statement carries NRICs. Nothing answered here repeats one: a refusal names headers and line
 * numbers, never a value from the file.
 */
import { json, problem, readJson, route } from "../../../server/http";
import * as remittances from "../../../server/repo/remittances";
import { importRemittance, type RemittanceProblem } from "../../../server/services/remittances";
import { MAX_REMITTANCE_BYTES, parseRemittanceRequest, type RemittanceListItem } from "../../../src/api/remittances";

/** How many statements the list shows. */
const LIST_LIMIT = 50;

function refusal(p: RemittanceProblem): Response {
  switch (p.error) {
    case "forbidden":
      return problem(403, "forbidden", {
        detail: p.reason === "columns" ? "only a reviewer can change a payer's statement columns" : "only a reviewer can import a possible duplicate",
      });
    case "unknown_payer":
      return problem(400, "invalid", { issues: [{ path: "payerId", message: "No payer has this ID." }] });
    case "columns_not_mapped":
      return problem(409, "columns_not_mapped", { payerId: p.payerId });
    case "statement_unreadable":
      return problem(422, "statement_unreadable", { problem: p.problem });
    case "possible_duplicate":
      return problem(409, "possible_duplicate", { remittanceId: p.remittanceId });
    case "real_identifier_refused":
      return problem(422, "real_identifier_refused", { lines: p.lines });
  }
}

export const onRequestPost = route(
  { auth: "access", roles: ["officer", "reviewer"], identity: true, maxBytes: MAX_REMITTANCE_BYTES },
  async ({ request, env, actor, now, keys }) => {
    const body = await readJson(request, parseRemittanceRequest, MAX_REMITTANCE_BYTES);
    if (!body.ok) return body.error;
    const result = await importRemittance({ db: env.DB, env, now, keys }, body.value, actor);
    return result.ok ? json(result.value) : refusal(result.error);
  },
);

export const onRequestGet = route({ auth: "access", roles: ["officer", "reviewer"] }, async ({ env }) => {
  const body: { items: RemittanceListItem[] } = { items: await remittances.list(env.DB, LIST_LIMIT) };
  return json(body);
});
