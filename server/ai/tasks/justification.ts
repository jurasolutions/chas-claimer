/**
 * Draft justification (AC-6.2): a first draft of the justification a claim over its benchmark needs,
 * written from the dentist's note for the dentist to edit. Nothing is saved; the draft goes back to
 * the page and becomes the claim's justification only when someone submits it.
 *
 * The dentist's note is sealed with the patient's identity and may name them, so the route opens it
 * and scrubs it with that same identity before anything leaves. The opening is on the audit trail
 * first, with the purpose named and no value (ADR 0006); if the audit write fails, nothing is sent.
 */
import { MAX_ACTION_TEXT } from "../../../src/api/claim-limits";
import type { JustificationResponse } from "../../../src/api/ai";
import { cents, formatSgd } from "../../../src/domain/money";
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
  "You help a dentist at a Singapore dental clinic write the justification a payer asks for when a claim is above its fee benchmark.",
  "You are given the claim's scheme, its lines, the benchmark it exceeds and the dentist's note. The patient is not identified.",
  "Write the justification in the dentist's voice, in two to four plain sentences, from what the note says.",
  "Do not invent clinical facts, diagnoses or amounts that are not in the note or the claim. If the note gives no reason, say what the dentist should add.",
].join("\n");

const SCHEMA = {
  type: "object",
  properties: { draft: { type: "string" } },
  required: ["draft"],
  additionalProperties: false,
};

function read(value: unknown): JustificationResponse | null {
  if (!isRecord(value)) return null;
  const draft = answerText(value.draft, MAX_ACTION_TEXT);
  return draft === null ? null : { draft };
}

function amount(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? formatSgd(cents(value)) : null;
}

export interface JustificationDeps {
  db: D1Database;
  now: number;
  keys: IdentifierKeys;
}

export async function draftJustification(
  deps: JustificationDeps,
  env: Env,
  claimId: string,
  actor: Actor,
): Promise<Result<JustificationResponse, AiTaskError>> {
  const detail = await claimDetail(deps, claimId, actor);
  if (!detail) return err("not_found");
  const { claim } = detail;

  const identity = await loadIdentity(deps.db, deps.keys, claim.visitKey);
  await auditStatement(deps.db, {
    at: new Date(deps.now).toISOString(),
    actor: actorId(actor),
    action: "revealed",
    entityType: "claim",
    entityId: claim.id,
    detail: { field: "notes", purpose: "ai_justification" },
  }).run();

  const lines = detail.lines.map(
    (l) =>
      `- Line ${l.lineNo}: clinic code ${l.clinicCode ?? "unknown"}, scheme code ${l.schemeCode}, tooth ${l.tooth ?? "none"}, quantity ${l.quantity}, fee ${formatSgd(l.feeCents)}`,
  );
  const benchmarks = claim.findings
    .filter((f) => f.code === "benchmark_exceeded")
    .map((f) => {
      const min = amount(f.params.minCents);
      const max = amount(f.params.maxCents);
      const line = f.lineNo === undefined ? "" : ` on line ${f.lineNo}`;
      return `- Above the fee benchmark${line}${min && max ? ` of ${min} to ${max}` : ""}`;
    });
  const text = [
    `Scheme: ${claim.scheme}`,
    "Lines:",
    ...lines,
    "Benchmark findings:",
    ...(benchmarks.length ? benchmarks : ["- none"]),
    `Dentist's note: ${identity?.notes?.trim() || "none"}`,
  ].join("\n");
  const prompt = deidentify(text, identity);
  if (!prompt.ok) return err("ai_identifiers_remain");

  const answer = await runAi(env, deps.now, { system: SYSTEM, prompt: prompt.value, schema: SCHEMA, read });
  return answer.ok ? ok(answer.value) : answer;
}
