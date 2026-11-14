import { describe, expect, it } from "vitest";
import { createD1 } from "../../tests/helpers/d1";
import { adoptStatements } from "./patients";

const visit = (db: D1Database, visitKey: string, patientHash: string) =>
  db
    .prepare("INSERT INTO visits (visit_key, current_revision, content_hash, branch_id, visit_date, patient_hash, patient_mask) VALUES (?, 1, ?, 'B1', '2026-11-01', ?, 'T****001A')")
    .bind(visitKey, `v1:content-${visitKey}`, patientHash);

async function hashes(db: D1Database, sql: string): Promise<Record<string, string>> {
  const { results } = await db.prepare(sql).all<{ k: string; h: string }>();
  return Object.fromEntries(results.map((r) => [r.k, r.h]));
}

describe("moving patients' rows to the current key's hash", () => {
  it("moves each patient's older rows to their own current hash and key version, one statement per table however many patients", async () => {
    const db = await createD1();
    await db.batch([
      visit(db, "V-1", "v1:aa"),
      visit(db, "V-2", "v1:bb"),
      visit(db, "V-3", "v1:cc"),
      db.prepare("INSERT INTO remittances (id, payer_id, file_name, file_hash, imported_at, actor, lines) VALUES ('R-1', 'CHAS', 'r.csv', 'v1:file', '2026-11-01T00:00:00Z', 'a', 2)"),
      db.prepare("INSERT INTO remittance_lines (remittance_id, line_no, patient_hash, key_version, amount_cents) VALUES ('R-1', 1, 'v1:aa', 1, 100), ('R-1', 2, 'v1:cc', 1, 100)"),
    ]);

    // The same patient twice, as a file with two lines for them gives it.
    const statements = adoptStatements(db, 2, [
      ["v2:aa", "v1:aa"],
      ["v2:bb", "v1:bb"],
      ["v2:aa", "v1:aa"],
    ]);
    expect(statements).toHaveLength(3);
    await db.batch(statements);

    expect(await hashes(db, "SELECT visit_key AS k, patient_hash AS h FROM visits")).toEqual({ "V-1": "v2:aa", "V-2": "v2:bb", "V-3": "v1:cc" });
    expect(await hashes(db, "SELECT line_no AS k, patient_hash AS h FROM remittance_lines")).toEqual({ 1: "v2:aa", 2: "v1:cc" });
    expect(await hashes(db, "SELECT line_no AS k, key_version AS h FROM remittance_lines")).toEqual({ 1: 2, 2: 1 });
  });

  it("has nothing to do when no patient has an older hash", () => {
    const db = {} as D1Database;
    expect(adoptStatements(db, 2, [["v2:aa"], ["v2:bb", "v2:bb"], []])).toEqual([]);
  });
});
