/**
 * The four AI suggestion routes (technical §6, spec Block 6). Each answers a suggestion and changes
 * nothing: a person reads it, edits it, and accepts it through the ordinary route (the code map PUT
 * with `origin: "ai_accepted"`, the settings save, the claim's note). Without `ANTHROPIC_API_KEY`
 * every route answers 503 `ai_not_configured` before calling out.
 *
 * Bodies carry ids and codes, never identity: the server reads the case itself and only ever sends
 * the model text that has been through the de-identification gate.
 */
import { z } from "zod";
import type { Result } from "../domain/result";
import { SourceSchemaSchema, type SourceMapping, type SourceSchema } from "../domain/source-mapping";
import { validate, type ValidationIssue } from "../domain/validation";

/** Longest clinic description the code suggestion accepts. */
export const MAX_AI_DESCRIPTION = 500;

/** `POST /api/ai/code-suggestion`: a CHAS procedure for one unmapped clinic code. */
export interface CodeSuggestionRequest {
  clinicCode: string;
  description: string;
}

/**
 * Always a CHAS procedure code from the rule set, or null for "not claimable". The page fills the
 * code-map form with it; nothing is saved until a reviewer accepts.
 */
export interface CodeSuggestionResponse {
  suggestion: { target: "chas"; payerId: ""; targetCode: string | null; reason: string };
}

/** `POST /api/ai/rejection-explainer` and `POST /api/ai/justification`: the claim, by id only. */
export interface ClaimAiRequest {
  claimId: string;
}

/** What the payer's rejection means and what might fix it. The claim's status does not change. */
export interface RejectionExplainerResponse {
  suggestion: { explanation: string; fix: string };
}

/** A justification for the dentist to edit. Nothing is saved until someone uses it. */
export interface JustificationResponse {
  draft: string;
}

/** `POST /api/ai/source-mapping`: table and column names only, as the connector describes them. */
export interface SourceMappingRequest {
  schema: SourceSchema;
}

/** A proposed mapping, already valid; the reviewer accepts it into the settings form and saves. */
export interface SourceMappingResponse {
  suggestion: { mapping: SourceMapping; notes: string };
}

const CodeSuggestionSchema = z.strictObject({
  clinicCode: z.string().trim().min(1).max(64),
  description: z.string().max(MAX_AI_DESCRIPTION),
});

const ClaimAiSchema = z.strictObject({ claimId: z.string().min(1).max(64) });

const SourceMappingRequestSchema = z.strictObject({ schema: SourceSchemaSchema });

export function parseCodeSuggestionRequest(body: unknown): Result<CodeSuggestionRequest, ValidationIssue[]> {
  return validate(CodeSuggestionSchema, body);
}

export function parseClaimAiRequest(body: unknown): Result<ClaimAiRequest, ValidationIssue[]> {
  return validate(ClaimAiSchema, body);
}

export function parseSourceMappingRequest(body: unknown): Result<SourceMappingRequest, ValidationIssue[]> {
  return validate(SourceMappingRequestSchema, body);
}
