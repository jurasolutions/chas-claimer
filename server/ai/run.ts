/**
 * One AI call, start to finish: the key check, the daily call cap, the request, and an answer the
 * task accepts or a plain failure. Nothing here writes anything but the `ai_usage` counters; what a
 * person does with a suggestion is the task's and the page's business.
 */
import { sgtDay } from "../../src/domain/dates";
import { err, ok, type Result } from "../../src/domain/result";
import type { Env } from "../env";
import { anthropicClient, classifyApiError, costNano, MAX_OUTPUT_TOKENS, MODEL, responseText, usageOf } from "./anthropic";
import type { DeidentifiedText } from "./deidentify";

export type AiFailure = "ai_not_configured" | "ai_cap_reached" | "ai_busy" | "ai_unavailable" | "ai_unusable";

export interface AiRequest<T> {
  /** A constant: the task's instructions, with no visit data in it. */
  system: string;
  /** Everything about the case, and only ever through `deidentify()`. */
  prompt: DeidentifiedText;
  /** The JSON schema the answer must follow (structured outputs). */
  schema: Record<string, unknown>;
  /** Turns the parsed answer into the task's value, or null when the task cannot use it. */
  read: (value: unknown) => T | null;
}

export const DEFAULT_DAILY_CALL_CAP = 200;

export function aiConfigured(env: Pick<Env, "ANTHROPIC_API_KEY">): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

function dailyCap(env: Pick<Env, "AI_DAILY_CALL_CAP">): number {
  const cap = Number.parseInt(env.AI_DAILY_CALL_CAP ?? "", 10);
  return Number.isFinite(cap) && cap >= 0 ? cap : DEFAULT_DAILY_CALL_CAP;
}

/** Counts the call against today's cap in one statement; false when the cap is already reached. */
async function takeCall(env: Env, day: string): Promise<boolean> {
  const cap = dailyCap(env);
  if (cap === 0) return false;
  const result = await env.DB.prepare(
    "INSERT INTO ai_usage (day, calls) VALUES (?1, 1) ON CONFLICT (day) DO UPDATE SET calls = calls + 1 WHERE calls < ?2",
  )
    .bind(day, cap)
    .run();
  return result.meta.changes > 0;
}

export async function runAi<T>(env: Env, now: number, request: AiRequest<T>): Promise<Result<T, AiFailure>> {
  if (!aiConfigured(env)) return err("ai_not_configured");
  const day = sgtDay(now);
  if (!(await takeCall(env, day))) return err("ai_cap_reached");

  let message;
  try {
    message = await anthropicClient(env).messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
      output_config: { format: { type: "json_schema", schema: request.schema }, effort: "low" },
    });
  } catch (error) {
    const failure = classifyApiError(error);
    return err(failure === "rate" ? "ai_busy" : failure === "input" ? "ai_unusable" : "ai_unavailable");
  }

  await env.DB.prepare("UPDATE ai_usage SET cost_nano_usd = cost_nano_usd + ?1 WHERE day = ?2")
    .bind(costNano(MODEL, usageOf(message)), day)
    .run();

  if (message.stop_reason !== "end_turn") return err("ai_unusable");
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText(message));
  } catch {
    return err("ai_unusable");
  }
  const value = request.read(parsed);
  return value === null ? err("ai_unusable") : ok(value);
}
