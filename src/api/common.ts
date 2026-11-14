/**
 * The request and response types every API area shares. Each area adds its own file beside this one
 * (`imports.ts`, `claims.ts`, ...); the UI is typed against these, never against server code.
 * Errors carry a code, never words: the page owns the wording (technical §6).
 */
import type { ValidationIssue } from "../domain/validation";
import type { Role } from "../domain/types";

/** An opaque position in a list. Pass `next` back as `cursor` to get the following page. */
export type Cursor = string;

/** A page of a cursor-paged list. Lists never include identity. */
export interface Page<T> {
  items: T[];
  /** Null on the last page. */
  next: Cursor | null;
}

/** The query every list route accepts. */
export interface PageQuery {
  cursor?: Cursor;
  /** 1 to 100; the route's default when absent. */
  limit?: number;
}

export const ERROR_CODES = [
  /** 400: the body or query failed validation; `issues` names the paths, never echoes a value. */
  "invalid",
  /** 401: no verified identity, or a bad connector token. Carries no detail. */
  "unauthenticated",
  /** 403: signed in but on neither role list, or the role cannot do this. */
  "forbidden",
  /** 403: a mutation without `Content-Type: application/json`. */
  "json_required",
  /** 403: a mutation whose `Origin` is not this site. */
  "foreign_origin",
  "not_found",
  "method_not_allowed",
  /** 409: `expectedVersion` is behind; reload and try again. */
  "stale",
  /** 409: the claim's status does not allow this action now; `detail` says why. */
  "not_allowed",
  /** 409: another officer has the claim's submission checklist open; carries `by` and `until`. */
  "checked_out",
  /** 409: another claim to the same payer was submitted with this `portalReference`. */
  "reference_taken",
  /** 409: the payer has no statement column mapping yet; a reviewer maps it. Carries `payerId`. */
  "columns_not_mapped",
  /**
   * 409: the payer has a statement with this file name and line count from under a retired identifier
   * key, so its content can't be compared. Carries the earlier `remittanceId`; a reviewer may confirm.
   */
  "possible_duplicate",
  /** 413: the body is over the route's limit. */
  "too_large",
  /** 422: a payment statement could not be read; `problem` names headers and line numbers, never a value. */
  "statement_unreadable",
  /** 422: a non-synthetic NRIC arrived while `ALLOW_REAL_IDENTIFIERS` is not `yes`. Never echoes it. */
  "real_identifier_refused",
  /** 503: Cloudflare Access is not configured; every Access route fails closed. */
  "auth_not_configured",
  /** 503: `IDENTIFIER_KEY` is missing or invalid; every identity route fails closed. */
  "identity_not_configured",
  /** 503: `ANTHROPIC_API_KEY` is not set; every AI route answers this before calling out. */
  "ai_not_configured",
  /** 429: today's `AI_DAILY_CALL_CAP` (SGT day) is used up. */
  "ai_cap_reached",
  /** 503: the AI service is rate-limiting; try again in a minute. */
  "ai_busy",
  /** 502: the AI service could not be reached or failed. */
  "ai_unavailable",
  /** 502: the AI answer could not be used (refused, cut off, or not what the task expects). */
  "ai_unusable",
  /** 422: the text still looked like it held an identifier after redaction, so nothing was sent. */
  "ai_identifiers_remain",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Every non-2xx JSON body: `{ error, ...detail }`. */
export type ProblemBody = { error: ErrorCode } & Record<string, unknown>;

/** The 400 body. */
export interface InvalidBody {
  error: "invalid";
  issues: ValidationIssue[];
}

/** `GET /api/me`. */
export interface MeResponse {
  email: string;
  /** Reviewers hold both roles: they can do everything officers can. */
  roles: Role[];
  /** Whether `ANTHROPIC_API_KEY` is set, so the page can show or hide AI suggestions. */
  aiConfigured: boolean;
  /**
   * Whether the synthetic clinic import and the payer simulator are on: `DEMO_MODE=yes`, or the desk
   * opened on loopback. The same test the simulator routes use.
   */
  demoMode: boolean;
}
