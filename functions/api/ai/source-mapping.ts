/**
 * `POST /api/ai/source-mapping`: a proposed source mapping from the clinic database's table and
 * column names (AC-6.5). Only a reviewer may ask, since only a reviewer changes the mapping. The
 * proposal is returned for the reviewer to check; it is saved only through the mapping screen.
 */
import { aiProblem } from "../../../server/ai/http";
import { aiConfigured } from "../../../server/ai/run";
import { proposeMapping } from "../../../server/ai/tasks/source-mapping";
import { json, readJson, route } from "../../../server/http";
import { parseSourceMappingRequest, type SourceMappingResponse } from "../../../src/api/ai";

/** Room for a few hundred tables' worth of names; a schema description holds no rows. */
const MAX_BYTES = 256 * 1024;

export const onRequestPost = route({ auth: "access", roles: ["reviewer"], maxBytes: MAX_BYTES }, async ({ request, env, now }) => {
  const body = await readJson(request, parseSourceMappingRequest, MAX_BYTES);
  if (!body.ok) return body.error;
  if (!aiConfigured(env)) return aiProblem("ai_not_configured");
  const suggestion = await proposeMapping(env, now, body.value);
  if (!suggestion.ok) return aiProblem(suggestion.error);
  const answer: SourceMappingResponse = { suggestion: suggestion.value };
  return json(answer);
});
