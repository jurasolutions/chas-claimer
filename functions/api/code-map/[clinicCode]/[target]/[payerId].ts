/**
 * `PUT /api/code-map/:clinicCode/:target/:payerId`: a reviewer sets what a clinic code claims as
 * under one target (payer `-` for CHAS and TOSP); `targetCode: null` means "not claimable".
 * `DELETE` removes the entry. Both audit the change and rebuild the visits carrying the code.
 */
import { z } from "zod";
import { json, problem, readJson, route } from "../../../../../server/http";
import { type CodeMapKey, deleteEntry, parseKey, saveEntry, targetCodeIssue } from "../../../../../server/services/code-map";
import type { CodeMapSaveRequest } from "../../../../../src/api/settings";
import { CODE_MAP_ORIGINS } from "../../../../../src/domain/types";
import { validate, type ValidationIssue } from "../../../../../src/domain/validation";

type Params = { clinicCode: string; target: string; payerId: string };

const SaveSchema = z.strictObject({
  targetCode: z.string().trim().min(1).max(64).nullable(),
  origin: z.enum(CODE_MAP_ORIGINS),
});
const parseSave = (u: unknown) => validate(SaveSchema, u);
const MAX_BYTES = 4 * 1024;

const isKey = (k: CodeMapKey | ValidationIssue): k is CodeMapKey => "target" in k;

export const onRequestPut = route<Params>({ auth: "access", roles: ["reviewer"], maxBytes: MAX_BYTES }, async ({ request, env, params, actor, now }) => {
  const key = await parseKey(env.DB, params);
  if (!isKey(key)) return problem(400, "invalid", { issues: [key] });
  const body = await readJson<CodeMapSaveRequest>(request, parseSave, MAX_BYTES);
  if (!body.ok) return body.error;
  const issue = targetCodeIssue(key, body.value.targetCode);
  if (issue) return problem(400, "invalid", { issues: [issue] });
  return json(await saveEntry({ db: env.DB, now }, key, body.value, actor));
});

export const onRequestDelete = route<Params>({ auth: "access", roles: ["reviewer"], maxBytes: MAX_BYTES }, async ({ env, params, actor, now }) => {
  const key = await parseKey(env.DB, params);
  if (!isKey(key)) return problem(400, "invalid", { issues: [key] });
  const removed = await deleteEntry({ db: env.DB, now }, key, actor);
  return removed ? json(removed) : problem(404, "not_found");
});
