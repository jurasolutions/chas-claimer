/**
 * Changing one code-map entry (technical §6): the change and its audit events go in one batch, then
 * the visits carrying the clinic code rebuild, at most `REBUILD_BATCH` per request.
 */
import { NO_PAYER_SEGMENT, type CodeMapSaveRequest, type CodeMapSaveResponse, type RebuildProgress } from "../../src/api/settings";
import { CHAS_RULE_SETS } from "../../src/domain/rules/chas";
import { type Actor, actorId, CODE_MAP_TARGETS, type CodeMapEntry, type CodeMapTarget } from "../../src/domain/types";
import type { ValidationIssue } from "../../src/domain/validation";
import { auditStatement } from "../repo/audit";
import * as codeMap from "../repo/code-map";
import * as settingsRepo from "../repo/settings";
import type { RebuildDeps } from "./rebuild";
import { rebuildBatch } from "./settings";

export interface CodeMapKey {
  clinicCode: string;
  target: CodeMapTarget;
  /** `""` for CHAS and TOSP. */
  payerId: string;
}

/** The audit entity ID of an entry: its path as the page sends it, with `-` for no payer. */
const entityId = (k: CodeMapKey) => `${encodeURIComponent(k.clinicCode)}/${k.target}/${k.payerId === "" ? NO_PAYER_SEGMENT : k.payerId}`;

/** A path segment decoded, or null when its percent-encoding is broken. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Reads a key from the path segments. The clinic code arrives percent-encoded (`codeMapPath`), so a
 * code with a space or a slash round-trips, and its length is judged decoded. A CHAS or TOSP entry
 * has no payer (`-`); a benefit entry names an insurer the settings know.
 */
export async function parseKey(db: D1Database, params: { clinicCode?: string; target?: string; payerId?: string }): Promise<CodeMapKey | ValidationIssue> {
  const { target = "", payerId = "" } = params;
  const clinicCode = decodeSegment(params.clinicCode ?? "");
  if (clinicCode === null) return { path: "clinicCode", message: "The clinic code in the path is not valid percent-encoding." };
  if (clinicCode.length === 0 || clinicCode.length > 64) return { path: "clinicCode", message: "Give a clinic code of 1 to 64 characters." };
  if (!(CODE_MAP_TARGETS as readonly string[]).includes(target)) return { path: "target", message: `The target is one of ${CODE_MAP_TARGETS.join(", ")}.` };
  const t = target as CodeMapTarget;
  if (t !== "benefit") {
    if (payerId !== NO_PAYER_SEGMENT) return { path: "payerId", message: `A ${t.toUpperCase()} entry has no payer; use ${NO_PAYER_SEGMENT}.` };
    return { clinicCode, target: t, payerId: "" };
  }
  const { settings } = await settingsRepo.get(db);
  if (!settings.payers.some((p) => p.id === payerId && p.scheme === "insurance"))
    return { path: "payerId", message: "A benefit code belongs to one of the insurers in settings." };
  return { clinicCode, target: t, payerId };
}

/** A CHAS entry must claim as a procedure some rule set knows. */
export function targetCodeIssue(key: CodeMapKey, targetCode: string | null): ValidationIssue | null {
  if (key.target !== "chas" || targetCode === null) return null;
  if (CHAS_RULE_SETS.some((rs) => Object.hasOwn(rs.procedures, targetCode))) return null;
  return { path: "targetCode", message: `${targetCode} is not a CHAS procedure code in any rule set.` };
}

const rebuildCode = (deps: RebuildDeps, key: CodeMapKey, actor: Actor): Promise<RebuildProgress> =>
  rebuildBatch(deps, { kind: "clinic_code", clinicCode: key.clinicCode }, "", actor);

export async function saveEntry(deps: RebuildDeps, key: CodeMapKey, body: CodeMapSaveRequest, actor: Actor): Promise<CodeMapSaveResponse> {
  const who = actorId(actor);
  const at = new Date(deps.now).toISOString();
  const previous = await codeMap.find(deps.db, key.clinicCode, key.target, key.payerId);
  const entry: CodeMapEntry = { ...key, payerId: key.payerId as CodeMapEntry["payerId"], targetCode: body.targetCode, origin: body.origin, updatedBy: who, updatedAt: at };
  const id = entityId(key);
  const detail = { targetCode: body.targetCode, origin: body.origin, previous: previous?.targetCode ?? null };
  await deps.db.batch([
    ...codeMap.saveStatements(deps.db, [entry]),
    auditStatement(deps.db, { at, actor: who, action: "code_map_saved", entityType: "code_map", entityId: id, detail }),
    ...(body.origin === "ai_accepted"
      ? [auditStatement(deps.db, { at, actor: who, action: "ai_suggestion_accepted", entityType: "code_map", entityId: id, detail: { targetCode: body.targetCode } })]
      : []),
  ]);
  return { entry, rebuild: await rebuildCode(deps, key, actor) };
}

/** Removes the entry; null when there is none. */
export async function deleteEntry(deps: RebuildDeps, key: CodeMapKey, actor: Actor): Promise<{ rebuild: RebuildProgress } | null> {
  const previous = await codeMap.find(deps.db, key.clinicCode, key.target, key.payerId);
  if (!previous) return null;
  const who = actorId(actor);
  const at = new Date(deps.now).toISOString();
  await deps.db.batch([
    codeMap.deleteStatement(deps.db, key.clinicCode, key.target, key.payerId),
    auditStatement(deps.db, {
      at,
      actor: who,
      action: "code_map_saved",
      entityType: "code_map",
      entityId: entityId(key),
      detail: { targetCode: null, origin: null, previous: previous.targetCode, deleted: true },
    }),
  ]);
  return { rebuild: await rebuildCode(deps, key, actor) };
}
