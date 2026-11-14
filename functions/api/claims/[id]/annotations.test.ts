import type { ClaimDetail } from "../../../../src/api/claim-detail";
import * as audit from "../../../../server/repo/audit";
import * as claims from "../../../../server/repo/claims";
import { importVisits } from "../../../../server/services/imports";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../../tests/helpers/access";
import { OFFICER } from "../../../../tests/helpers/env";
import { caseVisits, configuredDesk, NOW, OFFICER_ACTOR } from "../../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../../tests/helpers/http";
import { onRequestPut } from "./annotations";

const team = await accessTeam();
const JUSTIFICATION = "Extended consultation for a complex medical history.";

/** D18: a CHAS claim held back by the consultation benchmark until it carries a justification. */
async function d18() {
  const desk = await configuredDesk();
  await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D18") }, OFFICER_ACTOR);
  const claim = (await claims.forVisit(desk.db, "SC-D18")).find((c) => c.scheme === "chas")!;
  const put = async (json: unknown) =>
    call(onRequestPut, apiRequest(`/api/claims/${claim.id}/annotations`, { method: "PUT", json, jwt: await team.sign(accessClaims(OFFICER)) }), desk.env, {
      id: claim.id,
    });
  return { desk, claim, put };
}

beforeEach(() => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PUT /api/claims/:id/annotations", () => {
  it("saves a justification, answers the rebuilt claim, and audits the field name only (AC-2.8)", async () => {
    const { desk, claim, put } = await d18();
    expect(claim.status).toBe("needs_attention");

    const res = await put({ annotations: { justification: JUSTIFICATION }, expectedVersion: claim.version });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ClaimDetail;
    expect(body.claim).toMatchObject({ status: "ready", annotations: { justification: JUSTIFICATION } });
    expect(body.claim.findings.map((f) => f.code)).not.toContain("benchmark_exceeded");
    const trail = await audit.list(desk.db, { type: "claim", id: claim.id });
    expect(JSON.stringify(trail)).not.toContain("complex medical history");
  });

  it("answers 400 naming the field when a reference is too long, without echoing it", async () => {
    const { claim, put } = await d18();
    const long = "R".repeat(81);

    const res = await put({ annotations: { preAuthReference: long }, expectedVersion: claim.version });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: "invalid", issues: [{ path: "preAuthReference" }] });
    expect(text).not.toContain(long);
  });

  it("refuses an annotation the desk does not keep", async () => {
    const { claim, put } = await d18();

    const res = await put({ annotations: { note: "hello" }, expectedVersion: claim.version });

    expect(res.status).toBe(400);
  });

  it("answers 409 stale when the claim moved on", async () => {
    const { claim, put } = await d18();

    const res = await put({ annotations: { justification: JUSTIFICATION }, expectedVersion: claim.version - 1 });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale", currentVersion: claim.version });
  });
});
