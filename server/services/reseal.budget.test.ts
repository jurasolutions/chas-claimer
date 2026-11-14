import { describe, expect, it } from "vitest";
import { RESEAL_BATCH } from "../../src/api/settings";
import type { Actor } from "../../src/domain/types";
import { REVIEWER } from "../../tests/helpers/env";
import { rotatedDesk, seededDesk } from "../../tests/helpers/fixtures";
import { resealBatch } from "./reseal";

/**
 * One reseal batch is one invocation, and D1 allows 1,000 queries in one (technical F7, §9; review Q3).
 * A batch costs a few statements for the page, the patients' moves, the audit and what is left, and two
 * per revision it re-keys. These counts are ceilings: a change that makes a revision dearer fails here,
 * and `RESEAL_BATCH` has to come down with it.
 */
const FIXED = 6; // the stale page, the patient moves on visits, claims and statement lines, the audit, what is left
const PER_REVISION = 2; // the revision's re-key and its visit's head hash
/** What a batch may spend, leaving room under 1,000 for the request around it. */
const BUDGET = 700;

const ACTOR: Actor = { kind: "person", email: REVIEWER, roles: ["reviewer"] };

const ceiling = (revisions: number) => FIXED + PER_REVISION * revisions;

describe("a reseal batch's D1 statement count", () => {
  it("a full batch on the seeded desk stays within the per-revision cost", async () => {
    const desk = await rotatedDesk(await seededDesk());
    let statements = 0;
    const counting = new Proxy(desk.db, {
      get: (target, key) =>
        key === "prepare"
          ? (sql: string) => {
              statements += 1;
              return target.prepare(sql);
            }
          : Reflect.get(target, key, target),
    });

    const progress = await resealBatch({ ...desk.deps, db: counting }, "", ACTOR);

    expect(progress.moved).toBe(RESEAL_BATCH);
    expect(statements).toBeLessThanOrEqual(ceiling(RESEAL_BATCH));
  });

  it("a full batch stays within the budget", () => {
    expect(ceiling(RESEAL_BATCH)).toBeLessThanOrEqual(BUDGET);
  });
});
