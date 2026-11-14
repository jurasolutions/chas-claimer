/**
 * Byte and base64 helpers that run the same in Workers and in Node. Ported from the landing page's
 * `server/crypto.js`, typed.
 */
const encoder = new TextEncoder();

export const utf8 = (text: string): Uint8Array => encoder.encode(text);

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Null when `text` is not base64. */
export function base64ToBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export const base64UrlEncode = (bytes: Uint8Array): string =>
  bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Null when `text` is not base64url. */
export function base64UrlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return base64ToBytes(padded);
}

export const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The SHA-256 of `text`'s UTF-8 bytes, as lowercase hex. */
export const sha256Hex = async (text: string): Promise<string> => toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text))));

/**
 * A request's or a response's body as text, or null when it runs past `maxBytes`. A declared
 * Content-Length over the cap is refused before reading, and the rest of a long body is never read.
 */
export async function readCapped(message: Request | Response, maxBytes: number): Promise<string | null> {
  if (Number(message.headers.get("Content-Length") ?? 0) > maxBytes) {
    await message.body?.cancel();
    return null;
  }
  if (!message.body) return "";
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
