import { describe, expect, it } from "vitest";
import { testEnv } from "../../tests/helpers/env";
import { jsonAnswer, stubNetwork, type Answer } from "../../tests/helpers/network";
import { deidentify, type DeidentifiedText } from "./deidentify";
import { runAi, type AiRequest } from "./run";

const MESSAGES = "https://api.anthropic.com/v1/messages";
/** 2026-11-13 10:00 SGT. */
const NOW = Date.UTC(2026, 10, 13, 2, 0);

const prompt = (text: string): DeidentifiedText => {
  const result = deidentify(text);
  if (!result.ok) throw new Error("test prompt has identifiers");
  return result.value;
};

const request: AiRequest<{ code: string }> = {
  system: "You suggest a code.",
  prompt: prompt("Laser gum contouring"),
  schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
  read: (value) => (typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string" ? (value as { code: string }) : null),
};

/** A Messages API answer whose only text block is `text`. */
const message = (text: string, stop_reason = "end_turn") =>
  jsonAnswer({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200 },
  });

const apiError = (status: number, type: string, msg = "test") => jsonAnswer({ type: "error", error: { type, message: msg } }, status);

const configured = (overrides = {}) => testEnv({ ANTHROPIC_API_KEY: "test-key-not-real", ...overrides });

async function usage(env: Awaited<ReturnType<typeof testEnv>>) {
  return env.DB.prepare("SELECT day, calls, cost_nano_usd FROM ai_usage").all();
}

describe("runAi", () => {
  it("answers not configured without a key, and sends nothing", async () => {
    const env = await testEnv();
    const fetchStub = stubNetwork({});

    expect(await runAi(env, NOW, request)).toEqual({ ok: false, error: "ai_not_configured" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("sends the de-identified prompt to Haiku with structured outputs, reads the answer, and counts the call and its cost", async () => {
    const env = await configured();
    let sent: Record<string, unknown> | undefined;
    const fetchStub = stubNetwork({
      [MESSAGES]: async (req) => {
        sent = (await req.json()) as Record<string, unknown>;
        return message('{"code":"D4341"}')(req);
      },
    });

    expect(await runAi(env, NOW, request)).toEqual({ ok: true, value: { code: "D4341" } });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(sent).toMatchObject({
      model: "claude-haiku-5-5",
      system: "You suggest a code.",
      messages: [{ role: "user", content: "Laser gum contouring" }],
      output_config: { format: { type: "json_schema", schema: request.schema }, effort: "low" },
    });
    expect(sent).not.toHaveProperty("temperature");
    expect(sent).not.toHaveProperty("tools");
    // 1000 input tokens at 100 nano-USD and 200 output tokens at 500.
    expect((await usage(env)).results).toEqual([{ day: "2026-11-13", calls: 1, cost_nano_usd: 200_000 }]);
  });

  it("goes to ANTHROPIC_BASE_URL when it is set", async () => {
    const env = await configured({ ANTHROPIC_BASE_URL: "http://localhost:8787/stand-in" });
    stubNetwork({ "http://localhost:8787/stand-in/v1/messages": message('{"code":"X"}') });

    expect(await runAi(env, NOW, request)).toEqual({ ok: true, value: { code: "X" } });
  });

  it("stops at the daily call cap before sending, and starts again the next SGT day", async () => {
    const env = await configured({ AI_DAILY_CALL_CAP: "2" });
    const fetchStub = stubNetwork({ [MESSAGES]: message('{"code":"X"}') });

    await runAi(env, NOW, request);
    await runAi(env, NOW, request);
    expect(await runAi(env, NOW, request)).toEqual({ ok: false, error: "ai_cap_reached" });
    expect(fetchStub).toHaveBeenCalledTimes(2);

    expect((await runAi(env, NOW + 24 * 3_600_000, request)).ok).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it("caps at 200 calls a day when AI_DAILY_CALL_CAP is unset", async () => {
    const env = await configured();
    await env.DB.prepare("INSERT INTO ai_usage (day, calls) VALUES ('2026-11-13', 200)").run();
    const fetchStub = stubNetwork({});

    expect(await runAi(env, NOW, request)).toEqual({ ok: false, error: "ai_cap_reached" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each<[string, Answer, string]>([
    ["a 429", apiError(429, "rate_limit_error"), "ai_busy"],
    ["a 529 overload", apiError(529, "overloaded_error"), "ai_unavailable"],
    ["a 500", apiError(500, "api_error"), "ai_unavailable"],
    ["a spend limit", apiError(400, "invalid_request_error", "Your credit balance is too low"), "ai_unavailable"],
    ["a 400 about the input", apiError(400, "invalid_request_error"), "ai_unusable"],
    ["a refusal", message("", "refusal"), "ai_unusable"],
    ["a cut-off answer", message('{"code":', "max_tokens"), "ai_unusable"],
    ["text that is not JSON", message("D4341, I think"), "ai_unusable"],
    ["JSON the task does not accept", message('{"code":7}'), "ai_unusable"],
  ])("turns %s into %s", async (_label, answer, error) => {
    const env = await configured();
    stubNetwork({ [MESSAGES]: answer });

    expect(await runAi(env, NOW, request)).toEqual({ ok: false, error });
  });

  it("turns a dropped connection into unavailable", async () => {
    const env = await configured();
    stubNetwork({
      [MESSAGES]: () => {
        throw new TypeError("network down");
      },
    });

    expect(await runAi(env, NOW, request)).toEqual({ ok: false, error: "ai_unavailable" });
  });
});
