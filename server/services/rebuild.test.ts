import { describe, expect, it } from "vitest";
import { REVIEWER } from "../../tests/helpers/env";
import { CLINIC, CONNECTOR_ACTOR, configuredDesk, visitByKey } from "../../tests/helpers/fixtures";
import type { IsoDate } from "../../src/domain/dates";
import { cents } from "../../src/domain/money";
import type { SourceVisit } from "../../src/domain/source-visit";
import type { Actor } from "../../src/domain/types";
import * as audit from "../repo/audit";
import * as claims from "../repo/claims";
import { importVisits } from "./imports";
import { remarks } from "../repo/visits";
import { rebuildVisits } from "./rebuild";
import { saveSettings } from "./settings";

const REVIEWER_ACTOR: Actor = { kind: "person", email: REVIEWER, roles: ["reviewer"] };

/**
 * D27 with a Meridian yearly limit of $400: CHAS pays $584.50 of the $872 root canal and Meridian
 * the $287.50 left. One such claim fits the limit; two in a year pass it, which warns (decisions-g2 #8).
 */
const d27 = (): SourceVisit => {
  const v = visitByKey("SC-D27");
  return { ...v, policies: v.policies.map((p) => ({ ...p, limitCents: cents(40000) })) };
};

/** An earlier visit by the same patient for the same treatment, on `date`, completed on `completedOn`. */
const earlier = (visitKey: string, date: string, completedOn: string): SourceVisit => {
  const v = d27();
  return { ...v, visitKey, date: date as IsoDate, treatments: v.treatments.map((t) => ({ ...t, completedOn: completedOn as IsoDate })) };
};

async function meridian(db: D1Database, visitKey: string) {
  return (await claims.forVisit(db, visitKey)).find((c) => c.payerId === "MERIDIAN");
}

/** Whether the visit's Meridian claim carries the yearly-limit warning. */
async function overLimit(db: D1Database, visitKey: string): Promise<boolean> {
  return (await meridian(db, visitKey))!.findings.some((f) => f.code === "insurance_annual_limit_exceeded");
}

describe("the history a rebuild reads", () => {
  it("counts an earlier claim on the policy against this year's limit", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [earlier("SC-X1", "2026-03-02", "2026-03-02")] }, CONNECTOR_ACTOR);

    await importVisits(deps, { source: "connector", visits: [d27()] }, CONNECTOR_ACTOR);

    expect(await meridian(db, "SC-D27")).toMatchObject({ claimedCents: 28750, status: "ready" });
    expect(await overLimit(db, "SC-D27")).toBe(true);
  });

  it("counts a December visit completed in January in January's year", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [earlier("SC-X1", "2025-12-20", "2026-01-05")] }, CONNECTOR_ACTOR);

    await importVisits(deps, { source: "connector", visits: [d27()] }, CONNECTOR_ACTOR);

    expect(await overLimit(db, "SC-D27")).toBe(true);
  });

  it("does not count a December visit completed in December against the next year", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [earlier("SC-X1", "2025-12-20", "2025-12-20")] }, CONNECTOR_ACTOR);

    await importVisits(deps, { source: "connector", visits: [d27()] }, CONNECTOR_ACTOR);

    expect(await overLimit(db, "SC-D27")).toBe(false);
  });
});

/** Moves a visit's Meridian claim straight to submitted, standing in for the submission flow of a later ticket. */
async function submitMeridian(db: D1Database, visitKey: string) {
  const c = (await meridian(db, visitKey))!;
  await claims
    .transitionStatement(db, c.id, c.version, crypto.randomUUID(), {
      status: "submitted",
      updatedAt: "2026-11-13T02:00:00.000Z",
      submittedRevision: c.builtFromRevision,
      channel: "assisted",
    })
    .run();
}

/** Moves one of a visit's claims straight to submitted, standing in for the submission flow. */
async function submitClaim(db: D1Database, visitKey: string, payerId: string) {
  const c = (await claims.forVisit(db, visitKey)).find((x) => x.payerId === payerId)!;
  await claims
    .transitionStatement(db, c.id, c.version, crypto.randomUUID(), {
      status: "submitted",
      updatedAt: "2026-11-13T02:00:00.000Z",
      submittedRevision: c.builtFromRevision,
      channel: "assisted",
    })
    .run();
}

describe("a waterfall reorder after a lower payer's claim was sent (QA 03 D01)", () => {
  it("keeps the sent amounts, leaves Meridian what they left, and warns before it goes", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D04b")] }, CONNECTOR_ACTOR);
    await submitClaim(db, "SC-D04b", "CHAS");
    await submitClaim(db, "SC-D04b", "MEDISAVE_FLEXI");
    const insuranceFirst = { ...CLINIC.settings, waterfall: ["chas", "insurance", "medisave"] as typeof CLINIC.settings.waterfall };

    expect(await saveSettings(deps, insuranceFirst, 1, REVIEWER_ACTOR)).toMatchObject({ kind: "saved" });

    const after = await claims.forVisit(db, "SC-D04b");
    const amount = (payerId: string) => after.find((c) => c.payerId === payerId)!.claimedCents;
    expect([amount("CHAS"), amount("MEDISAVE_FLEXI"), amount("MERIDIAN")]).toEqual([62000, 40000, 28800]);
    expect(after.reduce((s, c) => s + c.claimedCents, 0)).toBeLessThanOrEqual(130800);
    const m = after.find((c) => c.payerId === "MERIDIAN")!;
    expect(m.findings).toContainEqual(expect.objectContaining({ code: "lower_payer_sent_first", severity: "warning", params: { scheme: "medisave_flexi" } }));
  });
});

describe("a rebuild after CHAS rejected the visit's claim (technical F5)", () => {
  it("warns on Meridian that its amount was based on CHAS, keeps it, and does not recreate the CHAS claim", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D27")] }, CONNECTOR_ACTOR);
    const chas = (await claims.forVisit(db, "SC-D27")).find((c) => c.payerId === "CHAS")!;
    await claims.transitionStatement(db, chas.id, chas.version, crypto.randomUUID(), { status: "rejected", updatedAt: "2026-11-13T02:00:00.000Z" }).run();

    await rebuildVisits(deps, ["SC-D27"], CONNECTOR_ACTOR, "settings");

    const after = await claims.forVisit(db, "SC-D27");
    expect(after.filter((c) => c.payerId === "CHAS").map((c) => c.status)).toEqual(["rejected"]);
    const m = after.find((c) => c.payerId === "MERIDIAN")!;
    expect(m).toMatchObject({ claimedCents: 28750, status: "ready" });
    expect(m.findings).toContainEqual(expect.objectContaining({ code: "upstream_rejected", severity: "warning", params: { scheme: "chas" } }));
  });
});

describe("importing a visit earlier than ones already built", () => {
  it("rebuilds the later visit's unsent claims against the new history", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [d27()] }, CONNECTOR_ACTOR);
    expect(await overLimit(db, "SC-D27")).toBe(false);

    await importVisits(deps, { source: "connector", visits: [earlier("SC-X1", "2026-03-02", "2026-03-02")] }, CONNECTOR_ACTOR);

    const later = await meridian(db, "SC-D27");
    expect(later).toMatchObject({ claimedCents: 28750, findings: expect.arrayContaining([expect.objectContaining({ code: "insurance_annual_limit_exceeded" })]) });
    const trail = await audit.list(db, { type: "claim", id: later!.id });
    expect(trail.at(-1)).toMatchObject({ detail: { reason: "import" } });
  });

  it("leaves a later claim already sent as it was, unflagged", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [d27()] }, CONNECTOR_ACTOR);
    await submitMeridian(db, "SC-D27");

    const summary = await importVisits(deps, { source: "connector", visits: [earlier("SC-X1", "2026-03-02", "2026-03-02")] }, CONNECTOR_ACTOR);

    expect(summary).toMatchObject({ new: 1, flagged: 0 });
    expect(await meridian(db, "SC-D27")).toMatchObject({ status: "submitted", claimedCents: 28750, changedAfterSubmission: false });
    expect(await overLimit(db, "SC-D27")).toBe(false);
  });

  it("leaves a later visit alone when the new one is outside every limit's reach", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [d27()] }, CONNECTOR_ACTOR);
    const before = await meridian(db, "SC-D27");

    await importVisits(deps, { source: "connector", visits: [earlier("SC-X1", "2022-03-02", "2022-03-02")] }, CONNECTOR_ACTOR);

    expect(await meridian(db, "SC-D27")).toEqual(before);
  });
});

describe("the order a rebuild takes a patient's visits in (technical §6)", () => {
  it("rebuilds an earlier visit before a later one whose visit key sorts first, so the later reads the new amount", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [earlier("SC-Z1", "2026-11-01", "2026-11-01"), earlier("SC-A1", "2026-11-07", "2026-11-07")] }, CONNECTOR_ACTOR);
    expect(await overLimit(db, "SC-A1")).toBe(true);
    const halfCopay = { ...CLINIC.settings, payers: CLINIC.settings.payers.map((p) => (p.id === "MERIDIAN" ? { ...p, copayPercent: 50 } : p)) };

    const saved = await saveSettings(deps, halfCopay, 1, REVIEWER_ACTOR);

    expect(saved).toMatchObject({ kind: "saved", body: { rebuild: { next: null } } });
    expect(await meridian(db, "SC-Z1")).toMatchObject({ claimedCents: 14375 });
    expect(await meridian(db, "SC-A1")).toMatchObject({ claimedCents: 14375 });
    expect(await overLimit(db, "SC-A1")).toBe(false);
  });

  it("rebuilds the visits a re-imported visit moved past when its date moves later", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [earlier("SC-X1", "2026-11-01", "2026-11-01"), earlier("SC-X2", "2026-11-07", "2026-11-07")] }, CONNECTOR_ACTOR);
    expect(await overLimit(db, "SC-X2")).toBe(true);

    await importVisits(deps, { source: "connector", visits: [earlier("SC-X1", "2026-11-10", "2026-11-10")] }, CONNECTOR_ACTOR);

    expect(await overLimit(db, "SC-X2")).toBe(false);
    expect(await overLimit(db, "SC-X1")).toBe(true);
  });
});

describe("what the build says about the visit", () => {
  it("keeps the remarks of a visit that has no claim, so the desk can still say why (UAT 4.10)", async () => {
    const { db, deps } = await configuredDesk();

    await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D24")] }, CONNECTOR_ACTOR);

    expect(await claims.forVisit(db, "SC-D24")).toEqual([]);
    expect((await remarks(db, "SC-D24"))!.findings).toContainEqual(expect.objectContaining({ code: "pa_patient_balance", severity: "warning" }));
  });

  it("writes nothing when the visit's remarks and claims are unchanged", async () => {
    const { deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D05")] }, CONNECTOR_ACTOR);

    const counts = await rebuildVisits(deps, ["SC-D05"], CONNECTOR_ACTOR, "settings");

    expect(counts).toEqual({ rebuilt: 0, flagged: 0 });
  });
});
