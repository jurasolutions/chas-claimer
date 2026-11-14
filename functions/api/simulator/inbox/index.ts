/**
 * `GET /api/simulator/inbox`: the claims the payer simulator received (AC-4.7), masked as they were
 * sent. The simulator is the desk's own stand-in for a payer; nothing here reaches a real one. Off
 * (404) unless `DEMO_MODE=yes` or the desk is addressed as localhost.
 */
import { simulatorOnly } from "../../../../server/channels/simulator";
import { json, route } from "../../../../server/http";
import { simulatorInbox } from "../../../../server/services/submissions";
import type { SimulatorInbox } from "../../../../src/api/submissions";

export const onRequestGet = simulatorOnly(
  route({ auth: "access", roles: ["officer", "reviewer"] }, async ({ env }) => {
    const body: SimulatorInbox = { items: await simulatorInbox(env.DB) };
    return json(body);
  }),
);
