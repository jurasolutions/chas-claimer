/**
 * `POST /api/imports`: the clinic connector sends up to 100 source visits (connector token).
 * `GET /api/imports`: recent imports with their counts, for officers.
 *
 * A refused import answers 422 `real_identifier_refused` (mapped in `server/http.ts`) with the
 * positions that carried an identifier outside the synthetic block, never the value (decisions-g2 #1).
 */
import { z } from "zod";
import { DEFAULT_MAX_BYTES, json, problem, readJson, route } from "../../../server/http";
import * as imports from "../../../server/repo/imports";
import { importVisits } from "../../../server/services/imports";
import { type ImportListResponse, type ImportRequest, MAX_VISITS_PER_IMPORT } from "../../../src/api/imports";
import { validate } from "../../../src/domain/validation";

const envelope = z.object({ visits: z.array(z.unknown()) });
const parseEnvelope = (u: unknown) => validate(envelope, u);

export const onRequestPost = route({ auth: "connector", identity: true }, async ({ request, env, actor, now, keys }) => {
  const body = await readJson<ImportRequest>(request, parseEnvelope, DEFAULT_MAX_BYTES);
  if (!body.ok) return body.error;
  if (body.value.visits.length > MAX_VISITS_PER_IMPORT) return problem(413, "too_large");
  return json(await importVisits({ db: env.DB, env, now, keys }, { source: "connector", visits: body.value.visits }, actor));
});

export const onRequestGet = route({ auth: "access", roles: ["officer", "reviewer"] }, async ({ env }) => {
  const body: ImportListResponse = { items: await imports.recent(env.DB) };
  return json(body);
});
