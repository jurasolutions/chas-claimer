/**
 * The synthetic clinic: a seeded, pure generator of a dental clinic's configuration, visits and
 * remittance files, built so every UAT case (D01-D27) exists with the feature it tests.
 * The same seed and as-of date always give the same output. No I/O, no clock, no network.
 */
import type { IsoDate } from "../../src/domain/dates";
import type { Cents } from "../../src/domain/money";
import type { DeskSettings } from "../../src/domain/settings";
import type { SourceVisit } from "../../src/domain/source-visit";
import { buildCases, REIMPORT_KEY, REIMPORT_REVISED_FEE, type CaseName } from "./cases";
import { syntheticCodeMap, syntheticSettings, type CodeMap } from "./config";
import { addRoutineVisits } from "./filler";
import { createIdentities } from "./identities";
import { buildRemittances, type Remittances } from "./remittances";
import { projectVisits, type ClinicRecords } from "./records";

export type { CodeMap } from "./config";
export { CASE_NAMES, type CaseName } from "./cases";
export type { ClinicRecords } from "./records";
export type { Remittances } from "./remittances";

export interface ClinicProfile {
  name: string;
  seed: number;
  asOf: IsoDate;
}

export interface SyntheticClinic {
  clinic: ClinicProfile;
  settings: DeskSettings;
  codeMap: CodeMap;
  /** The clinic's own rows: what the SQLite file holds. */
  records: ClinicRecords;
  /** Every visit as a source visit, ordered by date and then visit key. */
  visits: SourceVisit[];
  /** Each UAT case's visit keys. */
  cases: Record<CaseName, string[]>;
  /** Later versions of visits, for the re-import case: the clinic edited them after the first import. */
  revisions: SourceVisit[];
  /** R1 and R2 (uat-script 2.3) as CSV text. */
  remittances: Remittances;
}

export function generateClinic(opts: { seed: number; asOf: IsoDate }): SyntheticClinic {
  const ids = createIdentities(opts.seed);
  const records: ClinicRecords = { patients: [], chasCards: [], policies: [], appointments: [], preauthorisations: [] };
  const cases = buildCases(opts.asOf, ids, records);
  addRoutineVisits(opts.seed, opts.asOf, ids, records);
  const visits = projectVisits(records);
  return {
    clinic: { name: "Example Dental (synthetic)", seed: opts.seed, asOf: opts.asOf },
    settings: syntheticSettings(),
    codeMap: syntheticCodeMap(opts.asOf),
    records,
    visits,
    cases,
    remittances: buildRemittances(opts.asOf, visits),
    revisions: visits
      .filter((v) => v.visitKey === REIMPORT_KEY)
      .map((v) => ({ ...v, treatments: v.treatments.map((t) => (t.code === "SCL" ? { ...t, feeCents: REIMPORT_REVISED_FEE as Cents } : { ...t })) })),
  };
}
