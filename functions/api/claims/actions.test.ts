import type { BatchResponse } from "../../../src/api/claim-actions";
import * as claims from "../../../server/repo/claims";
import { importVisits } from "../../../server/services/imports";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../tests/helpers/access";
import { OFFICER, REVIEWER } from "../../../tests/helpers/env";
import { caseVisits, configuredDesk, NOW, OFFICER_ACTOR } from "../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../tests/helpers/http";
import { onRequestPost } from "./actions";

const team = await accessTeam();

/** D01 and the D02 consultations: every ready claim, as the queue showed them. */
async function readyBatch() {
  const desk = await configuredDesk();
  await importVisits(desk.deps, { source: "synthetic", visits: [...caseVisits("D01"), ...caseVisits("D02")] }, OFFICER_ACTOR);
  const ready = (await claims.list(desk.db, { status: ["ready"] }, { now: NOW })).items;
  const post = async (json: unknown, who = REVIEWER) =>
    call(onRequestPost, apiRequest("/api/claims/actions", { json, jwt: await team.sign(accessClaims(who)) }), desk.env);
  return { desk, ready, post };
}

beforeEach(() => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/claims/actions (batch)", () => {
  it("approves the claims still at the version selected and names the one that moved on (AC-3.4, S17)", async () => {
    const { desk, ready, post } = await readyBatch();
    expect(ready.length).toBeGreaterThanOrEqual(3);
    const [moved, ...rest] = ready;
    const items = [{ id: moved!.id, version: moved!.version + 1 }, ...rest.map((c) => ({ id: c.id, version: c.version }))];

    const res = await post({ action: "approve", items });

    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchResponse;
    expect(body.done.map((d) => d.id).sort()).toEqual(rest.map((c) => c.id).sort());
    expect(body.failed).toEqual([{ id: moved!.id, status: 409, error: { error: "stale", currentVersion: moved!.version } }]);
    expect(await claims.detail(desk.db, moved!.id)).toMatchObject({ status: "ready" });
    for (const c of rest) expect(await claims.detail(desk.db, c.id)).toMatchObject({ status: "approved", approvedBy: REVIEWER });
  });

  it("is for reviewers only", async () => {
    const { ready, post } = await readyBatch();

    const res = await post({ action: "approve", items: [{ id: ready[0]!.id, version: ready[0]!.version }] }, OFFICER);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
  });

  it("refuses a batch over 50 claims with 400, naming items", async () => {
    const { post } = await readyBatch();
    const items = Array.from({ length: 51 }, (_, i) => ({ id: `CL-${i}`, version: 1 }));

    const res = await post({ action: "approve", items });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid", issues: [expect.objectContaining({ path: "items" })] });
  });

  it("takes approve and unapprove only", async () => {
    const { ready, post } = await readyBatch();

    const res = await post({ action: "submit", items: [{ id: ready[0]!.id, version: ready[0]!.version }] });

    expect(res.status).toBe(400);
  });
});
