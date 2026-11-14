import * as claims from "../../../../server/repo/claims";
import { act, claimDetail } from "../../../../server/services/claims";
import { importVisits } from "../../../../server/services/imports";
import type { PacketView } from "../../../../src/api/submissions";
import type { Actor } from "../../../../src/domain/types";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../../tests/helpers/access";
import { OFFICER, REVIEWER } from "../../../../tests/helpers/env";
import { caseVisits, configuredDesk, NOW, OFFICER_ACTOR } from "../../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../../tests/helpers/http";
import { onRequestPost } from "./checkout";

const team = await accessTeam();
const OTHER_OFFICER = "second.officer@example.test";
const REVIEWER_ACTOR: Actor = { kind: "person", email: REVIEWER, roles: ["reviewer", "officer"] };

beforeEach(() => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

async function approvedChas() {
  const desk = await configuredDesk({ ROLE_OFFICERS: `${OFFICER},${OTHER_OFFICER}` });
  await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D01") }, OFFICER_ACTOR);
  const built = (await claims.forVisit(desk.db, "SC-D01")).find((c) => c.scheme === "chas")!;
  const approved = await act(desk.deps, built.id, { kind: "approve" }, built.version, REVIEWER_ACTOR);
  if (!approved.ok) throw new Error(`approve failed: ${approved.error.code}`);
  const post = async (json: unknown, who: string) =>
    call(onRequestPost, apiRequest(`/api/claims/${built.id}/checkout`, { json, jwt: await team.sign(accessClaims(who)) }), desk.env, { id: built.id });
  return { desk, claim: approved.value, post };
}

describe("POST /api/claims/:id/checkout", () => {
  it("holds an approved claim's checklist for the officer who opens it", async () => {
    const { post } = await approvedChas();

    const res = await post({}, OFFICER);

    expect(res.status).toBe(200);
    const view = (await res.json()) as PacketView;
    expect(view.checkout).toEqual({ by: OFFICER, until: new Date(NOW + 30 * 60_000).toISOString() });
    expect(view.fields.length).toBeGreaterThan(0);
  });

  it("AC-4.8: tells a second officer who holds it, and lets them take over only when they confirm", async () => {
    const { desk, claim, post } = await approvedChas();
    await post({}, OFFICER);

    const refused = await post({}, OTHER_OFFICER);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "checked_out", by: OFFICER });

    const taken = await post({ takeOver: true }, OTHER_OFFICER);
    expect(taken.status).toBe(200);
    expect(((await taken.json()) as PacketView).checkout?.by).toBe(OTHER_OFFICER);

    const detail = await claimDetail(desk.deps, claim.id, OFFICER_ACTOR);
    const event = detail!.audit.find((e) => e.action === "checkout_taken_over");
    expect(event).toMatchObject({ actor: OTHER_OFFICER, detail: { from: OFFICER } });
  });

  // QA defect D09 (qa-01.md): opening your own checklist again (a second tab, or a reload) must not bump
  // the claim's version, or the first tab's "Submitted with portal reference" is refused as stale.
  it("lets the officer who holds the checklist open it again without moving the claim on", async () => {
    const { post } = await approvedChas();
    const first = (await (await post({}, OFFICER)).json()) as PacketView;

    const again = await post({}, OFFICER);

    expect(again.status).toBe(200);
    expect(((await again.json()) as PacketView).version).toBe(first.version);
  });

  it("D17: opening your own checklist again extends the hold without logging another checkout", async () => {
    const { desk, claim, post } = await approvedChas();
    await post({}, OFFICER);
    vi.setSystemTime(NOW + 10 * 60_000);

    const again = (await (await post({}, OFFICER)).json()) as PacketView;

    expect(again.checkout).toEqual({ by: OFFICER, until: new Date(NOW + 40 * 60_000).toISOString() });
    const detail = await claimDetail(desk.deps, claim.id, OFFICER_ACTOR);
    expect(detail!.audit.filter((e) => e.action === "checkout")).toHaveLength(1);
  });

  it("refuses a claim that is not approved, and a body that is not the shape it takes", async () => {
    const desk = await configuredDesk();
    await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D01") }, OFFICER_ACTOR);
    const ready = (await claims.forVisit(desk.db, "SC-D01")).find((c) => c.scheme === "chas")!;
    const post = async (json: unknown) =>
      call(onRequestPost, apiRequest(`/api/claims/${ready.id}/checkout`, { json, jwt: await team.sign(accessClaims(OFFICER)) }), desk.env, { id: ready.id });

    expect((await post({})).status).toBe(409);
    expect((await post({ takeOver: "yes" })).status).toBe(400);
  });
});
