/**
 * Every API route file is one call to `route()`. Authentication runs inside the handler rather than
 * in a `_middleware`, so a test that calls `onRequest*` directly goes through it too.
 *
 * In order, a route:
 * 0. if it is switched off for this deployment (`enabled`), answers 404 `not_found` and nothing else;
 * 1. refuses a mutation without `Content-Type: application/json` (403 `json_required`), and on an
 *    Access route one whose `Origin` is not the request's own (403 `foreign_origin`), since Access
 *    authenticates by cookie and a cross-site form would carry it (technical F11);
 * 2. refuses a declared body over `maxBytes` (413 `too_large`);
 * 3. authenticates (401, or 503 when unconfigured) and checks roles (403 `forbidden`);
 * 4. on an `identity` route, derives the identifier keys or answers 503 `identity_not_configured`;
 * 5. runs the handler. An error the desk expects becomes its own answer (see `knownProblem`); any
 *    other answers 500 `internal`.
 * Every response it returns carries `Cache-Control: no-store`. Logs carry an error code and, where
 * the route has one, the claim ID: never a body, an identity value or a packet.
 */
import type { ErrorCode } from "../src/api/common";
import type { Result } from "../src/domain/result";
import { err, ok } from "../src/domain/result";
import type { Actor, Role } from "../src/domain/types";
import type { ValidationIssue } from "../src/domain/validation";
import { authenticate, checkConnectorToken, connectorConfigured, isLoopback } from "./auth";
import { readCapped } from "./bytes";
import { identifierKeys, type IdentifierKeys } from "./crypto";
import type { Env } from "./env";
import { RealIdentifierRefusedError } from "./services/imports";

export const DEFAULT_MAX_BYTES = 256 * 1024;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface RouteContext<P> {
  request: Request;
  env: Env;
  params: P;
  actor: Actor;
  /** Milliseconds since the epoch, read once per request. */
  now: number;
}

/** The context of a route declared with `identity: true`: the spine has already checked the keys. */
export interface IdentityRouteContext<P> extends RouteContext<P> {
  keys: IdentifierKeys;
}

export interface RouteOptions {
  /**
   * Whether the route exists on this deployment. When it answers false the route is 404 `not_found`
   * before any other check, so a deployment without it says nothing about it. It sees the request
   * so a route can exist on a developer's own machine alone.
   */
  enabled?: (env: Env, request: Request) => boolean;
  auth: "access" | "connector";
  /** The actor must hold at least one. Omitted: any role. A person on neither list is always refused. */
  roles?: Role[];
  maxBytes?: number;
  /**
   * The route hashes, seals or opens identifiers. Without usable keys it answers 503
   * `identity_not_configured` before the handler runs; the published dev key counts only on loopback.
   */
  identity?: true;
}

function noStore(res: Response): Response {
  const copy = new Response(res.body, res);
  copy.headers.set("Cache-Control", "no-store");
  return copy;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function problem(status: number, code: ErrorCode, detail: Record<string, unknown> = {}): Response {
  return json({ ...detail, error: code }, status);
}

function isJson(request: Request): boolean {
  const type = request.headers.get("Content-Type") ?? "";
  return type.split(";")[0]!.trim().toLowerCase() === "application/json";
}

function browserRefusal(request: Request, opts: RouteOptions): Response | null {
  if (READ_METHODS.has(request.method)) return null;
  if (!isJson(request)) return problem(403, "json_required");
  if (opts.auth === "access" && request.headers.get("Origin") !== new URL(request.url).origin) return problem(403, "foreign_origin");
  return null;
}

async function identify(request: Request, env: Env, opts: RouteOptions): Promise<Actor | Response> {
  if (opts.auth === "connector") {
    if (!connectorConfigured(env)) return problem(503, "auth_not_configured");
    return (await checkConnectorToken(request, env)) ? { kind: "system", name: "connector" } : problem(401, "unauthenticated");
  }
  const who = await authenticate(request, env);
  if ("failure" in who) return problem(who.failure === "auth_not_configured" ? 503 : 401, who.failure);
  if (who.kind === "person") {
    if (who.roles.length === 0) return problem(403, "forbidden");
    if (opts.roles && !opts.roles.some((r) => who.roles.includes(r))) return problem(403, "forbidden");
  }
  return who;
}

/** The answer for an error a handler is expected to throw, or null for one it is not. */
function knownProblem(e: unknown): Response | null {
  if (e instanceof RealIdentifierRefusedError) return problem(422, "real_identifier_refused", { importId: e.importId, indexes: [...e.indexes] });
  return null;
}

export function route<P extends Record<string, string> = Record<string, never>>(
  opts: RouteOptions & { identity: true },
  handler: (ctx: IdentityRouteContext<P>) => Promise<Response>,
): PagesFunction<Env>;
export function route<P extends Record<string, string> = Record<string, never>>(
  opts: RouteOptions,
  handler: (ctx: RouteContext<P>) => Promise<Response>,
): PagesFunction<Env>;
export function route<P extends Record<string, string> = Record<string, never>>(
  opts: RouteOptions,
  handler: (ctx: IdentityRouteContext<P>) => Promise<Response>,
): PagesFunction<Env> {
  // The overloads pair a keys-reading handler with `identity: true`, the only case that passes keys.
  const run = handler as (ctx: RouteContext<P> & { keys?: IdentifierKeys }) => Promise<Response>;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return async ({ request, env, params }) => {
    const claimId = typeof params.id === "string" ? params.id : undefined;
    try {
      if (opts.enabled && !opts.enabled(env, request)) return problem(404, "not_found");
      const refusal = browserRefusal(request, opts);
      if (refusal) return refusal;
      if (Number(request.headers.get("Content-Length") ?? 0) > maxBytes) return problem(413, "too_large");
      const actor = await identify(request, env, opts);
      if (actor instanceof Response) return actor;
      const ctx = { request, env, params: params as P, actor, now: Date.now() };
      if (!opts.identity) return noStore(await run(ctx));
      const keys = await identifierKeys(env, { loopback: isLoopback(request) });
      if (!keys) return problem(503, "identity_not_configured");
      return noStore(await run({ ...ctx, keys }));
    } catch (e) {
      const known = knownProblem(e);
      if (known) return known;
      console.error(JSON.stringify({ code: "internal", ...(claimId ? { claimId } : {}) }));
      return problem(500, "internal");
    }
  };
}

function issuesFrom(error: unknown): ValidationIssue[] {
  const isIssue = (i: unknown): i is ValidationIssue =>
    typeof i === "object" && i !== null && typeof (i as ValidationIssue).path === "string" && typeof (i as ValidationIssue).message === "string";
  return Array.isArray(error) ? error.filter(isIssue).map(({ path, message }) => ({ path, message })) : [];
}

/** The parsed body, or the response to send instead: 413 `too_large` or 400 `invalid` (paths, never values). */
export async function readJson<T>(request: Request, parse: (u: unknown) => Result<T, unknown>, maxBytes: number): Promise<Result<T, Response>> {
  const text = await readCapped(request, maxBytes);
  if (text === null) return err(problem(413, "too_large"));
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return err(problem(400, "invalid", { issues: [{ path: "", message: "The body is not valid JSON." }] }));
  }
  const parsed = parse(raw);
  return parsed.ok ? ok(parsed.value) : err(problem(400, "invalid", { issues: issuesFrom(parsed.error) }));
}
