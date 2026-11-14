/**
 * `POST /api/submissions`: send approved claims down the channel each was approved for (AC-4.1 to
 * AC-4.7). Officers and reviewers may send. The route opens identity keys because the api channel and
 * the file export carry identifiers in full; those never come back in the answer except inside the
 * payer's file, which is returned once and not stored.
 */
import { simulatorOn } from "../../../server/channels/simulator";
import { json, readJson, route } from "../../../server/http";
import { submitClaims } from "../../../server/services/submissions";
import { parseSubmitRequest } from "../../../src/api/submissions";

const MAX_BYTES = 16 * 1024;

export const onRequestPost = route(
  { auth: "access", roles: ["officer", "reviewer"], maxBytes: MAX_BYTES, identity: true },
  async ({ request, env, actor, now, keys }) => {
    const body = await readJson(request, parseSubmitRequest, MAX_BYTES);
    if (!body.ok) return body.error;
    const deps = { db: env.DB, env, now, keys, simulator: simulatorOn(env, request) };
    return json(await submitClaims(deps, body.value.items, actor));
  },
);
