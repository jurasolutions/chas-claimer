/**
 * A CSV export is a folder of `<table>.csv` files, one per table, header on the first line. Every
 * record here is synthetic.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { afterEach, describe, expect, it } from "vitest";
import { writeSqlite } from "../../mock/synthetic-clinic/write-sqlite";
import { CLINIC } from "../../tests/helpers/fixtures";
import { readVisits, type VisitRead } from "../mapping";
import { exportCsv, recordsWithPreAuth, shippedMapping } from "../test-support";
import { openCsv } from "./csv";
import { openSqlite } from "./sqlite";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "connector-csv-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function collect(reads: AsyncIterable<VisitRead>): Promise<VisitRead[]> {
  const out: VisitRead[] = [];
  for await (const r of reads) out.push(r);
  return out;
}

describe("a CSV export", () => {
  it("reads the same visits as the SQLite file it was exported from", async () => {
    const bytes = await writeSqlite({ ...CLINIC, records: recordsWithPreAuth() });
    const dir = tempDir();
    await exportCsv(bytes, dir);

    const sqlite = await openSqlite(bytes);
    const fromSqlite = await collect(readVisits(sqlite, shippedMapping()));
    sqlite.close();
    const fromCsv = await collect(readVisits(await openCsv(dir), shippedMapping()));

    expect(fromCsv.filter((r) => !r.ok)).toEqual([]);
    expect(fromCsv.map((r) => (r.ok ? r.visit : null))).toEqual(fromSqlite.map((r) => (r.ok ? r.visit : null)));
    expect(fromCsv[0]!.where).toBe("appointments.csv line 2");
  });

  it("reports a row missing its visit date by its line and reads the others (AC-7.4)", async () => {
    const dir = tempDir();
    await exportCsv(await withBlankDate(await writeSqlite(CLINIC), CLINIC.records.appointments[3]!.visitKey), dir);

    const reads = await collect(readVisits(await openCsv(dir), shippedMapping()));
    const bad = reads.filter((r) => !r.ok);
    expect(bad).toEqual([{ ok: false, where: "appointments.csv line 5", problems: [expect.objectContaining({ path: "date" })] }]);
    expect(reads.filter((r) => r.ok)).toHaveLength(CLINIC.records.appointments.length - 1);
  });

  it("describes its tables by file name and header only", async () => {
    const dir = tempDir();
    await exportCsv(await writeSqlite(CLINIC), dir);
    const schema = await (await openCsv(dir)).describe();
    expect(schema.kind).toBe("csv");
    expect(schema.tables.find((t) => t.name === "appointments")?.columns).toEqual(
      expect.arrayContaining(["appt_no", "patient_id", "appt_date", "doctor_note"]),
    );
    const text = JSON.stringify(schema);
    for (const p of CLINIC.records.patients) expect(text).not.toContain(p.nric);
  });

  it("names a missing file or column, and a file it cannot read, without a value", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "appointments.csv"), "appt_no,appt_date\r\nV-1,2026-11-01\r\n");
    writeFileSync(join(dir, "broken.csv"), 'a,b\r\n"SECRET-CELL,unterminated\r\n');
    const source = await openCsv(dir);
    await expect(source.rows("patients", ["patient_id"])).rejects.toThrow(/no table "patients"/);
    await expect(source.rows("appointments", ["doctor_note"])).rejects.toThrow(/appointments has no column "doctor_note"/);
    const broken = source.rows("broken", ["a"]);
    await expect(broken).rejects.toThrow(/broken\.csv/);
    await expect(broken).rejects.not.toThrow(/SECRET-CELL/);
  });

  it("refuses a file with no header row by column position, never echoing its first line", async () => {
    const dir = tempDir();
    const p = CLINIC.records.patients[0]!;
    const row = ["V-1", p.nric, "Test Patient Sentinel", "2026-11-01", p.phone, "123.50", "sentinel@example.test"];
    writeFileSync(join(dir, "patients.csv"), `${row.join(",")}\r\nV-2,${p.nric},Other,2026-11-02,,1,x@example.test\r\n`);
    for (const attempt of [() => openCsv(dir).then((s) => s.describe()), () => openCsv(dir).then((s) => s.rows("patients", ["name"]))]) {
      const error = await attempt().then(
        () => null,
        (e: Error) => e,
      );
      expect(error?.message).toMatch(/patients\.csv.*no header row/);
      expect(error?.message).toContain("columns 2, 4, 5, 6, 7");
      for (const value of row) expect(error?.message).not.toContain(value);
    }
  });

  it("takes ordinary column names, spaces and all, as a header", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "patients.csv"), "Patient ID,NRIC,Full name,Date of birth,phone_2,Amount ($)\r\nP-1,,,,,\r\n");
    const schema = await (await openCsv(dir)).describe();
    expect(schema.tables[0]?.columns).toEqual(["Patient ID", "NRIC", "Full name", "Date of birth", "phone_2", "Amount ($)"]);
  });
});

/** The clinic file with one appointment's date left blank, as a hand-kept export may have it. */
async function withBlankDate(bytes: Uint8Array, visitKey: string): Promise<Uint8Array> {
  const db = new (await initSqlJs()).Database(bytes);
  try {
    db.run("UPDATE appointments SET appt_date = '' WHERE appt_no = ?", [visitKey]);
    return db.export();
  } finally {
    db.close();
  }
}
