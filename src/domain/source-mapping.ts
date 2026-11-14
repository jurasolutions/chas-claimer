/**
 * How a clinic's own database maps onto the desk's visit fields. One definition for the mapping
 * screen (01b), the connector (05) and the mapping assistant (09). The assistant and the screen see
 * a `SourceSchema`: table and column names only, never a row value.
 */
import { z } from "zod";
import type { Result } from "./result";
import { validate, type ValidationIssue } from "./validation";

/**
 * A table or column name. Letters, digits, spaces, `_`, `.` and `-` only, so a reader can quote it
 * as an SQL identifier or match a CSV header without an escape path.
 */
const Identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_ .-]{0,63}$/, "use letters, digits, spaces, _ . or - (64 at most)");

export const SourceSchemaSchema = z.strictObject({
  kind: z.enum(["sqlite", "csv"]),
  tables: z
    .array(z.strictObject({ name: z.string().min(1).max(128), columns: z.array(z.string().max(128)).max(500) }))
    .max(200),
});
export type SourceSchema = z.infer<typeof SourceSchemaSchema>;

/** A table whose rows belong to a visit or a patient: `key` is the column holding that visit or patient key. */
const entity = <F extends z.ZodRawShape>(fields: F) =>
  z.strictObject({ table: Identifier, key: Identifier, fields: z.strictObject(fields) });

const req = Identifier;
const opt = Identifier.optional();

export const SourceMappingSchema = z.strictObject({
  /** How the clinic stores money: integer cents, or dollars with up to two decimals. */
  amountUnit: z.enum(["cents", "dollars"]),
  visits: z.strictObject({
    table: Identifier,
    fields: z.strictObject({
      visitKey: req,
      patientKey: req,
      branchId: req,
      dentistId: req,
      date: req,
      startTime: opt,
      voided: opt,
      billedAmount: opt,
      /** The dentist's free-text note. Sealed with the identity on import: it can name the patient. */
      notes: opt,
    }),
  }),
  /** `key` is the column the visits table's `patientKey` refers to. */
  patients: entity({ nric: req, name: req, phone: req, dateOfBirth: req, address: opt }),
  /** Visit-keyed treatment lines. */
  treatments: entity({
    code: req,
    description: req,
    fee: req,
    gst: opt,
    tooth: opt,
    quantity: opt,
    completion: opt,
    completedOn: opt,
  }),
  /** Patient-keyed tables; null when the clinic does not hold them. */
  chasCards: entity({ tier: req, expiry: req }).nullable(),
  policies: entity({ payerId: req, memberId: req, plan: req, employer: opt, limit: opt, validFrom: opt, validTo: opt }).nullable(),
  /** Visit-keyed MediSave details: the account holder and the MCAF; null when not held. */
  medisave: entity({
    holderRelationship: req,
    holderAge: req,
    holderNric: req,
    mcafType: req,
    mcafValidFrom: req,
    mcafValidTo: opt,
    mcafRevokedOn: opt,
  }).nullable(),
  /**
   * Visit-keyed pre-authorisations. Each lands on the visit patient's policy with the same payer;
   * one with no such policy is a problem with that visit. Absent or null when the clinic holds none.
   */
  preAuths: entity({ payerId: req, benefitCode: req, reference: req, approvedOn: req }).nullable().optional(),
});
export type SourceMapping = z.infer<typeof SourceMappingSchema>;

export function parseSourceMapping(input: unknown): Result<SourceMapping, ValidationIssue[]> {
  return validate(SourceMappingSchema, input);
}
