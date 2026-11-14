import type { Env } from "../../server/env";
import * as audit from "../../server/repo/audit";
import * as claims from "../../server/repo/claims";
import * as settingsRepo from "../../server/repo/settings";
import { REBUILD_BATCH, RESEAL_BATCH, type RebuildProgress, type ResealProgress, type ResealStatus, type SettingsResponse, type SettingsSaveResponse } from "../../src/api/settings";
import { listRuleSets } from "../../src/domain/rules";
import { accessClaims, accessTeam, stubAccessCerts } from "../../tests/helpers/access";
import { OFFICER, REVIEWER, STRANGER } from "../../tests/helpers/env";
import { CLINIC, configuredDesk, NOW, retiredDesk, rotatedDesk, seededDesk } from "../../tests/helpers/fixtures";
import { apiRequest, call } from "../../tests/helpers/http";
import { onRequestGet, onRequestPut } from "./settings";
import { onRequestPost as onRequestRebuild } from "./settings/rebuild";
import { onRequestGet as onRequestResealStatus, onRequestPost as onRequestReseal } from "./settings/reseal";

const team = await accessTeam();

beforeEach(() => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

const as = async (email: string) => team.sign(accessClaims(email));

describe("GET /api/settings", () => {
  it("lets an officer read the settings, the roles from the environment and the rule sets with their sources", async () => {
    const desk = await configuredDesk({ ROLE_REVIEWERS: ` ${REVIEWER.toUpperCase()} , second-reviewer@example.test,`, ROLE_OFFICERS: OFFICER });

    const res = await call(onRequestGet, apiRequest("/api/settings", { jwt: await as(OFFICER) }), desk.env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SettingsResponse;
    expect(body).toEqual({
      version: 1,
      settings: CLINIC.settings,
      roles: { reviewers: [REVIEWER, "second-reviewer@example.test"], officers: [OFFICER] },
      ruleSets: listRuleSets(),
      approvedByChannel: [],
    });
    expect(body.ruleSets[0]?.sources[0]).toEqual({ url: expect.stringMatching(/^https:/), retrieved: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it("S15: counts approved claims by the channel stamped on them, so the screen can warn before a channel change", async () => {
    const desk = await seededDesk();
    await desk.db.prepare("UPDATE claims SET status = 'approved', channel = 'assisted' WHERE id IN (SELECT id FROM claims WHERE status = 'ready' AND payer_id = 'CHAS' ORDER BY id LIMIT 3)").run();

    const res = await call(onRequestGet, apiRequest("/api/settings", { jwt: await as(OFFICER) }), desk.env);

    expect(((await res.json()) as SettingsResponse).approvedByChannel).toEqual([{ payerId: "CHAS", channel: "assisted", count: 3 }]);
  });

  it("refuses a caller with no role", async () => {
    const desk = await configuredDesk();
    const res = await call(onRequestGet, apiRequest("/api/settings", { jwt: await as(STRANGER) }), desk.env);
    expect(res.status).toBe(403);
  });
});

const SCALING_OVERRIDE = { procedureCode: "SCALING", minCents: 4000, maxCents: 9000, sourceUrl: "https://example.test/scaling-benchmark", asOf: "2026-10-01" };

const put = async (env: Env, email: string, body: unknown) =>
  call(onRequestPut, apiRequest("/api/settings", { method: "PUT", json: body, jwt: await as(email) }), env);

/** Posts each continuation until the rebuild is finished; returns every batch's progress. */
async function finishRebuild(env: Env, first: RebuildProgress): Promise<RebuildProgress[]> {
  const batches = [first];
  let next = first.next;
  while (next) {
    const res = await call(onRequestRebuild, apiRequest("/api/settings/rebuild", { json: next, jwt: await as(REVIEWER) }), env);
    expect(res.status).toBe(200);
    const progress = (await res.json()) as RebuildProgress;
    batches.push(progress);
    next = progress.next;
  }
  return batches;
}

const findingCodes = async (db: D1Database, visitKey: string) => (await claims.forVisit(db, visitKey)).flatMap((c) => c.findings.map((f) => f.code));

describe("PUT /api/settings", () => {
  it("AC-8.1: a reviewer fills a blank benchmark with its source; unsubmitted claims recompute and the trail records who", async () => {
    const desk = await seededDesk();
    expect(await findingCodes(desk.db, "SC-D01")).toContain("benchmark_not_set");
    const settings = { ...CLINIC.settings, benchmarkOverrides: [...CLINIC.settings.benchmarkOverrides, SCALING_OVERRIDE] };

    const res = await put(desk.env, REVIEWER, { settings, expectedVersion: 1 });

    expect(res.status).toBe(200);
    const saved = (await res.json()) as SettingsSaveResponse;
    expect(saved.version).toBe(2);
    expect(saved.rebuild.considered).toBe(REBUILD_BATCH);
    expect(saved.rebuild.remaining).toBeGreaterThan(0);
    const batches = await finishRebuild(desk.env, saved.rebuild);
    expect(batches.at(-1)).toMatchObject({ remaining: 0, next: null });
    expect(batches.every((b) => b.considered <= REBUILD_BATCH)).toBe(true);
    expect(await findingCodes(desk.db, "SC-D01")).not.toContain("benchmark_not_set");
    expect(await audit.list(desk.db, { type: "settings", id: "desk" })).toEqual([
      expect.objectContaining({ actor: REVIEWER, action: "settings_saved", detail: { fromVersion: 1, toVersion: 2, sections: ["benchmarkOverrides"] } }),
    ]);
    const after = await call(onRequestGet, apiRequest("/api/settings", { jwt: await as(OFFICER) }), desk.env);
    expect(await after.json()).toMatchObject({ version: 2, settings: { benchmarkOverrides: expect.arrayContaining([SCALING_OVERRIDE]) } });
  });

  it("refuses a benchmark without an https source, saving nothing", async () => {
    const desk = await configuredDesk();
    const { sourceUrl: _, ...unsourced } = SCALING_OVERRIDE;

    for (const override of [unsourced, { ...SCALING_OVERRIDE, sourceUrl: "http://example.test/scaling" }]) {
      const res = await put(desk.env, REVIEWER, { settings: { ...CLINIC.settings, benchmarkOverrides: [override] }, expectedVersion: 1 });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid", issues: [expect.objectContaining({ path: "settings.benchmarkOverrides.0.sourceUrl" })] });
    }
    expect(await audit.list(desk.db, { type: "settings", id: "desk" })).toEqual([]);
  });

  it("ADR 0008: refuses a new override for a procedure MOH publishes a benchmark for, or a code no rule set knows", async () => {
    const desk = await configuredDesk();
    await desk.db.batch([settingsRepo.saveStatement(desk.db, { ...CLINIC.settings, benchmarkOverrides: [] }, 1, OFFICER, new Date(NOW).toISOString())]);
    const published = { ...SCALING_OVERRIDE, procedureCode: "CONSULTATION" };
    const unknown = { ...SCALING_OVERRIDE, procedureCode: "NOT-A-CODE" };

    const res = await put(desk.env, REVIEWER, { settings: { ...CLINIC.settings, benchmarkOverrides: [SCALING_OVERRIDE, published, unknown] }, expectedVersion: 2 });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid",
      issues: [
        { path: "settings.benchmarkOverrides.1.procedureCode", message: expect.stringMatching(/MOH publishes a benchmark/) },
        { path: "settings.benchmarkOverrides.2.procedureCode", message: expect.stringMatching(/not a CHAS procedure code/) },
      ],
    });
  });

  it("AC-8.2: turning a dentist's MediSave accreditation off rebuilds only that dentist's visits", async () => {
    const desk = await seededDesk();
    const settings = { ...CLINIC.settings, dentists: CLINIC.settings.dentists.map((d) => (d.id === "DR-A" ? { ...d, medisaveAccredited: false } : d)) };
    const drA = CLINIC.visits.filter((v) => v.dentistId === "DR-A").length;

    const res = await put(desk.env, REVIEWER, { settings, expectedVersion: 1 });

    expect(res.status).toBe(200);
    const { rebuild } = (await res.json()) as SettingsSaveResponse;
    const batches = await finishRebuild(desk.env, rebuild);
    expect(rebuild.next?.scope ?? { kind: "dentists", ids: ["DR-A"] }).toEqual({ kind: "dentists", ids: ["DR-A"] });
    expect(batches.reduce((n, b) => n + b.considered, 0)).toBe(drA);
  });

  it("D11: switching Dr A's MediSave off and on clears approval only on the claims whose lines, amounts or blocking findings changed", async () => {
    const desk = await seededDesk();
    await desk.db
      .prepare("UPDATE claims SET status = 'approved', approved_revision = built_from_revision, approved_by = ?, approved_at = ? WHERE status = 'ready'")
      .bind(REVIEWER, new Date(NOW).toISOString())
      .run();
    const drA = CLINIC.visits.filter((v) => v.dentistId === "DR-A").map((v) => v.visitKey);
    const snapshot = async () =>
      new Map(
        (await Promise.all(drA.map((key) => claims.forVisit(desk.db, key)))).flat().map((c) => [
          c.id,
          {
            status: c.status,
            what: JSON.stringify([
              c.feeCents,
              c.claimedCents,
              c.lines.map((l) => [l.lineNo, l.schemeCode, l.claimedCents]),
              c.findings.filter((f) => f.severity === "blocking").map((f) => [f.code, f.lineNo ?? null]),
            ]),
          },
        ]),
      );
    const off = { ...CLINIC.settings, dentists: CLINIC.settings.dentists.map((d) => (d.id === "DR-A" ? { ...d, medisaveAccredited: false } : d)) };
    const save = async (settings: typeof CLINIC.settings, expectedVersion: number) => {
      const res = await put(desk.env, REVIEWER, { settings, expectedVersion });
      await finishRebuild(desk.env, ((await res.json()) as SettingsSaveResponse).rebuild);
    };

    const before = await snapshot();
    await save(off, 1);
    const during = await snapshot();
    await save(CLINIC.settings, 2);
    const after = await snapshot();

    const approved = [...before].filter(([, c]) => c.status === "approved").map(([id]) => id);
    const changed = approved.filter((id) => during.get(id)?.what !== before.get(id)?.what);
    const kept = approved.filter((id) => !changed.includes(id));
    expect(changed.length).toBeGreaterThan(0);
    expect(kept.length).toBeGreaterThan(0);
    for (const id of kept) expect([id, after.get(id)?.status]).toEqual([id, "approved"]);
    for (const id of changed) {
      expect([id, during.get(id)?.status]).not.toEqual([id, "approved"]);
      expect((await audit.list(desk.db, { type: "claim", id })).map((e) => e.action)).toContain("approval_cleared");
    }
  });

  it("rebuilds nothing when only a name or a payer's channel details change", async () => {
    const desk = await seededDesk();
    const settings = {
      ...CLINIC.settings,
      dentists: CLINIC.settings.dentists.map((d) => ({ ...d, name: `${d.name} (renamed)` })),
      payers: CLINIC.settings.payers.map((p) => ({ ...p, name: `${p.name} (renamed)` })),
    };

    const res = await put(desk.env, REVIEWER, { settings, expectedVersion: 1 });

    expect(res.status).toBe(200);
    expect(((await res.json()) as SettingsSaveResponse).rebuild).toEqual({ considered: 0, rebuilt: 0, flagged: 0, remaining: 0, next: null });
  });

  it("rebuilds nothing when only a payer's portal URL changes", async () => {
    const desk = await seededDesk();
    const settings = {
      ...CLINIC.settings,
      payers: CLINIC.settings.payers.map((p) => (p.id === "CHAS" ? { ...p, portalUrl: "https://portal.chas.example/claims" } : p)),
    };

    const res = await put(desk.env, REVIEWER, { settings, expectedVersion: 1 });

    expect(res.status).toBe(200);
    expect(((await res.json()) as SettingsSaveResponse).rebuild).toEqual({ considered: 0, rebuilt: 0, flagged: 0, remaining: 0, next: null });
  });

  it("refuses a save against a version someone else has already replaced", async () => {
    const desk = await configuredDesk();
    expect((await put(desk.env, REVIEWER, { settings: CLINIC.settings, expectedVersion: 1 })).status).toBe(200);

    const res = await put(desk.env, REVIEWER, { settings: CLINIC.settings, expectedVersion: 1 });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale", currentVersion: 2 });
    expect(await audit.list(desk.db, { type: "settings", id: "desk" })).toHaveLength(1);
  });

  it("answers stale before judging a save against a row it was not made from", async () => {
    const desk = await configuredDesk();
    expect((await put(desk.env, REVIEWER, { settings: CLINIC.settings, expectedVersion: 1 })).status).toBe(200);
    const unknown = { ...SCALING_OVERRIDE, procedureCode: "NOT-A-CODE" };

    const res = await put(desk.env, REVIEWER, { settings: { ...CLINIC.settings, benchmarkOverrides: [unknown] }, expectedVersion: 1 });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale", currentVersion: 2 });
  });

  it("lets an officer read the settings but not save them", async () => {
    const desk = await configuredDesk();

    const res = await put(desk.env, OFFICER, { settings: CLINIC.settings, expectedVersion: 1 });

    expect(res.status).toBe(403);
    expect((await settingsRepo.get(desk.db)).version).toBe(1);
  });

  it("lets an override already on file stay when the rest of the settings change", async () => {
    const desk = await configuredDesk();
    // Saved before MOH published a consultation benchmark; entered today it would be refused.
    const onFile = { ...CLINIC.settings, benchmarkOverrides: [{ ...SCALING_OVERRIDE, procedureCode: "CONSULTATION" }] } as typeof CLINIC.settings;
    await desk.db.batch([settingsRepo.saveStatement(desk.db, onFile, 1, OFFICER, new Date(NOW).toISOString())]);
    const settings = { ...onFile, waterfall: [...onFile.waterfall].reverse() };

    const res = await put(desk.env, REVIEWER, { settings, expectedVersion: 2 });

    expect(res.status).toBe(200);
    expect((await settingsRepo.get(desk.db)).settings.benchmarkOverrides).toEqual(onFile.benchmarkOverrides);
  });
});

describe("POST /api/settings/rebuild", () => {
  const rebuild = async (env: Env, email: string, body: unknown) =>
    call(onRequestRebuild, apiRequest("/api/settings/rebuild", { json: body, jwt: await as(email) }), env);

  it("continues for reviewers only, and refuses a cursor it did not issue", async () => {
    const desk = await seededDesk();

    expect((await rebuild(desk.env, OFFICER, { scope: { kind: "all" }, after: "" })).status).toBe(403);
    const bad = await rebuild(desk.env, REVIEWER, { scope: { kind: "dentists", ids: [] }, after: "" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid", issues: [expect.objectContaining({ path: "scope.ids" })] });
  });
});

describe("GET /api/settings/reseal (infra I1, review B1)", () => {
  const status = async (env: Env, email: string) => call(onRequestResealStatus, apiRequest("/api/settings/reseal", { jwt: await as(email) }), env);

  it("tells a reviewer the key version, whether the previous key is set, and what is left to move", async () => {
    const seeded = await seededDesk();
    const revisions = (await seeded.db.prepare("SELECT count(*) AS n FROM visit_revisions").first<number>("n")) ?? 0;

    const settled = await status(seeded.env, REVIEWER);
    const rotated = await status((await rotatedDesk(seeded)).env, REVIEWER);
    const unset = await status((await retiredDesk(seeded)).env, REVIEWER);

    expect(settled.status).toBe(200);
    const none = { remittanceFiles: 0, remittanceLines: 0 };
    expect(await settled.json()).toEqual({ version: 1, previousKeySet: false, remaining: 0, previousKeyMissing: false, cantMove: none } satisfies ResealStatus);
    expect(await rotated.json()).toEqual({ version: 2, previousKeySet: true, remaining: revisions, previousKeyMissing: false, cantMove: none } satisfies ResealStatus);
    expect(await unset.json()).toEqual({ version: 2, previousKeySet: false, remaining: revisions, previousKeyMissing: true, cantMove: none } satisfies ResealStatus);
  });

  it("refuses an officer, and writes no audit event", async () => {
    const desk = await rotatedDesk(await seededDesk());
    expect((await status(desk.env, OFFICER)).status).toBe(403);
    const audits = await desk.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'identity_resealed'").first<number>("n");
    expect(audits).toBe(0);
  });
});

describe("POST /api/settings/reseal (infra I1)", () => {
  const reseal = async (env: Env, email: string, body: unknown) =>
    call(onRequestReseal, apiRequest("/api/settings/reseal", { json: body, jwt: await as(email) }), env);

  it("lets a reviewer move every stored identity to the current key, one batch per request", async () => {
    const desk = await rotatedDesk(await seededDesk());
    let body = { after: "" };
    const batches: ResealProgress[] = [];
    for (let i = 0; i < 100; i += 1) {
      const res = await reseal(desk.env, REVIEWER, body);
      expect(res.status).toBe(200);
      const progress = (await res.json()) as ResealProgress;
      batches.push(progress);
      if (progress.next === null) break;
      body = progress.next;
    }
    expect(batches[0]?.moved).toBe(RESEAL_BATCH);
    expect(batches.at(-1)).toMatchObject({ failed: 0, remaining: 0, next: null });
    const left = await desk.db.prepare("SELECT count(*) AS n FROM visit_revisions WHERE identity_sealed NOT LIKE 'v2:%'").first<number>("n");
    expect(left).toBe(0);
  });

  it("refuses an officer, and a cursor it did not issue", async () => {
    const desk = await rotatedDesk(await seededDesk());
    expect((await reseal(desk.env, OFFICER, { after: "" })).status).toBe(403);
    for (const body of [{ after: "nonsense" }, { after: "[\"V-1\",-2]" }, { after: "", extra: 1 }, {}]) {
      expect((await reseal(desk.env, REVIEWER, body)).status, JSON.stringify(body)).toBe(400);
    }
    const audits = await desk.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'identity_resealed'").first<number>("n");
    expect(audits).toBe(0);
  });
});
