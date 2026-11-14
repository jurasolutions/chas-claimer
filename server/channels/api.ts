/**
 * The api channel (AC-4.6, F3): one POST per claim to the payer's endpoint, one at a time.
 *
 * - The endpoint must be https with a fully qualified host name: no IP literal, no localhost, no
 *   credentials in the URL (`apiUrlProblem`, checked again here because settings could predate it).
 * - The token comes from `PAYER_<ID>_API_TOKEN`, named from the payer ID and never from settings, and
 *   it goes only into the request header. It never reaches D1, the audit trail, a response or a log.
 * - No redirect is followed, a send gives up after 15 seconds, and an answer over 64 KB is refused.
 * - `Idempotency-Key` is the same for a claim at a visit revision within one submission cycle, so a
 *   send repeated after a timeout is one claim to the payer, while a claim the payer rejected and the
 *   desk reopened and sent again is a new one (`Outgoing.cycle`).
 *
 * The request is `{ claimId, payerId, fields: { <template key>: text | null } }` and a 2xx answer must
 * be JSON `{ reference }`, the payer's reference for the claim.
 */
import { cellText } from "../../src/domain/packet";
import { apiUrlProblem, payerTokenName } from "../../src/domain/settings";
import { MAX_PORTAL_REFERENCE } from "../../src/api/claim-limits";
import { readCapped, sha256Hex } from "../bytes";
import type { Env } from "../env";
import type { Outgoing, SendError, SendResult, SubmissionChannel } from "./index";

export const API_TIMEOUT_MS = 15_000;
export const MAX_API_ANSWER_BYTES = 64 * 1024;

function token(payerId: string, env: Env): string | undefined {
  const value = env[payerTokenName(payerId) as `PAYER_${string}_API_TOKEN`];
  return value?.trim() ? value.trim() : undefined;
}

export const apiChannel: SubmissionChannel = {
  kind: "api",
  opensIdentity: true,
  unavailable(payer, env) {
    if (!payer.apiUrl) return "This payer has no API address in settings.";
    const problem = apiUrlProblem(payer.apiUrl);
    if (problem) return `This payer's API address ${problem}.`;
    if (!token(payer.id, env)) return "This payer's API token is not set.";
    return null;
  },
  async send(outgoing, { env, payer }) {
    const results: Extract<SendResult, { kind: "sent" }>["results"] = [];
    for (const one of outgoing) {
      const answer = await sendOne(one, payer.apiUrl!, payer.apiAuthHeader ?? "Authorization", token(payer.id, env)!);
      results.push(typeof answer === "string" ? { claimId: one.packet.claimId, ok: false, error: answer } : { claimId: one.packet.claimId, ok: true, reference: answer.reference });
    }
    return { kind: "sent", results };
  },
};

async function sendOne({ packet, revision, cycle }: Outgoing, url: string, header: string, secret: string): Promise<{ reference: string } | SendError> {
  const body = JSON.stringify({ claimId: packet.claimId, payerId: packet.payerId, fields: Object.fromEntries(packet.fields.map((f) => [f.key, cellText(f.value)])) });
  const idempotencyKey = await sha256Hex(`${packet.claimId}:${revision}:${cycle}`);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": idempotencyKey,
        [header]: header.toLowerCase() === "authorization" ? `Bearer ${secret}` : secret,
      },
      body,
    });
  } catch (e) {
    return isTimeout(e) ? "timeout" : "network";
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel();
    return "redirect";
  }
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel();
    return `http_${res.status}`;
  }
  let text: string | null;
  try {
    text = await readCapped(res, MAX_API_ANSWER_BYTES);
  } catch (e) {
    return isTimeout(e) ? "timeout" : "network";
  }
  if (text === null) return "bad_response";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "bad_response";
  }
  const reference = typeof parsed === "object" && parsed !== null ? (parsed as { reference?: unknown }).reference : undefined;
  if (typeof reference !== "string") return "bad_response";
  const trimmed = reference.trim();
  if (!trimmed || trimmed.length > MAX_PORTAL_REFERENCE) return "bad_response";
  return { reference: trimmed };
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}
