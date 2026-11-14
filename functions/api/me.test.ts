import { accessClaims, accessTeam, stubAccessCerts } from "../../tests/helpers/access";
import { OFFICER, REVIEWER, STRANGER, testEnv } from "../../tests/helpers/env";
import { apiRequest, call } from "../../tests/helpers/http";
import { onRequestGet } from "./me";

const team = await accessTeam();

describe("GET /api/me", () => {
  it("tells a reviewer who they are, that they hold both roles, and whether AI and demo mode are on", async () => {
    stubAccessCerts(team);
    const env = await testEnv({ ANTHROPIC_API_KEY: "sk-test-not-real", DEMO_MODE: "yes" });

    const res = await call(onRequestGet, apiRequest("/api/me", { jwt: await team.sign(accessClaims(REVIEWER)) }), env);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ email: REVIEWER, roles: ["reviewer", "officer"], aiConfigured: true, demoMode: true });
  });

  it("gives an officer the officer role only, with AI and demo mode off when unset", async () => {
    stubAccessCerts(team);
    const env = await testEnv();

    const res = await call(onRequestGet, apiRequest("/api/me", { jwt: await team.sign(accessClaims(OFFICER)) }), env);

    expect(await res.json()).toEqual({ email: OFFICER, roles: ["officer"], aiConfigured: false, demoMode: false });
  });

  it("reports demo mode on a developer's own machine without DEMO_MODE, as the simulator routes decide it", async () => {
    const env = await testEnv({ DEV_USER: OFFICER, ACCESS_AUD: undefined, ACCESS_TEAM_DOMAIN: undefined });

    const res = await call(onRequestGet, apiRequest("/api/me", { site: "http://localhost:8788" }), env);

    expect(await res.json()).toMatchObject({ email: OFFICER, demoMode: true });
  });

  it("refuses a signed-in email on neither role list", async () => {
    stubAccessCerts(team);
    const env = await testEnv();

    const res = await call(onRequestGet, apiRequest("/api/me", { jwt: await team.sign(accessClaims(STRANGER)) }), env);

    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "forbidden" });
  });
});

describe("Access assertion verification, through GET /api/me", () => {
  const refused = async (jwt: string, overrides = {}) => {
    stubAccessCerts(team);
    const res = await call(onRequestGet, apiRequest("/api/me", { jwt }), await testEnv(overrides));
    return { status: res.status, cache: res.headers.get("Cache-Control"), body: await res.json() };
  };

  it("refuses an assertion for another application's audience", async () => {
    expect(await refused(await team.sign(accessClaims(REVIEWER, { aud: ["someone-elses-app"] })))).toEqual({
      status: 401,
      cache: "no-store",
      body: { error: "unauthenticated" },
    });
  });

  it("refuses an expired assertion", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect((await refused(await team.sign(accessClaims(REVIEWER, { iat: past - 600, nbf: past - 600, exp: past })))).status).toBe(401);
  });

  it("refuses an assertion signed by a different key under the team's key ID", async () => {
    const impostor = await accessTeam(team.kid);
    expect((await refused(await impostor.sign(accessClaims(REVIEWER)))).status).toBe(401);
  });

  it("refuses an assertion issued by another team", async () => {
    expect((await refused(await team.sign(accessClaims(REVIEWER, { iss: "https://other-team.cloudflareaccess.com" })))).status).toBe(401);
  });

  it("refuses an unsigned assertion", async () => {
    const valid = await team.sign(accessClaims(REVIEWER));
    const payload = valid.split(".")[1]!;
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", kid: team.kid })).toString("base64url")}.${payload}.`;
    expect((await refused(unsigned)).status).toBe(401);
  });

  it("never trusts the plain email header Access also sends", async () => {
    stubAccessCerts(team);
    const req = apiRequest("/api/me", { headers: { "Cf-Access-Authenticated-User-Email": REVIEWER } });
    const res = await call(onRequestGet, req, await testEnv());
    expect(res.status).toBe(401);
  });

  it("fails closed with 503 when the Access audience or team domain is not configured", async () => {
    const jwt = await team.sign(accessClaims(REVIEWER));
    expect(await refused(jwt, { ACCESS_AUD: undefined })).toEqual({ status: 503, cache: "no-store", body: { error: "auth_not_configured" } });
    expect((await refused(jwt, { ACCESS_TEAM_DOMAIN: undefined })).status).toBe(503);
  });

  it("ignores DEV_USER on a deployed hostname", async () => {
    const res = await call(onRequestGet, apiRequest("/api/me"), await testEnv({ DEV_USER: REVIEWER }));
    expect(res.status).toBe(401);
    const unconfigured = await testEnv({ DEV_USER: REVIEWER, ACCESS_AUD: undefined, ACCESS_TEAM_DOMAIN: undefined });
    expect((await call(onRequestGet, apiRequest("/api/me"), unconfigured)).status).toBe(503);
  });

  it("honours DEV_USER on localhost", async () => {
    const env = await testEnv({ DEV_USER: REVIEWER, ACCESS_AUD: undefined, ACCESS_TEAM_DOMAIN: undefined });
    const res = await call(onRequestGet, apiRequest("/api/me", { site: "http://localhost:8788" }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: REVIEWER, roles: ["reviewer", "officer"] });
  });

  it("fetches the team's key set once and reuses it", async () => {
    const domain = "cache-test.cloudflareaccess.com";
    const fetchStub = stubAccessCerts(team, domain);
    const env = await testEnv({ ACCESS_TEAM_DOMAIN: domain });
    const jwt = await team.sign(accessClaims(OFFICER, { iss: `https://${domain}` }));

    const first = await call(onRequestGet, apiRequest("/api/me", { jwt }), env);
    const second = await call(onRequestGet, apiRequest("/api/me", { jwt }), env);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});
