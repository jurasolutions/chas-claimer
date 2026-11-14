/**
 * The UAT cases (uat-script section 2.2) as clinic records. Patients P01-P37 carry the labels the
 * UAT uses; every visit is dated relative to the as-of date T, so the cases stay inside the
 * windows they test whenever the clinic is generated. Expected claim amounts are not here: they
 * belong to the rules' tests (tickets 02 and 03).
 *
 * Choices the UAT leaves open:
 * - An in-progress line carries no fee (0) and no GST: the clinic bills a crown when it is fitted.
 * - A patient's MCAF covers every one of that patient's visits. A standing one runs from T-400; a
 *   single-visit one runs on the visit's date only.
 * - Dates of birth sit 120 days before T, so a patient's age is the same on every recent visit.
 */
import { addDays, yearOf, type IsoDate } from "../../src/domain/dates";
import type { Cents } from "../../src/domain/money";
import type { Nric } from "../../src/domain/nric";
import type { SourceTreatment, SourceVisit } from "../../src/domain/source-visit";
import type { ChasTier } from "../../src/domain/types";
import type { Identities } from "./identities";
import type { AppointmentRecord, ClinicRecords, PatientRecord } from "./records";

export const CASE_NAMES = [
  "D01", "D02", "D03", "D04a", "D04b", "D05", "D06", "D07", "D07b", "D08", "D08b", "D09a", "D09b",
  "D10", "D11", "D12", "D13", "D14", "D14b", "D15", "D16", "D17", "D18", "D18b", "D19", "D20",
  "D21", "D22", "D23", "D24", "D25", "D26", "D27", "partlyUsedLimit", "multiTosp", "reimport",
] as const;
export type CaseName = (typeof CASE_NAMES)[number];

export const DESCRIPTIONS: Record<string, string> = {
  CON: "Consultation",
  SCL: "Scaling and polishing",
  XR: "X-ray",
  "FIL-S": "Simple filling",
  "EXT-P": "Posterior extraction",
  "RCT-A": "Root canal, anterior",
  "RCT-P": "Root canal, premolar",
  "RCT-M": "Root canal, molar",
  CRN: "Crown",
  WHT: "Whitening",
  "SURG-WT": "Wisdom tooth surgery",
  "SURG-WTS": "Wisdom tooth surgery, minor",
  PRS: "Periodontal surgery",
  IMP: "Implant",
  "NEW-99": "Laser gum contouring",
};

export const EAST = "BR-EAST";
export const WEST = "BR-WEST";
/** Singapore GST, 9% since 1 January 2024 (IRAS). Synthetic fees only; the desk reads GST as given. */
const GST_RATE = 0.09;

type Policy = "MERIDIAN" | "HARBOUR" | "HARBOUR_ENDED";
interface PatientSpec {
  id: string;
  tiers: ChasTier[];
  age: number;
  /** Overrides the default birth date, for the turning-60 cases. */
  dateOfBirth?: IsoDate;
  cardExpiry?: IsoDate;
  mcaf?: "standing" | "single_visit";
  /** Pays from a spouse's account (D26): the spouse's age. */
  spouseAge?: number;
  policy?: Policy;
}

/** A line on a visit: a completed one bills `fee`; an in-progress one bills nothing yet. */
export interface LineSpec {
  code: string;
  fee: number;
  inProgress?: boolean;
  tooth?: string;
  /** GST in cents, overriding the branch's rule (D22). */
  gst?: number;
}
export interface VisitSpec {
  key: string;
  patientId: string;
  branchId: string;
  dentistId?: string;
  date: IsoDate;
  startTime?: string;
  lines: LineSpec[];
}

/** `date` minus `years`, with 29 Feb falling back to 28 Feb in a common year. */
export function yearsBefore(date: IsoDate, years: number): IsoDate {
  const [y, m, d] = date.split("-");
  const year = Number(y) - years;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = m === "02" && d === "29" && !leap ? "28" : d;
  return `${String(year).padStart(4, "0")}-${m}-${day}` as IsoDate;
}

/** A birth date that gives `age` on every visit from T-119 to T. */
export function birthDateFor(asOf: IsoDate, age: number): IsoDate {
  return yearsBefore(addDays(asOf, -120), age);
}

export function treatment(line: LineSpec, branchId: string, date: IsoDate): SourceTreatment {
  const description = DESCRIPTIONS[line.code];
  if (description === undefined) throw new Error(`no description for ${line.code}`);
  if (line.inProgress) {
    return { code: line.code, description, feeCents: 0 as Cents, gstCents: null, tooth: line.tooth ?? null, quantity: 1, completion: "in_progress", completedOn: null };
  }
  const gst = line.gst ?? (branchId === EAST ? Math.round(line.fee * GST_RATE) : null);
  return {
    code: line.code,
    description,
    feeCents: line.fee as Cents,
    gstCents: gst === null ? null : (gst as Cents),
    tooth: line.tooth ?? null,
    quantity: 1,
    completion: "complete",
    completedOn: date,
  };
}

/** Who sees a patient at each branch unless a case says otherwise (uat-script 2.1). */
export const DEFAULT_DENTIST: Record<string, string> = { [EAST]: "DR-A", [WEST]: "DR-B" };

/**
 * Adds patients and appointments to `records` and returns the map from case name to visit keys.
 * Patients are created in label order, so identifiers depend only on the seed.
 */
export function buildCases(asOf: IsoDate, ids: Identities, records: ClinicRecords): Record<CaseName, string[]> {
  const T = asOf;
  const ago = (n: number) => addDays(T, -n);
  const cap = (d: IsoDate) => (d > T ? T : d);
  const notBefore = (d: IsoDate, floor: IsoDate) => cap(d < floor ? floor : d);
  const jan = (day: number) => `${yearOf(T)}-01-${String(day).padStart(2, "0")}` as IsoDate;

  const patients: PatientSpec[] = [
    { id: "P01", tiers: ["Blue"], age: 45 },
    { id: "P02", tiers: ["PG"], age: 85, mcaf: "standing" },
    { id: "P03", tiers: ["MG"], age: 70 },
    { id: "P04", tiers: ["Blue"], age: 40 },
    { id: "P05", tiers: ["Orange"], age: 35 },
    { id: "P06", tiers: ["PA"], age: 50 },
    { id: "P07", tiers: ["Green"], age: 45 },
    { id: "P08", tiers: ["MG"], age: 70, mcaf: "standing", policy: "MERIDIAN" },
    { id: "P09", tiers: ["Orange"], age: 45 },
    { id: "P10", tiers: ["Green"], age: 63, mcaf: "standing" },
    { id: "P11", tiers: ["Orange"], age: 50, cardExpiry: ago(40) },
    { id: "P12", tiers: ["Orange"], age: 50, cardExpiry: ago(6) },
    { id: "P13", tiers: ["Blue"], age: 40 },
    { id: "P14", tiers: ["Blue"], age: 40 },
    { id: "P15", tiers: ["Blue"], age: 30 },
    { id: "P16", tiers: ["Blue"], age: 30, mcaf: "single_visit" },
    { id: "P17", tiers: ["Blue"], age: 30, mcaf: "standing" },
    { id: "P18", tiers: ["Orange"], age: 55 },
    { id: "P19", tiers: ["Blue"], age: 50, mcaf: "standing" },
    { id: "P20", tiers: ["Blue"], age: 59, dateOfBirth: yearsBefore(addDays(T, 20), 60) },
    { id: "P21", tiers: ["Orange"], age: 60, dateOfBirth: yearsBefore(ago(4), 60), mcaf: "standing" },
    { id: "P22", tiers: ["Blue"], age: 70, mcaf: "standing" },
    { id: "P23", tiers: ["Blue"], age: 40, policy: "HARBOUR" },
    { id: "P24", tiers: ["Blue"], age: 40, policy: "HARBOUR_ENDED" },
    { id: "P25", tiers: ["Blue"], age: 40 },
    { id: "P26", tiers: ["Blue"], age: 40 },
    { id: "P27", tiers: ["Blue"], age: 40 },
    { id: "P28", tiers: ["Blue"], age: 40 },
    { id: "P29", tiers: ["MG", "Blue"], age: 70 },
    { id: "P30", tiers: ["Blue"], age: 40 },
    { id: "P31", tiers: ["Blue"], age: 40 },
    { id: "P32", tiers: ["Blue"], age: 40 },
    { id: "P33", tiers: ["Blue"], age: 65, mcaf: "standing", spouseAge: 66 },
    { id: "P34", tiers: ["Blue"], age: 40, policy: "MERIDIAN" },
    { id: "P35", tiers: ["Blue"], age: 40, policy: "MERIDIAN" },
    { id: "P36", tiers: ["Blue"], age: 30, mcaf: "single_visit" },
    { id: "P37", tiers: ["Blue"], age: 40 },
  ];
  const specs = new Map(patients.map((p) => [p.id, p]));
  const spouses = new Map<string, Nric>();
  for (const p of patients) {
    addPatient(records, ids, asOf, { patientId: p.id, tiers: p.tiers, age: p.age, dateOfBirth: p.dateOfBirth, cardExpiry: p.cardExpiry });
    if (p.spouseAge !== undefined) spouses.set(p.id, ids.nric());
    if (p.policy) {
      const harbour = p.policy !== "MERIDIAN";
      records.policies.push({
        patientId: p.id,
        payerId: harbour ? "HARBOUR" : "MERIDIAN",
        memberId: ids.memberId(),
        plan: harbour ? "Harbour Corporate Dental" : "Meridian Dental Basic",
        employer: harbour ? "Sample Employer (synthetic)" : null,
        limitCents: harbour ? null : (100_000 as Cents),
        validFrom: p.policy === "HARBOUR_ENDED" ? ago(425) : ago(400),
        validTo: p.policy === "HARBOUR_ENDED" ? ago(60) : null,
      });
    }
  }

  const medisaveFor = (patientId: string, date: IsoDate): SourceVisit["medisave"] => {
    const p = specs.get(patientId);
    if (!p?.mcaf) return null;
    const spouse = spouses.get(patientId);
    return {
      accountHolder: spouse && p.spouseAge !== undefined ? { relationship: "spouse", age: p.spouseAge, nric: spouse } : { relationship: "self", age: null, nric: null },
      mcaf:
        p.mcaf === "standing"
          ? { type: "standing", validFrom: ago(400), validTo: null, revokedOn: null }
          : { type: "single_visit", validFrom: date, validTo: date, revokedOn: null },
    };
  };
  const visit = (v: VisitSpec, note: string | null = null): string => {
    records.appointments.push(appointment(v, note, medisaveFor(v.patientId, v.date)));
    return v.key;
  };
  const one = (key: string, patientId: string, branchId: string, date: IsoDate, lines: LineSpec[], extra: Partial<VisitSpec> = {}) =>
    [visit({ key, patientId, branchId, date, lines, ...extra })];
  const CON = { code: "CON", fee: 2800 };
  const SCL = { code: "SCL", fee: 5000 };
  const CRN_STARTED = { code: "CRN", fee: 0, inProgress: true };
  const patientOf = (id: string) => records.patients.find((p) => p.patientId === id)!;
  const p25 = patientOf("P25");
  const p26 = patientOf("P26");

  return {
    D01: one("SC-D01", "P01", EAST, ago(3), [CON, { code: "SCL", fee: 6000 }]),
    D02: ["P02", "P03", "P04", "P05", "P06", "P07"].map((id) => visit({ key: `SC-D02-${id}`, patientId: id, branchId: WEST, date: ago(2), lines: [CON] })),
    D03: one("SC-D03", "P02", EAST, ago(5), [{ code: "RCT-M", fee: 90000 }]),
    D04a: one("SC-D04a", "P08", EAST, ago(18), [CON, { code: "XR", fee: 3000 }, CRN_STARTED]),
    D04b: one("SC-D04b", "P08", EAST, ago(4), [{ code: "CRN", fee: 120000 }]),
    D05: one("SC-D05", "P09", WEST, ago(10), [CON, CRN_STARTED]),
    D06: one("SC-D06", "P10", EAST, ago(6), [{ code: "RCT-P", fee: 70000 }]),
    D07: one("SC-D07", "P11", WEST, ago(6), [SCL]),
    D07b: one("SC-D07b", "P12", WEST, ago(6), [SCL]),
    D08: one("SC-D08", "P13", WEST, ago(31), [SCL]),
    D08b: one("SC-D08b", "P14", WEST, ago(30), [SCL]),
    D09a: one("SC-D09a", "P15", EAST, ago(7), [CON], { startTime: "09:30" }),
    D09b: one("SC-D09b", "P15", WEST, ago(7), [{ code: "XR", fee: 3000 }], { startTime: "16:00" }),
    D10: one("SC-D10", "P16", EAST, ago(8), [{ code: "SURG-WT", fee: 150000, tooth: "38" }]),
    D11: one("SC-D11", "P17", EAST, ago(8), [{ code: "SURG-WTS", fee: 40000 }]),
    D12: one("SC-D12", "P18", EAST, ago(9), [{ code: "PRS", fee: 90000 }]),
    D13: one("SC-D13", "P19", WEST, ago(9), [{ code: "IMP", fee: 300000 }], { dentistId: "DR-C" }),
    D14: one("SC-D14", "P20", WEST, ago(4), [{ code: "RCT-A", fee: 50000 }]),
    D14b: one("SC-D14b", "P21", WEST, ago(4), [{ code: "RCT-A", fee: 50000 }]),
    D15: one("SC-D15", "P22", WEST, ago(4), [SCL]),
    D16: [
      visit({ key: "SC-D16-PREP", patientId: "P23", branchId: EAST, date: ago(19), lines: [CRN_STARTED] }),
      visit({ key: "SC-D16", patientId: "P23", branchId: EAST, date: ago(5), lines: [{ code: "CRN", fee: 100000 }] }),
    ],
    D17: one("SC-D17", "P24", WEST, ago(5), [{ code: "FIL-S", fee: 8000 }]),
    D18: [visit({ key: "SC-D18", patientId: "P25", branchId: EAST, date: ago(3), lines: [{ code: "CON", fee: 3500 }] }, `Patient ${p25.name} (${p25.phone}) asked for a longer consultation.`)],
    D18b: [
      visit(
        { key: "SC-D18b", patientId: "P26", branchId: EAST, date: ago(3), lines: [{ code: "CON", fee: 2900 }] },
        `Patient ${p26.name}, ${p26.nric}, ${p26.phone}: extended consultation at the patient's request.`,
      ),
    ],
    D19: [ago(28), ago(14), ago(2)].map((d, i) =>
      visit({ key: `SC-D19-${i + 1}`, patientId: "P27", branchId: WEST, date: notBefore(d, jan(i + 1)), lines: [SCL] }),
    ),
    D20: one("SC-D20", "P28", EAST, ago(2), [CON, { code: "NEW-99", fee: 20000 }]),
    D21: one("SC-D21", "P29", WEST, ago(2), [CON]),
    D22: one("SC-D22", "P30", WEST, ago(2), [{ ...CON, gst: 252 }]),
    D23: one("SC-D23", "P31", EAST, "2025-09-15" as IsoDate, [CON]),
    D24: one("SC-D24", "P06", WEST, ago(1), [{ code: "WHT", fee: 15000 }]),
    D25: [
      visit({ key: "SC-D25-PREP", patientId: "P32", branchId: WEST, date: ago(20), lines: [CRN_STARTED] }),
      visit({ key: "SC-D25", patientId: "P32", branchId: EAST, date: ago(6), lines: [{ code: "CRN", fee: 100000 }] }),
    ],
    D26: one("SC-D26", "P33", WEST, ago(3), [{ code: "RCT-A", fee: 50000 }]),
    D27: one("SC-D27", "P35", EAST, ago(6), [{ code: "RCT-M", fee: 80000, tooth: "14" }]),
    partlyUsedLimit: [
      visit({ key: "SC-PARTLY-1", patientId: "P34", branchId: EAST, date: notBefore(ago(45), jan(1)), lines: [{ code: "CRN", fee: 100000 }] }),
      visit({ key: "SC-PARTLY-2", patientId: "P34", branchId: EAST, date: notBefore(ago(15), cap(jan(2))), lines: [{ code: "RCT-M", fee: 80000 }] }),
    ],
    multiTosp: one("SC-MULTITOSP", "P36", EAST, ago(11), [
      { code: "SURG-WT", fee: 150000, tooth: "38" },
      { code: "SURG-WT", fee: 150000, tooth: "48" },
    ]),
    reimport: one("SC-REIMPORT", "P37", WEST, ago(12), [SCL]),
  };
}

/** The reimport case's revision: the same visit with the scaling fee raised to $55.00. */
export const REIMPORT_KEY = "SC-REIMPORT";
export const REIMPORT_REVISED_FEE = 5500 as Cents;

export function addPatient(
  records: ClinicRecords,
  ids: Identities,
  asOf: IsoDate,
  p: { patientId: string; tiers: ChasTier[]; age: number; dateOfBirth?: IsoDate; cardExpiry?: IsoDate; address?: string | null },
): PatientRecord {
  const n = Number(p.patientId.slice(1));
  const patient: PatientRecord = {
    patientId: p.patientId,
    nric: ids.nric(),
    name: ids.name(),
    phone: ids.phone(),
    dateOfBirth: p.dateOfBirth ?? birthDateFor(asOf, p.age),
    address: p.address !== undefined ? p.address : n % 2 === 1 ? `${n} Example Street, Singapore 000${String(n).padStart(3, "0")}` : null,
  };
  records.patients.push(patient);
  for (const tier of p.tiers) records.chasCards.push({ patientId: p.patientId, tier, expiry: p.cardExpiry ?? addDays(asOf, 365) });
  return patient;
}

export function appointment(v: VisitSpec, dentistNote: string | null, medisave: SourceVisit["medisave"]): AppointmentRecord {
  return {
    visitKey: v.key,
    patientId: v.patientId,
    branchId: v.branchId,
    dentistId: v.dentistId ?? DEFAULT_DENTIST[v.branchId]!,
    date: v.date,
    startTime: v.startTime ?? null,
    voided: false,
    dentistNote,
    treatments: v.lines.map((l) => treatment(l, v.branchId, v.date)),
    medisave,
  };
}
