/**
 * Who is calling (technical F1, §7, decisions-g2 §10).
 *
 * A person is known only from a verified Access assertion. `DEV_USER` stands in for one on
 * loopback alone (localhost, 127.0.0.1 or [::1]), and a present assertion wins over it. Without `ACCESS_TEAM_DOMAIN` and
 * `ACCESS_AUD` every Access route fails closed. Roles come from `ROLE_REVIEWERS` and
 * `ROLE_OFFICERS`; reviewers also hold the officer role.
 *
 * The connector is known from `CONNECTOR_TOKEN`, compared in constant time.
 */
import { isLoopbackHost } from "../src/domain/hosts";
import type { Actor, Role } from "../src/domain/types";
import { verifyAccessJwt } from "./access-jwt";
import { utf8 } from "./bytes";
import type { Env } from "./env";

export type AuthFailure = { failure: "unauthenticated" | "auth_not_configured" };

/** The request was addressed to localhost, 127.0.0.1 or [::1]: a developer's machine, never the deployed desk. */
export const isLoopback = (request: Request): boolean => isLoopbackHost(new URL(request.url).hostname);

function emailsIn(list: string | undefined): Set<string> {
  return new Set(
    (list ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e !== ""),
  );
}

/** The role lists as the deployment sets them, normalised, for the settings screen to show read-only. */
export function roleLists(env: Env): { reviewers: string[]; officers: string[] } {
  return { reviewers: [...emailsIn(env.ROLE_REVIEWERS)], officers: [...emailsIn(env.ROLE_OFFICERS)] };
}

export function rolesFor(email: string, env: Env): Role[] {
  const who = email.trim().toLowerCase();
  if (emailsIn(env.ROLE_REVIEWERS).has(who)) return ["reviewer", "officer"];
  if (emailsIn(env.ROLE_OFFICERS).has(who)) return ["officer"];
  return [];
}

const person = (email: string, env: Env): Actor => ({ kind: "person", email, roles: rolesFor(email, env) });

export async function authenticate(request: Request, env: Env): Promise<Actor | AuthFailure> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  const configured = Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);

  if (assertion && configured) {
    const verified = await verifyAccessJwt(assertion, { teamDomain: env.ACCESS_TEAM_DOMAIN!, aud: env.ACCESS_AUD! });
    return verified ? person(verified.email, env) : { failure: "unauthenticated" };
  }
  if (env.DEV_USER && isLoopback(request)) return person(env.DEV_USER, env);
  return { failure: configured ? "unauthenticated" : "auth_not_configured" };
}

/**
 * The shortest connector token the desk accepts: 32 random bytes written as base64 (infra I2). A
 * shorter one counts as unset, so the import route fails closed instead of trusting a weak token.
 */
export const MIN_CONNECTOR_TOKEN_LENGTH = 43;

export const connectorConfigured = (env: Env): boolean => utf8(env.CONNECTOR_TOKEN ?? "").length >= MIN_CONNECTOR_TOKEN_LENGTH;

/**
 * Whether the request carries `Authorization: Bearer <CONNECTOR_TOKEN>`. Both sides go through HMAC
 * under a fresh random key and Web Crypto's verify compares the digests, so the time taken says
 * nothing about how much of the token matched.
 */
export async function checkConnectorToken(request: Request, env: Env): Promise<boolean> {
  if (!connectorConfigured(env)) return false;
  const match = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
  if (!match) return false;
  const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const expected = await crypto.subtle.sign("HMAC", key, utf8(env.CONNECTOR_TOKEN!));
  return crypto.subtle.verify("HMAC", key, expected, utf8(match[1]!));
}
