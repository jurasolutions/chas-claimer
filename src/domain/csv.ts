/**
 * RFC 4180 CSV: writing payer files with formula escaping, and reading remittance files.
 * Text cells that start like a spreadsheet formula are prefixed with ' (CSV injection, F9).
 * Amounts come from integer cents and never pass through the text path, so -12.50 stays numeric.
 */
import { formatDecimal } from "./money";
import { err, ok, type Result } from "./result";

export interface CsvColumn {
  key: string;
  header: string;
}

/** A text cell, an amount in integer cents (may be negative), or empty. */
export type CsvCell = string | { cents: number } | null;

export type CsvProblem = { kind: "too_many_rows"; maxRows: number } | { kind: "malformed"; row: number };

const FORMULA_LEAD = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function toCsv(columns: CsvColumn[], rows: Record<string, CsvCell>[]): string {
  const lines = [columns.map((c) => textCell(c.header)), ...rows.map((row) => columns.map((c) => cell(row[c.key] ?? null)))];
  return lines.map((fields) => (fields.length === 1 && fields[0] === "" ? '""' : fields.join(","))).join("\r\n") + "\r\n";
}

function cell(value: CsvCell): string {
  if (value === null) return "";
  if (typeof value === "string") return textCell(value);
  return formatDecimal(value.cents);
}

function textCell(text: string): string {
  const safe = FORMULA_LEAD.test(text) ? `'${text}` : text;
  return safe !== text || NEEDS_QUOTES.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Parses CSV text into rows of fields. Handles a BOM, CRLF or LF, quoted newlines; skips blank lines. */
export function parseCsv(text: string, opts: { maxRows: number }): Result<string[][], CsvProblem> {
  const records = parseCsvRecords(text, opts);
  return records.ok ? ok(records.value.map((r) => r.fields)) : records;
}

/** One CSV record and the 1-based line of the file it starts on, so a reader can point at it. */
export interface CsvRecord {
  line: number;
  fields: string[];
}

/** As `parseCsv`, with each record's starting line. Blank lines and newlines inside quotes count as lines. */
export function parseCsvRecords(text: string, opts: { maxRows: number }): Result<CsvRecord[], CsvProblem> {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let touched = false; // the current record has content (a character, a comma or a quoted field)
  let line = 1;
  let startLine = 1;
  let i = 0;

  const touch = () => {
    if (!touched) startLine = line;
    touched = true;
  };

  const endRecord = (): boolean => {
    if (touched) {
      fields.push(field);
      rows.push({ line: startLine, fields });
    }
    fields = [];
    field = "";
    touched = false;
    return rows.length <= opts.maxRows;
  };

  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"' && field === "") {
      touch();
      i += 1;
      for (;;) {
        if (i >= src.length) return err({ kind: "malformed", row: rows.length + 1 });
        const q = src[i]!;
        if (q === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        if (q === "\n" || (q === "\r" && src[i + 1] !== "\n")) line += 1;
        field += q;
        i += 1;
      }
      const next = src[i];
      if (next !== undefined && next !== "," && next !== "\r" && next !== "\n") {
        return err({ kind: "malformed", row: rows.length + 1 });
      }
      continue;
    }
    if (ch === ",") {
      touch();
      fields.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
      if (!endRecord()) return err({ kind: "too_many_rows", maxRows: opts.maxRows });
      line += 1;
      continue;
    }
    touch();
    field += ch;
    i += 1;
  }
  if (!endRecord()) return err({ kind: "too_many_rows", maxRows: opts.maxRows });
  return ok(rows);
}
