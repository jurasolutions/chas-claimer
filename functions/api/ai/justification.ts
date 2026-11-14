/**
 * `POST /api/ai/justification`: a draft justification from the dentist's note (AC-6.2). Officers and
 * reviewers may ask. The draft is returned for the dentist to edit; nothing on the claim changes.
 * The route opens the sealed note to scrub it, and records that it did.
 */
import { aiProblem } from "../../../server/ai/http";
import { aiConfigured } from "../../../server/ai/run";
import { draftJustification } from "../../../server/ai/tasks/justification";
import { json, readJson, route } from "../../../server/http";
import { parseClaimAiRequest, type JustificationResponse } from "../../../src/api/ai";

const MAX_BYTES = 1024;

export const onRequestPost = route(
  { auth: "access", roles: ["officer", "reviewer"], maxBytes: MAX_BYTES, identity: true },
  async ({ request, env, actor, now, keys }) => {
    const body = await readJson(request, parseClaimAiRequest, MAX_BYTES);
    if (!body.ok) return body.error;
    if (!aiConfigured(env)) return aiProblem("ai_not_configured");
    const draft = await draftJustification({ db: env.DB, now, keys }, env, body.value.claimId, actor);
    if (!draft.ok) return aiProblem(draft.error);
    const answer: JustificationResponse = draft.value;
    return json(answer);
  },
);
