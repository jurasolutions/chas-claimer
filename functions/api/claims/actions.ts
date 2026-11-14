/**
 * `POST /api/claims/actions`: approve, or take back approval of, up to 50 claims at once (AC-3.4).
 * Reviewers only. Each claim goes through at the version the reviewer selected it at, so one that
 * changed since fails on its own (S17) and the rest go through. A failed claim carries the same
 * status and body the single-claim route would answer.
 */
import { actErrorBody } from "../../../server/claim-http";
import { json, problem, readJson, route } from "../../../server/http";
import { actMany } from "../../../server/services/claims";
import { type BatchResponse, parseBatchRequest } from "../../../src/api/claim-actions";

const MAX_BYTES = 16 * 1024;

export const onRequestPost = route({ auth: "access", roles: ["reviewer"], maxBytes: MAX_BYTES }, async ({ request, env, actor, now }) => {
  const body = await readJson(request, parseBatchRequest, MAX_BYTES);
  if (!body.ok) return body.error;
  const outcome = await actMany({ db: env.DB, now }, body.value.items, { kind: body.value.action }, actor);
  if (!outcome.ok) return problem(400, "invalid", { issues: [{ path: outcome.error.field, message: outcome.error.problem }] });
  const answer: BatchResponse = {
    done: outcome.value.done,
    failed: outcome.value.failed.map(({ id, error }) => {
      const { status, body: problemBody } = actErrorBody(error);
      return { id, status, error: problemBody };
    }),
  };
  return json(answer);
});
