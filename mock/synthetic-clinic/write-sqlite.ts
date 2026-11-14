/**
 * Writes the synthetic clinic into a SQLite file in its own schema (`schema.sql`), and reads one
 * back. The reader goes through `projectVisits`, the same mapping the generator uses, so a file
 * read back gives the generator's visits, or the tester's edits to them. Bytes in, bytes out: the
 * caller decides where the file lives.
 */
import { readFileSync } from "node:fs";
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from "sql.js";
import type { IsoDate } from "../../src/domain/dates";
import type { Cents } from "../../src/domain/money";
import type { Nric } from "../../src/domain/nric";
import type { AccountHolder, Completion, HolderRelationship, McafType, SourceVisit } from "../../src/domain/source-visit";
import type { ChasTier } from "../../src/domain/types";
import type { SyntheticClinic } from "./generate";
import { projectVisits, type AppointmentRecord, type ClinicRecords } from "./records";

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

let SQL: SqlJsStatic | undefined;
const sqlite = async () => (SQL ??= await initSqlJs());

export async function writeSqlite(clinic: SyntheticClinic): Promise<Uint8Array> {
  const db = new (await sqlite()).Database();
  try {
    db.exec(SCHEMA);
    const insert = (sql: string, rows: SqlValue[][]) => {
      const stmt = db.prepare(sql);
      try {
        for (const row of rows) stmt.run(row);
      } finally {
        stmt.free();
      }
    };
    const { records, settings } = clinic;
    db.exec("BEGIN");
    insert("INSERT INTO branches VALUES (?, ?)", settings.branches.map((b) => [b.id, b.name]));
    insert("INSERT INTO doctors VALUES (?, ?)", settings.dentists.map((d) => [d.id, d.name]));
    insert(
      "INSERT INTO patients VALUES (?, ?, ?, ?, ?, ?)",
      records.patients.map((p) => [p.patientId, p.nric, p.name, p.phone, p.dateOfBirth, p.address]),
    );
    insert(
      "INSERT INTO chas_cards (patient_id, tier, expiry_date) VALUES (?, ?, ?)",
      records.chasCards.map((c) => [c.patientId, c.tier, c.expiry]),
    );
    insert(
      `INSERT INTO insurance_policies (patient_id, insurer_code, member_no, plan_name, employer, annual_limit_cents, valid_from, valid_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      records.policies.map((x) => [x.patientId, x.payerId, x.memberId, x.plan, x.employer, x.limitCents, x.validFrom, x.validTo]),
    );
    insert(
      `INSERT INTO appointments (appt_no, patient_id, branch_code, doctor_code, appt_date, start_time, is_void, doctor_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      records.appointments.map((a) => [a.visitKey, a.patientId, a.branchId, a.dentistId, a.date, a.startTime, a.voided ? 1 : 0, a.dentistNote]),
    );
    insert(
      `INSERT INTO treatment_lines (appt_no, line_no, item_code, item_desc, fee_cents, gst_cents, tooth, qty, status, completed_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      records.appointments.flatMap((a) =>
        a.treatments.map((t, i) => [a.visitKey, i + 1, t.code, t.description, t.feeCents, t.gstCents, t.tooth, t.quantity, t.completion, t.completedOn]),
      ),
    );
    insert(
      "INSERT INTO medisave_details VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      records.appointments.flatMap((a) => {
        if (!a.medisave) return [];
        const { accountHolder: h, mcaf } = a.medisave;
        return [[a.visitKey, h.relationship, h.nric, h.age, mcaf.type, mcaf.validFrom, mcaf.validTo, mcaf.revokedOn]];
      }),
    );
    insert(
      "INSERT INTO preauthorisations (appt_no, insurer_code, benefit_code, preauth_ref, approved_on) VALUES (?, ?, ?, ?, ?)",
      records.preauthorisations.map((x) => [x.visitKey, x.payerId, x.benefitCode, x.reference, x.approvedOn]),
    );
    db.exec("COMMIT");
    return db.export();
  } finally {
    db.close();
  }
}

export async function readSqlite(bytes: Uint8Array): Promise<{ records: ClinicRecords; visits: SourceVisit[] }> {
  const db = new (await sqlite()).Database(bytes);
  try {
    const records = readRecords(db);
    return { records, visits: projectVisits(records) };
  } finally {
    db.close();
  }
}

type Row = Record<string, SqlValue>;

function rows(db: Database, sql: string): Row[] {
  const stmt = db.prepare(sql);
  try {
    const out: Row[] = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    return out;
  } finally {
    stmt.free();
  }
}

const text = (v: SqlValue): string => String(v);
const optText = (v: SqlValue): string | null => (v === null ? null : String(v));
const int = (v: SqlValue): number => Number(v);
const optInt = (v: SqlValue): number | null => (v === null ? null : Number(v));

function readRecords(db: Database): ClinicRecords {
  const lines = new Map<string, AppointmentRecord["treatments"]>();
  for (const r of rows(db, "SELECT * FROM treatment_lines ORDER BY appt_no, line_no")) {
    const list = lines.get(text(r.appt_no!)) ?? [];
    list.push({
      code: text(r.item_code!),
      description: text(r.item_desc!),
      feeCents: int(r.fee_cents!) as Cents,
      gstCents: optInt(r.gst_cents!) as Cents | null,
      tooth: optText(r.tooth!),
      quantity: int(r.qty!),
      completion: text(r.status!) as Completion,
      completedOn: optText(r.completed_on!) as IsoDate | null,
    });
    lines.set(text(r.appt_no!), list);
  }

  const medisave = new Map<string, NonNullable<SourceVisit["medisave"]>>();
  for (const r of rows(db, "SELECT * FROM medisave_details")) {
    medisave.set(text(r.appt_no!), {
      accountHolder: {
        relationship: text(r.holder_relationship!) as HolderRelationship,
        age: optInt(r.holder_age!),
        nric: optText(r.holder_nric!) as Nric | null,
      } as AccountHolder,
      mcaf: {
        type: text(r.mcaf_type!) as McafType,
        validFrom: text(r.mcaf_valid_from!) as IsoDate,
        validTo: optText(r.mcaf_valid_to!) as IsoDate | null,
        revokedOn: optText(r.mcaf_revoked_on!) as IsoDate | null,
      },
    });
  }

  return {
    patients: rows(db, "SELECT * FROM patients ORDER BY rowid").map((r) => ({
      patientId: text(r.patient_id!),
      nric: text(r.nric!) as Nric,
      name: text(r.full_name!),
      phone: text(r.mobile!),
      dateOfBirth: text(r.dob!) as IsoDate,
      address: optText(r.address!),
    })),
    chasCards: rows(db, "SELECT * FROM chas_cards ORDER BY card_id").map((r) => ({
      patientId: text(r.patient_id!),
      tier: text(r.tier!) as ChasTier,
      expiry: text(r.expiry_date!) as IsoDate,
    })),
    policies: rows(db, "SELECT * FROM insurance_policies ORDER BY policy_id").map((r) => ({
      patientId: text(r.patient_id!),
      payerId: text(r.insurer_code!),
      memberId: text(r.member_no!),
      plan: text(r.plan_name!),
      employer: optText(r.employer!),
      limitCents: optInt(r.annual_limit_cents!) as Cents | null,
      validFrom: text(r.valid_from!) as IsoDate,
      validTo: optText(r.valid_to!) as IsoDate | null,
    })),
    appointments: rows(db, "SELECT * FROM appointments ORDER BY appt_id").map((r) => ({
      visitKey: text(r.appt_no!),
      patientId: text(r.patient_id!),
      branchId: text(r.branch_code!),
      dentistId: text(r.doctor_code!),
      date: text(r.appt_date!) as IsoDate,
      startTime: optText(r.start_time!),
      voided: int(r.is_void!) !== 0,
      dentistNote: optText(r.doctor_note!),
      treatments: lines.get(text(r.appt_no!)) ?? [],
      medisave: medisave.get(text(r.appt_no!)) ?? null,
    })),
    preauthorisations: rows(db, "SELECT * FROM preauthorisations ORDER BY preauth_id").map((r) => ({
      visitKey: text(r.appt_no!),
      payerId: text(r.insurer_code!),
      benefitCode: text(r.benefit_code!),
      reference: text(r.preauth_ref!),
      approvedOn: text(r.approved_on!) as IsoDate,
    })),
  };
}
