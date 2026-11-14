import { createD1 } from "../../tests/helpers/d1";
import { seedClaim } from "../../tests/helpers/seed";
import * as settingsRepo from "./settings";
import { CLINIC } from "../../tests/helpers/fixtures";
import type { AuditDraft } from "../../src/domain/types";
import { auditStatement, list } from "./audit";

const approve: AuditDraft = {
  at: "2026-07-02T01:00:00.000Z",
  actor: "officer@example.com",
  action: "approve",
  entityType: "claim",
  entityId: "C-1",
  detail: { fromVersion: 1 },
};

/** The transition the claims repository will issue: guarded by version, stamped with a nonce. */
const transition = (db: D1Database, expectedVersion: number, nonce: string) =>
  db
    .prepare("UPDATE claims SET status = 'approved', version = version + 1, last_action = ? WHERE id = 'C-1' AND version = ?")
    .bind(nonce, expectedVersion);

describe("the audit repository", () => {
  it("records an event and lists it back for its entity, oldest first", async () => {
    const db = await createD1();
    await seedClaim(db);
    await db.batch([
      auditStatement(db, approve),
      auditStatement(db, { ...approve, action: "submit", at: "2026-07-02T02:00:00.000Z", detail: {} }),
      auditStatement(db, { ...approve, entityId: "C-other" }),
    ]);

    const events = await list(db, { type: "claim", id: "C-1" });

    expect(events).toEqual([
      { id: 1, ...approve },
      { id: 2, ...approve, action: "submit", at: "2026-07-02T02:00:00.000Z", detail: {} },
    ]);
  });

  it("records a guarded event when the transition it belongs to went through", async () => {
    const db = await createD1();
    await seedClaim(db);

    const [update, audit] = await db.batch([transition(db, 1, "n1"), auditStatement(db, approve, { claimId: "C-1", nonce: "n1" })]);

    expect(update!.meta.changes).toBe(1);
    expect(audit!.meta.changes).toBe(1);
    expect(await list(db, { type: "claim", id: "C-1" })).toHaveLength(1);
  });

  it("records nothing when a stale transition changed nothing", async () => {
    const db = await createD1();
    await seedClaim(db);
    await db.batch([transition(db, 1, "n1"), auditStatement(db, approve, { claimId: "C-1", nonce: "n1" })]);

    const [update, audit] = await db.batch([
      transition(db, 1, "n2"),
      auditStatement(db, { ...approve, actor: "other@example.com" }, { claimId: "C-1", nonce: "n2" }),
    ]);

    expect(update!.meta.changes).toBe(0);
    expect(audit!.meta.changes).toBe(0);
    expect(await list(db, { type: "claim", id: "C-1" })).toEqual([{ id: 1, ...approve }]);
  });

  it("records a settings save only when the save just moved the row to the version it names", async () => {
    const db = await createD1();
    await db.batch([settingsRepo.saveStatement(db, CLINIC.settings, 0, "officer@example.com")]);
    const saved: AuditDraft = { ...approve, action: "settings_saved", entityType: "settings", entityId: "desk", detail: { toVersion: 2 } };
    const save = (actor: string) => [
      settingsRepo.saveStatement(db, CLINIC.settings, 1, actor),
      auditStatement(db, { ...saved, actor }, { settingsVersion: 2 }),
    ];

    const [first, firstAudit] = await db.batch(save("a@example.com"));
    const [second, secondAudit] = await db.batch(save("b@example.com"));

    expect([first!.meta.changes, firstAudit!.meta.changes]).toEqual([1, 1]);
    expect([second!.meta.changes, secondAudit!.meta.changes]).toEqual([0, 0]);
    expect(await list(db, { type: "settings", id: "desk" })).toEqual([{ id: 1, ...saved, actor: "a@example.com" }]);
  });
});
