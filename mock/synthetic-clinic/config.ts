/**
 * The synthetic clinic's configuration (UAT section 2.1): two branches, three dentists, the five
 * payers and the code map. Every name here is made up. The insurers are fictional
 * ("Meridian Dental Plan", "Harbour TPA") and their benefit codes are invented (decisions-g2 section 11).
 */
import type { IsoDate } from "../../src/domain/dates";
import type { DeskSettings, PayerSettings } from "../../src/domain/settings";
import type { CodeMapEntry } from "../../src/domain/types";

/** The code map the desk starts with: one row per clinic code and target. */
export type CodeMap = CodeMapEntry[];

/** The fields a claim form or export carries, in order. Made up for the synthetic payers. */
const CLAIM_FORM_FIELDS = ["visit_date", "branch", "dentist", "patient_nric", "patient_name", "treatment_code", "treatment_description", "fee", "claim_amount"];

/** Harbour TPA's upload template. Invented column names, not any real TPA's. */
const HARBOUR_TEMPLATE = ["claim_ref", "member_id", "patient_name", "visit_date", "benefit_code", "fee", "claim_amount", "pre_auth_ref"];

/** A fictional host: `.test` is reserved and never resolves (RFC 2606). */
const MERIDIAN_API_URL = "https://simulator.example.test/meridian";

function payer(p: Partial<PayerSettings> & Pick<PayerSettings, "id" | "name" | "scheme" | "channel">): PayerSettings {
  return {
    panel: false,
    copayPercent: null,
    annualLimitCents: null,
    preAuthBenefitCodes: [],
    deadlineDays: null,
    templateFields: CLAIM_FORM_FIELDS,
    apiUrl: null,
    apiAuthHeader: null,
    remittanceColumns: null,
    portalUrl: null,
    ...p,
  };
}

export function syntheticSettings(): DeskSettings {
  return {
    branches: [
      { id: "BR-EAST", name: "East branch", gstRegistered: true, chasRegistered: true, medisaveRegistered: true },
      { id: "BR-WEST", name: "West branch", gstRegistered: false, chasRegistered: true, medisaveRegistered: true },
    ],
    dentists: [
      { id: "DR-A", name: "Dentist A", medisaveAccredited: true },
      { id: "DR-B", name: "Dentist B", medisaveAccredited: true },
      { id: "DR-C", name: "Dentist C", medisaveAccredited: false },
    ],
    payers: [
      payer({
        id: "CHAS",
        name: "CHAS",
        scheme: "chas",
        channel: "assisted",
        remittanceColumns: { reference: "reference", patientNric: "identifier", visitDate: "visit date", amount: "amount", paidOn: null },
      }),
      payer({
        id: "MEDISAVE_TOSP",
        name: "MediSave (TOSP)",
        scheme: "medisave_tosp",
        channel: "simulator",
        templateFields: [...CLAIM_FORM_FIELDS, "account_holder_nric", "mcaf_type"],
      }),
      payer({
        id: "MEDISAVE_FLEXI",
        name: "Flexi-MediSave",
        scheme: "medisave_flexi",
        channel: "simulator",
        templateFields: [...CLAIM_FORM_FIELDS, "account_holder_nric", "mcaf_type"],
      }),
      payer({
        id: "MERIDIAN",
        name: "Meridian Dental Plan",
        scheme: "insurance",
        channel: "api",
        panel: true,
        apiUrl: MERIDIAN_API_URL,
        apiAuthHeader: "Authorization",
        remittanceColumns: { reference: "Claim Ref", patientNric: null, visitDate: "Service Date", amount: "Paid Amount", paidOn: "Paid On" },
      }),
      payer({
        id: "HARBOUR",
        name: "Harbour TPA",
        scheme: "insurance",
        channel: "file",
        panel: true,
        preAuthBenefitCodes: ["H-CRN"],
        templateFields: HARBOUR_TEMPLATE,
      }),
    ],
    // MOH's consultation and crown benchmarks ship in the CHAS rule set with their source
    // (decisions-g2 section 9); an override only fills a benchmark MOH leaves blank (ADR 0008).
    benchmarkOverrides: [],
    waterfall: ["chas", "medisave", "insurance"],
    sourceMapping: null,
  };
}

/** [clinic code, target, payer, target code]. A null target code is an explicit "not claimable". */
const CODE_MAP_ROWS: [string, CodeMapEntry["target"], string, string | null][] = [
  ["CON", "chas", "", "CONSULTATION"],
  ["SCL", "chas", "", "SCALING"],
  ["XR", "chas", "", "XRAY"],
  ["FIL-S", "chas", "", "FILLING_SIMPLE"],
  ["EXT-P", "chas", "", "EXTRACTION_POSTERIOR"],
  ["RCT-A", "chas", "", "RCT_ANTERIOR"],
  ["RCT-P", "chas", "", "RCT_PREMOLAR"],
  ["RCT-M", "chas", "", "RCT_MOLAR"],
  ["CRN", "chas", "", "CROWN_PERMANENT"],
  ["WHT", "chas", "", null],
  ["SURG-WT", "tosp", "", "SF813T"],
  ["SURG-WTS", "tosp", "", "SF811T"],
  ["PRS", "tosp", "", "SF708T"],
  ["IMP", "tosp", "", "SB816M"],
  ["RCT-A", "benefit", "MERIDIAN", "RC1"],
  ["RCT-P", "benefit", "MERIDIAN", "RC1"],
  ["RCT-M", "benefit", "MERIDIAN", "RC1"],
  ["CRN", "benefit", "MERIDIAN", "CR1"],
  ["CRN", "benefit", "HARBOUR", "H-CRN"],
  ["FIL-S", "benefit", "HARBOUR", "H-FIL"],
  ["EXT-P", "benefit", "HARBOUR", "H-EXT"],
];

/** NEW-99 ("Laser gum contouring") is deliberately absent: the unmapped code (D20). */
export function syntheticCodeMap(asOf: IsoDate): CodeMap {
  return CODE_MAP_ROWS.map(([clinicCode, target, payerId, targetCode]) => ({
    clinicCode,
    target,
    payerId,
    targetCode,
    origin: "manual",
    updatedBy: "synthetic-clinic",
    updatedAt: `${asOf}T00:00:00.000Z`,
  }));
}
