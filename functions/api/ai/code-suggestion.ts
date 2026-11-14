/**
 * `POST /api/ai/code-suggestion`: a CHAS procedure for one unmapped clinic code (AC-6.3). Officers and
 * reviewers may ask; only a reviewer can accept, through the code-map PUT. Nothing is written here
 * but the day's AI call count.
 *
 * When the desk holds the code, the description sent is the clinic's own from its records, not the
 * one in the request: text typed by hand only goes out for a code the desk has not seen.
 */
import { aiProblem } from "../../../server/ai/http";
import { aiConfigured } from "../../../server/ai/run";
import { suggestCode } from "../../../server/ai/tasks/code-suggestion";
import { json, readJson, route } from "../../../server/http";
import * as codeMap from "../../../server/repo/code-map";
import { MAX_AI_DESCRIPTION, parseCodeSuggestionRequest, type CodeSuggestionResponse } from "../../../src/api/ai";

const MAX_BYTES = MAX_AI_DESCRIPTION * 4 + 1024;

export const onRequestPost = route({ auth: "access", roles: ["officer", "reviewer"], maxBytes: MAX_BYTES }, async ({ request, env, now }) => {
  const body = await readJson(request, parseCodeSuggestionRequest, MAX_BYTES);
  if (!body.ok) return body.error;
  if (!aiConfigured(env)) return aiProblem("ai_not_configured");
  const { clinicCode } = body.value;
  const held = (await codeMap.unmapped(env.DB)).find((u) => u.clinicCode === clinicCode)?.description;
  const suggestion = await suggestCode(env, now, { clinicCode, description: held ?? body.value.description });
  if (!suggestion.ok) return aiProblem(suggestion.error);
  const answer: CodeSuggestionResponse = { suggestion: suggestion.value };
  return json(answer);
});
