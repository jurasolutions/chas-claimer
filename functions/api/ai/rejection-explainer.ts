/**
 * `POST /api/ai/rejection-explainer`: why a payer rejected a claim and what to change (AC-6.4).
 * Officers and reviewers may ask. The answer is a suggestion; the claim is not touched. The route
 * opens the patient's identity only to scrub the rejection text, and records that it did.
 */
import { aiProblem } from "../../../server/ai/http";
import { aiConfigured } from "../../../server/ai/run";
import { explainRejection } from "../../../server/ai/tasks/rejection-explainer";
import { json, readJson, route } from "../../../server/http";
import { parseClaimAiRequest, type RejectionExplainerResponse } from "../../../src/api/ai";

const MAX_BYTES = 1024;

export const onRequestPost = route(
  { auth: "access", roles: ["officer", "reviewer"], maxBytes: MAX_BYTES, identity: true },
  async ({ request, env, actor, now, keys }) => {
    const body = await readJson(request, parseClaimAiRequest, MAX_BYTES);
    if (!body.ok) return body.error;
    if (!aiConfigured(env)) return aiProblem("ai_not_configured");
    const suggestion = await explainRejection({ db: env.DB, now, keys }, env, body.value.claimId, actor);
    if (!suggestion.ok) return aiProblem(suggestion.error);
    const answer: RejectionExplainerResponse = { suggestion: suggestion.value };
    return json(answer);
  },
);
