import type { ClaimDetail } from "../../../../src/api/claim-detail";
import * as claims from "../../../../server/repo/claims";
import { importVisits } from "../../../../server/services/imports";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../../tests/helpers/access";
import { OFFICER, REVIEWER } from "../../../../tests/helpers/env";
import { caseVisits, configuredDesk, NOW, OFFICER_ACTOR } from "../../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../../tests/helpers/http";
import { onRequestPost } from "./actions";

const team = await accessTeam();

async function d01() {
  const desk = await configuredDesk();
  await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D01") }, OFFICER_ACTOR);
  const claim = (await claims.forVisit(desk.db, "SC-D01")).find((c) => c.scheme === "chas")!;
  const post = async (json: unknown, who = REVIEWER, origin?: string) =>
    call(onRequestPost, apiRequest(`/api/claims/${claim.id}/actions`, { json, origin, jwt: await team.sign(accessClaims(who)) }), desk.env, {
      id: claim.id,
    });
  return { desk, claim, post };
}

beforeEach(() => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/claims/:id/actions", () => {
  it("approves a ready claim for a reviewer and answers the claim as it now stands (AC-3.1)", async () => {
    const { claim, post } = await d01();

    const res = await post({ action: { kind: "approve" }, expectedVersion: claim.version });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ClaimDetail;
    expect(body.claim).toMatchObject({ id: claim.id, status: "approved", approvedBy: REVIEWER });
    expect(body.claim.version).toBeGreaterThan(claim.version);
    expect(body.audit.map((e) => e.action)).toEqual(["built", "approve"]);
  });

  it("refuses approval from an officer with 403 forbidden (SC4.3)", async () => {
    const { claim, post } = await d01();

    const res = await post({ action: { kind: "approve" }, expectedVersion: claim.version }, OFFICER);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
  });

  it("answers 409 stale with the version the server holds", async () => {
    const { claim, post } = await d01();

    const res = await post({ action: { kind: "approve" }, expectedVersion: claim.version + 7 });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale", currentVersion: claim.version });
  });

  it("answers 409 not_allowed for an action the claim's status does not take", async () => {
    const { claim, post } = await d01();

    const res = await post({ action: { kind: "reopen" }, expectedVersion: claim.version });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_allowed" });
  });

  it("answers 400 naming the path of a bad field, without echoing the value", async () => {
    const { claim, post } = await d01();

    const res = await post({ action: { kind: "record_payment", cents: 100, paidOn: "SECRET-DATE" }, expectedVersion: claim.version });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: "invalid", issues: [expect.objectContaining({ path: "action.paidOn" })] });
    expect(text).not.toContain("SECRET-DATE");
  });

  it("refuses a request from another origin", async () => {
    const { claim, post } = await d01();

    const res = await post({ action: { kind: "approve" }, expectedVersion: claim.version }, REVIEWER, "https://elsewhere.example");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "foreign_origin" });
  });
});
