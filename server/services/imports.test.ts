import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CLINIC, CONNECTOR_ACTOR, configuredDesk, OFFICER_ACTOR, rotatedDesk, visitByKey } from "../../tests/helpers/fixtures";
import { cents } from "../../src/domain/money";
import { nricCheckLetter } from "../../src/domain/nric";
import type { ClaimState } from "../../src/domain/claims/state";
import type { SourceVisit } from "../../src/domain/source-visit";
import type { ClaimStatus } from "../../src/domain/types";
import * as audit from "../repo/audit";
import * as claims from "../repo/claims";
import * as imports from "../repo/imports";
import { importVisits, RealIdentifierRefusedError } from "./imports";

/** A well-formed NRIC outside the synthetic T9 block. */
const OUTSIDE_BLOCK = `T8999999${nricCheckLetter("T", "8999999")}`;

const withFees = (v: SourceVisit, fees: Record<string, { feeCents: number; gstCents: number | null }>): SourceVisit => ({
  ...v,
  treatments: v.treatments.map((t) => {
    const f = fees[t.code];
    return f ? { ...t, feeCents: cents(f.feeCents), gstCents: f.gstCents === null ? null : cents(f.gstCents) } : t;
  }),
});

/** Every row of every table, except the import bookkeeping (its own rows and audit events). */
async function snapshot(db: D1Database): Promise<Record<string, unknown[]>> {
  const { results: tables } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('imports', 'd1_migrations') ORDER BY name")
    .all<{ name: string }>();
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    const where = name === "audit_events" ? " WHERE entity_type <> 'import'" : "";
    out[name] = (await db.prepare(`SELECT * FROM ${name}${where} ORDER BY rowid`).all()).results;
  }
  return out;
}

async function count(db: D1Database, sql: string, ...binds: unknown[]): Promise<number> {
  return (await db.prepare(sql).bind(...binds).first<number>("n")) ?? 0;
}

async function chasClaim(db: D1Database, visitKey: string) {
  const claim = (await claims.forVisit(db, visitKey)).find((c) => c.scheme === "chas");
  if (!claim) throw new Error(`no CHAS claim for ${visitKey}`);
  return claim;
}

/** Moves a claim straight to a status, standing in for the approval and submission flows of later tickets. */
async function force(db: D1Database, visitKey: string, status: ClaimStatus) {
  const c = await chasClaim(db, visitKey);
  const extra =
    status === "approved"
      ? { approvedRevision: c.builtFromRevision, approvedBy: "reviewer@example.test", approvedAt: "2026-11-13T02:00:00.000Z" }
      : status === "submitted"
        ? { submittedRevision: c.builtFromRevision, channel: "assisted" as const }
        : {};
  await claims.transitionStatement(db, c.id, c.version, crypto.randomUUID(), { status, updatedAt: "2026-11-13T02:00:00.000Z", ...extra }).run();
}

describe("importVisits", () => {
  it("builds D01 into one ready CHAS claim the queue shows masked (AC-1.7)", async () => {
    const { db, deps } = await configuredDesk();

    const summary = await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D01")] }, CONNECTOR_ACTOR);

    expect(summary).toMatchObject({ received: 1, new: 1, changed: 0, unchanged: 0, flagged: 0, refused: 0, ignored: [] });
    const page = await claims.list(db, {}, { now: deps.now });
    expect(page.items).toHaveLength(1);
    const [row] = page.items;
    expect(row).toMatchObject({
      visitKey: "SC-D01",
      scheme: "chas",
      status: "ready",
      claimedCents: 5050,
      branchId: "BR-EAST",
      deadline: { deadline: "2026-12-10", daysLeft: 27, warning: false },
    });
    const nric = visitByKey("SC-D01").patient.nric;
    expect(row!.patientMask).toMatch(/^T••••\d{3}[A-Z]$/);
    expect(row!.patientMask.endsWith(nric.slice(-4))).toBe(true);
    expect(row!.findings.filter((f) => f.code === "benchmark_not_set").map((f) => f.lineNo)).toEqual([2]);
  });

  it("refuses a whole import carrying an NRIC outside the synthetic block, recording positions only", async () => {
    const { db, deps } = await configuredDesk();
    const real = { ...visitByKey("SC-D15"), patient: { ...visitByKey("SC-D15").patient, nric: OUTSIDE_BLOCK } };

    const attempt = importVisits(deps, { source: "connector", visits: [visitByKey("SC-D01"), real] }, CONNECTOR_ACTOR);

    const error = await attempt.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RealIdentifierRefusedError);
    expect((error as RealIdentifierRefusedError).indexes).toEqual([1]);
    expect(JSON.stringify(error)).not.toContain(OUTSIDE_BLOCK);
    expect((error as Error).message).not.toContain(OUTSIDE_BLOCK);
    expect(await count(db, "SELECT COUNT(*) AS n FROM visits")).toBe(0);
    expect(await count(db, "SELECT COUNT(*) AS n FROM claims")).toBe(0);
    const row = await db.prepare("SELECT received, refused, finished_at FROM imports").first<{ received: number; refused: number; finished_at: string | null }>();
    expect(row).toMatchObject({ received: 2, refused: 2 });
    expect(row!.finished_at).not.toBeNull();
    const events = await audit.list(db, { type: "import", id: (error as RealIdentifierRefusedError).importId });
    expect(events.map((e) => e.action)).toEqual(["import_refused"]);
    expect(events[0]!.detail).toEqual({ reason: "real_identifier_refused", received: 2, indexes: [1] });
    const everything = JSON.stringify(await snapshot(db)) + JSON.stringify(await db.prepare("SELECT * FROM imports").all());
    expect(everything).not.toContain(OUTSIDE_BLOCK);
  });

  it("lets an NRIC outside the block through when real identifiers are allowed", async () => {
    const { deps } = await configuredDesk({ ALLOW_REAL_IDENTIFIERS: "yes" });
    const real = { ...visitByKey("SC-D15"), patient: { ...visitByKey("SC-D15").patient, nric: OUTSIDE_BLOCK } };

    const summary = await importVisits(deps, { source: "connector", visits: [real] }, CONNECTOR_ACTOR);

    expect(summary.new).toBe(1);
  });

  it("refuses a malformed visit by position and path, never by value, and imports the rest", async () => {
    const { db, deps } = await configuredDesk();
    const bad = { ...visitByKey("SC-D15"), patient: { ...visitByKey("SC-D15").patient, nric: "X1234567Q" } };

    const summary = await importVisits(deps, { source: "connector", visits: [bad, visitByKey("SC-D01")] }, CONNECTOR_ACTOR);

    expect(summary).toMatchObject({ received: 2, new: 1, refused: 1 });
    expect(summary.refusedVisits).toHaveLength(1);
    expect(summary.refusedVisits[0]!.index).toBe(0);
    expect(summary.refusedVisits[0]!.issues.map((i) => i.path)).toContain("patient.nric");
    expect(JSON.stringify(summary)).not.toContain("X1234567Q");
    expect(await count(db, "SELECT refused AS n FROM imports")).toBe(1);
  });

  it("writes nothing when the same content arrives again (AC-1.3, SC1.12)", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D01")] }, CONNECTOR_ACTOR);
    const before = await snapshot(db);

    const summary = await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D01")] }, CONNECTOR_ACTOR);

    expect(summary).toMatchObject({ received: 1, new: 0, changed: 0, unchanged: 1, ignored: [] });
    expect(await snapshot(db)).toEqual(before);
  });

  it("ignores a revision 1 payload that arrives after revision 2 (AC-1.3)", async () => {
    const { db, deps } = await configuredDesk();
    const v1 = visitByKey("SC-D01");
    const v2 = withFees(v1, { SCL: { feeCents: 5500, gstCents: 495 } });
    await importVisits(deps, { source: "connector", visits: [v1] }, CONNECTOR_ACTOR);
    await importVisits(deps, { source: "connector", visits: [v2] }, CONNECTOR_ACTOR);
    const before = await snapshot(db);

    const summary = await importVisits(deps, { source: "connector", visits: [v1] }, CONNECTOR_ACTOR);

    expect(summary).toMatchObject({ new: 0, changed: 0, unchanged: 0, ignored: [{ visitKey: "SC-D01", reason: "older_than_current" }] });
    expect(await snapshot(db)).toEqual(before);
  });

  it("keeps the ignored count on the import's log row (AC-1.4)", async () => {
    const { db, deps } = await configuredDesk();
    const v1 = visitByKey("SC-D01");
    const v2 = withFees(v1, { SCL: { feeCents: 5500, gstCents: 495 } });
    await importVisits(deps, { source: "connector", visits: [v1] }, CONNECTOR_ACTOR);
    await importVisits(deps, { source: "connector", visits: [v2] }, CONNECTOR_ACTOR);

    const { importId } = await importVisits(deps, { source: "connector", visits: [v1, visitByKey("SC-D03")] }, CONNECTOR_ACTOR);

    const [row] = await imports.recent(db, 1);
    expect(row).toMatchObject({ id: importId, received: 2, new: 1, changed: 0, unchanged: 0, ignored: 1, refused: 0 });
  });

  it("gives every synthetic visit one revision and counts that add up (AC-1.4, SC1.11)", async () => {
    const { db, deps } = await configuredDesk();

    const s = await importVisits(deps, { source: "synthetic", visits: CLINIC.visits }, OFFICER_ACTOR);

    expect(s.received).toBe(CLINIC.visits.length);
    expect(s.new + s.changed + s.unchanged + s.ignored.length + s.refused).toBe(s.received);
    expect(s.new).toBe(CLINIC.visits.length);
    expect(await count(db, "SELECT COUNT(*) AS n FROM visit_revisions")).toBe(CLINIC.visits.length);
    expect(await count(db, "SELECT COUNT(*) AS n FROM visits WHERE visit_key NOT IN (SELECT DISTINCT visit_key FROM claims)")).toBeLessThan(CLINIC.visits.length);
    expect(await count(db, "SELECT COUNT(*) AS n FROM (SELECT visit_key, payer_id FROM claims GROUP BY 1, 2 HAVING COUNT(*) > 1)")).toBe(0);
  });

  it("keeps one revision and one set of claims when two imports of the same visits overlap (AC-1.5)", async () => {
    const { db, deps } = await configuredDesk();
    const batch = CLINIC.visits.slice(0, 20);

    const [a, b] = await Promise.all([
      importVisits(deps, { source: "connector", visits: batch }, CONNECTOR_ACTOR),
      importVisits(deps, { source: "synthetic", visits: batch }, OFFICER_ACTOR),
    ]);

    expect(a.new + b.new).toBe(batch.length);
    expect(a.unchanged + b.unchanged).toBe(batch.length);
    expect(await count(db, "SELECT COUNT(*) AS n FROM visit_revisions")).toBe(batch.length);
    expect(await count(db, "SELECT COUNT(*) AS n FROM (SELECT visit_key, payer_id FROM claims GROUP BY 1, 2 HAVING COUNT(*) > 1)")).toBe(0);
  });

  it("leaves a submitted claim as sent and flags it changed after submission (UAT 5.12, SC1.12)", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D01")] }, CONNECTOR_ACTOR);
    await force(db, "SC-D01", "submitted");

    const summary = await importVisits(
      deps,
      { source: "connector", visits: [withFees(visitByKey("SC-D01"), { SCL: { feeCents: 5500, gstCents: 495 } })] },
      CONNECTOR_ACTOR,
    );

    expect(summary).toMatchObject({ changed: 1, flagged: 1 });
    const c = await chasClaim(db, "SC-D01");
    expect(c).toMatchObject({ status: "submitted", claimedCents: 5050, changedAfterSubmission: true });
    const trail = await audit.list(db, { type: "claim", id: c.id });
    expect(trail.at(-1)).toMatchObject({ action: "flagged_changed", detail: { revision: 2, claimedCents: 5050 } });
  });

  it("sends an approved claim whose fee changed back to ready and records the cleared approval (UAT 5.14)", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D15")] }, CONNECTOR_ACTOR);
    await force(db, "SC-D15", "approved");

    await importVisits(deps, { source: "connector", visits: [withFees(visitByKey("SC-D15"), { SCL: { feeCents: 1500, gstCents: null } })] }, CONNECTOR_ACTOR);

    const c = await chasClaim(db, "SC-D15");
    expect(c).toMatchObject({ status: "ready", claimedCents: 1500, approvedRevision: null, approvedBy: null });
    const trail = await audit.list(db, { type: "claim", id: c.id });
    expect(trail.at(-1)).toMatchObject({ action: "approval_cleared", detail: { revision: 2, from: "approved", to: "ready" } });
  });

  it("moves a kept approval to the new revision when only a note changed (technical F5)", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D15")] }, CONNECTOR_ACTOR);
    await force(db, "SC-D15", "approved");

    await importVisits(deps, { source: "connector", visits: [{ ...visitByKey("SC-D15"), notes: "Front desk: called to confirm the card." }] }, CONNECTOR_ACTOR);

    const c = await chasClaim(db, "SC-D15");
    expect(c).toMatchObject({ status: "approved", builtFromRevision: 2, approvedRevision: 2 });
  });

  it("withdraws a voided visit's unsent claims and flags its sent ones (S7)", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D01"), visitByKey("SC-D15")] }, CONNECTOR_ACTOR);
    await force(db, "SC-D01", "submitted");

    await importVisits(
      deps,
      { source: "connector", visits: [{ ...visitByKey("SC-D01"), voided: true }, { ...visitByKey("SC-D15"), voided: true }] },
      CONNECTOR_ACTOR,
    );

    expect(await chasClaim(db, "SC-D01")).toMatchObject({ status: "submitted", changedAfterSubmission: true });
    const d15 = await chasClaim(db, "SC-D15");
    expect(d15.status).toBe("withdrawn");
    const trail = await audit.list(db, { type: "claim", id: d15.id });
    expect(trail.at(-1)).toMatchObject({ action: "withdraw", detail: { why: "voided_in_clinic", from: "ready" } });
  });

  it("clears the approval and the checkout of an approved claim the voided visit withdraws (Sec-2)", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D15")] }, CONNECTOR_ACTOR);
    const c = await chasClaim(db, "SC-D15");
    await claims
      .transitionStatement(db, c.id, c.version, crypto.randomUUID(), {
        status: "approved",
        updatedAt: "2026-11-13T02:00:00.000Z",
        approvedRevision: c.builtFromRevision,
        approvedBy: "reviewer@example.test",
        approvedAt: "2026-11-13T02:00:00.000Z",
        selfApproved: true,
        channel: "assisted",
        checkoutBy: "officer@example.test",
        checkoutUntil: "2026-11-13T02:30:00.000Z",
      })
      .run();

    await importVisits(deps, { source: "connector", visits: [{ ...visitByKey("SC-D15"), voided: true }] }, CONNECTOR_ACTOR);

    expect(await chasClaim(db, "SC-D15")).toMatchObject({
      status: "withdrawn",
      approvedRevision: null,
      approvedBy: null,
      approvedAt: null,
      selfApproved: false,
      channel: null,
      checkoutBy: null,
      checkoutUntil: null,
    });
  });

  it("never brings a closed claim back (S8, UAT 5.15)", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D15")] }, CONNECTOR_ACTOR);
    await force(db, "SC-D15", "withdrawn");
    const before = await chasClaim(db, "SC-D15");

    await importVisits(deps, { source: "connector", visits: [withFees(visitByKey("SC-D15"), { SCL: { feeCents: 4000, gstCents: null } })] }, CONNECTOR_ACTOR);

    const after = await claims.forVisit(db, "SC-D15");
    expect(after.filter((c) => c.scheme === "chas")).toHaveLength(1);
    expect(after.find((c) => c.scheme === "chas")).toMatchObject({ id: before.id, status: "withdrawn", version: before.version, claimedCents: before.claimedCents });
  });

  it("leaves every table identical when the same batch is imported twice (SC1.13)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.subarray(CLINIC.visits, { minLength: 1, maxLength: 5 }), async (batch) => {
        const { db, deps } = await configuredDesk();
        await importVisits(deps, { source: "connector", visits: batch }, CONNECTOR_ACTOR);
        const once = await snapshot(db);

        const again = await importVisits(deps, { source: "connector", visits: batch }, CONNECTOR_ACTOR);

        expect(again.unchanged).toBe(batch.length);
        expect(await snapshot(db)).toEqual(once);
      }),
      { seed: 20261113, numRuns: 100 },
    );
    // A hundred fresh desks under a fixed seed: slow on a loaded machine, never random. Only time can fail it.
  }, 60_000);
});

describe("importVisits during a key rotation (infra I1)", () => {
  /** What a claim decides, without the row's identity or the key its patient hash is under. */
  const outcome = (c: ClaimState) => ({ payerId: c.payerId, scheme: c.scheme, status: c.status, claimedCents: c.claimedCents, findings: c.findings });
  /** The key version each row's patient hash is under. */
  const versions = async (db: D1Database, table: "visits" | "claims", keys: readonly string[]) =>
    (
      await db
        .prepare(`SELECT patient_hash FROM ${table} WHERE visit_key IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(keys))
        .all<{ patient_hash: string }>()
    ).results.map((r) => r.patient_hash.slice(0, 3));

  it("writes nothing when a visit stored under the previous key arrives again unchanged", async () => {
    const before = await configuredDesk();
    await importVisits(before.deps, { source: "connector", visits: [visitByKey("SC-D01")] }, CONNECTOR_ACTOR);
    const { db, deps } = await rotatedDesk(before);
    const once = await snapshot(db);

    const summary = await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D01")] }, CONNECTOR_ACTOR);

    expect(summary).toMatchObject({ new: 0, changed: 0, unchanged: 1, ignored: [] });
    expect(await snapshot(db)).toEqual(once);
  });

  it("ignores an older revision written under the previous key", async () => {
    const before = await configuredDesk();
    const v1 = visitByKey("SC-D01");
    await importVisits(before.deps, { source: "connector", visits: [v1] }, CONNECTOR_ACTOR);
    const { db, deps } = await rotatedDesk(before);
    await importVisits(deps, { source: "connector", visits: [withFees(v1, { SCL: { feeCents: 5500, gstCents: 495 } })] }, CONNECTOR_ACTOR);
    const once = await snapshot(db);

    const summary = await importVisits(deps, { source: "connector", visits: [v1] }, CONNECTOR_ACTOR);

    expect(summary).toMatchObject({ new: 0, changed: 0, unchanged: 0, ignored: [{ visitKey: "SC-D01", reason: "older_than_current" }] });
    expect(await snapshot(db)).toEqual(once);
  });

  it("finds a returning patient's earlier visits under the previous key and moves them to the current one", async () => {
    const p27 = ["SC-D19-1", "SC-D19-2", "SC-D19-3"];
    const [first, second, third] = p27.map(visitByKey);
    const single = await configuredDesk();
    await importVisits(single.deps, { source: "connector", visits: [first, second, third] }, CONNECTOR_ACTOR);
    const before = await configuredDesk();
    await importVisits(before.deps, { source: "connector", visits: [first, second, visitByKey("SC-D01")] }, CONNECTOR_ACTOR);
    const { db, deps } = await rotatedDesk(before);

    await importVisits(deps, { source: "connector", visits: [third] }, CONNECTOR_ACTOR);

    const built = await claims.forVisit(db, "SC-D19-3");
    expect(built.map(outcome)).toEqual((await claims.forVisit(single.db, "SC-D19-3")).map(outcome));
    expect(built.find((c) => c.scheme === "chas")?.findings.map((f) => f.code)).toContain("frequency_over_limit");
    expect(new Set([...(await versions(db, "visits", p27)), ...(await versions(db, "claims", p27))])).toEqual(new Set(["v2:"]));
    // A patient who has not come back keeps the previous key's hash until the re-seal route moves it.
    expect(new Set([...(await versions(db, "visits", ["SC-D01"])), ...(await versions(db, "claims", ["SC-D01"]))])).toEqual(new Set(["v1:"]));
  });
});
