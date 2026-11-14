/**
 * Reads a clinic's CSV export: a folder holding one `<table>.csv` per table, its first record the
 * column names. Read-only. Rows point at their file and line ("appointments.csv line 4"), so a
 * person can open the file and find the row. Every cell arrives as text; the mapper coerces it.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsvRecords, type CsvRecord } from "../../src/domain/csv";
import type { SourceSchema } from "../../src/domain/source-mapping";
import { checkColumns, noTable, SourceShapeError, type SourceRow, type TableSource } from "./source";

/** Far more rows than a clinic's table holds; a file past it is refused rather than read in part. */
const MAX_ROWS = 1_000_000;

/**
 * Cells no column name takes but a row often holds: an NRIC/FIN, an email address, or anything that
 * starts like a number, date, phone number or amount. Column names start with a letter.
 */
const VALUE_SHAPED = [/^[STFGM]\d{7}[A-Z]$/i, /@/, /^[-+$\d]/];

/**
 * An export saved without its header row would otherwise hand a patient's row to `describe` as
 * column names. Refuses it by column position, never echoing the cell.
 */
function refuseValueShapedHeader(file: string, header: readonly string[]): void {
  const positions = header.flatMap((cell, i) => (VALUE_SHAPED.some((re) => re.test(cell)) ? [i + 1] : []));
  if (positions.length === 0) return;
  throw new SourceShapeError(
    `the first line of ${file} does not look like column names (${positions.length === 1 ? "column" : "columns"} ${positions.join(", ")} ${positions.length === 1 ? "looks" : "look"} like values), so the file seems to have no header row. Add a header row naming each column`,
  );
}

export async function openCsv(dir: string): Promise<TableSource> {
  const files = (await readdir(dir, { withFileTypes: true }))
    .filter((f) => f.isFile() && f.name.toLowerCase().endsWith(".csv"))
    .map((f) => f.name)
    .sort();
  const fileOf = new Map(files.map((name) => [name.slice(0, -".csv".length), name]));
  const parsed = new Map<string, { header: string[]; records: CsvRecord[] }>();

  async function load(table: string) {
    const cached = parsed.get(table);
    if (cached) return cached;
    const file = fileOf.get(table);
    if (file === undefined) throw noTable(table);
    const result = parseCsvRecords(await readFile(join(dir, file), "utf8"), { maxRows: MAX_ROWS });
    if (!result.ok) {
      throw new SourceShapeError(
        result.error.kind === "too_many_rows"
          ? `${file} has more than ${MAX_ROWS} rows`
          : `${file} could not be read as CSV at record ${result.error.row}`,
      );
    }
    const [head, ...records] = result.value;
    const header = (head?.fields ?? []).map((h) => h.trim());
    refuseValueShapedHeader(file, header);
    const loaded = { header, records };
    parsed.set(table, loaded);
    return loaded;
  }

  return {
    async describe(): Promise<SourceSchema> {
      const tables = [];
      for (const name of fileOf.keys()) tables.push({ name, columns: (await load(name)).header });
      return { kind: "csv", tables };
    },

    async rows(table, columns): Promise<SourceRow[]> {
      const { header, records } = await load(table);
      checkColumns(table, header, columns);
      const index = columns.map((c) => header.indexOf(c));
      return records.map((r) => ({
        where: `${fileOf.get(table)} line ${r.line}`,
        values: Object.fromEntries(columns.map((c, j) => [c, r.fields[index[j]!]])),
      }));
    },

    close: () => parsed.clear(),
  };
}
