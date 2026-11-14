/**
 * `GET /api/overview`: the Today counts for officers and reviewers (AC-8.3). Aggregates only.
 */
import { json, route } from "../../server/http";
import { overview } from "../../server/repo/overview";

export const onRequestGet = route({ auth: "access", roles: ["officer", "reviewer"] }, async ({ env, now }) => json(await overview(env.DB, now)));
