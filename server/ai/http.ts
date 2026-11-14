/**
 * How an AI task's failure answers over HTTP. Every body is a code and nothing else: the model's
 * words, the prompt and the case never come back in an error.
 */
import type { ErrorCode } from "../../src/api/common";
import { problem } from "../http";
import type { AiFailure } from "./run";

/** A task's failures: the runner's, the de-identification gate's, a claim that is not there, and a claim the task does not apply to. */
export type AiTaskError = AiFailure | "ai_identifiers_remain" | "not_found" | "not_allowed";

const STATUS: Record<AiTaskError, number> = {
  ai_not_configured: 503,
  ai_cap_reached: 429,
  ai_busy: 503,
  ai_unavailable: 502,
  ai_unusable: 502,
  ai_identifiers_remain: 422,
  not_found: 404,
  not_allowed: 409,
};

export function aiProblem(error: AiTaskError): Response {
  return problem(STATUS[error], error satisfies ErrorCode);
}
