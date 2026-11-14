import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../../connector/cli";
import { openSqlite } from "../../../connector/sources/sqlite";
import { writeSqlite } from "../../../mock/synthetic-clinic/write-sqlite";
import { CLINIC } from "../../../tests/helpers/fixtures";
import { parseDescribe } from "./describe";

describe("parseDescribe: the connector's describe output, pasted back in", () => {
  it("reads back exactly what the connector describes for the synthetic clinic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "describe-"));
    try {
      const file = join(dir, "clinic.sqlite");
      writeFileSync(file, await writeSqlite(CLINIC));
      const lines: string[] = [];
      expect(await run(["describe", "--source", file], (line) => void lines.push(line), {})).toBe(0);
      const source = await openSqlite(await writeSqlite(CLINIC));
      const described = await source.describe();
      source.close();

      expect(parseDescribe(lines.join("\n"))).toEqual(described);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a SQLite description into table and column names", () => {
    const text = ["A sqlite source with 2 tables:", "  visits: visit_id, patient_id, visit_date", "  patients: patient_id, full_name"].join("\n");

    expect(parseDescribe(text)).toEqual({
      kind: "sqlite",
      tables: [
        { name: "visits", columns: ["visit_id", "patient_id", "visit_date"] },
        { name: "patients", columns: ["patient_id", "full_name"] },
      ],
    });
  });

  it("reads a one-table CSV description pasted with Windows line endings and blank lines around it", () => {
    const text = "\r\nA csv source with 1 table:\r\n  visits.csv: visit_id, amount\r\n\r\n";

    expect(parseDescribe(text)).toEqual({ kind: "csv", tables: [{ name: "visits.csv", columns: ["visit_id", "amount"] }] });
  });

  it("reads a table with no columns", () => {
    expect(parseDescribe("A sqlite source with 1 table:\n  empty: ")).toEqual({ kind: "sqlite", tables: [{ name: "empty", columns: [] }] });
  });

  it.each([
    ["empty text", ""],
    ["no heading", "  visits: visit_id"],
    ["a heading for another kind of source", "A postgres source with 1 table:\n  visits: visit_id"],
    ["fewer tables than the heading says", "A sqlite source with 2 tables:\n  visits: visit_id"],
    ["more tables than the heading says", "A sqlite source with 1 table:\n  visits: visit_id\n  patients: patient_id"],
    ["a table line with no colon", "A sqlite source with 1 table:\n  visits visit_id"],
    ["a column name longer than the desk takes", `A sqlite source with 1 table:\n  visits: ${"c".repeat(129)}`],
    ["rows pasted in place of a description", "visit_id,patient_id\nV1,P1"],
  ])("refuses %s", (_name, text) => {
    expect(parseDescribe(text)).toBeNull();
  });
});
