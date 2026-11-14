/**
 * The desk settings document: branches, dentists, payers, benchmark overrides, the waterfall order
 * and the accepted source mapping. Landed complete in block 01 so no later ticket edits this file.
 * Rule-set data (CHAS limits, benchmark ranges, the Flexi start date) lives in `rules/`, not here.
 */
import { z } from "zod";
import { parseIsoDate, type IsoDate } from "./dates";
import type { Result } from "./result";
import { SourceMappingSchema } from "./source-mapping";
import { CHANNELS, PAYER_ID_PATTERN, SCHEMES, type PayerId } from "./types";
import { validate, type ValidationIssue } from "./validation";

const Id = z.string().min(1).max(64);
const Name = z.string().min(1).max(200);
const NonNegCents = z.number().int().min(0).max(100_000_000);
const IsoDateSchema = z
  .string()
  .refine((s) => parseIsoDate(s) !== null, "use a real date as YYYY-MM-DD")
  .transform((s) => s as IsoDate);

/**
 * Where the `api` channel may send a claim (technical F3): https, no credentials in the URL, and a
 * named host that is not an IP literal or localhost.
 */
export function apiUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.username !== "" || url.password !== "") return "must not carry a user name or password";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^[0-9.]+$/.test(host)) return "must be a host name, not an IP address";
  if (host === "localhost" || host.endsWith(".localhost")) return "must not be localhost";
  if (!host.includes(".")) return "must be a fully qualified host name";
  return null;
}

const HttpsUrl = z.string().superRefine((s, ctx) => {
  const problem = apiUrlProblem(s);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

const BranchSchema = z.strictObject({
  id: Id,
  name: Name,
  gstRegistered: z.boolean(),
  chasRegistered: z.boolean(),
  medisaveRegistered: z.boolean(),
});

const DentistSchema = z.strictObject({
  id: Id,
  name: Name,
  medisaveAccredited: z.boolean(),
});

/** The column headers of a payer's remittance file; null where the file has no such column. */
export const RemittanceColumnsSchema = z.strictObject({
  reference: z.string().min(1).max(128).nullable(),
  patientNric: z.string().min(1).max(128).nullable(),
  visitDate: z.string().min(1).max(128).nullable(),
  amount: z.string().min(1).max(128),
  paidOn: z.string().min(1).max(128).nullable(),
});

const PayerSchema = z
  .strictObject({
    id: z.string().regex(PAYER_ID_PATTERN, "use A-Z, 0-9 and _ (2 to 32 characters)"),
    name: Name,
    scheme: z.enum(SCHEMES),
    channel: z.enum(CHANNELS),
    /** Insurers only: whether the clinic is on this insurer's panel. */
    panel: z.boolean(),
    copayPercent: z.number().min(0).max(100).nullable(),
    annualLimitCents: NonNegCents.nullable(),
    preAuthBenefitCodes: z.array(z.string().min(1).max(64)).max(200),
    /** Days after the visit to submit; null means no deadline check. */
    deadlineDays: z.number().int().min(1).max(3650).nullable(),
    /** The payer template's fields, in the template's order; at most 12. */
    templateFields: z.array(z.string().min(1).max(64)).max(12),
    apiUrl: HttpsUrl.nullable(),
    /** The header the token goes in; the token itself comes from `payerTokenName(id)`. */
    apiAuthHeader: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)
      .nullable(),
    remittanceColumns: RemittanceColumnsSchema.nullable(),
    /**
     * The payer's claims portal, for the checklist's "Open portal" link. Optional and blank by
     * default; https only, with the API URL's host rules. A document saved before this field reads as blank.
     */
    portalUrl: HttpsUrl.nullable().default(null),
  })
  .superRefine((p, ctx) => {
    if (p.channel === "api" && p.apiUrl === null) {
      ctx.addIssue({ code: "custom", path: ["apiUrl"], message: "the api channel needs an API URL" });
    }
  });

const BenchmarkOverrideSchema = z
  .strictObject({
    procedureCode: z.string().min(1).max(64),
    minCents: NonNegCents,
    maxCents: NonNegCents,
    /** Where the range comes from: shown beside every benchmark finding. */
    sourceUrl: HttpsUrl,
    asOf: IsoDateSchema,
  })
  .refine((b) => b.minCents <= b.maxCents, { path: ["maxCents"], message: "the maximum is below the minimum" });

const WATERFALL_LEVELS = ["chas", "medisave", "insurance"] as const;

export const DeskSettingsSchema = z.strictObject({
  branches: z.array(BranchSchema).min(1).max(50),
  dentists: z.array(DentistSchema).max(500),
  payers: z
    .array(PayerSchema)
    .max(50)
    .superRefine((payers, ctx) => {
      const seen = new Set<string>();
      payers.forEach((p, i) => {
        if (seen.has(p.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: `${p.id} is used twice` });
        seen.add(p.id);
      });
    }),
  benchmarkOverrides: z.array(BenchmarkOverrideSchema).max(200),
  /** The order payers are applied in; each level appears once. */
  waterfall: z
    .array(z.enum(WATERFALL_LEVELS))
    .length(3)
    .refine((w) => new Set(w).size === 3, "list chas, medisave and insurance once each"),
  /** The source mapping a person accepted for the connector; null until one is. */
  sourceMapping: SourceMappingSchema.nullable(),
});

export type DeskSettings = z.infer<typeof DeskSettingsSchema>;
export type PayerSettings = DeskSettings["payers"][number];
export type BranchSettings = DeskSettings["branches"][number];
export type DentistSettings = DeskSettings["dentists"][number];
export type RemittanceColumns = NonNullable<PayerSettings["remittanceColumns"]>;
export type WaterfallLevel = (typeof WATERFALL_LEVELS)[number];
export type SettingsIssue = ValidationIssue;

export function parseDeskSettings(input: unknown): Result<DeskSettings, SettingsIssue[]> {
  return validate(DeskSettingsSchema, input);
}

/** The environment variable holding a payer's API token. Derived, never configured (technical F3). */
export function payerTokenName(payerId: PayerId): string {
  if (!PAYER_ID_PATTERN.test(payerId)) throw new Error("payer ID outside the token-name pattern");
  return `PAYER_${payerId}_API_TOKEN`;
}

const CLAIM_FORM_FIELDS = ["visit_date", "branch", "dentist", "patient_nric", "patient_name", "treatment_code", "treatment_description", "fee", "claim_amount"];

/** The synthetic clinic's settings, and the starting point for a real one. All names are made up. */
export const DEFAULT_SETTINGS: DeskSettings = {
  branches: [
    { id: "BR-CENTRAL", name: "Central branch", gstRegistered: true, chasRegistered: true, medisaveRegistered: true },
    { id: "BR-EAST", name: "East branch", gstRegistered: false, chasRegistered: true, medisaveRegistered: false },
  ],
  dentists: [
    { id: "DR-A", name: "Dentist A", medisaveAccredited: true },
    { id: "DR-B", name: "Dentist B", medisaveAccredited: true },
    { id: "DR-C", name: "Dentist C", medisaveAccredited: false },
  ],
  payers: [
    {
      id: "CHAS",
      name: "CHAS",
      scheme: "chas",
      channel: "simulator",
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
    },
    {
      id: "MEDISAVE_TOSP",
      name: "MediSave (TOSP)",
      scheme: "medisave_tosp",
      channel: "simulator",
      panel: false,
      copayPercent: null,
      annualLimitCents: null,
      preAuthBenefitCodes: [],
      deadlineDays: null,
      templateFields: [...CLAIM_FORM_FIELDS, "account_holder_nric", "mcaf_type"],
      apiUrl: null,
      apiAuthHeader: null,
      remittanceColumns: null,
      portalUrl: null,
    },
    {
      id: "MEDISAVE_FLEXI",
      name: "Flexi-MediSave",
      scheme: "medisave_flexi",
      channel: "simulator",
      panel: false,
      copayPercent: null,
      annualLimitCents: null,
      preAuthBenefitCodes: [],
      deadlineDays: null,
      templateFields: [...CLAIM_FORM_FIELDS, "account_holder_nric", "mcaf_type"],
      apiUrl: null,
      apiAuthHeader: null,
      remittanceColumns: null,
      portalUrl: null,
    },
    {
      id: "MERIDIAN",
      name: "Meridian Dental Plan",
      scheme: "insurance",
      channel: "simulator",
      panel: true,
      copayPercent: 10,
      annualLimitCents: 100_000,
      preAuthBenefitCodes: ["MDP-CROWN", "MDP-ROOT"],
      deadlineDays: null,
      templateFields: [...CLAIM_FORM_FIELDS, "member_id", "plan"],
      apiUrl: null,
      apiAuthHeader: null,
      remittanceColumns: null,
      portalUrl: null,
    },
    {
      id: "HARBOUR",
      name: "Harbour TPA",
      scheme: "insurance",
      channel: "simulator",
      panel: true,
      copayPercent: null,
      annualLimitCents: 150_000,
      preAuthBenefitCodes: ["HB-PROSTH"],
      deadlineDays: null,
      templateFields: [...CLAIM_FORM_FIELDS, "member_id", "plan", "employer"],
      apiUrl: null,
      apiAuthHeader: null,
      remittanceColumns: null,
      portalUrl: null,
    },
  ],
  benchmarkOverrides: [],
  waterfall: ["chas", "medisave", "insurance"],
  sourceMapping: null,
};
