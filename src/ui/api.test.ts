// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessRedirect, jsonAnswer, stubNetwork } from "../../tests/helpers/network";
import type { MeResponse } from "../api/common";
import { ApiError, api, onSessionEnded } from "./api";

const origin = window.location.origin;
const me: MeResponse = { email: "officer@example.test", roles: ["officer"], aiConfigured: false, demoMode: true };

describe("api client", () => {
  it("gets JSON from a same-origin path", async () => {
    const fetchStub = stubNetwork({ [`${origin}/api/me`]: jsonAnswer(me) });

    await expect(api.get<MeResponse>("/api/me")).resolves.toEqual(me);

    const request = new Request(fetchStub.mock.calls[0]![0], fetchStub.mock.calls[0]![1]);
    expect(request.method).toBe("GET");
    expect(request.headers.get("Accept")).toBe("application/json");
  });

  it("posts a JSON body with the JSON content type the server requires", async () => {
    let seen: { method: string; contentType: string | null; body: unknown } | undefined;
    stubNetwork({
      [`${origin}/api/claims/c1/reveal`]: async (request) => {
        seen = { method: request.method, contentType: request.headers.get("Content-Type"), body: await request.json() };
        return jsonAnswer({ value: "T9000000J" })(request);
      },
    });

    await expect(api.post("/api/claims/c1/reveal", { field: "nric" })).resolves.toEqual({ value: "T9000000J" });
    expect(seen).toEqual({ method: "POST", contentType: "application/json", body: { field: "nric" } });
  });

  it("puts and deletes for the routes that take them", async () => {
    const methods: string[] = [];
    stubNetwork({
      [`${origin}/api/settings`]: (request) => {
        methods.push(request.method);
        return jsonAnswer({ ok: true })(request);
      },
    });

    await api.put("/api/settings", { expectedVersion: 1 });
    await api.delete("/api/settings");
    expect(methods).toEqual(["PUT", "DELETE"]);
  });

  it("throws an ApiError carrying the status and the error code, never words", async () => {
    stubNetwork({ [`${origin}/api/me`]: jsonAnswer({ error: "forbidden" }, 403) });

    const error = await api.get("/api/me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "forbidden", body: { error: "forbidden" } });
  });

  it("calls a body that isn't JSON an internal error", async () => {
    stubNetwork({ [`${origin}/api/me`]: () => new Response("<html>bad gateway</html>", { status: 502 }) });

    await expect(api.get("/api/me")).rejects.toMatchObject({ status: 502, code: "internal" });
  });

  it("treats a 204 as no content", async () => {
    stubNetwork({ [`${origin}/api/code-map/x`]: () => new Response(null, { status: 204 }) });

    await expect(api.delete("/api/code-map/x")).resolves.toBeUndefined();
  });

  it("marks a bodyless delete as JSON too, so the server's json_required check lets it through", async () => {
    let seen: { contentType: string | null; body: string } | undefined;
    stubNetwork({
      [`${origin}/api/code-map/x`]: async (request) => {
        seen = { contentType: request.headers.get("Content-Type"), body: await request.text() };
        return new Response(null, { status: 204 });
      },
    });

    await api.delete("/api/code-map/x");
    expect(seen).toEqual({ contentType: "application/json", body: "" });
  });
});

describe("when the sign-in session ends (infra I4, review S-4)", () => {
  const refused = () => vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
  let stop: () => void = () => undefined;
  afterEach(() => stop());

  it("asks the browser not to follow a redirect, so Access's sign-in redirect arrives as an answer", async () => {
    const fetchStub = stubNetwork({ [`${origin}/api/me`]: jsonAnswer(me) });

    await api.get("/api/me");
    expect(new Request(fetchStub.mock.calls[0]![0], fetchStub.mock.calls[0]![1]).redirect).toBe("manual");
  });

  it("tells whoever is listening when Access redirects to sign in, and rejects as unauthenticated", async () => {
    const heard = vi.fn();
    stop = onSessionEnded(heard);
    stubNetwork({ [`${origin}/api/claims`]: accessRedirect });

    await expect(api.get("/api/claims")).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("tells whoever is listening when the desk itself no longer sees a signed-in person", async () => {
    const heard = vi.fn();
    stop = onSessionEnded(heard);
    stubNetwork({ [`${origin}/api/claims`]: jsonAnswer({ error: "unauthenticated" }, 401) });

    await expect(api.get("/api/claims")).rejects.toBeInstanceOf(ApiError);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("says nothing when the request never reached the desk: that is the connection, not the session", async () => {
    const heard = vi.fn();
    stop = onSessionEnded(heard);
    refused();

    await expect(api.get("/api/claims")).rejects.toBeInstanceOf(TypeError);
    expect(heard).not.toHaveBeenCalled();
  });

  it("says nothing when the server answered with any other error", async () => {
    const heard = vi.fn();
    stop = onSessionEnded(heard);
    stubNetwork({ [`${origin}/api/me`]: jsonAnswer({ error: "forbidden" }, 403) });

    await expect(api.get("/api/me")).rejects.toBeInstanceOf(ApiError);
    expect(heard).not.toHaveBeenCalled();
  });

  it("stops telling a listener once it unsubscribes", async () => {
    const heard = vi.fn();
    onSessionEnded(heard)();
    stubNetwork({ [`${origin}/api/claims`]: accessRedirect });

    await expect(api.get("/api/claims")).rejects.toBeInstanceOf(ApiError);
    expect(heard).not.toHaveBeenCalled();
  });
});
