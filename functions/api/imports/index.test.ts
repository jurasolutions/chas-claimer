import type { ImportListResponse, ImportSummary } from "../../../src/api/imports";
import { nricCheckLetter } from "../../../src/domain/nric";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../tests/helpers/access";
import { OFFICER, REVIEWER, STRANGER, TEST_CONNECTOR_TOKEN } from "../../../tests/helpers/env";
import { CLINIC, configuredDesk, visitByKey } from "../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../tests/helpers/http";
import { onRequestGet, onRequestPost } from "./index";

const team = await accessTeam();
const OUTSIDE_BLOCK = `T8999999${nricCheckLetter("T", "8999999")}`;
const bearer = { Authorization: `Bearer ${TEST_CONNECTOR_TOKEN}` };
const connectorPost = (json: unknown, headers: Record<string, string> = bearer) => apiRequest("/api/imports", { json, origin: null, headers });

describe("POST /api/imports (the connector)", () => {
  it("imports the clinic's visits and reports what changed, then the same batch again as unchanged", async () => {
    const { env } = await configuredDesk();
    const visits = CLINIC.visits.slice(0, 20);

    const first = await call(onRequestPost, connectorPost({ visits }), env);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ received: 20, new: 20, changed: 0, unchanged: 0, refused: 0 } satisfies Partial<ImportSummary>);

    const again = await call(onRequestPost, connectorPost({ visits }), env);
    expect(await again.json()).toMatchObject({ received: 20, new: 0, changed: 0, unchanged: 20 } satisfies Partial<ImportSummary>);
  });

  it("refuses an NRIC outside the synthetic block with 422, naming positions and never the value", async () => {
    const { env } = await configuredDesk();
    const real = { ...visitByKey("SC-D15"), patient: { ...visitByKey("SC-D15").patient, nric: OUTSIDE_BLOCK } };

    const res = await call(onRequestPost, connectorPost({ visits: [visitByKey("SC-D01"), real] }), env);

    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).not.toContain(OUTSIDE_BLOCK);
    expect(text).not.toContain(OUTSIDE_BLOCK.slice(1, 8));
    expect(JSON.parse(text)).toMatchObject({ error: "real_identifier_refused", indexes: [1] });
  });

  it("refuses more than 100 visits as too large", async () => {
    const { env } = await configuredDesk();
    const visits = Array.from({ length: 101 }, (_, i) => CLINIC.visits[i % CLINIC.visits.length]);

    const res = await call(onRequestPost, connectorPost({ visits }), env);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
  });

  it("refuses a body that is not a visits envelope with the path that failed", async () => {
    const { env } = await configuredDesk();

    const res = await call(onRequestPost, connectorPost({ visit: [] }), env);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid", issues: [{ path: "visits" }] });
  });

  it("refuses a request without the connector token, and a signed-in officer is not the connector", async () => {
    const { env } = await configuredDesk();
    stubAccessCerts(team);

    const none = await call(onRequestPost, connectorPost({ visits: [] }, {}), env);
    const officer = await call(
      onRequestPost,
      apiRequest("/api/imports", { json: { visits: [] }, jwt: await team.sign(accessClaims(OFFICER)) }),
      env,
    );

    expect(none.status).toBe(401);
    expect(officer.status).toBe(401);
  });
});

describe("GET /api/imports", () => {
  it("lists recent imports newest first with their counts, for an officer or a reviewer", async () => {
    const { env } = await configuredDesk();
    await call(onRequestPost, connectorPost({ visits: CLINIC.visits.slice(0, 3) }), env);
    await call(onRequestPost, connectorPost({ visits: CLINIC.visits.slice(0, 4) }), env);
    stubAccessCerts(team);

    for (const who of [OFFICER, REVIEWER]) {
      const res = await call(onRequestGet, apiRequest("/api/imports", { jwt: await team.sign(accessClaims(who)) }), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ImportListResponse;
      expect(body.items).toHaveLength(2);
      expect(body.items[0]).toMatchObject({ source: "connector", actor: "system:connector", received: 4, new: 1, unchanged: 3, ignored: 0, refused: 0 });
      expect(body.items[1]).toMatchObject({ received: 3, new: 3 });
      expect(body.items[0]!.finishedAt).not.toBeNull();
    }
  });

  it("refuses someone on neither role list", async () => {
    const { env } = await configuredDesk();
    stubAccessCerts(team);

    const res = await call(onRequestGet, apiRequest("/api/imports", { jwt: await team.sign(accessClaims(STRANGER)) }), env);

    expect(res.status).toBe(403);
  });
});
