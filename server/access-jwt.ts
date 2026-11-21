/**
 * Cloudflare Access assertion verification (technical F1). The `Cf-Access-Authenticated-User-Email`
 * header is never trusted: it can be forged on any hostname Access does not sit in front of. Only an
 * RS256 `Cf-Access-Jwt-Assertion` signed by the team's keys, for this application's audience, issued
 * by the team and unexpired, yields an email.
 *
 * The team's key set is cached in module scope for ten minutes. A token naming a key the cache does
 * not hold triggers one early refresh (Access rotates keys), at most once a minute.
 */
import { base64UrlDecode, utf8 } from "./bytes";

const KEY_SET_TTL_MS = 10 * 60 * 1000;
const MIN_REFRESH_MS = 60 * 1000;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

interface KeySet {
  fetchedAt: number;
  keys: Map<string, JsonWebKey>;
}

const keySets = new Map<string, KeySet>();

async function fetchKeySet(teamDomain: string): Promise<KeySet | null> {
  try {
    // "manual", not "error": the Workers runtime throws on "error". A redirect then arrives as a
    // response that is not ok, so the key set is still never read from anywhere but the team domain.
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { redirect: "manual" });
    if (!res.ok) return null;
    const body = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) return null;
    const keys = new Map<string, JsonWebKey>();
    for (const k of body.keys as (JsonWebKey & { kid?: unknown })[]) {
      if (k && typeof k.kid === "string" && k.kty === "RSA") keys.set(k.kid, k);
    }
    const set = { fetchedAt: Date.now(), keys };
    keySets.set(teamDomain, set);
    return set;
  } catch {
    return null;
  }
}

async function keyFor(teamDomain: string, kid: string): Promise<JsonWebKey | null> {
  let set = keySets.get(teamDomain);
  const age = set ? Date.now() - set.fetchedAt : Infinity;
  if (!set || age > KEY_SET_TTL_MS || (!set.keys.has(kid) && age > MIN_REFRESH_MS)) {
    set = (await fetchKeySet(teamDomain)) ?? set;
  }
  return set?.keys.get(kid) ?? null;
}

function decodeJson(part: string): Record<string, unknown> | null {
  const bytes = base64UrlDecode(part);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The verified email, or null for anything short of a valid assertion for this application. */
export async function verifyAccessJwt(token: string, cfg: { teamDomain: string; aud: string }): Promise<{ email: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeJson(headerPart);
  const claims = decodeJson(payloadPart);
  const signature = base64UrlDecode(signaturePart);
  if (!header || !claims || !signature) return null;
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const jwk = await keyFor(cfg.teamDomain, header.kid);
  if (!jwk) return null;
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, RS256, false, ["verify"]);
    valid = await crypto.subtle.verify(RS256.name, key, signature, utf8(`${headerPart}.${payloadPart}`));
  } catch {
    return null;
  }
  if (!valid) return null;

  const now = Date.now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(cfg.aud)) return null;
  if (claims.iss !== `https://${cfg.teamDomain}`) return null;
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + 60)) return null;
  if (typeof claims.email !== "string" || claims.email === "") return null;
  return { email: claims.email };
}
