/**
 * `POST /api/settings/rebuild`: reviewers continue a rebuild a settings or code-map save started,
 * posting the `next` cursor the last batch returned. Each request rebuilds at most `REBUILD_BATCH`
 * visits and says how many remain.
 */
import { z } from "zod";
import { json, readJson, route } from "../../../server/http";
import { rebuildBatch } from "../../../server/services/settings";
import type { RebuildCursor } from "../../../src/api/settings";
import { validate } from "../../../src/domain/validation";

const Ids = z.array(z.string().min(1).max(64)).min(1).max(500);

const CursorSchema = z.strictObject({
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("all") }),
    z.strictObject({ kind: z.literal("dentists"), ids: Ids }),
    z.strictObject({ kind: z.literal("branches"), ids: Ids }),
    z.strictObject({ kind: z.literal("clinic_code"), clinicCode: z.string().min(1).max(64) }),
  ]),
  after: z.string().max(200),
});
const parseCursor = (u: unknown) => validate(CursorSchema, u);

export const onRequestPost = route({ auth: "access", roles: ["reviewer"], maxBytes: 64 * 1024 }, async ({ request, env, actor, now }) => {
  const body = await readJson<RebuildCursor>(request, parseCursor, 64 * 1024);
  if (!body.ok) return body.error;
  return json(await rebuildBatch({ db: env.DB, now }, body.value.scope, body.value.after, actor));
});
