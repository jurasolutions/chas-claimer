/**
 * A clinic visit as the connector or the synthetic clinic hands it over, already mapped onto the
 * desk's fields with money in integer cents. The import splits it at once into an `identity` part,
 * sealed before it is stored, and a de-identified `clinical` part that everything else reads
 * (technical F1, ADR 0006). Parse problems name a path and never echo a value.
 */
import { z } from "zod";
import { ageOn, parseIsoDate, type IsoDate } from "./dates";
import type { Cents } from "./money";
import { parseNric, type Nric } from "./nric";
import type { Result } from "./result";
import { CHAS_TIERS, PAYER_ID_PATTERN, type ChasTier, type PayerId } from "./types";
import { validate, type ValidationIssue } from "./validation";

export type FieldProblem = ValidationIssue;

const Text = (max: number) => z.string().trim().min(1).max(max);
const NricSchema = z.string().transform((raw, ctx) => {
  const nric = parseNric(raw);
  if (nric === null) {
    ctx.addIssue({ code: "custom", message: "not a valid NRIC or FIN" });
    return z.NEVER;
  }
  return nric;
});
const DateSchema = z.string().transform((raw, ctx) => {
  const date = parseIsoDate(raw);
  if (date === null) {
    ctx.addIssue({ code: "custom", message: "use a real date as YYYY-MM-DD" });
    return z.NEVER;
  }
  return date;
});
const CentsSchema = z
  .number()
  .int()
  .min(0)
  .max(100_000_000)
  .transform((n) => n as Cents);
const PayerIdSchema = z.string().regex(PAYER_ID_PATTERN, "not a payer ID");

export const COMPLETIONS = ["complete", "in_progress"] as const;
export type Completion = (typeof COMPLETIONS)[number];

export const MCAF_TYPES = ["single_visit", "period", "standing"] as const;
export type McafType = (typeof MCAF_TYPES)[number];

/** Whose MediSave pays (functional S2). `self` is the patient: no separate NRIC or age. */
export const HOLDER_RELATIONSHIPS = ["self", "spouse", "parent", "child", "grandparent", "sibling"] as const;
export type HolderRelationship = (typeof HOLDER_RELATIONSHIPS)[number];

const TreatmentSchema = z.strictObject({
  code: Text(64),
  description: z.string().trim().max(500),
  feeCents: CentsSchema,
  gstCents: CentsSchema.nullable().default(null),
  tooth: z.string().trim().max(16).nullable().default(null),
  quantity: z.number().int().min(1).max(1000).default(1),
  completion: z.enum(COMPLETIONS).default("complete"),
  completedOn: DateSchema.nullable().default(null),
});

const AccountHolderSchema = z
  .strictObject({
    relationship: z.enum(HOLDER_RELATIONSHIPS),
    age: z.number().int().min(0).max(130).nullable().default(null),
    nric: NricSchema.nullable().default(null),
  })
  .superRefine((h, ctx) => {
    if (h.relationship === "self") {
      if (h.nric !== null) ctx.addIssue({ code: "custom", path: ["nric"], message: "the patient's own account takes no separate NRIC" });
      if (h.age !== null) ctx.addIssue({ code: "custom", path: ["age"], message: "the patient's own account takes no separate age" });
      return;
    }
    if (h.nric === null) ctx.addIssue({ code: "custom", path: ["nric"], message: "another account holder needs an NRIC" });
    if (h.age === null) ctx.addIssue({ code: "custom", path: ["age"], message: "another account holder needs an age" });
  });

const MedisaveSchema = z.strictObject({
  accountHolder: AccountHolderSchema.default({ relationship: "self", age: null, nric: null }),
  mcaf: z.strictObject({
    type: z.enum(MCAF_TYPES),
    validFrom: DateSchema,
    validTo: DateSchema.nullable().default(null),
    revokedOn: DateSchema.nullable().default(null),
  }),
});

const SourceVisitSchema = z.strictObject({
  visitKey: Text(128),
  patient: z.strictObject({
    nric: NricSchema,
    name: Text(200),
    phone: Text(40),
    dateOfBirth: DateSchema,
    address: z.string().trim().max(500).nullable().default(null),
  }),
  branchId: Text(64),
  dentistId: Text(64),
  date: DateSchema,
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM")
    .nullable()
    .default(null),
  voided: z.boolean().default(false),
  treatments: z.array(TreatmentSchema).max(200),
  /**
   * The dentist's free-text note. It can carry a name, a phone number or an NRIC (D18, D18b), so it
   * is sealed with the identity and only the AI path opens and scrubs it (ADR 0004, functional S9).
   */
  notes: z.string().trim().max(4000).nullable().default(null),
  /** Every card the patient holds; the rules pick the valid tier with the highest subsidy (functional S5, D21). */
  chasCards: z
    .array(z.strictObject({ tier: z.enum(CHAS_TIERS), expiry: DateSchema }))
    .max(10)
    .default([]),
  policies: z
    .array(
      z.strictObject({
        payerId: PayerIdSchema,
        memberId: Text(64),
        plan: Text(128),
        employer: z.string().trim().max(200).nullable().default(null),
        limitCents: CentsSchema.nullable().default(null),
        /** Null when the source does not say: the policy is taken as running (D17 has an end date). */
        validFrom: DateSchema.nullable().default(null),
        validTo: DateSchema.nullable().default(null),
        /** Pre-authorisations the insurer approved against this policy (D16). */
        preAuths: z
          .array(z.strictObject({ benefitCode: Text(64), reference: Text(64), approvedOn: DateSchema }))
          .max(50)
          .default([]),
      }),
    )
    .max(20)
    .default([]),
  medisave: MedisaveSchema.nullable().default(null),
  /** What the clinic billed each payer, when the source holds the split (functional S16). */
  billedCents: z.record(PayerIdSchema, CentsSchema).default({}),
});

/** A parsed source visit, branded where the domain brands: `Nric`, `IsoDate`, `Cents`. */
export type SourceVisit = z.output<typeof SourceVisitSchema>;
export type SourceTreatment = SourceVisit["treatments"][number];
/** For `self`, `age` and `nric` are null: the patient's own apply. */
export type AccountHolder = NonNullable<SourceVisit["medisave"]>["accountHolder"];

export function parseSourceVisit(input: unknown): Result<SourceVisit, FieldProblem[]> {
  return validate(SourceVisitSchema, input);
}

/** Everything that identifies a person. Sealed with AES-GCM before it is stored (technical F1). */
export interface VisitIdentity {
  nric: Nric;
  name: string;
  phone: string;
  dateOfBirth: IsoDate;
  address: string | null;
  memberIds: { payerId: PayerId; memberId: string }[];
  /** Another person's NRIC when their MediSave pays; null for the patient's own account. */
  accountHolderNric: Nric | null;
  /** The dentist's note, which may name the patient. Only the AI path opens it, and scrubs it first. */
  notes: string | null;
  /** Insurer pre-authorisation references, kept with the member IDs they sit beside on a claim form. */
  preAuthRefs: { payerId: PayerId; benefitCode: string; reference: string }[];
}

/** A policy as the rules see it: no member ID, and pre-authorisations without their reference. */
export interface ClinicalPolicy {
  payerId: PayerId;
  plan: string;
  employer: string | null;
  limitCents: Cents | null;
  validFrom: IsoDate | null;
  validTo: IsoDate | null;
  preAuths: { benefitCode: string; approvedOn: IsoDate }[];
}

/** The de-identified visit every rule, screen and export reads. No field of `VisitIdentity` appears here. */
export interface ClinicalVisit {
  visitKey: string;
  branchId: string;
  dentistId: string;
  date: IsoDate;
  startTime: string | null;
  voided: boolean;
  ageAtVisit: number;
  treatments: SourceTreatment[];
  chasCards: { tier: ChasTier; expiry: IsoDate }[];
  policies: ClinicalPolicy[];
  medisave: {
    accountHolder: { relationship: HolderRelationship; ageAtVisit: number };
    mcaf: NonNullable<SourceVisit["medisave"]>["mcaf"];
  } | null;
  billedCents: Record<PayerId, Cents>;
}

/**
 * Splits a parsed visit into the part that is sealed and the part everything else reads. Ages are
 * taken at the visit date, so the result depends on the visit alone.
 */
export function splitVisit(v: SourceVisit): { identity: VisitIdentity; clinical: ClinicalVisit } {
  const ageAtVisit = ageOn(v.patient.dateOfBirth, v.date);
  const identity: VisitIdentity = {
    nric: v.patient.nric,
    name: v.patient.name,
    phone: v.patient.phone,
    dateOfBirth: v.patient.dateOfBirth,
    address: v.patient.address,
    memberIds: v.policies.map((p) => ({ payerId: p.payerId, memberId: p.memberId })),
    accountHolderNric: v.medisave?.accountHolder.nric ?? null,
    notes: v.notes,
    preAuthRefs: v.policies.flatMap((p) =>
      p.preAuths.map((a) => ({ payerId: p.payerId, benefitCode: a.benefitCode, reference: a.reference })),
    ),
  };
  const clinical: ClinicalVisit = {
    visitKey: v.visitKey,
    branchId: v.branchId,
    dentistId: v.dentistId,
    date: v.date,
    startTime: v.startTime,
    voided: v.voided,
    ageAtVisit,
    treatments: v.treatments,
    chasCards: v.chasCards,
    policies: v.policies.map((p) => ({
      payerId: p.payerId,
      plan: p.plan,
      employer: p.employer,
      limitCents: p.limitCents,
      validFrom: p.validFrom,
      validTo: p.validTo,
      preAuths: p.preAuths.map((a) => ({ benefitCode: a.benefitCode, approvedOn: a.approvedOn })),
    })),
    medisave: v.medisave && {
      accountHolder: {
        relationship: v.medisave.accountHolder.relationship,
        ageAtVisit: v.medisave.accountHolder.age ?? ageAtVisit,
      },
      mcaf: v.medisave.mcaf,
    },
    billedCents: v.billedCents,
  };
  return { identity, clinical };
}

/**
 * The inverse of `splitVisit`: the visit the import parsed, from the two parts it stored. The
 * re-seal route uses it to rebuild a revision's content hash under a new key (infra I1), so
 * `canonicalJson(joinVisit(splitVisit(v)))` is `canonicalJson(v)` for every parsed visit.
 * Member IDs line up with the policies by position, and pre-authorisation references in order.
 */
export function joinVisit(identity: VisitIdentity, clinical: ClinicalVisit): SourceVisit {
  const refs = [...identity.preAuthRefs];
  const policies = clinical.policies.map((p, i) => {
    const memberId = identity.memberIds[i];
    if (memberId?.payerId !== p.payerId) throw new Error("The sealed member IDs don't line up with the visit's policies.");
    const preAuths = p.preAuths.map((a) => {
      const ref = refs.shift();
      if (ref?.payerId !== p.payerId || ref.benefitCode !== a.benefitCode) {
        throw new Error("The sealed pre-authorisation references don't line up with the visit's policies.");
      }
      return { benefitCode: a.benefitCode, reference: ref.reference, approvedOn: a.approvedOn };
    });
    return {
      payerId: p.payerId,
      memberId: memberId.memberId,
      plan: p.plan,
      employer: p.employer,
      limitCents: p.limitCents,
      validFrom: p.validFrom,
      validTo: p.validTo,
      preAuths,
    };
  });
  if (identity.memberIds.length !== policies.length || refs.length > 0) {
    throw new Error("The sealed identity holds more than the visit's policies.");
  }
  const holder = clinical.medisave?.accountHolder;
  return {
    visitKey: clinical.visitKey,
    patient: {
      nric: identity.nric,
      name: identity.name,
      phone: identity.phone,
      dateOfBirth: identity.dateOfBirth,
      address: identity.address,
    },
    branchId: clinical.branchId,
    dentistId: clinical.dentistId,
    date: clinical.date,
    startTime: clinical.startTime,
    voided: clinical.voided,
    treatments: clinical.treatments,
    notes: identity.notes,
    chasCards: clinical.chasCards,
    policies,
    medisave:
      clinical.medisave && holder
        ? {
            accountHolder:
              holder.relationship === "self"
                ? { relationship: "self", age: null, nric: null }
                : { relationship: holder.relationship, age: holder.ageAtVisit, nric: identity.accountHolderNric },
            mcaf: clinical.medisave.mcaf,
          }
        : null,
    billedCents: clinical.billedCents,
  };
}

/**
 * JSON with object keys sorted at every depth and `undefined` members dropped: the input to a
 * visit's content hash, so the same visit hashes the same whatever order its keys arrived in.
 */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(v).sort()) {
    const member = (v as Record<string, unknown>)[key];
    if (member !== undefined) out[key] = sortKeys(member);
  }
  return out;
}
