/** `GET /api/me`: who the desk thinks you are, your roles, and the switches the page needs. */
import type { MeResponse } from "../../src/api/common";
import { simulatorOn } from "../../server/channels/simulator";
import { json, route } from "../../server/http";

export const onRequestGet = route({ auth: "access" }, async ({ request, env, actor }) => {
  if (actor.kind !== "person") return json({ error: "forbidden" }, 403);
  const body: MeResponse = {
    email: actor.email,
    roles: [...actor.roles],
    aiConfigured: Boolean(env.ANTHROPIC_API_KEY),
    demoMode: simulatorOn(env, request),
  };
  return json(body);
});
