import * as codeMap from "../../../server/repo/code-map";
import { importVisits } from "../../../server/services/imports";
import { accessClaims, accessTeam } from "../../../tests/helpers/access";
import { apiError, deskRows, modelJson, modelText, stubModel } from "../../../tests/helpers/ai";
import { OFFICER, REVIEWER, STRANGER } from "../../../tests/helpers/env";
import { caseVisits, configuredDesk, NOW, OFFICER_ACTOR } from "../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../tests/helpers/http";
import type { Env } from "../../../server/env";
import { onRequestPost } from "./code-suggestion";

const team = await accessTeam();
const NEW_99 = { clinicCode: "NEW-99", description: "Laser gum contouring" };

async function d20(overrides: Partial<Env> = { ANTHROPIC_API_KEY: "test-key-not-real" }) {
  const desk = await configuredDesk(overrides);
  await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D20") }, OFFICER_ACTOR);
  const post = async (json: unknown, who = OFFICER) =>
    call(onRequestPost, apiRequest("/api/ai/code-suggestion", { json, jwt: await team.sign(accessClaims(who)) }), desk.env, {});
  return { desk, post };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/ai/code-suggestion (AC-6.3)", () => {
  it("suggests a CHAS procedure for an unmapped clinic code and saves nothing", async () => {
    const { desk, post } = await d20();
    const model = stubModel(team, modelJson({ targetCode: "SCALING", reason: "Gum contouring is closest to scaling." }));
    const before = await deskRows(desk.db);

    const res = await post(NEW_99);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      suggestion: { target: "chas", payerId: "", targetCode: "SCALING", reason: "Gum contouring is closest to scaling." },
    });
    expect(model.calls()).toBe(1);
    expect(model.sent[0]).toContain("Laser gum contouring");
    expect(await codeMap.find(desk.db, "NEW-99", "chas", "")).toBeNull();
    expect(await deskRows(desk.db)).toEqual(before);
  });

  it("answers a reviewer too, and suggests not claimable as a null code", async () => {
    const { post } = await d20();
    stubModel(team, modelJson({ targetCode: null, reason: "Cosmetic work is not a CHAS procedure." }));

    const res = await post(NEW_99, REVIEWER);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { suggestion: { targetCode: unknown } }).suggestion.targetCode).toBeNull();
  });

  it("asks for a code from the CHAS rule set only", async () => {
    const { post } = await d20();
    const model = stubModel(team, modelJson({ targetCode: "SCALING", reason: "r" }));

    await post(NEW_99);

    const body = JSON.parse(model.sent[0]!) as { output_config: { format: { schema: unknown } } };
    expect(JSON.stringify(body.output_config.format.schema)).toContain('"RCT_MOLAR"');
  });

  it("sends the description the desk holds for the code, not the one in the request", async () => {
    const { post } = await d20();
    const model = stubModel(team, modelJson({ targetCode: null, reason: "r" }));

    const res = await post({ clinicCode: "NEW-99", description: "Typed by hand for Mdm Test Person Two" });

    expect(res.status).toBe(200);
    expect(model.sent[0]).toContain("Laser gum contouring");
    expect(model.sent[0]).not.toContain("Test Person Two");
  });

  it("falls back to the request's description for a code the desk does not hold, with identifier patterns redacted", async () => {
    const { post } = await d20();
    const model = stubModel(team, modelJson({ targetCode: null, reason: "r" }));

    const res = await post({ clinicCode: "NEW-77", description: "Laser gum contouring, call +65 0000 0042 or someone@example.test" });

    expect(res.status).toBe(200);
    expect(model.sent[0]).toContain("Laser gum contouring");
    expect(model.sent[0]).not.toContain("0000 0042");
    expect(model.sent[0]).not.toContain("someone@example.test");
  });

  it("refuses a code outside the rule set, and answers with no suggestion", async () => {
    const { desk, post } = await d20();
    stubModel(team, modelJson({ targetCode: "LASER_WHITENING", reason: "r" }));
    const before = await deskRows(desk.db);

    const res = await post(NEW_99);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "ai_unusable" });
    expect(await deskRows(desk.db)).toEqual(before);
  });

  it.each([
    ["text that is not JSON", modelText("SCALING, probably")],
    ["markup in place of an answer", modelText("<script>alert(1)</script>")],
    ["an amount in place of a code", modelJson({ targetCode: 2050, reason: "r" })],
    ["an answer cut off at the token limit", modelText('{"targetCode":"SCAL', "max_tokens")],
  ])("answers ai_unusable for %s", async (_name, answer) => {
    const { post } = await d20();
    stubModel(team, answer);

    const res = await post(NEW_99);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "ai_unusable" });
  });

  it("answers ai_not_configured without a key, and never calls the model (AC-6.1)", async () => {
    const { desk, post } = await d20({});
    const model = stubModel(team, modelJson({ targetCode: "SCALING", reason: "r" }));
    const before = await deskRows(desk.db);

    const res = await post(NEW_99);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ai_not_configured" });
    expect(model.calls()).toBe(0);
    expect(await deskRows(desk.db)).toEqual(before);
  });

  it.each([
    ["the service is rate-limiting", apiError(429, "rate_limit_error"), 503, "ai_busy"],
    ["the service failed", apiError(500, "api_error"), 502, "ai_unavailable"],
    ["the service is overloaded", apiError(529, "overloaded_error"), 502, "ai_unavailable"],
  ] as const)("answers a plain failure when %s", async (_name, answer, status, code) => {
    const { desk, post } = await d20();
    stubModel(team, answer);
    const before = await deskRows(desk.db);

    const res = await post(NEW_99);

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code });
    expect(await deskRows(desk.db)).toEqual(before);
  });

  it("answers 429 once today's call cap is used up", async () => {
    const { post } = await d20({ ANTHROPIC_API_KEY: "test-key-not-real", AI_DAILY_CALL_CAP: "1" });
    const model = stubModel(team, modelJson({ targetCode: "SCALING", reason: "r" }));

    expect((await post(NEW_99)).status).toBe(200);
    const res = await post(NEW_99);

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "ai_cap_reached" });
    expect(model.calls()).toBe(1);
  });

  it("answers 400 for a description over the limit, and 403 to a stranger", async () => {
    const { post } = await d20();
    const model = stubModel(team, modelJson({ targetCode: "SCALING", reason: "r" }));

    expect((await post({ clinicCode: "NEW-99", description: "x".repeat(501) })).status).toBe(400);
    expect((await post(NEW_99, STRANGER)).status).toBe(403);
    expect(model.calls()).toBe(0);
  });
});
