import type { CodeMapResponse } from "../../../src/api/settings";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../tests/helpers/access";
import { OFFICER, STRANGER } from "../../../tests/helpers/env";
import { CLINIC, NOW, seededDesk } from "../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../tests/helpers/http";
import { onRequestGet } from "./index";

const team = await accessTeam();

beforeEach(() => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

const as = async (email: string) => team.sign(accessClaims(email));

describe("GET /api/code-map", () => {
  it("lets an officer read the map and the clinic codes current visits carry that nothing maps", async () => {
    const desk = await seededDesk();

    const res = await call(onRequestGet, apiRequest("/api/code-map", { jwt: await as(OFFICER) }), desk.env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as CodeMapResponse;
    expect(body.items).toHaveLength(CLINIC.codeMap.length);
    expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({ clinicCode: CLINIC.codeMap[0]!.clinicCode })]));
    expect(body.unmapped).toEqual([{ clinicCode: "NEW-99", description: "Laser gum contouring", visits: 1 }]);
  });

  it("refuses a caller with no role", async () => {
    const desk = await seededDesk();
    const res = await call(onRequestGet, apiRequest("/api/code-map", { jwt: await as(STRANGER) }), desk.env);
    expect(res.status).toBe(403);
  });
});
