/**
 * `GET /api/code-map`: officers and reviewers read the code map and the clinic codes no entry covers.
 */
import { json, route } from "../../../server/http";
import * as codeMap from "../../../server/repo/code-map";
import type { CodeMapResponse } from "../../../src/api/settings";

export const onRequestGet = route({ auth: "access", roles: ["officer", "reviewer"] }, async ({ env }) => {
  const body: CodeMapResponse = { items: await codeMap.get(env.DB), unmapped: await codeMap.unmapped(env.DB) };
  return json(body);
});
