/**
 * Turns a clinic source's rows into source visits through a source mapping (technical F1). One visit
 * per row of the visits table, in the source's order, each with its patient, treatment lines, every
 * CHAS card, policies, MediSave details and pre-authorisations joined on by key.
 *
 * Each visit is parsed here with the import's own schema, so a row the desk would refuse is reported
 * at the clinic, by where it sits in the source, and skipped. Problems name a path, never a value,
 * and say what is wrong in plain words ("the visit date is missing"), never in the schema's own text.
 *
 * Values are coerced the way clinic systems store them: blanks are absent, keys compare as text,
 * numbers may arrive as text, dates may carry a time, times may carry seconds, and money is cents
 * or dollars as the mapping says. Anything else passes through unchanged for the schema to refuse.
 */
import type { IsoDate } from "../src/domain/dates";
import { parseDollars } from "../src/domain/money";
import type { SourceMapping } from "../src/domain/source-mapping";
import { parseSourceVisit, type SourceVisit } from "../src/domain/source-visit";
import type { ValidationIssue } from "../src/domain/validation";
import { inPlainWords } from "./problems";
import type { SourceRow, TableSource } from "./sources/source";

export type VisitRead =
  | { ok: true; where: string; visit: SourceVisit }
  | { ok: false; where: string; problems: ValidationIssue[] };

type Fields = Record<string, string | undefined>;
type Values = Record<string, unknown>;

export async function* readVisits(source: TableSource, mapping: SourceMapping, opts: { since?: IsoDate } = {}): AsyncGenerator<VisitRead> {
  const read = async (table: string, fields: Fields, key?: string) => {
    const columns = [...new Set([...(key ? [key] : []), ...Object.values(fields).filter((c): c is string => c !== undefined)])];
    return source.rows(table, columns);
  };
  const grouped = async (entity: { table: string; key: string; fields: Fields } | null | undefined) => {
    const groups = new Map<string, Values[]>();
    if (!entity) return groups;
    for (const row of await read(entity.table, entity.fields, entity.key)) {
      const k = keyOf(row.values[entity.key]);
      if (k === null) continue;
      const list = groups.get(k) ?? [];
      list.push(pick(row.values, entity.fields));
      groups.set(k, list);
    }
    return groups;
  };

  const visitRows = await read(mapping.visits.table, mapping.visits.fields);
  const patients = await grouped(mapping.patients);
  const treatments = await grouped(mapping.treatments);
  const chasCards = await grouped(mapping.chasCards);
  const policies = await grouped(mapping.policies);
  const medisave = await grouped(mapping.medisave);
  const preAuths = await grouped(mapping.preAuths);
  const money = (v: unknown) => (mapping.amountUnit === "cents" ? int(v) : dollars(v));

  for (const row of visitRows) {
    const v = pick(row.values, mapping.visits.fields);
    const date = isoDate(v.date);
    if (opts.since && typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < opts.since) continue;
    yield assemble(row, v, date);
  }

  function assemble(row: SourceRow, v: Values, date: unknown): VisitRead {
    const visitKey = keyOf(v.visitKey);
    const patientKey = keyOf(v.patientKey);
    const problems: ValidationIssue[] = [];

    const patientRows = patientKey === null ? [] : (patients.get(patientKey) ?? []);
    if (patientRows.length === 0) problems.push({ path: "patient", message: "no patient row has this visit's patient key" });
    if (patientRows.length > 1) problems.push({ path: "patient", message: "more than one patient row has this visit's patient key" });

    const ms = visitKey === null ? [] : (medisave.get(visitKey) ?? []);
    if (ms.length > 1) problems.push({ path: "medisave", message: "more than one MediSave row for this visit" });

    const patientPolicies = (patientKey === null ? [] : (policies.get(patientKey) ?? [])).map((p): Values => ({ ...p, payerId: text(p.payerId) }));
    const visitPreAuths = (visitKey === null ? [] : (preAuths.get(visitKey) ?? [])).map((a): Values => ({ ...a, payerId: text(a.payerId) }));
    if (visitPreAuths.some((a) => !patientPolicies.some((p) => p.payerId === a.payerId))) {
      problems.push({ path: "policies", message: "a pre-authorisation names a payer the patient has no policy with" });
    }
    if (problems.length > 0) return { ok: false, where: row.where, problems };

    const p = patientRows[0]!;
    const m = ms[0];
    const candidate = {
      visitKey: visitKey ?? undefined,
      patient: {
        nric: text(p.nric),
        name: text(p.name),
        phone: text(p.phone),
        dateOfBirth: isoDate(p.dateOfBirth),
        address: text(p.address),
      },
      branchId: keyOf(v.branchId) ?? undefined,
      dentistId: keyOf(v.dentistId) ?? undefined,
      date,
      startTime: time(v.startTime),
      voided: bool(v.voided),
      treatments: (visitKey === null ? [] : (treatments.get(visitKey) ?? [])).map((t) => ({
        code: text(t.code),
        description: text(t.description) ?? "",
        feeCents: money(t.fee),
        gstCents: money(t.gst),
        tooth: text(t.tooth),
        quantity: int(t.quantity),
        completion: text(t.completion),
        completedOn: isoDate(t.completedOn),
      })),
      notes: text(v.notes),
      chasCards: (patientKey === null ? [] : (chasCards.get(patientKey) ?? [])).map((c) => ({ tier: text(c.tier), expiry: isoDate(c.expiry) })),
      policies: patientPolicies.map((x) => ({
        payerId: x.payerId,
        memberId: text(x.memberId),
        plan: text(x.plan),
        employer: text(x.employer),
        limitCents: money(x.limit),
        validFrom: isoDate(x.validFrom),
        validTo: isoDate(x.validTo),
        preAuths: visitPreAuths
          .filter((a) => a.payerId === x.payerId)
          .map((a) => ({ benefitCode: text(a.benefitCode), reference: text(a.reference), approvedOn: isoDate(a.approvedOn) })),
      })),
      medisave: m && {
        accountHolder: { relationship: text(m.holderRelationship), age: int(m.holderAge), nric: text(m.holderNric) },
        mcaf: { type: text(m.mcafType), validFrom: isoDate(m.mcafValidFrom), validTo: isoDate(m.mcafValidTo), revokedOn: isoDate(m.mcafRevokedOn) },
      },
    };
    const parsed = parseSourceVisit(candidate);
    if (parsed.ok) return { ok: true, where: row.where, visit: parsed.value };
    return { ok: false, where: row.where, problems: parsed.error.map((issue) => inPlainWords(issue, candidate)) };
  }
}

/** The mapped fields of a row, renamed from the clinic's columns to the mapping's field names. */
function pick(values: Values, fields: Fields): Values {
  const out: Values = {};
  for (const [field, column] of Object.entries(fields)) if (column !== undefined) out[field] = values[column];
  return out;
}

const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** Keys compare as text, so an integer key in one table matches its text in another. */
function keyOf(v: unknown): string | null {
  if (blank(v)) return null;
  return typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "bigint" ? String(v) : null;
}

function text(v: unknown): unknown {
  if (blank(v)) return undefined;
  return typeof v === "number" ? String(v) : v;
}

function int(v: unknown): unknown {
  if (blank(v)) return undefined;
  if (typeof v === "string" && /^\s*-?\d+\s*$/.test(v)) return Number(v);
  return v;
}

/** Dollars as the desk reads them (`parseDollars`); a value it refuses passes through for the schema to name. */
function dollars(v: unknown): unknown {
  if (blank(v)) return undefined;
  if (typeof v !== "number" && typeof v !== "string") return v;
  const parsed = parseDollars(String(v));
  return parsed.ok ? parsed.value : v;
}

function bool(v: unknown): unknown {
  if (blank(v)) return undefined;
  if (v === 0 || v === 1) return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "y"].includes(s)) return true;
    if (["0", "false", "no", "n"].includes(s)) return false;
  }
  return v;
}

/** "2026-11-13 00:00:00" and "2026-11-13T00:00:00Z" are the date; anything else is left to the schema. */
function isoDate(v: unknown): unknown {
  if (blank(v)) return undefined;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v.trim())) return v.trim().slice(0, 10);
  return v;
}

/** "09:30:00" is "09:30". */
function time(v: unknown): unknown {
  if (blank(v)) return undefined;
  if (typeof v === "string" && /^\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v.trim())) return v.trim().slice(0, 5);
  return v;
}
