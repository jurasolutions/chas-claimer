/**
 * Identifier keys (ADR 0006, technical.md F2, infra I1). `IDENTIFIER_KEY` (32 random bytes, base64)
 * is the current key, at `IDENTIFIER_KEY_VERSION` (default 1). Each key is HKDF'd into a
 * `match/v<n>` HMAC key for patient and content hashes and an `identity/v<n>` AES-GCM key for the
 * sealed identity part of each revision, and every stored value carries its `v<n>:` prefix.
 *
 * During a rotation `IDENTIFIER_KEY_PREVIOUS` holds the previous key, one version back: values under it
 * still open and still match until the re-seal route has moved every row to the current version.
 * No key, no identity work: callers fail closed when `identifierKeys` returns null.
 */
import type { Nric } from "../src/domain/nric";
import type { VisitIdentity } from "../src/domain/source-visit";
import { base64ToBytes, base64UrlDecode, base64UrlEncode, toHex, utf8 } from "./bytes";
import type { Env } from "./env";

/** One key at one version: the prefix its values carry and the two keys derived from it. */
export interface KeyVersion {
  readonly version: number;
  readonly prefix: string;
  readonly match: CryptoKey;
  readonly identity: CryptoKey;
}

export interface IdentifierKeys {
  /** Writes every new value. */
  readonly current: KeyVersion;
  /** The key one version back, set only while a rotation is under way. */
  readonly previous: KeyVersion | null;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const SALT = utf8("chas-claimer/identifier-key");
/** 1 to 999, written plainly: "01" or "1.5" is a typo, not a version. */
const VERSION_TEXT = /^[1-9]\d{0,2}$/;
const PREFIX = /^v[1-9]\d{0,2}:/;

/**
 * SHA-256 of the key `npm run dev:functions` binds, which package.json publishes. Comparing a
 * fingerprint keeps the key itself out of the server code.
 */
const DEV_KEY_FINGERPRINT = "329ecd5876634fc92edadf97b430ba69ff5aa086bec8e5b97dafd1873df913de";

export interface IdentifierKeyOptions {
  /** The request came to localhost, 127.0.0.1 or [::1]: the only place the published dev key works. */
  readonly loopback?: boolean;
}

/** The raw key, or null when it is not base64 or not exactly 32 bytes. */
function rawKey(text: string): Uint8Array | null {
  const raw = base64ToBytes(text);
  return raw && raw.length === KEY_BYTES ? raw : null;
}

const isDevKey = async (raw: Uint8Array): Promise<boolean> =>
  toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", raw))) === DEV_KEY_FINGERPRINT;

async function keyVersion(raw: Uint8Array, version: number): Promise<KeyVersion> {
  const root = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  const derive = (info: string, algorithm: HmacKeyGenParams | AesKeyGenParams, usages: KeyUsage[]) =>
    crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: SALT, info: utf8(info) }, root, algorithm, false, usages);
  return {
    version,
    prefix: `v${version}:`,
    match: await derive(`match/v${version}`, { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
    identity: await derive(`identity/v${version}`, { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
  };
}

/**
 * Null, so the caller fails closed, when:
 * - the current key is missing, not base64 or not exactly 32 bytes;
 * - the version is not a whole number from 1 to 999;
 * - a previous key is set at version 1 (there is no version 0), is malformed, or is the current key again;
 * - either key is the published dev key outside loopback.
 * An empty string counts as unset, as Cloudflare's dashboard leaves a cleared variable.
 */
export async function identifierKeys(env: Env, opts: IdentifierKeyOptions = {}): Promise<IdentifierKeys | null> {
  const raw = env.IDENTIFIER_KEY ? rawKey(env.IDENTIFIER_KEY) : null;
  if (!raw) return null;
  const versionText = env.IDENTIFIER_KEY_VERSION || "1";
  if (!VERSION_TEXT.test(versionText)) return null;
  const version = Number(versionText);

  let previousRaw: Uint8Array | null = null;
  if (env.IDENTIFIER_KEY_PREVIOUS) {
    previousRaw = rawKey(env.IDENTIFIER_KEY_PREVIOUS);
    if (!previousRaw || version === 1 || toHex(previousRaw) === toHex(raw)) return null;
  }
  if (!opts.loopback && ((await isDevKey(raw)) || (previousRaw !== null && (await isDevKey(previousRaw))))) return null;

  return {
    current: await keyVersion(raw, version),
    previous: previousRaw ? await keyVersion(previousRaw, version - 1) : null,
  };
}

/** The prefix every value written now carries; a stored value without it waits for the re-seal route. */
export const currentPrefix = (k: IdentifierKeys): string => k.current.prefix;

/** The current key's version, stored beside hashes that can't be re-keyed. */
export const currentVersion = (k: IdentifierKeys): number => k.current.version;

/** The keys in use, current first. */
const inUse = (k: IdentifierKeys): KeyVersion[] => (k.previous ? [k.current, k.previous] : [k.current]);

async function keyedHash(key: KeyVersion, domain: string, text: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key.match, utf8(`${domain}\u0000${text}`));
  return key.prefix + toHex(new Uint8Array(mac));
}

/** The key a patient is matched on across visits, without storing the NRIC itself. */
export const patientHash = (k: IdentifierKeys, nric: Nric): Promise<string> => keyedHash(k.current, "patient", nric);

/**
 * The patient's hash under every key in use, current first. While a rotation is under way a
 * returning patient's earlier rows may still carry the previous key's hash.
 */
export const patientHashes = (k: IdentifierKeys, nric: Nric): Promise<string[]> =>
  Promise.all(inUse(k).map((key) => keyedHash(key, "patient", nric)));

/** A keyed fingerprint of a canonical revision, so a re-import of the same content is a no-op. */
export const contentHash = (k: IdentifierKeys, canonical: string): Promise<string> => keyedHash(k.current, "content", canonical);

/** The content's hash under every key in use, current first, as `patientHashes`. */
export const contentHashes = (k: IdentifierKeys, canonical: string): Promise<string[]> =>
  Promise.all(inUse(k).map((key) => keyedHash(key, "content", canonical)));

/** The `visit_revisions` row a sealed identity belongs to. */
export interface SealedRow {
  readonly visitKey: string;
  readonly revision: number;
}

/**
 * The row is the seal's additional authenticated data, so a blob copied onto another visit or
 * revision fails to open instead of naming the wrong patient. The revision is a whole number and
 * comes last, so `visitKey:revision` cannot be read two ways.
 */
function rowData(row: SealedRow): Uint8Array {
  if (!Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error("A sealed row's revision is a whole number.");
  return utf8(`${row.visitKey}:${row.revision}`);
}

export async function sealIdentity(k: IdentifierKeys, id: VisitIdentity, row: SealedRow): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: rowData(row) }, k.current.identity, utf8(JSON.stringify(id))),
  );
  const packed = new Uint8Array(IV_BYTES + cipher.length);
  packed.set(iv);
  packed.set(cipher, IV_BYTES);
  return k.current.prefix + base64UrlEncode(packed);
}

/**
 * Opens with the key the value's prefix names, the current or the previous one. Throws on a version
 * neither key is at, malformed text, the wrong key, the wrong row, or any tampering.
 */
export async function openIdentity(k: IdentifierKeys, sealed: string, row: SealedRow): Promise<VisitIdentity> {
  const prefix = PREFIX.exec(sealed)?.[0];
  const key = prefix ? inUse(k).find((candidate) => candidate.prefix === prefix) : undefined;
  if (!prefix || !key) throw new Error("Unknown sealed identity version.");
  const packed = base64UrlDecode(sealed.slice(prefix.length));
  if (!packed || packed.length <= IV_BYTES) throw new Error("Malformed sealed identity.");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: packed.slice(0, IV_BYTES), additionalData: rowData(row) },
    key.identity,
    packed.slice(IV_BYTES),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as VisitIdentity;
}
