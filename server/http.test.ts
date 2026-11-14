import { nricCheckLetter, parseNric } from "../src/domain/nric";
import { err, ok } from "../src/domain/result";
import { accessClaims, accessTeam, stubAccessCerts } from "../tests/helpers/access";
import { DEV_IDENTIFIER_KEY, OFFICER, REVIEWER, TEST_CONNECTOR_TOKEN, TEST_IDENTIFIER_KEY, testEnv } from "../tests/helpers/env";
import { apiRequest, call } from "../tests/helpers/http";
import { patientHash } from "./crypto";
import { json, readJson, route } from "./http";
import { RealIdentifierRefusedError } from "./services/imports";

const team = await accessTeam();

const parseNote = (u: unknown) =>
  typeof u === "object" && u !== null && typeof (u as { note?: unknown }).note === "string"
    ? ok({ note: (u as { note: string }).note })
    : err([{ path: "note", message: "A note is required." }]);

/** A stand-in for a real route: echoes the note back and who sent it. */
const echo = route({ auth: "access", maxBytes: 64 }, async ({ request, actor }) => {
  const body = await readJson(request, parseNote, 64);
  if (!body.ok) return body.error;
  return json({ note: body.value.note, actor });
});
const reviewersOnly = route({ auth: "access", roles: ["reviewer"] }, async () => json({ done: true }));
const broken = route<{ id: string }>({ auth: "access" }, async () => {
  throw new Error("boom, with a secret value 000-patient");
});
const refusesIdentifier = route({ auth: "access" }, async () => {
  throw new RealIdentifierRefusedError("imp-9", [0, 3]);
});
const fromConnector = route({ auth: "connector" }, async ({ actor }) => json({ actor }));
const demoOnly = route({ enabled: (env) => env.DEMO_MODE === "yes", auth: "access" }, async () => json({ done: true }));

async function asOfficer(opts: Parameters<typeof apiRequest>[1] = {}) {
  stubAccessCerts(team);
  return apiRequest("/api/echo", { jwt: await team.sign(accessClaims(OFFICER)), ...opts });
}

describe("route() on an Access route", () => {
  it("runs the handler for a same-origin JSON mutation and marks the answer no-store", async () => {
    const res = await call(echo, await asOfficer({ json: { note: "hello" } }), await testEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ note: "hello", actor: { kind: "person", email: OFFICER, roles: ["officer"] } });
  });

  it("refuses a mutation that is not JSON, the shape a cross-site form would send", async () => {
    const req = await asOfficer({ body: "note=hello", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const res = await call(echo, req, await testEnv());

    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "json_required" });
  });

  it("accepts JSON with a charset", async () => {
    const req = await asOfficer({ body: '{"note":"hi"}', headers: { "Content-Type": "application/json; charset=utf-8" } });
    expect((await call(echo, req, await testEnv())).status).toBe(200);
  });

  it("refuses a mutation from another origin, or with no Origin at all", async () => {
    const foreign = await call(echo, await asOfficer({ json: { note: "x" }, origin: "https://evil.example.test" }), await testEnv());
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "foreign_origin" });

    const missing = await call(echo, await asOfficer({ json: { note: "x" }, origin: null }), await testEnv());
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: "foreign_origin" });
  });

  it("refuses a body over the route's limit, whether declared or streamed", async () => {
    const big = { note: "x".repeat(100) };
    const declared = await asOfficer({ json: big, headers: { "Content-Length": "120" } });
    const declaredRes = await call(echo, declared, await testEnv());
    expect(declaredRes.status).toBe(413);
    expect(await declaredRes.json()).toEqual({ error: "too_large" });

    const streamed = await call(echo, await asOfficer({ json: big }), await testEnv());
    expect(streamed.status).toBe(413);
  });

  it("answers malformed JSON and a failed parse with 400 invalid and the paths only", async () => {
    const malformed = await call(echo, await asOfficer({ body: "{not json", headers: { "Content-Type": "application/json" } }), await testEnv());
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "invalid" });

    const wrongShape = await call(echo, await asOfficer({ json: { note: 42 } }), await testEnv());
    expect(wrongShape.status).toBe(400);
    expect(await wrongShape.json()).toEqual({ error: "invalid", issues: [{ path: "note", message: "A note is required." }] });
  });

  it("refuses an officer on a reviewer-only route and lets a reviewer through", async () => {
    stubAccessCerts(team);
    const env = await testEnv();
    const officer = await call(reviewersOnly, apiRequest("/api/x", { jwt: await team.sign(accessClaims(OFFICER)) }), env);
    const reviewer = await call(reviewersOnly, apiRequest("/api/x", { jwt: await team.sign(accessClaims(REVIEWER)) }), env);

    expect([officer.status, reviewer.status]).toEqual([403, 200]);
    expect(await officer.json()).toEqual({ error: "forbidden" });
  });

  it("answers a GET without an assertion with 401 and no-store", async () => {
    const res = await call(reviewersOnly, apiRequest("/api/x"), await testEnv());
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("turns a thrown error into 500 internal, logging the code and claim ID only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const req = await asOfficer();
    const res = await call(broken, req, await testEnv(), { id: "claim-7" });

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "internal" });
    expect(log.mock.calls).toEqual([['{"code":"internal","claimId":"claim-7"}']]);
  });

  it("answers 404 for a route that is off before any other check, and runs the usual checks when it is on", async () => {
    const crossSite = () => apiRequest("/api/x", { json: {}, origin: "https://evil.example" });

    const off = await call(demoOnly, crossSite(), await testEnv());
    const on = await call(demoOnly, crossSite(), await testEnv({ DEMO_MODE: "yes" }));

    expect(off.status).toBe(404);
    expect(off.headers.get("Cache-Control")).toBe("no-store");
    expect(await off.json()).toEqual({ error: "not_found" });
    expect(on.status).toBe(403);
  });

  it("answers a refused real identifier with 422, naming the import and positions only, and logs nothing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(refusesIdentifier, await asOfficer(), await testEnv());

    expect(res.status).toBe(422);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "real_identifier_refused", importId: "imp-9", indexes: [0, 3] });
    expect(log).not.toHaveBeenCalled();
  });
});

describe("route() on a connector route", () => {
  const push = (headers: Record<string, string>) => apiRequest("/api/connector/visits", { json: {}, origin: null, headers });

  it("accepts the connector's bearer token without an Origin and acts as the connector", async () => {
    const res = await call(fromConnector, push({ Authorization: `Bearer ${TEST_CONNECTOR_TOKEN}` }), await testEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ actor: { kind: "system", name: "connector" } });
  });

  it("refuses a wrong or missing token with 401", async () => {
    const env = await testEnv();
    const wrong = await call(fromConnector, push({ Authorization: `Bearer ${TEST_CONNECTOR_TOKEN.slice(0, -1)}x` }), env);
    const missing = await call(fromConnector, push({}), env);

    expect([wrong.status, missing.status]).toEqual([401, 401]);
    expect(await wrong.json()).toEqual({ error: "unauthenticated" });
  });

  it("fails closed with 503 when the token is unset or too short to be a real one", async () => {
    const auth = { Authorization: "Bearer short" };
    const unset = await call(fromConnector, push(auth), await testEnv({ CONNECTOR_TOKEN: undefined }));
    const short = await call(fromConnector, push(auth), await testEnv({ CONNECTOR_TOKEN: "short" }));

    expect([unset.status, short.status]).toEqual([503, 503]);
    expect(await unset.json()).toEqual({ error: "auth_not_configured" });
  });

  it("counts a token shorter than 43 characters (32 random bytes in base64) as unset, and accepts one of 43", async () => {
    const at42 = "a".repeat(42);
    const at43 = "b".repeat(43);
    const shortOne = await call(fromConnector, push({ Authorization: `Bearer ${at42}` }), await testEnv({ CONNECTOR_TOKEN: at42 }));
    const longEnough = await call(fromConnector, push({ Authorization: `Bearer ${at43}` }), await testEnv({ CONNECTOR_TOKEN: at43 }));

    expect(shortOne.status).toBe(503);
    expect(await shortOne.json()).toEqual({ error: "auth_not_configured" });
    expect(longEnough.status).not.toBe(503);
    expect(longEnough.status).not.toBe(401);
  });

  it("still requires JSON on a connector mutation", async () => {
    const req = apiRequest("/api/connector/visits", {
      body: "a,b",
      origin: null,
      headers: { "Content-Type": "text/csv", Authorization: `Bearer ${TEST_CONNECTOR_TOKEN}` },
    });
    expect((await call(fromConnector, req, await testEnv())).status).toBe(403);
  });
});

describe("an identity route", () => {
  const identityRoute = route({ auth: "access", identity: true }, async ({ keys }) =>
    json({ hashed: (await patientHash(keys, parseNric(`T9000001${nricCheckLetter("T", "9000001")}`)!)).startsWith("v1:") }),
  );
  const withKey = async (key: string | undefined, site?: string) => {
    stubAccessCerts(team);
    const req = apiRequest("/api/x", { jwt: await team.sign(accessClaims(OFFICER)), site });
    return call(identityRoute, req, await testEnv({ IDENTIFIER_KEY: key }));
  };

  it("fails closed with 503 when IDENTIFIER_KEY is missing or not a 32-byte key", async () => {
    const missing = await withKey(undefined);
    const short = await withKey("c2hvcnQ=");

    expect([missing.status, short.status]).toEqual([503, 503]);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    expect(await missing.json()).toEqual({ error: "identity_not_configured" });
  });

  it("hands the handler its keys when one is configured", async () => {
    const res = await withKey(TEST_IDENTIFIER_KEY);
    expect([res.status, await res.json()]).toEqual([200, { hashed: true }]);
  });

  it("refuses the published dev key on a deployed hostname, without echoing it", async () => {
    const res = await withKey(DEV_IDENTIFIER_KEY);
    const body = await res.text();

    expect(res.status).toBe(503);
    expect(JSON.parse(body)).toEqual({ error: "identity_not_configured" });
    expect(body).not.toContain(DEV_IDENTIFIER_KEY);
  });

  it("accepts the dev key over loopback, as `npm run dev:functions` serves it", async () => {
    for (const site of ["http://localhost:8788", "http://127.0.0.1:8788", "http://[::1]:8788"]) {
      const res = await withKey(DEV_IDENTIFIER_KEY, site);
      expect([site, res.status]).toEqual([site, 200]);
    }
  });

  it("authenticates before it looks at the key, so a stranger learns nothing about configuration", async () => {
    const res = await call(identityRoute, apiRequest("/api/x"), await testEnv({ IDENTIFIER_KEY: undefined }));
    expect(res.status).toBe(401);
  });
});
