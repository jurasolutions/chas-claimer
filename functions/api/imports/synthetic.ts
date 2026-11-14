/**
 * `POST /api/imports/synthetic`: loads one page of the synthetic clinic for today through the same
 * import service as the connector (`loadSyntheticClinic`). The body names where the page starts;
 * the answer says where the next one does. Only where the simulator is on (`DEMO_MODE=yes`, or a
 * developer's own machine on loopback); otherwise the route is not there (404) whoever asks.
 */
import { z } from "zod";
import { simulatorOn } from "../../../server/channels/simulator";
import { DEFAULT_MAX_BYTES, json, readJson, route } from "../../../server/http";
import { loadSyntheticClinic } from "../../../server/services/synthetic";
import type { SyntheticImportRequest } from "../../../src/api/imports";
import { validate } from "../../../src/domain/validation";

const body = z.object({ offset: z.number().int().nonnegative().optional() });
const parseBody = (u: unknown) => validate(body, u);

export const onRequestPost = route(
  { enabled: simulatorOn, auth: "access", roles: ["officer", "reviewer"], identity: true },
  async ({ request, env, actor, now, keys }) => {
    const parsed = await readJson<SyntheticImportRequest>(request, parseBody, DEFAULT_MAX_BYTES);
    if (!parsed.ok) return parsed.error;
    return json(await loadSyntheticClinic({ db: env.DB, env, now, keys }, actor, parsed.value.offset ?? 0));
  },
);
