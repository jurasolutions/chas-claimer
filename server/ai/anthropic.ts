/**
 * The Anthropic client settings, ported from the landing page's `server/anthropic.js`: one model, no
 * SDK retries (a person presses the button again), logging off so no prompt reaches a log, and an
 * optional base URL for a local stand-in.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";

export const MODEL = "claude-haiku-5-5";

/** Enough for any of the four tasks' structured answers. */
export const MAX_OUTPUT_TOKENS = 4096;

/** Built per call, so it picks up whatever `fetch` is current (a test stub included). */
export function anthropicClient(env: Pick<Env, "ANTHROPIC_API_KEY" | "ANTHROPIC_BASE_URL">): Anthropic {
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    maxRetries: 0,
    timeout: 60_000,
    logLevel: "off",
  });
}

export type ApiFailure = "unavailable" | "rate" | "billing" | "input";

/** What went wrong with a call, in the four ways the desk tells apart. */
export function classifyApiError(error: unknown): ApiFailure {
  if (error instanceof Anthropic.APIConnectionError) return "unavailable";
  if (!(error instanceof Anthropic.APIError)) return "unavailable";
  const body = (error.error as { error?: { type?: string; message?: string } } | undefined)?.error;
  const type = body?.type ?? "";
  const message = body?.message ?? "";
  if (error instanceof Anthropic.RateLimitError || type === "rate_limit_error") return "rate";
  if (error.status === 402 || type === "billing_error") return "billing";
  if (error.status === 400 && /credit balance|usage limit|spend limit/i.test(message)) return "billing";
  if (error.status === 400 && type === "invalid_request_error") return "input";
  return "unavailable";
}

/** The answer's text blocks, joined. */
export function responseText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export interface Usage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export function usageOf(message: Anthropic.Message): Usage {
  const u = message.usage;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  };
}

/** Nano-USD per token, from Anthropic's published list prices. */
export const PRICES_NANO_USD: Readonly<Record<string, Usage>> = {
  "claude-haiku-5-5": { input: 100, output: 500, cacheWrite: 125, cacheRead: 10 },
};

export function priceOf(model: string): Usage {
  const price = PRICES_NANO_USD[model];
  if (!price) throw new Error(`No price for model ${model}`);
  return price;
}

/** What a call cost, in whole nano-USD. */
export function costNano(model: string, usage: Usage): number {
  const p = priceOf(model);
  return usage.input * p.input + usage.output * p.output + usage.cacheWrite * p.cacheWrite + usage.cacheRead * p.cacheRead;
}
