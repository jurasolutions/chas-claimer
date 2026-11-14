import type { Env } from "../../../../server/env";
import { importRemittance } from "../../../../server/services/remittances";
import type { RemittanceDetail } from "../../../../src/api/remittances";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../../tests/helpers/access";
import { OFFICER, STRANGER } from "../../../../tests/helpers/env";
import { NOW, OFFICER_ACTOR } from "../../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../../tests/helpers/http";
import { awaitingPayment, R1 } from "../../../../tests/helpers/payments";
import { onRequestGet } from "./index";

const team = await accessTeam();

async function r1Imported() {
  const desk = await awaitingPayment();
  const imported = await importRemittance(desk.deps, R1, OFFICER_ACTOR);
  if (!imported.ok || imported.value.outcome !== "imported") throw new Error("R1 did not import");
  return { desk, remittanceId: imported.value.remittanceId };
}

async function get(env: Env, id: string, email = OFFICER) {
  return call(onRequestGet, apiRequest(`/api/remittances/${id}`, { jwt: await team.sign(accessClaims(email)) }), env, { id });
}

beforeEach(() => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/remittances/:id", () => {
  it("answers R1's lines with the claim each paid and why the rest wait, without an identifier", async () => {
    const { desk, remittanceId } = await r1Imported();

    const res = await get(desk.env, remittanceId);

    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as RemittanceDetail;
    expect(body.remittance).toMatchObject({ id: remittanceId, payerId: "CHAS", fileName: "r1-chas.csv", lines: 5, matched: 3 });
    expect(body.lines.map((l) => [l.lineNo, l.match?.visitKey ?? null, l.note?.kind ?? null])).toEqual([
      [1, "SC-D01", null],
      [2, "SC-D03", null],
      [3, "SC-D02-P04", null],
      [4, null, "no_claim"],
      [5, null, "closed"],
    ]);
    expect(body.lines[4]!.note).toMatchObject({ kind: "closed", visitKey: "SC-D01", status: "paid" });
    expect(text).not.toMatch(/[STFGM]\d{7}[A-Z]/);
    expect(text).not.toContain("patientHash");
  });

  it("answers 404 for a statement the desk does not have", async () => {
    const { desk } = await r1Imported();

    const res = await get(desk.env, "no-such-statement");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("refuses a person on neither role list", async () => {
    const { desk, remittanceId } = await r1Imported();

    expect((await get(desk.env, remittanceId, STRANGER)).status).toBe(403);
  });
});
