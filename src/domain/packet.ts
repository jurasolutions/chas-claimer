/**
 * A claim as one payer's template asks for it (technical §5, AC-4.1): only the template's fields, in
 * the template's order. A key the desk does not know is carried empty, never guessed. Nothing from the
 * dentist's notes, the diagnosis or another payer's claim can reach a packet, because no key maps to them.
 *
 * With identity null the packet is the screen's: identity fields are masked (the NRIC shows the
 * claim's mask, the rest are empty until revealed). Identity is passed only to send, export and reveal.
 */
import type { CsvCell } from "./csv";
import type { ClaimState } from "./claims/state";
import type { ClinicalVisit, VisitIdentity } from "./source-visit";
import { formatDecimal } from "./money";
import type { IdentityField } from "./types";

export interface PacketField {
  key: string;
  label: string;
  value: CsvCell;
  /** The identity field behind this value, which a person reveals one at a time; null for clinical fields. */
  identityField: IdentityField | null;
  /** True when `value` is withheld or a mask rather than the real identifier. */
  masked: boolean;
}

export interface ClaimPacket {
  claimId: string;
  payerId: string;
  fields: PacketField[];
}

/** What a packet is built from: the claim, the clinical record it was built from, and display names. */
export interface ClaimForPacket {
  claim: Pick<ClaimState, "id" | "payerId" | "visitDate" | "patientMask" | "feeCents" | "claimedCents" | "annotations" | "lines">;
  clinical: Pick<ClinicalVisit, "treatments" | "policies" | "medisave">;
  branchName: string;
  dentistName: string;
}

export interface PayerTemplate {
  payerId: string;
  fields: readonly string[];
}

const LABELS: Record<string, string> = {
  visit_date: "Visit date",
  service_date: "Service date",
  date: "Date",
  branch: "Branch",
  dentist: "Dentist",
  patient_nric: "Patient NRIC",
  nric: "NRIC",
  patient_name: "Patient name",
  phone: "Phone",
  date_of_birth: "Date of birth",
  address: "Address",
  member_id: "Member ID",
  account_holder_nric: "Account holder NRIC",
  plan: "Plan",
  employer: "Employer",
  treatment_code: "Treatment code",
  treatment_description: "Treatment",
  benefit_code: "Benefit code",
  scheme_code: "Scheme code",
  tooth: "Tooth",
  fee: "Fee",
  claim_amount: "Claim amount",
  amount: "Amount",
  mcaf_type: "MCAF type",
  claim_ref: "Claim reference",
  claim_id: "Claim reference",
  pre_auth_ref: "Pre-authorisation reference",
};

const IDENTITY_KEYS: Record<string, IdentityField> = {
  patient_nric: "nric",
  nric: "nric",
  patient_name: "name",
  phone: "phone",
  date_of_birth: "date_of_birth",
  address: "address",
  member_id: "member_id",
  account_holder_nric: "account_holder_nric",
};

export function fieldLabel(key: string): string {
  const known = LABELS[key];
  if (known) return known;
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function buildPacket(input: ClaimForPacket, template: PayerTemplate, identity: VisitIdentity | null): ClaimPacket {
  return {
    claimId: input.claim.id,
    payerId: input.claim.payerId,
    fields: template.fields.map((key) => field(input, key, identity)),
  };
}

function field(input: ClaimForPacket, key: string, identity: VisitIdentity | null): PacketField {
  const label = fieldLabel(key);
  const identityField = IDENTITY_KEYS[key];
  if (!identityField) return { key, label, value: clinicalValue(input, key, identity), identityField: null, masked: false };
  const medisave = input.clinical.medisave;
  if (identityField === "account_holder_nric" && (medisave === null || medisave.accountHolder.relationship === "self")) {
    return { key, label, value: null, identityField: null, masked: false };
  }
  if (identity === null) return { key, label, value: identityField === "nric" ? input.claim.patientMask : null, identityField, masked: true };
  return { key, label, value: identityValue(identity, identityField, input.claim.payerId), identityField, masked: false };
}

function identityValue(identity: VisitIdentity, f: IdentityField, payerId: string): string | null {
  switch (f) {
    case "nric":
      return identity.nric;
    case "name":
      return identity.name;
    case "phone":
      return identity.phone;
    case "date_of_birth":
      return identity.dateOfBirth;
    case "address":
      return identity.address;
    case "member_id":
      return identity.memberIds.find((m) => m.payerId === payerId)?.memberId ?? null;
    case "account_holder_nric":
      return identity.accountHolderNric;
  }
}

function clinicalValue(input: ClaimForPacket, key: string, identity: VisitIdentity | null): CsvCell {
  const { claim, clinical } = input;
  const policy = clinical.policies.find((p) => p.payerId === claim.payerId);
  const lines = (pick: (l: ClaimForPacket["claim"]["lines"][number]) => string | null) => joined(claim.lines.map(pick));
  switch (key) {
    case "visit_date":
    case "service_date":
    case "date":
      return claim.visitDate;
    case "branch":
      return input.branchName;
    case "dentist":
      return input.dentistName;
    case "plan":
      return policy?.plan ?? null;
    case "employer":
      return policy?.employer ?? null;
    case "treatment_code":
      return lines((l) => clinical.treatments[l.treatmentRef]?.code ?? null);
    case "treatment_description":
      return lines((l) => clinical.treatments[l.treatmentRef]?.description ?? null);
    case "benefit_code":
    case "scheme_code":
      return lines((l) => l.schemeCode);
    case "tooth":
      return lines((l) => l.tooth);
    case "fee":
      return { cents: claim.feeCents };
    case "claim_amount":
    case "amount":
      return { cents: claim.claimedCents };
    case "mcaf_type":
      return clinical.medisave?.mcaf.type ?? null;
    case "claim_ref":
    case "claim_id":
      return claim.id;
    case "pre_auth_ref":
      // The officer's annotation wins; otherwise the reference the clinic recorded, which is sealed
      // with the identity and so appears only when the packet is opened to send.
      return (
        claim.annotations.preAuthReference ??
        (identity && lines((l) => identity.preAuthRefs.find((r) => r.payerId === claim.payerId && r.benefitCode === l.schemeCode)?.reference ?? null))
      );
    default:
      return null;
  }
}

function joined(values: (string | null)[]): string | null {
  const present = values.filter((v): v is string => v !== null && v !== "");
  return present.length === 0 ? null : present.join("; ");
}

/** A packet value as a person reads and copies it: amounts with two decimals, no currency sign. */
export function cellText(value: CsvCell): string | null {
  if (value === null || typeof value === "string") return value;
  return formatDecimal(value.cents);
}
