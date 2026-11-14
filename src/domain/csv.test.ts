import fc from "fast-check";
import { parseCsv, parseCsvRecords, toCsv, type CsvColumn } from "./csv";

const FORMULA_LEADS = ["=", "+", "-", "@", "\t", "\r"];

/** Text biased towards the characters CSV has to handle: separators, quotes, line breaks and formula leads. */
const arbCellText = fc.oneof(
  fc.string({ unit: "binary", maxLength: 12 }),
  fc.string({ unit: fc.constantFrom(",", '"', "\n", "\r", "=", "+", "-", "@", "\t", "a", " ", "é", "1"), maxLength: 8 }),
);

const columns = (n: number): CsvColumn[] => Array.from({ length: n }, (_, i) => ({ key: `c${i}`, header: `Column ${i}` }));

describe("CSV", () => {
  it("writes RFC 4180 records with CRLF and quotes only where needed", () => {
    const text = toCsv(
      [
        { key: "name", header: "Name" },
        { key: "note", header: "Note" },
        { key: "amount", header: "Amount" },
      ],
      [
        { name: "Tan, A", note: 'said "hi"', amount: { cents: 46250 } },
        { name: "plain", note: "two\nlines", amount: { cents: -1250 } },
        { name: null, note: "", amount: { cents: 5 } },
      ],
    );
    expect(text).toBe(
      'Name,Note,Amount\r\n"Tan, A","said ""hi""",462.50\r\nplain,"two\nlines",-12.50\r\n,,0.05\r\n',
    );
  });

  it("neutralises a text cell that starts like a formula", () => {
    const text = toCsv([{ key: "a", header: "A" }], [{ a: "=SUM(A1:A9)" }, { a: "@cmd" }, { a: "-1+1" }, { a: "\tx" }]);
    expect(text).toBe(`A\r\n"'=SUM(A1:A9)"\r\n"'@cmd"\r\n"'-1+1"\r\n"'\tx"\r\n`);
  });

  it("writes amounts from integer cents, never through the text path", () => {
    expect(toCsv([{ key: "a", header: "A" }], [{ a: { cents: -140000 } }])).toBe("A\r\n-1400.00\r\n");
    expect(() => toCsv([{ key: "a", header: "A" }], [{ a: { cents: 1.5 } }])).toThrow();
  });

  it("parses a remittance file with a BOM, CRLF and quoted newlines", () => {
    const result = parseCsv('﻿Ref,Amount\r\n"CL-1\nnote",12.50\r\nCL-2,"1,400.00"\r\n', { maxRows: 10 });
    expect(result).toEqual({
      ok: true,
      value: [
        ["Ref", "Amount"],
        ["CL-1\nnote", "12.50"],
        ["CL-2", "1,400.00"],
      ],
    });
  });

  it("accepts LF-only files and a missing final newline, and skips blank lines", () => {
    expect(parseCsv("a,b\n1,2\n\n3,4", { maxRows: 10 })).toEqual({
      ok: true,
      value: [
        ["a", "b"],
        ["1", "2"],
        ["3", "4"],
      ],
    });
  });

  it("gives each record the line it starts on, counting blank lines and quoted newlines", () => {
    const result = parseCsvRecords('a,b\r\n1,"x\r\ny"\r\n\r\n2,z\n3,w', { maxRows: 10 });
    expect(result).toEqual({
      ok: true,
      value: [
        { line: 1, fields: ["a", "b"] },
        { line: 2, fields: ["1", "x\r\ny"] },
        { line: 5, fields: ["2", "z"] },
        { line: 6, fields: ["3", "w"] },
      ],
    });
  });

  it("refuses a file over the row cap", () => {
    expect(parseCsv("a\r\n1\r\n2\r\n", { maxRows: 2 })).toEqual({ ok: false, error: { kind: "too_many_rows", maxRows: 2 } });
    expect(parseCsv("a\r\n1\r\n", { maxRows: 2 }).ok).toBe(true);
  });

  it("refuses an unterminated quote and text after a closing quote", () => {
    expect(parseCsv('a\r\n"open', { maxRows: 10 })).toEqual({ ok: false, error: { kind: "malformed", row: 2 } });
    expect(parseCsv('"a"b\r\n', { maxRows: 10 })).toEqual({ ok: false, error: { kind: "malformed", row: 1 } });
  });

  it("round-trips arbitrary text, with formula-leading cells read back behind a quote mark", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }).chain((n) => fc.tuple(fc.constant(n), fc.array(fc.array(arbCellText, { minLength: n, maxLength: n }), { maxLength: 5 }))),
        ([n, cells]) => {
          const cols = columns(n);
          const rows = cells.map((r) => Object.fromEntries(r.map((v, i) => [`c${i}`, v])));
          const parsed = parseCsv(toCsv(cols, rows), { maxRows: 100 });
          if (!parsed.ok) return false;
          const expected = [cols.map((c) => c.header), ...cells.map((r) => r.map((v) => (FORMULA_LEADS.some((l) => v.startsWith(l)) ? `'${v}` : v)))];
          expect(parsed.value).toEqual(expected);
          return true;
        },
      ),
    );
  });

  it("leaves no text cell starting with a formula character", () => {
    fc.assert(
      fc.property(fc.array(arbCellText, { minLength: 1, maxLength: 6 }), (texts) => {
        const parsed = parseCsv(toCsv(columns(1), texts.map((t) => ({ c0: t }))), { maxRows: 100 });
        return parsed.ok && parsed.value.every((row) => row.every((cell) => !FORMULA_LEADS.some((l) => cell.startsWith(l))));
      }),
    );
  });
});
