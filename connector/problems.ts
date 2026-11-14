/**
 * Turns the import schema's issues into the words a clinic administrator reads (QA D19): "the visit
 * date is missing", "the fee on treatment line 2 isn't an amount of zero or more". Zod's own text
 * never reaches the screen, and neither does the value: the message is built from the field's path
 * and whether the mapped row had anything there at all.
 */
import { COMPLETIONS, HOLDER_RELATIONSHIPS, MCAF_TYPES } from "../src/domain/source-visit";
import { CHAS_TIERS } from "../src/domain/types";
import type { ValidationIssue } from "../src/domain/validation";

type Kind = "text" | "date" | "time" | "amount" | "count" | "nric" | "payer" | "yesno" | readonly string[];

/** Paths with each list index as `#`; `{1}` and `{2}` in a label are the first and second line numbers. */
const FIELDS: Record<string, [label: string, kind: Kind]> = {
  visitKey: ["the visit key", "text"],
  "patient.nric": ["the patient's NRIC or FIN", "nric"],
  "patient.name": ["the patient's name", "text"],
  "patient.phone": ["the patient's phone number", "text"],
  "patient.dateOfBirth": ["the patient's date of birth", "date"],
  "patient.address": ["the patient's address", "text"],
  branchId: ["the branch", "text"],
  dentistId: ["the dentist", "text"],
  date: ["the visit date", "date"],
  startTime: ["the start time", "time"],
  voided: ["the voided flag", "yesno"],
  notes: ["the dentist's note", "text"],
  "treatments.#.code": ["the item code on treatment line {1}", "text"],
  "treatments.#.description": ["the description on treatment line {1}", "text"],
  "treatments.#.feeCents": ["the fee on treatment line {1}", "amount"],
  "treatments.#.gstCents": ["the GST on treatment line {1}", "amount"],
  "treatments.#.tooth": ["the tooth on treatment line {1}", "text"],
  "treatments.#.quantity": ["the quantity on treatment line {1}", "count"],
  "treatments.#.completion": ["the status on treatment line {1}", COMPLETIONS],
  "treatments.#.completedOn": ["the completion date on treatment line {1}", "date"],
  "chasCards.#.tier": ["the tier on CHAS card {1}", CHAS_TIERS],
  "chasCards.#.expiry": ["the expiry date on CHAS card {1}", "date"],
  "policies.#.payerId": ["the insurer on policy {1}", "payer"],
  "policies.#.memberId": ["the member ID on policy {1}", "text"],
  "policies.#.plan": ["the plan on policy {1}", "text"],
  "policies.#.employer": ["the employer on policy {1}", "text"],
  "policies.#.limitCents": ["the annual limit on policy {1}", "amount"],
  "policies.#.validFrom": ["the start date on policy {1}", "date"],
  "policies.#.validTo": ["the end date on policy {1}", "date"],
  "policies.#.preAuths.#.benefitCode": ["the benefit code on pre-authorisation {2} of policy {1}", "text"],
  "policies.#.preAuths.#.reference": ["the reference on pre-authorisation {2} of policy {1}", "text"],
  "policies.#.preAuths.#.approvedOn": ["the approval date on pre-authorisation {2} of policy {1}", "date"],
  "medisave.accountHolder.relationship": ["the MediSave account holder's relationship", HOLDER_RELATIONSHIPS],
  "medisave.accountHolder.age": ["the MediSave account holder's age", "count"],
  "medisave.accountHolder.nric": ["the MediSave account holder's NRIC or FIN", "nric"],
  "medisave.mcaf.type": ["the MCAF type", MCAF_TYPES],
  "medisave.mcaf.validFrom": ["the MCAF start date", "date"],
  "medisave.mcaf.validTo": ["the MCAF end date", "date"],
  "medisave.mcaf.revokedOn": ["the MCAF revocation date", "date"],
};

/** A list the schema caps: more entries than one visit takes. */
const LISTS: Record<string, string> = {
  treatments: "the visit has more treatment lines than the desk takes",
  chasCards: "the patient has more CHAS cards than the desk takes",
  policies: "the patient has more policies than the desk takes",
  "policies.#.preAuths": "policy {1} has more pre-authorisations than the desk takes",
};

/** The same issue, its message rewritten from the path and the mapped row; the path is kept for tests and logs. */
export function inPlainWords(issue: ValidationIssue, candidate: unknown): ValidationIssue {
  const segments = issue.path === "" ? [] : issue.path.split(".");
  const lines = segments.filter((s) => /^\d+$/.test(s)).map((s) => Number(s) + 1);
  const pattern = segments.map((s) => (/^\d+$/.test(s) ? "#" : s)).join(".");
  const numbered = (template: string) => template.replace(/\{(\d)\}/g, (_, n: string) => String(lines[Number(n) - 1] ?? ""));

  const list = LISTS[pattern];
  if (list) return { path: issue.path, message: numbered(list) };
  const field = FIELDS[pattern];
  if (!field) return { path: issue.path, message: issue.path === "" ? "the row isn't a visit the desk can read" : `the field ${issue.path} isn't valid` };

  const [template, kind] = field;
  const label = numbered(template);
  const value = at(candidate, segments);
  if (value === undefined || value === null) return { path: issue.path, message: `${label} is missing` };
  if (pattern.startsWith("medisave.accountHolder.") && at(candidate, ["medisave", "accountHolder", "relationship"]) === "self") {
    return { path: issue.path, message: `${label} should be blank when the MediSave account is the patient's own` };
  }
  return { path: issue.path, message: `${label} ${refusal(kind, value)}` };
}

function refusal(kind: Kind, value: unknown): string {
  if (typeof kind !== "string") return `isn't one of: ${kind.join(", ")}`;
  switch (kind) {
    case "date":
      return "isn't a date; use YYYY-MM-DD";
    case "time":
      return "isn't a time; use HH:MM";
    case "amount":
      return "isn't an amount of zero or more";
    case "count":
      return "isn't a whole number in range";
    case "nric":
      return "isn't valid";
    case "payer":
      return "isn't a payer ID";
    case "yesno":
      return "isn't yes or no";
    case "text":
      return typeof value === "string" ? "is too long" : "isn't text";
  }
}

function at(value: unknown, segments: string[]): unknown {
  let here = value;
  for (const s of segments) {
    if (here === null || typeof here !== "object") return undefined;
    here = (here as Record<string, unknown>)[s];
  }
  return here;
}
