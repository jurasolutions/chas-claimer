/**
 * A stand-in for a Cloudflare Access team: an RSA key set generated per test file and JWTs signed
 * with it, so `verifyAccessJwt` is tested against real RS256 signatures without the network.
 */
import { TEST_AUD, TEST_TEAM_DOMAIN } from "./env";
import { jsonAnswer, stubNetwork } from "./network";

const RS256 = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const b64urlJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

export interface AccessTeam {
  kid: string;
  jwks: { keys: JsonWebKey[] };
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

export async function accessTeam(kid = "test-kid-1"): Promise<AccessTeam> {
  const pair = (await crypto.subtle.generateKey(RS256, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kid,
    jwks: { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" } as JsonWebKey] },
    async sign(claims, header = {}) {
      const signingInput = `${b64urlJson({ alg: "RS256", kid, typ: "JWT", ...header })}.${b64urlJson(claims)}`;
      const signature = await crypto.subtle.sign(RS256.name, pair.privateKey, new TextEncoder().encode(signingInput));
      return `${signingInput}.${b64url(new Uint8Array(signature))}`;
    },
  };
}

/** Claims Access would put in the assertion for `email`, valid for ten minutes from now. */
export function accessClaims(email: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: [TEST_AUD],
    email,
    iss: `https://${TEST_TEAM_DOMAIN}`,
    iat: now,
    nbf: now,
    exp: now + 600,
    sub: "00000000-0000-0000-0000-000000000001",
    type: "app",
    ...overrides,
  };
}

/** Serves `team`'s key set at the team domain's certs URL; every other URL still throws. */
export function stubAccessCerts(team: AccessTeam, teamDomain = TEST_TEAM_DOMAIN) {
  return stubNetwork({ [`https://${teamDomain}/cdn-cgi/access/certs`]: jsonAnswer({ keys: team.jwks.keys }) });
}
