import * as audit from "../../../../../../server/repo/audit";
import { importRemittance } from "../../../../../../server/services/remittances";
import type { RemittanceDetail } from "../../../../../../src/api/remittances";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../../../../tests/helpers/access";
import { OFFICER, STRANGER } from "../../../../../../tests/helpers/env";
import { NOW, OFFICER_ACTOR } from "../../../../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../../../../tests/helpers/http";
import { awaitingPayment, claimOf, force, R1 } from "../../../../../../tests/helpers/payments";
import { onRequestPost } from "./match";

const team = await accessTeam();

/** R1 imported with D05 sent as well, so UNKNOWN-1 (line 4) has a claim a person can match it to. */
async function r1WithD05() {
  const desk = await awaitingPayment();
  await force(desk.db, "SC-D05", "CHAS", "submitted", { portalReference: "MHCP-0005" });
  const imported = await importRemittance(desk.deps, R1, OFFICER_ACTOR);
  if (!imported.ok || imported.value.outcome !== "imported") throw new Error("R1 did not import");
  const remittanceId = imported.value.remittanceId;
  const post = async (n: string, json: unknown, email = OFFICER) =>
    call(onRequestPost, apiRequest(`/api/remittances/${remittanceId}/lines/${n}/match`, { json, jwt: await team.sign(accessClaims(email)) }), desk.env, {
      id: remittanceId,
      n,
    });
  return { desk, remittanceId, post, d05: await claimOf(desk.db, "SC-D05", "CHAS") };
}

beforeEach(() => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/remittances/:id/lines/:n/match", () => {
  it("AC-5.5: matches line 4 to D05 for an officer, pays D05 and audits the match", async () => {
    const { desk, remittanceId, post, d05 } = await r1WithD05();

    const res = await post("4", { claimId: d05.id, expectedVersion: d05.version });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RemittanceDetail;
    expect(body.lines[3]).toMatchObject({ lineNo: 4, match: { kind: "manual", visitKey: "SC-D05" }, note: null });
    expect(await claimOf(desk.db, "SC-D05", "CHAS")).toMatchObject({ status: "paid", paidCents: 9999 });
    const trail = await audit.list(desk.db, { type: "remittance", id: remittanceId });
    expect(trail).toContainEqual(expect.objectContaining({ action: "remittance_line_matched", actor: OFFICER }));
  });

  it("answers 409 stale with the version the server holds when the claim moved on", async () => {
    const { post, d05 } = await r1WithD05();

    const res = await post("4", { claimId: d05.id, expectedVersion: d05.version + 3 });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale", currentVersion: d05.version });
  });

  it("answers 409 not allowed for a line that already paid a claim", async () => {
    const { post, d05 } = await r1WithD05();

    const res = await post("1", { claimId: d05.id, expectedVersion: d05.version });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_allowed" });
  });

  it.each(["0", "6", "abc", "1.5", "01"])("answers 404 for line %s", async (n) => {
    const { post, d05 } = await r1WithD05();

    expect((await post(n, { claimId: d05.id, expectedVersion: d05.version })).status).toBe(404);
  });

  it("answers 400 for a body with a field it does not take", async () => {
    const { post, d05 } = await r1WithD05();

    const res = await post("4", { claimId: d05.id, expectedVersion: d05.version, cents: 1 });

    expect(res.status).toBe(400);
  });

  it("refuses a person on neither role list", async () => {
    const { post, d05 } = await r1WithD05();

    expect((await post("4", { claimId: d05.id, expectedVersion: d05.version }, STRANGER)).status).toBe(403);
  });
});
