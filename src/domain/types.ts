/**
 * Glossary types and every closed union the claims desk uses. Block 01 declares these complete;
 * a later block adding a member is a one-line change the conductor merges (technical §4).
 * The `as const` arrays are the runtime source for zod enums and the migration's CHECK lists.
 */
import type { Cents } from "./money";
import type { IsoDate } from "./dates";

// ---------------------------------------------------------------- claims and their lifecycle

export const CLAIM_STATUSES = [
  "needs_attention",
  "ready",
  "approved",
  "submitted",
  "accepted",
  "rejected",
  "paid",
  "withdrawn",
  "written_off",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Every action a person or a system actor can take on a claim (decisions-g2 §2). */
export type ClaimAction =
  | { kind: "approve" }
  | { kind: "unapprove" }
  | { kind: "submit"; portalReference?: string }
  | { kind: "portal_refused"; message: string }
  | { kind: "accept"; acceptedCents?: Cents; reason?: string }
  | { kind: "reject"; reason: string }
  | { kind: "record_payment"; cents: Cents; paidOn: IsoDate; remittanceLineId?: string }
  | { kind: "accept_short_payment"; reason: string }
  | { kind: "reopen" }
  | { kind: "withdraw"; reason: string }
  | { kind: "write_off"; reason: string }
  | { kind: "acknowledge_change"; note: string };
export type ClaimActionKind = ClaimAction["kind"];
export const CLAIM_ACTION_KINDS = [
  "approve",
  "unapprove",
  "submit",
  "portal_refused",
  "accept",
  "reject",
  "record_payment",
  "accept_short_payment",
  "reopen",
  "withdraw",
  "write_off",
  "acknowledge_change",
] as const satisfies readonly ClaimActionKind[];

// ---------------------------------------------------------------- payers and schemes

export const SCHEMES = ["chas", "medisave_tosp", "medisave_flexi", "insurance"] as const;
export type Scheme = (typeof SCHEMES)[number];

/** Each scheme's name as the desk shows it on its own, in a list or a heading. */
export const SCHEME_NAMES: Readonly<Record<Scheme, string>> = {
  chas: "CHAS",
  medisave_tosp: "Surgical MediSave (TOSP)",
  medisave_flexi: "Flexi-MediSave",
  insurance: "Insurance",
};

/** A payer's ID: upper-case letters, digits and underscores (also the `PAYER_<ID>_API_TOKEN` infix). */
export type PayerId = string;
export const PAYER_ID_PATTERN = /^[A-Z0-9_]{2,32}$/;

export const CHANNELS = ["assisted", "file", "api", "simulator"] as const;
export type Channel = (typeof CHANNELS)[number];

export const SUBMISSION_RESULTS = ["checklist", "exported", "sent", "failed"] as const;
export type SubmissionResult = (typeof SUBMISSION_RESULTS)[number];

export const CHAS_TIERS = ["PG", "MG", "Blue", "Orange", "Green", "PA"] as const;
export type ChasTier = (typeof CHAS_TIERS)[number];

// ---------------------------------------------------------------- imports, code map, remittances, simulator

export const IMPORT_SOURCES = ["connector", "synthetic", "upload"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const CODE_MAP_TARGETS = ["chas", "tosp", "benefit"] as const;
export type CodeMapTarget = (typeof CODE_MAP_TARGETS)[number];

export const CODE_MAP_ORIGINS = ["manual", "ai_accepted"] as const;
export type CodeMapOrigin = (typeof CODE_MAP_ORIGINS)[number];

/** One row of the code map. `targetCode` null is an explicit "not claimable" mapping (D20). */
export interface CodeMapEntry {
  clinicCode: string;
  target: CodeMapTarget;
  /** The insurer for a benefit code; "" for CHAS and TOSP. */
  payerId: PayerId | "";
  targetCode: string | null;
  origin: CodeMapOrigin;
  updatedBy: string;
  updatedAt: string;
}

export const MATCH_KINDS = ["reference", "patient_date_amount", "manual"] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

export const SIM_STATES = ["received", "accepted", "rejected", "paid"] as const;
export type SimState = (typeof SIM_STATES)[number];

// ---------------------------------------------------------------- findings and the bill split

export const SEVERITIES = ["blocking", "warning"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Codes for findings on a claim. Their wording, severity and fixes live in `claims/findings.ts`. */
export const FINDING_CODES = [
  // CHAS
  "card_expired",
  "chas_green_no_dental",
  "past_submission_window",
  "deadline_approaching",
  "same_day_duplicate",
  "branch_not_chas_registered",
  "frequency_over_limit",
  "benchmark_exceeded",
  "benchmark_not_set",
  // MediSave
  "branch_not_medisave_registered",
  "dentist_not_medisave_accredited",
  "medisave_no_mcaf",
  "tosp_not_in_rule_set",
  "tosp_msp_ranked",
  "tosp_too_many_procedures",
  "tosp_too_many_systems",
  "tosp_too_many_in_system",
  "tosp_multiple_codes",
  "flexi_yearly_amount_exceeded",
  // insurance
  "pre_auth_missing",
  "policy_not_active",
  "insurance_annual_limit_exceeded",
  "insurance_deadline_passed",
  // any scheme
  "no_rule_set",
  "unmapped_treatment",
  "gst_not_registered",
  "waiting_on_upper_payer",
  "upstream_rejected",
  "lower_payer_sent_first",
  "sent_claims_exceed_fee",
  "billed_amount_differs",
  "pa_patient_balance",
  "tier_chosen_from_several",
  "started_at_other_branch",
  "changed_after_submission",
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

export interface Finding {
  code: FindingCode;
  severity: Severity;
  /** Values the message needs, never identity (for example `{ daysLeft: 3 }`). */
  params: Record<string, string | number>;
  /** The rule-set entry the finding comes from, shown as its source. */
  ruleRef?: string;
  /** The claim line it concerns, if one. */
  lineNo?: number;
}

/** Notes on a visit rather than on a claim: why a claim was not built, or a line was held. */
export const VISIT_NOTE_CODES = [
  "held_until_complete",
  "flexi_patient_under_60",
  "flexi_treatment_not_covered",
  "flexi_no_rule_set",
  "insurer_not_on_panel",
  "withdrawn_not_rebuilt",
  "voided_in_clinic",
] as const;
export type VisitNoteCode = (typeof VISIT_NOTE_CODES)[number];

export interface VisitNote {
  code: VisitNoteCode;
  params: Record<string, string | number>;
  /** The rule set the note comes from, when a rule set decided it. */
  ruleRef?: string;
}

/**
 * One segment of the bill split; the patient balance is last and the segments sum to the visit fee.
 * A frozen claim's split ends in `"rest"` instead when open claims on the visit were rebuilt after
 * it: the rest of the bill, which they and the patient share (N3).
 */
export interface SplitSegment {
  payer: PayerId | "patient" | "rest";
  label: string;
  cents: Cents;
  claimId?: string;
}

// ---------------------------------------------------------------- people, identity and the audit trail

export const ROLES = ["reviewer", "officer"] as const;
export type Role = (typeof ROLES)[number];

export const SYSTEM_ACTORS = ["connector", "simulator", "remittance"] as const;
export type SystemActorName = (typeof SYSTEM_ACTORS)[number];

/** Who did something: a signed-in person, or a system actor recording an outcome through `act`. */
export type Actor =
  | { kind: "person"; email: string; roles: readonly Role[] }
  | { kind: "system"; name: SystemActorName };

/** How an actor is written in the audit trail and on records: an email, or `system:<name>`. */
export function actorId(a: Actor): string {
  return a.kind === "person" ? a.email : `system:${a.name}`;
}

/** The identity fields a person may reveal, one at a time and audited. */
export const IDENTITY_FIELDS = ["nric", "name", "phone", "date_of_birth", "address", "member_id", "account_holder_nric"] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];

export const AUDIT_ENTITY_TYPES = ["claim", "visit", "import", "settings", "code_map", "remittance"] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const AUDIT_ACTIONS = [
  ...CLAIM_ACTION_KINDS,
  "built",
  "rebuilt",
  "approval_cleared",
  "flagged_changed",
  "accepted_by_remittance",
  "submission_failed",
  "exported",
  "sent_not_recorded",
  "checkout",
  "checkout_taken_over",
  "annotations_saved",
  "revealed",
  "import_completed",
  "import_refused",
  "settings_saved",
  "code_map_saved",
  "remittance_imported",
  "remittance_line_matched",
  "remittance_line_released",
  "remittance_duplicate_confirmed",
  "ai_suggestion_accepted",
  "identity_resealed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Why the claims are being rebuilt, recorded in each rebuild's audit event. */
export type RebuildReason = "import" | "settings" | "code_map" | "annotations" | "deadline" | "lifecycle";

/** An audit event before it is written. `detail` never carries an identity value. */
export interface AuditDraft {
  at: string;
  actor: string;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  detail: Record<string, unknown>;
}

export interface AuditEvent extends AuditDraft {
  id: number;
}
