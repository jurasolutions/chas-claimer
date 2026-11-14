/** Shared by the connector's tests. Every record is synthetic. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import initSqlJs from "sql.js";
import type { ClinicRecords } from "../mock/synthetic-clinic/records";
import { parseSourceMapping, type SourceMapping } from "../src/domain/source-mapping";
import { CLINIC } from "../tests/helpers/fixtures";

export const SHIPPED_MAPPING_PATH = new URL("./mappings/synthetic-clinic.json", import.meta.url);

export function shippedMapping(): SourceMapping {
  const parsed = parseSourceMapping(JSON.parse(readFileSync(SHIPPED_MAPPING_PATH, "utf8")));
  if (!parsed.ok) throw new Error(`shipped mapping is invalid: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

/** Writes every table of a SQLite file as `<table>.csv` in `dir`, as a clinic's CSV export would: header first, blanks for nulls. */
export async function exportCsv(bytes: Uint8Array, dir: string): Promise<void> {
  const db = new (await initSqlJs()).Database(bytes);
  try {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")[0]?.values ?? [];
    for (const [name] of tables) {
      const table = String(name);
      const result = db.exec(`SELECT * FROM "${table}" ORDER BY rowid`)[0];
      const columns = result?.columns ?? db.exec(`PRAGMA table_info("${table}")`)[0]!.values.map((r) => String(r[1]));
      const cell = (v: unknown) => (v === null || v === undefined ? "" : `"${String(v).replace(/"/g, '""')}"`);
      const lines = [columns.join(","), ...(result?.values ?? []).map((r) => r.map(cell).join(","))];
      writeFileSync(join(dir, `${table}.csv`), lines.join("\r\n") + "\r\n");
    }
  } finally {
    db.close();
  }
}

/** The clinic's records with one pre-authorisation filed against a visit whose patient holds a policy. */
export function recordsWithPreAuth(): ClinicRecords {
  const records = structuredClone(CLINIC.records);
  const policy = records.policies[0]!;
  const appt = records.appointments.find((a) => a.patientId === policy.patientId)!;
  records.preauthorisations.push({
    visitKey: appt.visitKey,
    payerId: policy.payerId,
    benefitCode: "PA-TEST-1",
    reference: "PAREF-TEST-0001",
    approvedOn: appt.date,
  });
  return records;
}
