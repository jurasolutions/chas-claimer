/**
 * The synthetic clinic's own records, shaped the way a clinic management system holds them: one row
 * per patient, CHAS card, insurance policy, appointment and pre-authorisation. Dentist notes, every
 * CHAS card, policy validity and pre-authorisations all reach the source visit, so the SQLite file
 * the connector reads (ticket 05) and the visits the generator returns carry the same facts.
 *
 * `projectVisits` is the one mapping from these records to source visits. The generator and the
 * SQLite reader both use it, so a file read back gives exactly the visits the generator returns.
 */
import type { IsoDate } from "../../src/domain/dates";
import type { Cents } from "../../src/domain/money";
import type { Nric } from "../../src/domain/nric";
import type { SourceTreatment, SourceVisit } from "../../src/domain/source-visit";
import type { ChasTier } from "../../src/domain/types";

export interface PatientRecord {
  patientId: string;
  nric: Nric;
  name: string;
  phone: string;
  dateOfBirth: IsoDate;
  address: string | null;
}

/** A patient may hold more than one card (D21); the visit carries every one, in record order. */
export interface ChasCardRecord {
  patientId: string;
  tier: ChasTier;
  expiry: IsoDate;
}

export interface PolicyRecord {
  patientId: string;
  payerId: string;
  memberId: string;
  plan: string;
  employer: string | null;
  limitCents: Cents | null;
  validFrom: IsoDate;
  /** Null while the policy runs. D17's ended at T-60 and is still on file. */
  validTo: IsoDate | null;
}

export interface AppointmentRecord {
  visitKey: string;
  patientId: string;
  branchId: string;
  dentistId: string;
  date: IsoDate;
  startTime: string | null;
  voided: boolean;
  /** Free text. D18 and D18b's carry the patient's synthetic name, phone and (D18b) identifier. */
  dentistNote: string | null;
  treatments: SourceTreatment[];
  medisave: SourceVisit["medisave"];
}

/** Keyed by appointment, as the clinic files it; it lands on that patient's policy with the same payer. */
export interface PreauthorisationRecord {
  visitKey: string;
  payerId: string;
  benefitCode: string;
  reference: string;
  approvedOn: IsoDate;
}

export interface ClinicRecords {
  patients: PatientRecord[];
  chasCards: ChasCardRecord[];
  policies: PolicyRecord[];
  appointments: AppointmentRecord[];
  /** Empty as generated: UAT 5.16 has the tester add PA-0016 to D16 by hand. */
  preauthorisations: PreauthorisationRecord[];
}

/** Source visits from the clinic's records, ordered by date and then visit key. */
export function projectVisits(records: ClinicRecords): SourceVisit[] {
  const patients = new Map(records.patients.map((p) => [p.patientId, p]));
  return records.appointments
    .map((a): SourceVisit => {
      const p = patients.get(a.patientId);
      if (!p) throw new Error(`appointment ${a.visitKey} names a patient with no record`);
      const preAuths = records.preauthorisations.filter((r) => r.visitKey === a.visitKey);
      const policies = records.policies.filter((x) => x.patientId === a.patientId);
      for (const r of preAuths) {
        if (!policies.some((x) => x.payerId === r.payerId)) {
          throw new Error(`appointment ${a.visitKey} has a pre-authorisation for ${r.payerId}, which the patient has no policy with`);
        }
      }
      return {
        visitKey: a.visitKey,
        patient: { nric: p.nric, name: p.name, phone: p.phone, dateOfBirth: p.dateOfBirth, address: p.address },
        branchId: a.branchId,
        dentistId: a.dentistId,
        date: a.date,
        startTime: a.startTime,
        voided: a.voided,
        treatments: a.treatments.map((t) => ({ ...t })),
        notes: a.dentistNote,
        chasCards: records.chasCards.filter((c) => c.patientId === a.patientId).map((c) => ({ tier: c.tier, expiry: c.expiry })),
        policies: policies.map((x) => ({
          payerId: x.payerId,
          memberId: x.memberId,
          plan: x.plan,
          employer: x.employer,
          limitCents: x.limitCents,
          validFrom: x.validFrom,
          validTo: x.validTo,
          preAuths: preAuths
            .filter((r) => r.payerId === x.payerId)
            .map((r) => ({ benefitCode: r.benefitCode, reference: r.reference, approvedOn: r.approvedOn })),
        })),
        medisave: a.medisave && {
          accountHolder: { ...a.medisave.accountHolder },
          mcaf: { ...a.medisave.mcaf },
        },
        billedCents: {},
      };
    })
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.visitKey < y.visitKey ? -1 : x.visitKey > y.visitKey ? 1 : 0));
}
