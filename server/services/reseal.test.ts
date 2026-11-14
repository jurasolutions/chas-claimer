import { describe, expect, it } from "vitest";
import { RESEAL_BATCH, type ResealProgress } from "../../src/api/settings";
import type { Actor } from "../../src/domain/types";
import { OTHER_IDENTIFIER_KEY, REVIEWER } from "../../tests/helpers/env";
import { CLINIC, type Desk, emptyDesk, OFFICER_ACTOR, retiredDesk, rotatedDesk, seededDesk } from "../../tests/helpers/fixtures";
import { claimOf, force } from "../../tests/helpers/payments";
import { nricCheckLetter } from "../../src/domain/nric";
import { identifierKeys, openIdentity } from "../crypto";
import { importVisits } from "./imports";
import { importRemittance, matchByHand, remittanceDetail } from "./remittances";
import { resealBatch } from "./reseal";

const ACTOR: Actor = { kind: "person", email: REVIEWER, roles: ["reviewer"] };
/** A third test key (synthetic, published here on purpose). */
const THIRD_KEY = btoa("chas-claimer-test-key-number-six");

async function count(db: D1Database, sql: string): Promise<number> {
  return (await db.prepare(sql).first<number>("n")) ?? 0;
}

/** Posts the cursor back until the reseal says it is finished. */
async function resealAll(desk: Desk): Promise<ResealProgress[]> {
  const batches: ResealProgress[] = [];
  let after = "";
  for (let i = 0; i < 1000; i += 1) {
    const progress = await resealBatch(desk.deps, after, ACTOR);
    batches.push(progress);
    if (progress.next === null) return batches;
    after = progress.next.after;
  }
  throw new Error("the reseal never finished");
}

/** The desk once the rotation is over: the new key alone, at version 2. */
const afterRotation = retiredDesk;

describe("resealing stored identities under the current key (infra I1)", () => {
  it("moves every revision, visit, claim and patient hash to the current version in capped batches", async () => {
    const desk = await rotatedDesk(await seededDesk());
    const revisions = await count(desk.db, "SELECT count(*) AS n FROM visit_revisions");
    expect(revisions).toBeGreaterThan(RESEAL_BATCH);

    const batches = await resealAll(desk);
    expect(batches[0]).toMatchObject({ moved: RESEAL_BATCH, failed: 0, remaining: revisions - RESEAL_BATCH });
    expect(batches.reduce((n, b) => n + b.moved, 0)).toBe(revisions);
    expect(batches.at(-1)).toMatchObject({ failed: 0, failures: [], remaining: 0, previousKeyMissing: false, cantMove: { remittanceFiles: 0, remittanceLines: 0 }, next: null });

    for (const [table, column] of [
      ["visit_revisions", "identity_sealed"],
      ["visit_revisions", "content_hash"],
      ["visits", "content_hash"],
      ["visits", "patient_hash"],
      ["claims", "patient_hash"],
    ]) {
      expect(await count(desk.db, `SELECT count(*) AS n FROM ${table} WHERE ${column} NOT LIKE 'v2:%'`), `${table}.${column}`).toBe(0);
    }
  });

  it("leaves a desk that opens and re-imports with the new key alone", async () => {
    const desk = await rotatedDesk(await seededDesk());
    await resealAll(desk);
    const done = await afterRotation(desk);

    const { results } = await done.db.prepare("SELECT visit_key, revision, identity_sealed FROM visit_revisions").all<{ visit_key: string; revision: number; identity_sealed: string }>();
    for (const r of results) {
      await expect(openIdentity(done.deps.keys, r.identity_sealed, { visitKey: r.visit_key, revision: r.revision })).resolves.toHaveProperty("nric");
    }
    const again = await importVisits(done.deps, { source: "synthetic", visits: CLINIC.visits }, OFFICER_ACTOR);
    expect(again).toMatchObject({ new: 0, changed: 0, unchanged: CLINIC.visits.length, ignored: [] });
  });

  it("writes one audit event per batch, with counts and versions only", async () => {
    const desk = await rotatedDesk(await seededDesk());
    const batches = await resealAll(desk);
    const { results } = await desk.db
      .prepare("SELECT actor, entity_type, entity_id, detail_json FROM audit_events WHERE action = 'identity_resealed' ORDER BY id")
      .all<{ actor: string; entity_type: string; entity_id: string; detail_json: string }>();
    expect(results).toHaveLength(batches.length);
    expect(results[0]).toMatchObject({ actor: REVIEWER, entity_type: "settings", entity_id: "identifier_key" });
    expect(JSON.parse(results[0]?.detail_json ?? "{}")).toEqual({
      version: 2,
      considered: RESEAL_BATCH,
      attempted: RESEAL_BATCH,
      failed: 0,
    });
    expect(results.map((r) => r.detail_json).join("")).not.toMatch(/T9\d{7}[A-Z]/);
  });

  it("reports what remains and moves nothing while the previous key is not set", async () => {
    const seeded = await seededDesk();
    const revisions = await count(seeded.db, "SELECT count(*) AS n FROM visit_revisions");
    const desk = await afterRotation(seeded);
    expect(await resealBatch(desk.deps, "", ACTOR)).toEqual({
      moved: 0,
      failed: 0,
      failures: [],
      remaining: revisions,
      previousKeyMissing: true,
      cantMove: { remittanceFiles: 0, remittanceLines: 0 },
      next: null,
    });
    expect(await count(desk.db, "SELECT count(*) AS n FROM audit_events WHERE action = 'identity_resealed'")).toBe(0);
  });

  it("counts a revision under neither key as failed, leaves it and moves on", async () => {
    const seeded = await seededDesk();
    const revisions = await count(seeded.db, "SELECT count(*) AS n FROM visit_revisions");
    // Version 3 over version 2: the version 1 rows were never moved, so neither key opens them.
    const env = { ...seeded.env, IDENTIFIER_KEY: THIRD_KEY, IDENTIFIER_KEY_VERSION: "3", IDENTIFIER_KEY_PREVIOUS: OTHER_IDENTIFIER_KEY };
    const keys = await identifierKeys(env);
    if (!keys?.previous) throw new Error("keys did not load");
    const desk: Desk = { env, db: seeded.db, deps: { ...seeded.deps, env, keys } };

    const batches = await resealAll(desk);
    expect(batches[0]).toMatchObject({ moved: 0, failed: RESEAL_BATCH, remaining: revisions });
    expect(batches[0]?.next).not.toBeNull();
    const { results: first } = await desk.db
      .prepare("SELECT visit_key AS visitKey, revision FROM visit_revisions ORDER BY visit_key, revision LIMIT ?")
      .bind(RESEAL_BATCH)
      .all<{ visitKey: string; revision: number }>();
    expect(batches[0]?.failures).toEqual(first);
    expect(batches.reduce((n, b) => n + b.failed, 0)).toBe(revisions);
    expect(batches.at(-1)).toMatchObject({ remaining: revisions, next: null });
    expect(await count(desk.db, "SELECT count(*) AS n FROM visit_revisions WHERE identity_sealed LIKE 'v1:%'")).toBe(revisions);
  });

  it("does nothing on an empty desk", async () => {
    const desk = await rotatedDesk(await emptyDesk());
    expect(await resealBatch(desk.deps, "", ACTOR)).toEqual({
      moved: 0,
      failed: 0,
      failures: [],
      remaining: 0,
      previousKeyMissing: false,
      cantMove: { remittanceFiles: 0, remittanceLines: 0 },
      next: null,
    });
  });

  it("still reports what remains on a desk at version 1 with no previous key, without flagging a missing one", async () => {
    const desk = await seededDesk();
    expect(await resealBatch(desk.deps, "", ACTOR)).toMatchObject({ remaining: 0, previousKeyMissing: false });
  });
});

describe("payment statements across a rotation (infra I1, review B1)", () => {
  const d01 = CLINIC.visits.find((v) => v.visitKey === "SC-D01");
  if (!d01) throw new Error("the synthetic clinic has no SC-D01");
  /** A synthetic patient in the reserved T9 block with no visit on the desk. */
  const STRANGER = `T9000123${nricCheckLetter("T", "9000123")}`;
  const STATEMENT = {
    payerId: "CHAS",
    fileName: "chas-before-rotation.csv",
    csv: `reference,identifier,visit date,amount\r\nMHCP-0001,${d01.patient.nric},${d01.date},50.50\r\nMHCP-0005,${STRANGER},${d01.date},99.99\r\n`,
  };

  /** A statement taken in under version 1, then the desk rotated to version 2 and resealed. */
  async function resealedWithStatement() {
    const seeded = await seededDesk();
    const imported = await importRemittance(seeded.deps, STATEMENT, OFFICER_ACTOR);
    if (!imported.ok || imported.value.outcome !== "imported") throw new Error("the statement did not import");
    const desk = await rotatedDesk(seeded);
    const batches = await resealAll(desk);
    return { desk, batches, remittanceId: imported.value.remittanceId };
  }

  it("counts the statement and the line it cannot move, while a line whose patient has a visit moves with it", async () => {
    const { desk, batches, remittanceId } = await resealedWithStatement();

    expect(batches.at(-1)).toMatchObject({ remaining: 0, cantMove: { remittanceFiles: 1, remittanceLines: 1 }, next: null });
    const { results } = await desk.db
      .prepare("SELECT line_no, substr(patient_hash, 1, 3) AS prefix, key_version FROM remittance_lines WHERE remittance_id = ? ORDER BY line_no")
      .bind(remittanceId)
      .all();
    expect(results).toEqual([
      { line_no: 1, prefix: "v2:", key_version: 2 },
      { line_no: 2, prefix: "v1:", key_version: 1 },
    ]);
  });

  it("leaves a line under the retired key matchable by reference and by hand once the previous key is unset", async () => {
    const { desk, remittanceId } = await resealedWithStatement();
    const done = await afterRotation(desk);
    await force(done.db, "SC-D05", "CHAS", "submitted", { portalReference: "MHCP-0005" });

    const detail = await remittanceDetail(done.db, remittanceId);
    expect(detail?.lines[1]).toMatchObject({ lineNo: 2, match: null, note: { kind: "fits", visitKey: "SC-D05" } });

    const d05 = await claimOf(done.db, "SC-D05", "CHAS");
    const matched = await matchByHand(done.deps, remittanceId, 2, { claimId: d05.id, expectedVersion: d05.version }, OFFICER_ACTOR);
    expect(matched.ok).toBe(true);
    expect(await claimOf(done.db, "SC-D05", "CHAS")).toMatchObject({ status: "paid", paidCents: 9999 });
  });
});
