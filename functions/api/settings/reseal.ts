/**
 * `GET /api/settings/reseal`: where the identifier key stands (`ResealStatus`), for the settings
 * page. Reads only, so it writes no audit event.
 *
 * `POST /api/settings/reseal`: after an `IDENTIFIER_KEY` rotation (infra I1, ADR 0006), reviewers
 * move stored identities to the current key, starting from `after: ""` and posting the `next`
 * cursor each batch returns until it is null. Each request moves at most `RESEAL_BATCH` visit
 * revisions and says how many are still under an older key, which ones failed, whether the previous
 * key is missing, and the payment statement rows no re-seal can move (`ResealProgress`).
 */
import { z } from "zod";
import { json, readJson, route } from "../../../server/http";
import { decodeAfter, resealBatch, resealStatus } from "../../../server/services/reseal";
import type { ResealCursor } from "../../../src/api/settings";
import { validate } from "../../../src/domain/validation";

const CursorSchema = z.strictObject({
  after: z
    .string()
    .max(400)
    .refine((s) => decodeAfter(s) !== null, "Not a cursor this route issued."),
});
const parseCursor = (u: unknown) => validate(CursorSchema, u);

export const onRequestGet = route({ auth: "access", roles: ["reviewer"], identity: true }, async ({ env, keys }) =>
  json(await resealStatus({ db: env.DB, keys })),
);

export const onRequestPost = route(
  { auth: "access", roles: ["reviewer"], identity: true, maxBytes: 64 * 1024 },
  async ({ request, env, actor, now, keys }) => {
    const body = await readJson<ResealCursor>(request, parseCursor, 64 * 1024);
    if (!body.ok) return body.error;
    return json(await resealBatch({ db: env.DB, now, keys }, body.value.after, actor));
  },
);
