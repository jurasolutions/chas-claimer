/**
 * The synthetic clinic as a SQLite file in the clinic's own schema: what the connector (ticket 05)
 * reads, and what the tester edits for the re-import steps (UAT 5.12, 5.14-5.16, 6.3).
 */
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { parseIsoDate, type IsoDate } from "../../src/domain/dates";
import { generateClinic } from "./generate";
import { readSqlite, writeSqlite } from "./write-sqlite";

const T = parseIsoDate("2026-11-13") as IsoDate;
const clinic = generateClinic({ seed: 7, asOf: T });

async function edit(bytes: Uint8Array, sql: string): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const db = new SQL.Database(bytes);
  try {
    db.exec(sql);
    return db.export();
  } finally {
    db.close();
  }
}

describe("writeSqlite / readSqlite", () => {
  it("reads back exactly the records and visits the generator returns", async () => {
    const back = await readSqlite(await writeSqlite(clinic));
    expect(back.records).toEqual(clinic.records);
    expect(back.visits).toEqual(clinic.visits);
  });

  it("writes byte-identical files for the same seed and as-of date (SC7.10)", async () => {
    const a = await writeSqlite(generateClinic({ seed: 7, asOf: T }));
    const b = await writeSqlite(generateClinic({ seed: 7, asOf: T }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const c = await writeSqlite(generateClinic({ seed: 8, asOf: T }));
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });

  it("holds the clinic's own tables, not the desk's", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database(await writeSqlite(clinic));
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")[0]!.values.flat();
    const counts = Object.fromEntries(
      ["patients", "appointments", "branches", "doctors"].map((t) => [t, db.exec(`SELECT count(*) FROM ${t}`)[0]!.values[0]![0]]),
    );
    db.close();
    expect(tables).toEqual([
      "appointments",
      "branches",
      "chas_cards",
      "doctors",
      "insurance_policies",
      "medisave_details",
      "patients",
      "preauthorisations",
      "treatment_lines",
    ]);
    expect(counts).toEqual({ patients: 60, appointments: 200, branches: 2, doctors: 3 });
  });

  it("lets the tester change a fee in the file and see it on re-read (UAT 5.12)", async () => {
    const d01 = "SC-D01";
    const edited = await edit(
      await writeSqlite(clinic),
      `UPDATE treatment_lines SET fee_cents = 5500, gst_cents = 495 WHERE appt_no = '${d01}' AND item_code = 'SCL'`,
    );
    const scaling = (await readSqlite(edited)).visits.find((v) => v.visitKey === d01)!.treatments.find((t) => t.code === "SCL")!;
    expect([scaling.feeCents, scaling.gstCents]).toEqual([5500, 495]);
  });

  it("lets the tester add a pre-authorisation and change a treatment code (UAT 5.16, 6.3)", async () => {
    const d16 = "SC-D16";
    const d27 = "SC-D27";
    const edited = await edit(
      await writeSqlite(clinic),
      `INSERT INTO preauthorisations (appt_no, insurer_code, benefit_code, preauth_ref, approved_on)
       VALUES ('${d16}', 'HARBOUR', 'H-CRN', 'PA-0016', (SELECT appt_date FROM appointments WHERE appt_no = 'SC-D16-PREP'));
       UPDATE treatment_lines SET item_code = 'RCT-P' WHERE appt_no = '${d27}' AND line_no = 1;`,
    );
    const back = await readSqlite(edited);
    const prepDate = back.visits.find((v) => v.visitKey === "SC-D16-PREP")!.date;
    expect(back.records.preauthorisations).toEqual([
      { visitKey: d16, payerId: "HARBOUR", benefitCode: "H-CRN", reference: "PA-0016", approvedOn: prepDate },
    ]);
    const fit = back.visits.find((v) => v.visitKey === d16)!;
    expect(fit.policies.map((p) => [p.payerId, p.preAuths])).toEqual([
      ["HARBOUR", [{ benefitCode: "H-CRN", reference: "PA-0016", approvedOn: prepDate }]],
    ]);
    expect(back.visits.find((v) => v.visitKey === "SC-D16-PREP")!.policies[0]!.preAuths).toEqual([]);
    expect(back.visits.find((v) => v.visitKey === d27)!.treatments[0]!.code).toBe("RCT-P");
  });

  it("refuses a pre-authorisation for an insurer the patient has no policy with", async () => {
    const edited = await edit(
      await writeSqlite(clinic),
      `INSERT INTO preauthorisations (appt_no, insurer_code, benefit_code, preauth_ref, approved_on)
       VALUES ('SC-D16', 'MERIDIAN', 'CR1', 'PA-0099', '2026-11-01');`,
    );
    await expect(readSqlite(edited)).rejects.toThrow(/SC-D16.*MERIDIAN/);
  });
});
