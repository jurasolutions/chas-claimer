/**
 * Desks for tests: the synthetic clinic (seed 7, T = 2026-11-13) in an in-memory D1. Every record
 * is synthetic and every NRIC uses the reserved test prefix.
 *
 * - `emptyDesk()`: migrations only.
 * - `configuredDesk()`: the generator's settings and code map saved, nothing imported.
 * - `seededDesk()`: the whole clinic imported through the import service.
 */
import { generateClinic, type CaseName } from "../../mock/synthetic-clinic/generate";
import { identifierKeys } from "../../server/crypto";
import type { Env } from "../../server/env";
import * as codeMap from "../../server/repo/code-map";
import * as settings from "../../server/repo/settings";
import { type Deps, importVisits } from "../../server/services/imports";
import type { IsoDate } from "../../src/domain/dates";
import type { SourceVisit } from "../../src/domain/source-visit";
import type { Actor } from "../../src/domain/types";
import { OFFICER, OTHER_IDENTIFIER_KEY, testEnv } from "./env";

export const TODAY = "2026-11-13" as IsoDate;
/** 10:00 SGT on TODAY. */
export const NOW = Date.parse("2026-11-13T02:00:00.000Z");
export const CLINIC = generateClinic({ seed: 7, asOf: TODAY });
export const OFFICER_ACTOR: Actor = { kind: "person", email: OFFICER, roles: ["officer"] };
export const CONNECTOR_ACTOR: Actor = { kind: "system", name: "connector" };

export interface Desk {
  env: Env;
  db: D1Database;
  deps: Deps;
}

/** A case's source visits, in clinic order. */
export function caseVisits(name: CaseName): SourceVisit[] {
  const keys = new Set(CLINIC.cases[name]);
  return CLINIC.visits.filter((v) => keys.has(v.visitKey));
}

export function visitByKey(key: string): SourceVisit {
  const v = CLINIC.visits.find((x) => x.visitKey === key);
  if (!v) throw new Error(`no synthetic visit ${key}`);
  return v;
}

export async function emptyDesk(overrides: Partial<Env> = {}, now = NOW): Promise<Desk> {
  const env = await testEnv(overrides);
  const keys = await identifierKeys(env);
  if (!keys) throw new Error("test identifier key did not load");
  return { env, db: env.DB, deps: { db: env.DB, env, now, keys } };
}

export async function configuredDesk(overrides: Partial<Env> = {}, now = NOW): Promise<Desk> {
  const desk = await emptyDesk(overrides, now);
  await desk.db.batch([settings.saveStatement(desk.db, CLINIC.settings, 0, OFFICER, new Date(now).toISOString()), ...codeMap.saveStatements(desk.db, CLINIC.codeMap)]);
  return desk;
}

/**
 * The same desk mid-rotation: `OTHER_IDENTIFIER_KEY` is the current key at version 2 and the
 * desk's key is the previous one. Rows written before stay as they were.
 */
export async function rotatedDesk(desk: Desk): Promise<Desk> {
  const env: Env = { ...desk.env, IDENTIFIER_KEY: OTHER_IDENTIFIER_KEY, IDENTIFIER_KEY_VERSION: "2", IDENTIFIER_KEY_PREVIOUS: desk.env.IDENTIFIER_KEY };
  const keys = await identifierKeys(env);
  if (!keys?.previous) throw new Error("rotated identifier keys did not load");
  return { env, db: desk.db, deps: { ...desk.deps, env, keys } };
}

/** The same desk once a rotation is over: `OTHER_IDENTIFIER_KEY` alone, at version 2, with no previous key. */
export async function retiredDesk(desk: Desk): Promise<Desk> {
  const env: Env = { ...desk.env, IDENTIFIER_KEY: OTHER_IDENTIFIER_KEY, IDENTIFIER_KEY_VERSION: "2", IDENTIFIER_KEY_PREVIOUS: undefined };
  const keys = await identifierKeys(env);
  if (!keys || keys.previous) throw new Error("the rotated key did not load alone");
  return { env, db: desk.db, deps: { ...desk.deps, env, keys } };
}

export async function seededDesk(overrides: Partial<Env> = {}, now = NOW): Promise<Desk> {
  const desk = await configuredDesk(overrides, now);
  await importVisits(desk.deps, { source: "synthetic", visits: CLINIC.visits }, OFFICER_ACTOR);
  return desk;
}
