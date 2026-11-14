/**
 * `POST /api/submissions/confirm`: the officer uploaded an exported file to the payer's portal, so its
 * claims become submitted under the file's batch reference (AC-4.5). Each claim is checked on its own.
 */
import { json, readJson, route } from "../../../server/http";
import { confirmExport } from "../../../server/services/submissions";
import { parseConfirmExportRequest } from "../../../src/api/submissions";

const MAX_BYTES = 16 * 1024;

export const onRequestPost = route({ auth: "access", roles: ["officer", "reviewer"], maxBytes: MAX_BYTES }, async ({ request, env, actor, now }) => {
  const body = await readJson(request, parseConfirmExportRequest, MAX_BYTES);
  if (!body.ok) return body.error;
  return json(await confirmExport({ db: env.DB, now }, body.value.batchRef, body.value.items, actor));
});
