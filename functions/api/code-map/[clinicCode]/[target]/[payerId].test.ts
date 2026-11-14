import type { Env } from "../../../../../server/env";
import * as audit from "../../../../../server/repo/audit";
import * as claims from "../../../../../server/repo/claims";
import type { CodeMapResponse, CodeMapSaveResponse } from "../../../../../src/api/settings";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../../../tests/helpers/access";
import { OFFICER, REVIEWER } from "../../../../../tests/helpers/env";
import { NOW, seededDesk } from "../../../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../../../tests/helpers/http";
import { onRequestGet } from "../../index";
import { onRequestDelete, onRequestPut } from "./[payerId]";

const team = await accessTeam();

beforeEach(() => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

const as = async (email: string) => team.sign(accessClaims(email));

type Key = { clinicCode: string; target: string; payerId: string };
const NEW99_CHAS: Key = { clinicCode: "NEW-99", target: "chas", payerId: "-" };
const pathOf = (k: Key) => `/api/code-map/${k.clinicCode}/${k.target}/${k.payerId}`;

const put = async (env: Env, email: string, key: Key, body: unknown) =>
  call(onRequestPut, apiRequest(pathOf(key), { method: "PUT", json: body, jwt: await as(email) }), env, key);
const del = async (env: Env, email: string, key: Key) =>
  call(onRequestDelete, apiRequest(pathOf(key), { method: "DELETE", json: {}, jwt: await as(email) }), env, key);

const findingCodes = async (db: D1Database, visitKey: string) => (await claims.forVisit(db, visitKey)).flatMap((c) => c.findings.map((f) => f.code));
const unmapped = async (env: Env) =>
  ((await (await call(onRequestGet, apiRequest("/api/code-map", { jwt: await as(OFFICER) }), env)).json()) as CodeMapResponse).unmapped;

describe("PUT /api/code-map/:clinicCode/:target/:payerId", () => {
  it("a reviewer maps the unmapped code; its visit rebuilds without the unmapped finding and the trail records who", async () => {
    const desk = await seededDesk();
    expect(await findingCodes(desk.db, "SC-D20")).toContain("unmapped_treatment");

    const res = await put(desk.env, REVIEWER, NEW99_CHAS, { targetCode: null, origin: "manual" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as CodeMapSaveResponse;
    expect(body.entry).toEqual({ clinicCode: "NEW-99", target: "chas", payerId: "", targetCode: null, origin: "manual", updatedBy: REVIEWER, updatedAt: new Date(NOW).toISOString() });
    expect(body.rebuild).toMatchObject({ considered: 1, remaining: 0, next: null });
    expect(await findingCodes(desk.db, "SC-D20")).not.toContain("unmapped_treatment");
    expect(await unmapped(desk.env)).toEqual([]);
    expect(await audit.list(desk.db, { type: "code_map", id: "NEW-99/chas/-" })).toEqual([
      expect.objectContaining({ actor: REVIEWER, action: "code_map_saved", detail: { targetCode: null, origin: "manual", previous: null } }),
    ]);
  });

  it("corrects an entry already on file: the trail keeps the code it replaced and the visits rebuild", async () => {
    const desk = await seededDesk();
    const key: Key = { clinicCode: "NEW-99", target: "benefit", payerId: "MERIDIAN" };
    await put(desk.env, REVIEWER, key, { targetCode: "PERIO-2", origin: "manual" });

    const res = await put(desk.env, REVIEWER, key, { targetCode: "PERIO-3", origin: "manual" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as CodeMapSaveResponse;
    expect(body.entry.targetCode).toBe("PERIO-3");
    expect(body.rebuild).toMatchObject({ considered: 1, next: null });
    expect((await audit.list(desk.db, { type: "code_map", id: "NEW-99/benefit/MERIDIAN" })).at(-1)).toMatchObject({
      action: "code_map_saved",
      detail: { targetCode: "PERIO-3", origin: "manual", previous: "PERIO-2" },
    });
  });

  it("records an accepted AI suggestion as such", async () => {
    const desk = await seededDesk();

    const res = await put(desk.env, REVIEWER, { clinicCode: "NEW-99", target: "benefit", payerId: "MERIDIAN" }, { targetCode: "PERIO-2", origin: "ai_accepted" });

    expect(res.status).toBe(200);
    expect((await audit.list(desk.db, { type: "code_map", id: "NEW-99/benefit/MERIDIAN" })).map((e) => e.action)).toEqual(["code_map_saved", "ai_suggestion_accepted"]);
  });

  it("refuses a key that cannot exist: an unknown target, a payer on a CHAS or TOSP entry, a benefit without an insurer", async () => {
    const desk = await seededDesk();
    const bad: Key[] = [
      { clinicCode: "NEW-99", target: "flexi", payerId: "-" },
      { clinicCode: "NEW-99", target: "chas", payerId: "MERIDIAN" },
      { clinicCode: "NEW-99", target: "tosp", payerId: "MERIDIAN" },
      { clinicCode: "NEW-99", target: "benefit", payerId: "-" },
      { clinicCode: "NEW-99", target: "benefit", payerId: "CHAS" },
      { clinicCode: "NEW-99", target: "benefit", payerId: "NO-SUCH-PAYER" },
    ];

    for (const key of bad) {
      const res = await put(desk.env, REVIEWER, key, { targetCode: "X1", origin: "manual" });
      expect(res.status, JSON.stringify(key)).toBe(400);
    }
    expect(await unmapped(desk.env)).toHaveLength(1);
  });

  it("decodes a clinic code the path carries percent-encoded, and judges its length decoded", async () => {
    const desk = await seededDesk();
    const spaced = "XR/OPG 1";
    const long = " ".repeat(64);

    for (const clinicCode of [spaced, long]) {
      const res = await put(desk.env, REVIEWER, { ...NEW99_CHAS, clinicCode: encodeURIComponent(clinicCode) }, { targetCode: null, origin: "manual" });
      expect(res.status, clinicCode).toBe(200);
      expect(((await res.json()) as CodeMapSaveResponse).entry.clinicCode).toBe(clinicCode);
    }
    const tooLong = await put(desk.env, REVIEWER, { ...NEW99_CHAS, clinicCode: encodeURIComponent("x".repeat(65)) }, { targetCode: null, origin: "manual" });
    expect(tooLong.status).toBe(400);
  });

  it("refuses a clinic code whose percent-encoding is broken", async () => {
    const desk = await seededDesk();

    const res = await put(desk.env, REVIEWER, { ...NEW99_CHAS, clinicCode: "XR%2" }, { targetCode: null, origin: "manual" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid", issues: [{ path: "clinicCode" }] });
  });

  it("refuses a CHAS target code no rule set knows, and a malformed body", async () => {
    const desk = await seededDesk();

    const unknown = await put(desk.env, REVIEWER, NEW99_CHAS, { targetCode: "NOT-A-CODE", origin: "manual" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "invalid", issues: [expect.objectContaining({ path: "targetCode" })] });
    const extra = await put(desk.env, REVIEWER, NEW99_CHAS, { targetCode: null, origin: "manual", note: "x" });
    expect(extra.status).toBe(400);
  });

  it("lets an officer read the map but not change it", async () => {
    const desk = await seededDesk();
    expect((await put(desk.env, OFFICER, NEW99_CHAS, { targetCode: null, origin: "manual" })).status).toBe(403);
    expect((await del(desk.env, OFFICER, NEW99_CHAS)).status).toBe(403);
  });
});

describe("DELETE /api/code-map/:clinicCode/:target/:payerId", () => {
  it("removes an entry, audits it and rebuilds the visits carrying the code", async () => {
    const desk = await seededDesk();
    await put(desk.env, REVIEWER, NEW99_CHAS, { targetCode: null, origin: "manual" });

    const res = await del(desk.env, REVIEWER, NEW99_CHAS);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { rebuild: unknown }).rebuild).toMatchObject({ considered: 1, next: null });
    expect(await findingCodes(desk.db, "SC-D20")).toContain("unmapped_treatment");
    expect((await audit.list(desk.db, { type: "code_map", id: "NEW-99/chas/-" })).at(-1)).toMatchObject({
      actor: REVIEWER,
      action: "code_map_saved",
      detail: { targetCode: null, origin: null, previous: null, deleted: true },
    });
  });

  it("answers 404 for an entry that is not there", async () => {
    const desk = await seededDesk();
    expect((await del(desk.env, REVIEWER, NEW99_CHAS)).status).toBe(404);
  });
});
