/**
 * Routine visits that make the clinic look like a working practice rather than a list of test
 * cases: patients P38 onwards, each with a handful of consultations, scalings, X-rays and fillings
 * over the last 180 days. They test nothing on their own; they give the queues and filters volume.
 */
import { addDays, type IsoDate } from "../../src/domain/dates";
import { CHAS_TIERS, type ChasTier } from "../../src/domain/types";
import { addPatient, appointment, DEFAULT_DENTIST, EAST, WEST, type LineSpec } from "./cases";
import { mulberry32, type Identities } from "./identities";
import type { ClinicRecords } from "./records";

export const PATIENT_COUNT = 60;
export const VISIT_COUNT = 200;

const ROUTINE: LineSpec[] = [
  { code: "CON", fee: 2800 },
  { code: "SCL", fee: 5000 },
  { code: "XR", fee: 3000 },
  { code: "FIL-S", fee: 8000 },
];

/** Tops the clinic up to PATIENT_COUNT patients and VISIT_COUNT visits. */
export function addRoutineVisits(seed: number, asOf: IsoDate, ids: Identities, records: ClinicRecords): void {
  // A stream of its own, so adding a case never reshuffles the routine visits' identities.
  const rng = mulberry32(seed ^ 0x5eed_f111);
  const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

  const first = records.patients.length + 1;
  const patients = PATIENT_COUNT - records.patients.length;
  let remaining = VISIT_COUNT - records.appointments.length;
  if (patients <= 0 || remaining < patients) throw new Error("the cases leave no room for routine visits");

  let n = 0;
  for (let i = 0; i < patients; i++) {
    const patientId = `P${String(first + i).padStart(2, "0")}`;
    const roll = rng();
    const tiers: ChasTier[] = roll < 0.2 ? [] : [CHAS_TIERS[int(0, CHAS_TIERS.length - 1)]!];
    addPatient(records, ids, asOf, { patientId, tiers, age: int(21, 80) });

    // Spread what is left as evenly as possible over the patients still to come.
    const visits = Math.ceil(remaining / (patients - i));
    remaining -= visits;
    const days = new Set<number>();
    while (days.size < visits) days.add(int(1, 180));
    for (const day of [...days].sort((a, b) => b - a)) {
      const branchId = rng() < 0.5 ? EAST : WEST;
      const line = ROUTINE[int(0, ROUTINE.length - 1)]!;
      const second = rng() < 0.4 ? ROUTINE.find((l) => l.code !== line.code && rng() < 0.5) : undefined;
      records.appointments.push(
        appointment(
          {
            key: `SC-F${String(++n).padStart(4, "0")}`,
            patientId,
            branchId,
            dentistId: DEFAULT_DENTIST[branchId]!,
            date: addDays(asOf, -day),
            lines: second ? [line, second] : [line],
          },
          null,
          null,
        ),
      );
    }
  }
}
