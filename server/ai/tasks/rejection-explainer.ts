/**
 * Explain (AC-6.4): why a payer rejected a claim and what to change, as a suggestion. The claim is
 * read, never written: its status, version and reason stay as they were whatever the model answers.
 *
 * A payer's rejection text is free text and may name the patient, so the route opens the visit's
 * identity to scrub it. That opening is on the audit trail before anything is sent, with the purpose
 * named and no value (ADR 0006); if the audit write fails, the call throws and nothing is sent.
 */
import type { RejectionExplainerResponse } from "../../../src/api/ai";
import { formatSgd } from "../../../src/domain/money";
import { err, ok, type Result } from "../../../src/domain/result";
import { actorId, type Actor } from "../../../src/domain/types";
import type { IdentifierKeys } from "../../crypto";
import type { Env } from "../../env";
import { auditStatement } from "../../repo/audit";
import { loadIdentity } from "../../repo/visits";
import { claimDetail } from "../../services/claims";
import { deidentify } from "../deidentify";
import type { AiTaskError } from "../http";
import { answerText, isRecord } from "../read";
import { runAi } from "../run";

const SYSTEM = [
  "You help the claims officer at a Singapore dental clinic understand why a payer rejected a claim.",
  "You are given the claim's scheme, its lines and the payer's rejection reason. The patient is not identified.",
  "Explain the rejection in plain words, in two or three sentences.",
  "Then give the fix: what the officer should change before resubmitting, in one or two sentences.",
  "Do not invent payer rules or amounts that are not in the claim.",
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    explanation: { type: "string" },
    fix: { type: "string" },
  },
  required: ["explanation", "fix"],
  additionalProperties: false,
};

type Suggestion = RejectionExplainerResponse["suggestion"];

function read(value: unknown): Suggestion | null {
  if (!isRecord(value)) return null;
  const explanation = answerText(value.explanation);
  const fix = answerText(value.fix);
  return explanation === null || fix === null ? null : { explanation, fix };
}

export interface ExplainDeps {
  db: D1Database;
  now: number;
  keys: IdentifierKeys;
}

export async function explainRejection(
  deps: ExplainDeps,
  env: Env,
  claimId: string,
  actor: Actor,
): Promise<Result<Suggestion, AiTaskError>> {
  const detail = await claimDetail(deps, claimId, actor);
  if (!detail) return err("not_found");
  const { claim } = detail;
  if (claim.status !== "rejected" || !claim.rejectionReason) return err("not_allowed");

  const identity = await loadIdentity(deps.db, deps.keys, claim.visitKey);
  await auditStatement(deps.db, {
    at: new Date(deps.now).toISOString(),
    actor: actorId(actor),
    action: "revealed",
    entityType: "claim",
    entityId: claim.id,
    detail: { field: "identity", purpose: "ai_rejection_explainer" },
  }).run();

  const lines = detail.lines.map(
    (l) =>
      `- Line ${l.lineNo}: clinic code ${l.clinicCode ?? "unknown"}, scheme code ${l.schemeCode}, tooth ${l.tooth ?? "none"}, quantity ${l.quantity}, fee ${formatSgd(l.feeCents)}, claimed ${formatSgd(l.claimedCents)}`,
  );
  const text = [
    `Scheme: ${claim.scheme}`,
    `Payer: ${claim.payerId}`,
    "Lines:",
    ...lines,
    `Claimed in total: ${formatSgd(claim.claimedCents)}`,
    `Rejection reason from the payer: ${claim.rejectionReason}`,
  ].join("\n");
  const prompt = deidentify(text, identity);
  if (!prompt.ok) return err("ai_identifiers_remain");

  const answer = await runAi(env, deps.now, { system: SYSTEM, prompt: prompt.value, schema: SCHEMA, read });
  return answer.ok ? ok(answer.value) : answer;
}
