/**
 * The synthetic clinic (demo mode only): today's generated clinic, imported through `importVisits`
 * like any connector run.
 *
 * - One call imports one page of at most `MAX_VISITS_PER_IMPORT` visits, as its own import, so a
 *   single invocation stays as small as a connector post (technical F7). The caller asks for the
 *   next page until there is none.
 * - Pages follow clinic order, so a patient's earlier visit lands before a later one, as it would
 *   in one import of the whole clinic.
 * - The generator's settings and code map are written only when the desk has none yet, so loading
 *   the clinic again never overwrites what an officer has set up since.
 */
import { generateClinic } from "../../mock/synthetic-clinic/generate";
import { MAX_VISITS_PER_IMPORT, type SyntheticImportPage } from "../../src/api/imports";
import { sgtDay } from "../../src/domain/dates";
import { type Actor, actorId } from "../../src/domain/types";
import * as codeMap from "../repo/code-map";
import * as settings from "../repo/settings";
import { type Deps, importVisits, visitOrder } from "./imports";

export async function loadSyntheticClinic(deps: Deps, actor: Actor, offset: number): Promise<SyntheticImportPage> {
  const { db, now } = deps;
  const clinic = generateClinic({ seed: 7, asOf: sgtDay(now) });

  const setup: D1PreparedStatement[] = [];
  if ((await settings.get(db)).version === 0) setup.push(settings.saveStatement(db, clinic.settings, 0, actorId(actor), new Date(now).toISOString()));
  if ((await codeMap.get(db)).length === 0) setup.push(...codeMap.saveStatements(db, clinic.codeMap));
  if (setup.length > 0) await db.batch(setup);

  const ordered = [...clinic.visits].sort(visitOrder);
  const end = offset + MAX_VISITS_PER_IMPORT;
  const summary = await importVisits(deps, { source: "synthetic", visits: ordered.slice(offset, end) }, actor);
  return { ...summary, next: end < ordered.length ? end : null };
}
