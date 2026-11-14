import * as audit from "../../../../server/repo/audit";
import * as claims from "../../../../server/repo/claims";
import { importVisits } from "../../../../server/services/imports";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../../tests/helpers/access";
import { OFFICER, REVIEWER, STRANGER } from "../../../../tests/helpers/env";
import { caseVisits, configuredDesk, NOW, OFFICER_ACTOR, visitByKey } from "../../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../../tests/helpers/http";
import { onRequestPost } from "./reveal";

const team = await accessTeam();

async function d01() {
  const desk = await configuredDesk();
  await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D01") }, OFFICER_ACTOR);
  const claim = (await claims.forVisit(desk.db, "SC-D01")).find((c) => c.scheme === "chas")!;
  const post = async (json: unknown, who = OFFICER) =>
    call(onRequestPost, apiRequest(`/api/claims/${claim.id}/reveal`, { json, jwt: await team.sign(accessClaims(who)) }), desk.env, { id: claim.id });
  return { desk, claim, post };
}

beforeEach(() => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/claims/:id/reveal (S11)", () => {
  it("answers the field to an officer once the reveal is on the trail, naming the field and not the value", async () => {
    const { desk, claim, post } = await d01();
    const nric = visitByKey("SC-D01").patient.nric;

    const res = await post({ field: "nric" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: nric });
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
    const last = (await audit.list(desk.db, { type: "claim", id: claim.id })).at(-1);
    expect(last).toMatchObject({ action: "revealed", actor: OFFICER, detail: { field: "nric" } });
    expect(JSON.stringify(last)).not.toContain(nric);
  });

  it("answers a reviewer too", async () => {
    const { post } = await d01();

    const res = await post({ field: "name" }, REVIEWER);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: visitByKey("SC-D01").patient.name });
  });

  it("answers 500 and no value when the reveal cannot be recorded", async () => {
    const { desk, post } = await d01();
    await desk.db.prepare("CREATE TRIGGER audit_down BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit down'); END").run();

    const res = await post({ field: "nric" });

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(visitByKey("SC-D01").patient.nric);
  });

  it("answers 400 for a field the visit has no value for, and for a field that is not an identity field", async () => {
    const { post } = await d01();

    expect((await post({ field: "account_holder_nric" })).status).toBe(400);
    expect((await post({ field: "diagnosis" })).status).toBe(400);
  });

  it("refuses a signed-in person on neither role list", async () => {
    const { post } = await d01();

    expect((await post({ field: "nric" }, STRANGER)).status).toBe(403);
  });
});
