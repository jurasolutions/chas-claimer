/**
 * The Pages Functions environment: the D1 binding and every variable the desk reads. Values are set
 * in Cloudflare Pages environment variables (or `.dev.vars` locally), never in a file in the repo.
 * The README's environment table describes each one.
 */
export interface Env {
  DB: D1Database;
  /** `<team>.cloudflareaccess.com`. With `ACCESS_AUD`, required: every Access route fails closed without both. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Local development only: honoured only when the request's host is localhost or 127.0.0.1. */
  DEV_USER?: string;
  /** Comma-separated emails. Reviewers also hold the officer role. */
  ROLE_REVIEWERS?: string;
  ROLE_OFFICERS?: string;
  /** At least 43 characters (32 random bytes in base64); valid only on `POST /api/imports`. */
  CONNECTOR_TOKEN?: string;
  /** 32 bytes, base64. Identity routes fail closed without it. */
  IDENTIFIER_KEY?: string;
  /** `IDENTIFIER_KEY`'s version, 1 to 999; unset means 1. Raise it by one with each new key. */
  IDENTIFIER_KEY_VERSION?: string;
  /** During a rotation only: the previous key, one version back, until the re-seal route reports nothing left. */
  IDENTIFIER_KEY_PREVIOUS?: string;
  /** `yes` lets a non-synthetic NRIC through the import guard. */
  ALLOW_REAL_IDENTIFIERS?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  /** Default 200. */
  AI_DAILY_CALL_CAP?: string;
  /** `yes` enables the synthetic clinic import. */
  DEMO_MODE?: string;
  [payerToken: `PAYER_${string}_API_TOKEN`]: string | undefined;
}
