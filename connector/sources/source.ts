/**
 * A clinic source the connector can read: tables of rows, nothing more. The SQLite and CSV readers
 * implement it; the mapper (`../mapping.ts`) turns its rows into source visits.
 *
 * `describe` returns table and column names only, never a row value, so it can be shown, logged or
 * handed to the mapping assistant. Errors name a table or column, never a value.
 */
import type { SourceSchema } from "../../src/domain/source-mapping";

export interface SourceRow {
  /** Where the row sits in the source, for a person to find it: "appointments row 3", "appointments.csv line 4". */
  where: string;
  /** The requested columns' raw values, keyed by column name. */
  values: Record<string, unknown>;
}

export interface TableSource {
  describe(): Promise<SourceSchema>;
  /** Every row of `table`, in the source's own order, with the given columns. Throws `SourceShapeError` when one is missing. */
  rows(table: string, columns: readonly string[]): Promise<SourceRow[]>;
  close(): void;
}

/** The source lacks a table or column the mapping names. The message carries names only. */
export class SourceShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceShapeError";
  }
}

export function checkColumns(table: string, have: readonly string[], want: readonly string[]): void {
  const missing = want.filter((c) => !have.includes(c));
  if (missing.length > 0) {
    throw new SourceShapeError(`${table} has no column ${missing.map((c) => JSON.stringify(c)).join(", ")}`);
  }
}

export const noTable = (table: string) => new SourceShapeError(`the source has no table ${JSON.stringify(table)}`);
