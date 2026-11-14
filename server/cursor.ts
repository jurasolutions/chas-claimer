/**
 * Opaque list cursors: a JSON position, base64url-encoded. The repo that issues a cursor checks the
 * shape of what decodes; a cursor that does not decode at all comes back as `undefined`.
 */
import { base64UrlDecode, base64UrlEncode, utf8 } from "./bytes";

export const encodeCursor = (position: unknown): string => base64UrlEncode(utf8(JSON.stringify(position)));

export function decodeCursor(cursor: string): unknown {
  const bytes = base64UrlDecode(cursor);
  if (!bytes) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}
