import { describe, expect, it } from "vitest";
import { MAX_REMITTANCE_LINES } from "../../src/api/remittances";
import { OFFICER_ACTOR } from "../../tests/helpers/fixtures";
import { awaitingPayment, R1, R2 } from "../../tests/helpers/payments";
import { importRemittance } from "./remittances";

/**
 * One statement import is one invocation, and D1 allows 1,000 queries in one (technical F7, §9). An
 * import costs a few statements for the file, one per line, and a hold and a payment through the
 * lifecycle per paid line. These counts are ceilings: a change that makes a paid line dearer fails here,
 * and the line cap has to come down with it.
 */
const FIXED = 7; // settings, the file-hash lookup, the retired-key lookalike lookup, the file row, its audit, the candidate claims, the recount
const PER_LINE = 1; // the line's insert
const PER_PAID_LINE = 12; // the hold, then `act`: the claim read, its context, the write and audits, the claim read back
/** What the import may spend, leaving room under 1,000 for the request around it and a column mapping save. */
const BUDGET = 700;

async function counted(file: typeof R1) {
  const { db, deps } = await awaitingPayment();
  let statements = 0;
  const counting = new Proxy(db, {
    get: (target, key) =>
      key === "prepare"
        ? (sql: string) => {
            statements += 1;
            return target.prepare(sql);
          }
        : Reflect.get(target, key, target),
  });
  const result = await importRemittance({ ...deps, db: counting }, file, OFFICER_ACTOR);
  if (!result.ok || result.value.outcome !== "imported") throw new Error(`the ${file.fileName} import did not import`);
  return { statements, lines: result.value.lines, paid: result.value.matched };
}

const ceiling = (lines: number, paid: number) => FIXED + PER_LINE * lines + PER_PAID_LINE * paid;

describe("a statement import's D1 statement count", () => {
  it.each([R1, R2])("$fileName stays within the per-line costs", async (file) => {
    const { statements, lines, paid } = await counted(file);

    expect(paid).toBeGreaterThan(0);
    expect(statements).toBeLessThanOrEqual(ceiling(lines, paid));
  });

  it("a full file where every line pays stays within the budget", () => {
    expect(ceiling(MAX_REMITTANCE_LINES, MAX_REMITTANCE_LINES)).toBeLessThanOrEqual(BUDGET);
  });
});
