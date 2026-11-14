/**
 * `GET /api/settings`: officers and reviewers read the settings, the role lists and the rule sets.
 * `PUT /api/settings`: reviewers save, against the version they read (409 `stale` otherwise).
 */
import { z } from "zod";
import { DEFAULT_MAX_BYTES, json, problem, readJson, route } from "../../server/http";
import { readSettings, saveSettings } from "../../server/services/settings";
import type { SettingsSaveRequest } from "../../src/api/settings";
import { DeskSettingsSchema } from "../../src/domain/settings";
import { validate } from "../../src/domain/validation";

const SaveRequestSchema = z.strictObject({
  settings: DeskSettingsSchema,
  expectedVersion: z.number().int().min(0),
});
const parseSaveRequest = (u: unknown) => validate(SaveRequestSchema, u);

export const onRequestGet = route({ auth: "access", roles: ["officer", "reviewer"] }, async ({ env }) => json(await readSettings(env)));

export const onRequestPut = route({ auth: "access", roles: ["reviewer"] }, async ({ request, env, actor, now }) => {
  const body = await readJson<SettingsSaveRequest>(request, parseSaveRequest, DEFAULT_MAX_BYTES);
  if (!body.ok) return body.error;
  const outcome = await saveSettings({ db: env.DB, now }, body.value.settings, body.value.expectedVersion, actor);
  if (outcome.kind === "invalid") return problem(400, "invalid", { issues: outcome.issues });
  if (outcome.kind === "stale") return problem(409, "stale", { currentVersion: outcome.currentVersion });
  return json(outcome.body);
});
