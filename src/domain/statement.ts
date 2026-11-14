/**
 * A payer's payment statement (remittance file), read through the columns the officer mapped for that
 * payer. Pure. A problem names a header or a line number, never a cell's value: the identifier
 * column holds NRICs.
 */
import { parseCsvRecords } from "./csv";
import { type IsoDate, parseIsoDate } from "./dates";
import { parseDollars } from "./money";
import { type Nric, parseNric } from "./nric";
import { err, ok, type Result } from "./result";
import type { RemittanceColumns } from "./settings";

/** One payment line. `lineNo` counts payment lines from 1, after the header and blank lines. */
export interface StatementLine {
  lineNo: number;
  portalReference: string | null;
  patientNric: Nric | null;
  visitDate: IsoDate | null;
  /** Signed: a negative line is a clawback or a recovery. */
  amountCents: number;
  paidOn: IsoDate | null;
}

export type StatementColumn = keyof RemittanceColumns;

export type StatementProblem =
  | { kind: "malformed" }
  | { kind: "too_many_lines"; maxLines: number }
  | { kind: "missing_columns"; headers: string[] }
  | { kind: "bad_lines"; lines: { lineNo: number; column: string }[] };

const ORDER: readonly StatementColumn[] = ["reference", "patientNric", "visitDate", "amount", "paidOn"];

const headerKey = (h: string) => h.trim().toLowerCase();

/** "-$1,288.00" -> -128800. A leading minus and a dollar sign are allowed; anything else is not an amount. */
function parseAmount(text: string): number | null {
  const m = /^(-)?\s*\$?\s*(.+)$/.exec(text);
  if (!m) return null;
  const abs = parseDollars(m[2]!);
  if (!abs.ok) return null;
  return m[1] && abs.value !== 0 ? -abs.value : abs.value;
}

export function parseStatement(csv: string, columns: RemittanceColumns, opts: { maxLines: number }): Result<StatementLine[], StatementProblem> {
  // One extra row for the header line.
  const records = parseCsvRecords(csv, { maxRows: opts.maxLines + 1 });
  if (!records.ok) {
    return err(records.error.kind === "too_many_rows" ? { kind: "too_many_lines", maxLines: opts.maxLines } : { kind: "malformed" });
  }
  const [header, ...rows] = records.value;
  const at = new Map((header?.fields ?? []).map((h, i) => [headerKey(h), i] as const));
  const index: Partial<Record<StatementColumn, number>> = {};
  const missing: string[] = [];
  for (const col of ORDER) {
    const name = columns[col];
    if (name === null) continue;
    const i = at.get(headerKey(name));
    if (i === undefined) missing.push(name);
    else index[col] = i;
  }
  if (missing.length > 0) return err({ kind: "missing_columns", headers: missing });

  const lines: StatementLine[] = [];
  const bad: { lineNo: number; column: string }[] = [];
  let lineNo = 0;
  for (const row of rows) {
    if (row.fields.every((f) => f.trim() === "")) continue;
    lineNo += 1;
    const cell = (col: StatementColumn): string => {
      const i = index[col];
      return i === undefined ? "" : (row.fields[i] ?? "").trim();
    };
    const fail = (col: StatementColumn) => bad.push({ lineNo, column: columns[col]! });
    const optional = <T,>(col: StatementColumn, parse: (s: string) => T | null): T | null => {
      const text = cell(col);
      if (text === "") return null;
      const value = parse(text);
      if (value === null) fail(col);
      return value;
    };

    const before = bad.length;
    const reference = cell("reference") || null;
    const patientNric = optional("patientNric", parseNric);
    const visitDate = optional("visitDate", parseIsoDate);
    const amountText = cell("amount");
    const amountCents = amountText === "" ? null : parseAmount(amountText);
    if (amountCents === null) fail("amount");
    const paidOn = optional("paidOn", parseIsoDate);
    if (bad.length === before && amountCents !== null) {
      lines.push({ lineNo, portalReference: reference, patientNric, visitDate, amountCents, paidOn });
    }
  }
  if (bad.length > 0) return err({ kind: "bad_lines", lines: bad });
  return ok(lines);
}
