/**
 * `POST /api/simulator/inbox/:id`: the simulated payer accepts, rejects or pays a claim it received
 * (AC-4.7). The claim moves with the simulator as actor, so the trail shows the payer's answer as a
 * payer's. Answers the inbox item as it now stands. The reason is never echoed in an error or logged.
 * Off (404) unless `DEMO_MODE=yes` or the desk is addressed as localhost, so a deployed desk can never
 * record a payment the simulator made up.
 */
import { simulatorOnly } from "../../../../server/channels/simulator";
import { actProblem } from "../../../../server/claim-http";
import { json, readJson, route } from "../../../../server/http";
import { simulatorDecide } from "../../../../server/services/submissions";
import { parseSimulatorDecision } from "../../../../src/api/submissions";

const MAX_BYTES = 16 * 1024;

export const onRequestPost = simulatorOnly(
  route<{ id: string }>({ auth: "access", roles: ["officer", "reviewer"], maxBytes: MAX_BYTES }, async ({ request, env, params, now }) => {
    const body = await readJson(request, parseSimulatorDecision, MAX_BYTES);
    if (!body.ok) return body.error;
    const done = await simulatorDecide({ db: env.DB, now }, params.id, body.value);
    return done.ok ? json(done.item) : actProblem(done.error);
  }),
);
