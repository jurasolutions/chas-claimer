/**
 * The desk settings as the settings screen sees them, and saving them (functional §8, technical §6).
 *
 * A save is versioned and audited in one batch, then rebuilds the unsubmitted claims the change can
 * move, at most `REBUILD_BATCH` visits per request.
 */
import { REBUILD_BATCH, type RebuildCursor, type RebuildProgress, type RebuildScope, type SettingsResponse, type SettingsSaveResponse } from "../../src/api/settings";
import { listRuleSets } from "../../src/domain/rules";
import { CHAS_RULE_SETS } from "../../src/domain/rules/chas";
import type { DeskSettings } from "../../src/domain/settings";
import { canonicalJson } from "../../src/domain/source-visit";
import type { ValidationIssue } from "../../src/domain/validation";
import { type Actor, actorId } from "../../src/domain/types";
import { roleLists } from "../auth";
import type { Env } from "../env";
import * as affected from "../repo/affected-visits";
import { auditStatement } from "../repo/audit";
import { approvedByChannel } from "../repo/overview";
import * as settingsRepo from "../repo/settings";
import { rebuildVisits, type RebuildDeps, type RebuildReason } from "./rebuild";

export async function readSettings(env: Env): Promise<SettingsResponse> {
  const { version, settings } = await settingsRepo.get(env.DB);
  return {
    version,
    settings,
    roles: roleLists(env),
    ruleSets: listRuleSets(),
    approvedByChannel: await approvedByChannel(env.DB),
  };
}

const DONE: RebuildProgress = { considered: 0, rebuilt: 0, flagged: 0, remaining: 0, next: null };

const reasonFor = (scope: RebuildScope): RebuildReason => (scope.kind === "clinic_code" ? "code_map" : "settings");

/** Rebuilds the next batch of visits in `scope` after `after`; `null` scope means nothing can move. */
export async function rebuildBatch(deps: RebuildDeps, scope: RebuildScope | null, after: string, actor: Actor): Promise<RebuildProgress> {
  if (!scope) return DONE;
  const { keys, last, remaining } = await affected.page(deps.db, scope, after, REBUILD_BATCH);
  const counts = await rebuildVisits(deps, keys, actor, reasonFor(scope));
  const next: RebuildCursor | null = remaining > 0 && last !== null ? { scope, after: last } : null;
  return { considered: keys.length, rebuilt: counts.rebuilt, flagged: counts.flagged, remaining, next };
}

/** The top-level sections whose content differs, in document order. */
function changedSections(before: DeskSettings, after: DeskSettings): (keyof DeskSettings)[] {
  return (Object.keys(after) as (keyof DeskSettings)[]).filter((k) => canonicalJson(before[k]) !== canonicalJson(after[k]));
}

/** What a payer contributes to building a claim; its name and how it is sent do not. */
const payerRules = ({
  name: _n,
  channel: _c,
  apiUrl: _u,
  apiAuthHeader: _h,
  remittanceColumns: _r,
  templateFields: _t,
  portalUrl: _p,
  ...rules
}: DeskSettings["payers"][number]) => rules;

/** Ids whose entry was added, removed or changed in what `project` keeps. */
function changedIds<T extends { id: string }>(before: readonly T[], after: readonly T[], project: (t: T) => unknown): string[] {
  const was = new Map(before.map((t) => [t.id, canonicalJson(project(t))]));
  const now = new Map(after.map((t) => [t.id, canonicalJson(project(t))]));
  const ids = new Set([...was.keys(), ...now.keys()]);
  return [...ids].filter((id) => was.get(id) !== now.get(id)).sort();
}

/** The visits a save can move: everything, one set of dentists or branches, or nothing. */
function rebuildScope(before: DeskSettings, after: DeskSettings): RebuildScope | null {
  const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
  if (!same(before.payers.map(payerRules), after.payers.map(payerRules))) return { kind: "all" };
  if (!same(before.benchmarkOverrides, after.benchmarkOverrides) || !same(before.waterfall, after.waterfall)) return { kind: "all" };
  const dentists = changedIds(before.dentists, after.dentists, ({ name: _, ...d }) => d);
  const branches = changedIds(before.branches, after.branches, ({ name: _, ...b }) => b);
  if (dentists.length > 0 && branches.length > 0) return { kind: "all" };
  if (dentists.length > 0) return { kind: "dentists", ids: dentists };
  if (branches.length > 0) return { kind: "branches", ids: branches };
  return null;
}

/**
 * ADR 0008: an override may only fill a benchmark MOH has left blank. An override carried unchanged
 * from the stored settings is not re-judged, so a later rule set cannot lock the settings.
 */
function benchmarkIssues(before: DeskSettings, after: DeskSettings): ValidationIssue[] {
  const onFile = new Set(before.benchmarkOverrides.map(canonicalJson));
  return after.benchmarkOverrides.flatMap((o, i) => {
    if (onFile.has(canonicalJson(o))) return [];
    const path = `settings.benchmarkOverrides.${i}.procedureCode`;
    const known = CHAS_RULE_SETS.filter((rs) => Object.hasOwn(rs.procedures, o.procedureCode));
    if (known.length === 0) return [{ path, message: `${o.procedureCode} is not a CHAS procedure code in any rule set.` }];
    if (known.every((rs) => rs.procedures[o.procedureCode]?.benchmark != null))
      return [{ path, message: `MOH publishes a benchmark for ${o.procedureCode}, so the desk uses that one.` }];
    return [];
  });
}

export type SaveOutcome =
  | { kind: "saved"; body: SettingsSaveResponse }
  | { kind: "stale"; currentVersion: number }
  | { kind: "invalid"; issues: ValidationIssue[] };

/**
 * Saves `settings` against `expectedVersion`, judged against the row it was made from: a save against
 * any other version is stale at once. A race lost after that check still changes nothing, and its
 * guarded audit event records nothing, even when it repeats an earlier save in the same millisecond.
 */
export async function saveSettings(deps: RebuildDeps, settings: DeskSettings, expectedVersion: number, actor: Actor): Promise<SaveOutcome> {
  const before = await settingsRepo.get(deps.db);
  if (before.version !== expectedVersion) return { kind: "stale", currentVersion: before.version };
  const issues = benchmarkIssues(before.settings, settings);
  if (issues.length > 0) return { kind: "invalid", issues };
  const who = actorId(actor);
  const at = new Date(deps.now).toISOString();
  const toVersion = expectedVersion + 1;
  const detail = { fromVersion: expectedVersion, toVersion, sections: changedSections(before.settings, settings) };
  const [saved] = await deps.db.batch([
    settingsRepo.saveStatement(deps.db, settings, expectedVersion, who, at),
    auditStatement(deps.db, { at, actor: who, action: "settings_saved", entityType: "settings", entityId: "desk", detail }, { settingsVersion: toVersion }),
  ]);
  if (!saved || saved.meta.changes !== 1) return { kind: "stale", currentVersion: (await settingsRepo.get(deps.db)).version };
  const rebuild = await rebuildBatch(deps, rebuildScope(before.settings, settings), "", actor);
  return { kind: "saved", body: { version: toVersion, rebuild } };
}
