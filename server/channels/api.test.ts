import type { PayerSettings } from "../../src/domain/settings";
import { CLINIC } from "../../tests/helpers/fixtures";
import { type Answer, stubNetwork } from "../../tests/helpers/network";
import { testEnv } from "../../tests/helpers/env";
import type { Env } from "../env";
import { API_TIMEOUT_MS, apiChannel, MAX_API_ANSWER_BYTES } from "./api";
import type { Outgoing } from "./index";

const MERIDIAN = CLINIC.settings.payers.find((p) => p.id === "MERIDIAN")!;
const URL_ = MERIDIAN.apiUrl!;

const payer = (over: Partial<PayerSettings> = {}): PayerSettings => ({ ...MERIDIAN, ...over });
const one: Outgoing = { packet: { claimId: "C-1", payerId: "MERIDIAN", fields: [] }, revision: 1, cycle: 0 };

async function env(token: string | null = "test-token"): Promise<Env> {
  return testEnv(token === null ? {} : { PAYER_MERIDIAN_API_TOKEN: token });
}

async function sendWith(answer: Answer) {
  stubNetwork({ [URL_]: answer });
  const result = await apiChannel.send([one], { env: await env(), payer: payer(), db: (await env()).DB, now: 0 });
  if (result.kind !== "sent") throw new Error("expected sent");
  return result.results[0]!;
}

describe("api channel", () => {
  it.each([
    ["http://meridian.example.test/claims", "This payer's API address must use https."],
    ["https://10.0.0.5/claims", "This payer's API address must be a host name, not an IP address."],
    ["https://[::1]/claims", "This payer's API address must be a host name, not an IP address."],
    ["https://localhost/claims", "This payer's API address must not be localhost."],
  ])("F3: refuses %s before sending anything", async (apiUrl, detail) => {
    const fetchStub = stubNetwork({});
    expect(apiChannel.unavailable(payer({ apiUrl }), await env())).toBe(detail);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("F3: refuses a payer with no API address, or with no token in its own variable", async () => {
    expect(apiChannel.unavailable(payer({ apiUrl: null }), await env())).toBe("This payer has no API address in settings.");
    expect(apiChannel.unavailable(payer(), await env(null))).toBe("This payer's API token is not set.");
    expect(apiChannel.unavailable(payer(), await testEnv({ PAYER_HARBOUR_API_TOKEN: "other" }))).toBe("This payer's API token is not set.");
    expect(apiChannel.unavailable(payer(), await env())).toBeNull();
  });

  it("F3: does not follow a redirect, and gives up after 15 seconds", async () => {
    let init: Request | undefined;
    const result = await sendWith((req) => {
      init = req;
      return new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.test/" } });
    });
    expect(result).toEqual({ claimId: "C-1", ok: false, error: "redirect" });
    expect(init!.redirect).toBe("manual");
    expect(API_TIMEOUT_MS).toBe(15_000);
  });

  it("F3: refuses an answer larger than the cap without reading the rest", async () => {
    const big = JSON.stringify({ reference: "R-1", pad: "x".repeat(MAX_API_ANSWER_BYTES) });
    expect(await sendWith(() => new Response(big, { status: 200 }))).toEqual({ claimId: "C-1", ok: false, error: "bad_response" });
  });

  it("F3: a payer error is reported by its status, and an answer without a reference is refused", async () => {
    expect(await sendWith(() => new Response("{}", { status: 503 }))).toEqual({ claimId: "C-1", ok: false, error: "http_503" });
    expect(await sendWith(() => new Response("{}", { status: 200 }))).toEqual({ claimId: "C-1", ok: false, error: "bad_response" });
    expect(await sendWith(() => new Response("not json", { status: 200 }))).toEqual({ claimId: "C-1", ok: false, error: "bad_response" });
  });

  it("F3: a lost connection is a network failure", async () => {
    expect(
      await sendWith(() => {
        throw new TypeError("fetch failed");
      }),
    ).toEqual({ claimId: "C-1", ok: false, error: "network" });
  });
});
