/**
 * Suggest code (AC-6.3): a CHAS procedure code for a clinic code the code map does not know, or
 * null for "not claimable". The description is the clinic's own treatment name, so it goes through
 * the pattern scrub only. The answer is a suggestion; the reviewer accepts it through the code-map
 * PUT, which records `ai_suggestion_accepted`.
 */
import type { CodeSuggestionRequest, CodeSuggestionResponse } from "../../../src/api/ai";
import { err, ok, type Result } from "../../../src/domain/result";
import { CHAS_RULE_SETS } from "../../../src/domain/rules/chas";
import type { Env } from "../../env";
import { deidentify } from "../deidentify";
import type { AiTaskError } from "../http";
import { answerText, isRecord } from "../read";
import { runAi } from "../run";

/** Every CHAS procedure code in any rule set, sorted. */
const CHAS_CODES: readonly string[] = [...new Set(CHAS_RULE_SETS.flatMap((rs) => Object.keys(rs.procedures)))].sort();

const SYSTEM = [
  "You help a Singapore dental clinic map its own treatment codes to CHAS dental procedure codes.",
  "You are given one clinic code and the clinic's description of it.",
  "Answer with the single CHAS procedure code the treatment would be claimed as, or null when the treatment is not claimable under CHAS (cosmetic work, for example).",
  `Choose only from these codes: ${CHAS_CODES.join(", ")}.`,
  "Give a reason of one or two sentences that a clinic reviewer can check. Do not mention amounts.",
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    targetCode: { anyOf: [{ type: "string", enum: CHAS_CODES }, { type: "null" }] },
    reason: { type: "string" },
  },
  required: ["targetCode", "reason"],
  additionalProperties: false,
};

type Suggestion = CodeSuggestionResponse["suggestion"];

function read(value: unknown): Suggestion | null {
  if (!isRecord(value)) return null;
  const reason = answerText(value.reason);
  const code = value.targetCode;
  if (reason === null) return null;
  if (code !== null && !(typeof code === "string" && CHAS_CODES.includes(code))) return null;
  return { target: "chas", payerId: "", targetCode: code, reason };
}

export async function suggestCode(env: Env, now: number, request: CodeSuggestionRequest): Promise<Result<Suggestion, AiTaskError>> {
  const prompt = deidentify(`Clinic code: ${request.clinicCode}\nDescription: ${request.description}`);
  if (!prompt.ok) return err("ai_identifiers_remain");
  const answer = await runAi(env, now, { system: SYSTEM, prompt: prompt.value, schema: SCHEMA, read });
  return answer.ok ? ok(answer.value) : answer;
}
