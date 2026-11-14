/**
 * Builds requests the way a browser on the deployed desk would send them, and calls a Pages Function
 * the way the Pages runtime does: `{ request, env, params }`.
 */
import type { Env } from "../../server/env";

export const SITE = "https://claims.example.test";

export interface RequestOptions {
  method?: string;
  /** Sent as a JSON body with `Content-Type: application/json`. */
  json?: unknown;
  /** A raw body, sent as given. */
  body?: string;
  /** Defaults to the request's own origin on a mutation; pass null to leave it out. */
  origin?: string | null;
  /** The Access assertion to send in `Cf-Access-Jwt-Assertion`. */
  jwt?: string;
  headers?: Record<string, string>;
  /** Defaults to SITE. */
  site?: string;
}

export function apiRequest(path: string, opts: RequestOptions = {}): Request {
  const site = opts.site ?? SITE;
  const method = opts.method ?? (opts.json !== undefined || opts.body !== undefined ? "POST" : "GET");
  const headers = new Headers();
  if (opts.json !== undefined) headers.set("Content-Type", "application/json");
  const origin = opts.origin === undefined ? (method === "GET" || method === "HEAD" ? null : new URL(site).origin) : opts.origin;
  if (origin !== null) headers.set("Origin", origin);
  if (opts.jwt) headers.set("Cf-Access-Jwt-Assertion", opts.jwt);
  for (const [name, value] of Object.entries(opts.headers ?? {})) headers.set(name, value);
  const body = opts.json !== undefined ? JSON.stringify(opts.json) : opts.body;
  return new Request(new URL(path, site), { method, headers, body });
}

type Handler = PagesFunction<Env>;

export async function call(handler: Handler, request: Request, env: Env, params: Record<string, string> = {}): Promise<Response> {
  const context = {
    request,
    env,
    params,
    data: {},
    functionPath: new URL(request.url).pathname,
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null, { status: 404 }),
  } as unknown as Parameters<Handler>[0];
  return handler(context);
}
