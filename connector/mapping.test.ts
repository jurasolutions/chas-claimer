/**
 * The connector reads the clinic's own tables through a source mapping. Against the synthetic
 * clinic's SQLite file and the shipped mapping it must give exactly the visits the generator
 * projects from the same records. Every record here is synthetic.
 */
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { projectVisits } from "../mock/synthetic-clinic/records";
import { writeSqlite } from "../mock/synthetic-clinic/write-sqlite";
import type { IsoDate } from "../src/domain/dates";
import { parseSourceVisit, type SourceVisit } from "../src/domain/source-visit";
import { CLINIC } from "../tests/helpers/fixtures";
import { readVisits, type VisitRead } from "./mapping";
import { openSqlite } from "./sources/sqlite";
import { recordsWithPreAuth, shippedMapping } from "./test-support";

async function collect(reads: AsyncIterable<VisitRead>): Promise<VisitRead[]> {
  const out: VisitRead[] = [];
  for await (const r of reads) out.push(r);
  return out;
}

const byKey = (visits: SourceVisit[]) => new Map(visits.map((v) => [v.visitKey, v]));

describe("reading the synthetic clinic through the shipped mapping", () => {
  it("gives the generator's visits, with every CHAS card, policy validity, note and pre-authorisation", async () => {
    const records = recordsWithPreAuth();
    const source = await openSqlite(await writeSqlite({ ...CLINIC, records }));
    try {
      const reads = await collect(readVisits(source, shippedMapping()));
      const problems = reads.filter((r) => !r.ok);
      expect(problems).toEqual([]);

      const read = reads.flatMap((r) => (r.ok ? [r.visit] : []));
      const expected = projectVisits(records).map((v) => {
        const p = parseSourceVisit(v);
        if (!p.ok) throw new Error("projected visit did not parse");
        return p.value;
      });
      expect(read).toHaveLength(expected.length);
      expect(byKey(read)).toEqual(byKey(expected));

      const withPreAuth = read.find((v) => v.policies.some((p) => p.preAuths.length > 0));
      expect(withPreAuth?.policies.flatMap((p) => p.preAuths)).toEqual([
        { benefitCode: "PA-TEST-1", reference: "PAREF-TEST-0001", approvedOn: expect.any(String) },
      ]);
      expect(read.some((v) => v.chasCards.length > 1)).toBe(true);
      expect(read.some((v) => v.notes !== null)).toBe(true);
    } finally {
      source.close();
    }
  });

  it("points at each visit by its row in the visits table", async () => {
    const source = await openSqlite(await writeSqlite(CLINIC));
    try {
      const reads = await collect(readVisits(source, shippedMapping()));
      expect(reads[0]!.where).toBe("appointments row 1");
      expect(reads[1]!.where).toBe("appointments row 2");
    } finally {
      source.close();
    }
  });

  it("reads only visits on or after --since", async () => {
    const source = await openSqlite(await writeSqlite(CLINIC));
    try {
      const since = "2026-11-01" as IsoDate;
      const reads = await collect(readVisits(source, shippedMapping(), { since }));
      const expected = CLINIC.visits.filter((v) => v.date >= since).map((v) => v.visitKey).sort();
      expect(reads.flatMap((r) => (r.ok ? [r.visit.visitKey] : [])).sort()).toEqual(expected);
      expect(expected.length).toBeGreaterThan(0);
      expect(expected.length).toBeLessThan(CLINIC.visits.length);
    } finally {
      source.close();
    }
  });

  it("describes the source by table and column names only", async () => {
    const source = await openSqlite(await writeSqlite(CLINIC));
    try {
      const schema = await source.describe();
      expect(schema.kind).toBe("sqlite");
      const appointments = schema.tables.find((t) => t.name === "appointments");
      expect(appointments?.columns).toEqual(expect.arrayContaining(["appt_no", "patient_id", "appt_date", "doctor_note"]));
      const text = JSON.stringify(schema);
      for (const p of CLINIC.records.patients) {
        expect(text).not.toContain(p.nric);
        expect(text).not.toContain(p.name);
      }
    } finally {
      source.close();
    }
  });

  it("names a mapped table or column the source lacks, and nothing else", async () => {
    const source = await openSqlite(await writeSqlite(CLINIC));
    try {
      const mapping = shippedMapping();
      const missingColumn = { ...mapping, visits: { ...mapping.visits, fields: { ...mapping.visits.fields, notes: "dentist_remarks" } } };
      await expect(collect(readVisits(source, missingColumn))).rejects.toThrow(/appointments has no column "dentist_remarks"/);
      const missingTable = { ...mapping, chasCards: { ...mapping.chasCards!, table: "chas" } };
      await expect(collect(readVisits(source, missingTable))).rejects.toThrow(/no table "chas"/);
    } finally {
      source.close();
    }
  });
});

describe("amounts in dollars", () => {
  it("reads dollars as the desk does, thousands separators included, and lets the schema refuse a sign", async () => {
    const [first, second] = CLINIC.records.appointments;
    const db = new (await initSqlJs()).Database(await writeSqlite(CLINIC));
    db.run("UPDATE treatment_lines SET fee_cents = '1,234.50', gst_cents = '0.5' WHERE appt_no = ?", [first!.visitKey]);
    db.run("UPDATE treatment_lines SET fee_cents = '-12.00' WHERE appt_no = ?", [second!.visitKey]);
    const source = await openSqlite(db.export());
    db.close();
    try {
      const reads = await collect(readVisits(source, { ...shippedMapping(), amountUnit: "dollars" }));
      const read = reads.find((r) => r.ok && r.visit.visitKey === first!.visitKey);
      expect(read?.ok && read.visit.treatments.map((t) => [t.feeCents, t.gstCents])).toEqual(
        expect.arrayContaining([[123450, 50]]),
      );
      const refused = reads.find((r) => !r.ok && r.where === "appointments row 2");
      expect(refused).toMatchObject({ problems: [expect.objectContaining({ path: expect.stringMatching(/^treatments\.\d+\.feeCents$/) })] });
    } finally {
      source.close();
    }
  });
});

describe("assembling a visit", () => {
  it("reports a visit whose patient has no record, by its row, and reads the rest", async () => {
    const records = structuredClone(CLINIC.records);
    records.appointments[2]!.patientId = "P-MISSING";
    const source = await openSqlite(await writeSqlite({ ...CLINIC, records }));
    try {
      const reads = await collect(readVisits(source, shippedMapping()));
      const bad = reads.filter((r) => !r.ok);
      expect(bad).toEqual([{ ok: false, where: "appointments row 3", problems: [{ path: "patient", message: "no patient row has this visit's patient key" }] }]);
      expect(reads.filter((r) => r.ok)).toHaveLength(records.appointments.length - 1);
    } finally {
      source.close();
    }
  });

  it("reports a pre-authorisation with no policy for its payer without echoing a value", async () => {
    const records = structuredClone(CLINIC.records);
    const appt = records.appointments.find((a) => !records.policies.some((p) => p.patientId === a.patientId))!;
    records.preauthorisations.push({ visitKey: appt.visitKey, payerId: "NOPAYER", benefitCode: "B1", reference: "PAREF-TEST-0002", approvedOn: appt.date });
    // projectVisits refuses this record set, so write the rows directly.
    const db = new (await initSqlJs()).Database(await writeSqlite({ ...CLINIC, records: { ...records, preauthorisations: [] } }));
    db.run("INSERT INTO preauthorisations (appt_no, insurer_code, benefit_code, preauth_ref, approved_on) VALUES (?, ?, ?, ?, ?)", [
      appt.visitKey,
      "NOPAYER",
      "B1",
      "PAREF-TEST-0002",
      appt.date,
    ]);
    const source = await openSqlite(db.export());
    db.close();
    try {
      const reads = await collect(readVisits(source, shippedMapping()));
      const bad = reads.filter((r) => !r.ok);
      expect(bad).toHaveLength(1);
      expect(JSON.stringify(bad)).not.toMatch(/NOPAYER|PAREF-TEST-0002/);
      expect(bad[0]).toMatchObject({ problems: [{ path: "policies", message: "a pre-authorisation names a payer the patient has no policy with" }] });
    } finally {
      source.close();
    }
  });
});

describe("problems in plain words (QA D19)", () => {
  const ZOD_TEXT = /Invalid|expected|received|Too (big|small)/;

  async function readWith(sql: string, params: (string | number)[]): Promise<VisitRead[]> {
    const db = new (await initSqlJs()).Database(await writeSqlite(CLINIC));
    db.run(sql, params);
    const source = await openSqlite(db.export());
    db.close();
    try {
      return (await collect(readVisits(source, shippedMapping()))).filter((r) => !r.ok);
    } finally {
      source.close();
    }
  }

  it("says a blank visit date is missing", async () => {
    const appt = CLINIC.records.appointments[0]!;
    const bad = await readWith("UPDATE appointments SET appt_date = '' WHERE appt_no = ?", [appt.visitKey]);
    expect(bad).toEqual([{ ok: false, where: "appointments row 1", problems: [{ path: "date", message: "the visit date is missing" }] }]);
  });

  it("says a malformed date isn't a date and never echoes it", async () => {
    const appt = CLINIC.records.appointments[0]!;
    const bad = await readWith("UPDATE appointments SET appt_date = '13/11/2026' WHERE appt_no = ?", [appt.visitKey]);
    expect(bad).toMatchObject([{ problems: [{ path: "date", message: "the visit date isn't a date; use YYYY-MM-DD" }] }]);
    expect(JSON.stringify(bad)).not.toContain("13/11/2026");
  });

  it("names a treatment line's field by its line and a bad NRIC without the value", async () => {
    const appt = CLINIC.records.appointments[0]!;
    const fee = await readWith("UPDATE treatment_lines SET fee_cents = 'abc' WHERE appt_no = ?", [appt.visitKey]);
    expect(fee[0]).toMatchObject({ problems: expect.arrayContaining([{ path: "treatments.0.feeCents", message: "the fee on treatment line 1 isn't an amount of zero or more" }]) });
    expect(JSON.stringify(fee)).not.toContain("abc");

    const nric = await readWith("UPDATE patients SET nric = 'T9XXXXXXX' WHERE patient_id = ?", [appt.patientId]);
    expect(nric.length).toBeGreaterThan(0);
    for (const r of nric) expect(r).toMatchObject({ problems: [{ path: "patient.nric", message: "the patient's NRIC or FIN isn't valid" }] });
    expect(JSON.stringify(nric)).not.toContain("T9XXXXXXX");

    for (const r of [...fee, ...nric]) for (const p of r.ok ? [] : r.problems) expect(p.message).not.toMatch(ZOD_TEXT);
  });
});
