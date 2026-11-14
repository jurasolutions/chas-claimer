/**
 * The connector's client for `POST /api/imports`. Every request goes through the network stub; the
 * desk's answers here are canned, and `cli.test.ts` runs the real import handler.
 */
import { describe, expect, it } from "vitest";
import { jsonAnswer, stubNetwork } from "../tests/helpers/network";
import { CLINIC } from "../tests/helpers/fixtures";
import { deskFromEnv, postVisits } from "./post";

const URL_ = "https://claims.example.test/api/imports";
const desk = { url: "https://claims.example.test", token: "connector-token-for-tests" };
const noWait = async () => {};
const summary = { importId: "imp-1", received: 1, new: 1, changed: 0, unchanged: 0, flagged: 0, refused: 0, ignored: [], refusedVisits: [] };
const visits = CLINIC.visits.slice(0, 1);

describe("posting a page of visits", () => {
  it("sends the visits as JSON with the bearer token and the Access service token", async () => {
    const fetch = stubNetwork({ [URL_]: jsonAnswer(summary) });
    const result = await postVisits({ ...desk, access: { clientId: "id.access", clientSecret: "access-secret" } }, visits, { wait: noWait });

    expect(result).toEqual({ kind: "imported", summary });
    const request = new Request(fetch.mock.calls[0]![0] as RequestInfo, fetch.mock.calls[0]![1]);
    expect(request.method).toBe("POST");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(request.headers.get("Authorization")).toBe("Bearer connector-token-for-tests");
    expect(request.headers.get("CF-Access-Client-Id")).toBe("id.access");
    expect(request.headers.get("CF-Access-Client-Secret")).toBe("access-secret");
    expect(await request.json()).toEqual({ visits: JSON.parse(JSON.stringify(visits)) });
  });

  it("leaves the Access headers out when no service token is set", async () => {
    const fetch = stubNetwork({ [URL_]: jsonAnswer(summary) });
    await postVisits(desk, visits, { wait: noWait });
    const request = new Request(fetch.mock.calls[0]![0] as RequestInfo, fetch.mock.calls[0]![1]);
    expect(request.headers.has("CF-Access-Client-Id")).toBe(false);
  });

  it("retries a 5xx or a dropped connection three times, waiting longer each time", async () => {
    let calls = 0;
    stubNetwork({
      [URL_]: () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return calls < 4 ? jsonAnswer({ error: "busy" }, 503)(new Request(URL_)) : jsonAnswer(summary)(new Request(URL_));
      },
    });
    const waits: number[] = [];
    const result = await postVisits(desk, visits, { wait: async (ms) => void waits.push(ms) });
    expect(result.kind).toBe("imported");
    expect(calls).toBe(4);
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  it("gives up as unreachable after the third retry", async () => {
    const fetch = stubNetwork({ [URL_]: jsonAnswer({ error: "busy" }, 502) });
    expect(await postVisits(desk, visits, { wait: noWait })).toEqual({ kind: "unreachable", status: 502, code: "busy" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not retry a refusal", async () => {
    const fetch = stubNetwork({ [URL_]: jsonAnswer({ error: "unauthenticated" }, 401) });
    expect(await postVisits(desk, visits, { wait: noWait })).toEqual({ kind: "token_refused" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("names the desk's error code, and the positions of visits refused for a real identifier", async () => {
    stubNetwork({ [URL_]: jsonAnswer({ error: "real_identifier_refused", importId: "imp-2", indexes: [0] }, 422) });
    expect(await postVisits(desk, visits, { wait: noWait })).toEqual({ kind: "refused", status: 422, code: "real_identifier_refused", indexes: [0] });

    stubNetwork({ [URL_]: jsonAnswer({ error: "too_large" }, 413) });
    expect(await postVisits(desk, visits, { wait: noWait })).toEqual({ kind: "refused", status: 413, code: "too_large" });
  });

  it("tells an Access refusal (a redirect or a page that is not the desk's JSON) from the desk's own", async () => {
    stubNetwork({ [URL_]: () => new Response(null, { status: 302, headers: { Location: "https://jura-test.cloudflareaccess.com/login" } }) });
    expect(await postVisits(desk, visits, { wait: noWait })).toEqual({ kind: "access_refused", status: 302 });

    stubNetwork({ [URL_]: () => new Response("<html>Forbidden</html>", { status: 403, headers: { "Content-Type": "text/html" } }) });
    expect(await postVisits(desk, visits, { wait: noWait })).toEqual({ kind: "access_refused", status: 403 });
  });
});

describe("the desk's address and tokens", () => {
  const withoutAccess = { CLAIMS_DESK_URL: "https://claims.example.test/", CONNECTOR_TOKEN: "connector-token-for-tests" };
  const env = { ...withoutAccess, CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "access-secret" };

  it("come from the environment only", () => {
    expect(deskFromEnv(env)).toEqual({
      ok: true,
      value: { url: "https://claims.example.test", token: "connector-token-for-tests", access: { clientId: "id.access", clientSecret: "access-secret" } },
    });
  });

  it("require the Access service token for a desk that is not on this machine, naming the variables only", () => {
    const none = deskFromEnv(withoutAccess);
    expect(none).toEqual({ ok: false, error: expect.stringContaining("CF_ACCESS_CLIENT_ID") });
    expect(!none.ok && none.error).toContain("CF_ACCESS_CLIENT_SECRET");
    const half = deskFromEnv({ ...withoutAccess, CF_ACCESS_CLIENT_ID: "id.access" });
    expect(half).toEqual({ ok: false, error: expect.stringContaining("CF_ACCESS_CLIENT_SECRET") });
    expect(!half.ok && half.error).not.toContain("id.access");
  });

  it("leave the Access service token optional on this machine, but never half of it", () => {
    for (const host of ["http://localhost:8788", "http://127.0.0.1:8788", "http://[::1]:8788", "https://localhost"]) {
      expect(deskFromEnv({ ...withoutAccess, CLAIMS_DESK_URL: host })).toEqual({ ok: true, value: { url: host, token: withoutAccess.CONNECTOR_TOKEN } });
    }
    const half = deskFromEnv({ ...withoutAccess, CLAIMS_DESK_URL: "http://localhost:8788", CF_ACCESS_CLIENT_SECRET: "access-secret" });
    expect(half).toEqual({ ok: false, error: expect.stringContaining("CF_ACCESS_CLIENT_ID") });
    expect(!half.ok && half.error).not.toContain("access-secret");
  });

  it("name each missing variable, never a value", () => {
    const missing = deskFromEnv({});
    expect(missing).toEqual({ ok: false, error: expect.stringContaining("CLAIMS_DESK_URL") });
    expect(!missing.ok && missing.error).toContain("CONNECTOR_TOKEN");
  });

  it("refuse to send a token over plain http, except to this machine", () => {
    expect(deskFromEnv({ ...env, CLAIMS_DESK_URL: "http://claims.example.test" }).ok).toBe(false);
    expect(deskFromEnv({ ...env, CLAIMS_DESK_URL: "not a url" }).ok).toBe(false);
    expect(deskFromEnv({ ...env, CLAIMS_DESK_URL: "http://localhost.example.test" }).ok).toBe(false);
  });
});
