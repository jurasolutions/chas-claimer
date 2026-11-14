/**
 * The connector's side of `POST /api/imports`: one page of visits per request, the bearer
 * `CONNECTOR_TOKEN` and, when set, the Cloudflare Access service token (decisions-g2 #15).
 *
 * A 5xx, a dropped connection or a timeout is retried three times; the import is idempotent (an
 * unchanged visit writes nothing), so sending a page twice is safe. A refusal is never retried.
 * Outcomes carry status codes, error codes and positions only, never a value from a visit.
 */
import type { ImportSummary } from "../src/api/imports";
import { isLoopbackHost } from "../src/domain/hosts";
import { err, ok, type Result } from "../src/domain/result";
import type { SourceVisit } from "../src/domain/source-visit";

export interface Desk {
  /** The desk's origin, no trailing slash. */
  url: string;
  token: string;
  access?: { clientId: string; clientSecret: string };
}

export type PostOutcome =
  | { kind: "imported"; summary: ImportSummary }
  /** The desk answered 401: `CONNECTOR_TOKEN` is wrong or not set on the desk. */
  | { kind: "token_refused" }
  /** Cloudflare Access stopped the request before it reached the desk: a redirect, or a 401/403 page that is not the desk's JSON. */
  | { kind: "access_refused"; status: number }
  /** The desk refused the page with its own error code; `indexes` are positions in the page. */
  | { kind: "refused"; status: number; code: string; indexes?: number[] }
  /** No answer worth keeping after every attempt: the last 5xx status, or none when the connection failed. */
  | { kind: "unreachable"; status?: number; code?: string }
  /** An answer that is neither the desk's summary nor its error. */
  | { kind: "unexpected"; status: number };

export interface PostOptions {
  /** Waits between attempts; a test passes one that returns at once. */
  wait?: (ms: number) => Promise<void>;
  /** How long one attempt may take before it counts as a dropped connection. */
  timeoutMs?: number;
}

/** The waits before the first, second and third retry. */
const BACKOFF_MS = [1000, 2000, 4000];

/** How many times a page is sent again after a 5xx, a dropped connection or a timeout. */
export const RETRIES = BACKOFF_MS.length;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function postVisits(desk: Desk, visits: readonly SourceVisit[], opts: PostOptions = {}): Promise<PostOutcome> {
  const wait = opts.wait ?? sleep;
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${desk.token}` };
  if (desk.access) {
    headers["CF-Access-Client-Id"] = desk.access.clientId;
    headers["CF-Access-Client-Secret"] = desk.access.clientSecret;
  }
  const body = JSON.stringify({ visits });

  let last: PostOutcome = { kind: "unreachable" };
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    if (attempt > 0) await wait(BACKOFF_MS[attempt - 1]!);
    let res: Response;
    try {
      res = await fetch(`${desk.url}/api/imports`, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
    } catch {
      last = { kind: "unreachable" };
      continue;
    }
    const answer = await read(res);
    if (res.status >= 500) {
      last = { kind: "unreachable", status: res.status, ...(answer.code ? { code: answer.code } : {}) };
      continue;
    }
    return outcome(res.status, answer);
  }
  return last;
}

interface Answer {
  json: unknown;
  code?: string;
}

async function read(res: Response): Promise<Answer> {
  const type = (res.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") {
    await res.body?.cancel();
    return { json: undefined };
  }
  try {
    const json: unknown = await res.json();
    const code = isRecord(json) && typeof json.error === "string" ? json.error : undefined;
    return { json, ...(code ? { code } : {}) };
  } catch {
    return { json: undefined };
  }
}

function outcome(status: number, answer: Answer): PostOutcome {
  if (status >= 300 && status < 400) return { kind: "access_refused", status };
  if (status === 200 && isSummary(answer.json)) return { kind: "imported", summary: answer.json };
  if (!answer.code) return status === 401 || status === 403 ? { kind: "access_refused", status } : { kind: "unexpected", status };
  if (status === 401) return { kind: "token_refused" };
  const indexes = isRecord(answer.json) && Array.isArray(answer.json.indexes) ? answer.json.indexes.filter((i): i is number => Number.isInteger(i)) : undefined;
  return { kind: "refused", status, code: answer.code, ...(indexes ? { indexes } : {}) };
}

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u);

function isSummary(u: unknown): u is ImportSummary {
  return (
    isRecord(u) &&
    typeof u.importId === "string" &&
    ["received", "new", "changed", "unchanged", "flagged", "refused"].every((k) => typeof u[k] === "number") &&
    Array.isArray(u.ignored) &&
    Array.isArray(u.refusedVisits)
  );
}

/**
 * The desk's address and tokens, from the environment only: `CLAIMS_DESK_URL`, `CONNECTOR_TOKEN`,
 * and the pair `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`. The pair is required for any desk
 * not on this machine (decisions-g2 #15), and optional on loopback, where no Access stands in front.
 * The error names variables, never a value.
 */
export function deskFromEnv(env: Record<string, string | undefined>): Result<Desk, string> {
  const get = (name: string) => {
    const v = env[name]?.trim();
    return v ? v : undefined;
  };
  const rawUrl = get("CLAIMS_DESK_URL");
  const token = get("CONNECTOR_TOKEN");
  const clientId = get("CF_ACCESS_CLIENT_ID");
  const clientSecret = get("CF_ACCESS_CLIENT_SECRET");

  const missing = [!rawUrl && "CLAIMS_DESK_URL", !token && "CONNECTOR_TOKEN"].filter((m): m is string => typeof m === "string");
  if (missing.length > 0) return err(`Set ${missing.join(" and ")} in the environment.`);

  let url: URL;
  try {
    url = new URL(rawUrl!);
  } catch {
    return err("CLAIMS_DESK_URL is not a URL.");
  }
  const local = isLoopbackHost(url.hostname);
  const secure = url.protocol === "https:" || (url.protocol === "http:" && local);
  if (!secure) return err("CLAIMS_DESK_URL must start with https:// (plain http is allowed only for this machine).");
  if (url.username || url.password || url.search || url.hash) return err("CLAIMS_DESK_URL must be the desk's address only, with no credentials, query or fragment.");

  if (!clientId || !clientSecret) {
    const absent = [!clientId && "CF_ACCESS_CLIENT_ID", !clientSecret && "CF_ACCESS_CLIENT_SECRET"].filter((m): m is string => typeof m === "string");
    if (!local) {
      return err(`Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, the desk's Cloudflare Access service token: a desk that is not on this machine needs both. Missing: ${absent.join(" and ")}.`);
    }
    if (absent.length === 1) return err(`Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither: ${absent[0]} is missing.`);
  }

  return ok({
    url: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
    token: token!,
    ...(clientId && clientSecret ? { access: { clientId, clientSecret } } : {}),
  });
}
