/**
 * The page's only way to reach the server. Paths are same-origin and absolute ("/api/me"); the
 * response types come from `src/api/*`, never from server code.
 *
 * Errors arrive as `{ error: code }` (technical §6) and surface as an `ApiError`. The page owns
 * the words, so nothing here turns a code into a sentence. The UI never computes an amount: it
 * formats the `Cents` the server sends.
 */
import { ERROR_CODES, type ErrorCode, type ProblemBody } from "../api/common";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly body: ProblemBody,
  ) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

const sessionListeners = new Set<() => void>();

/**
 * Hear when the sign-in session has ended (infra I4, review S-4). Once a session expires, Access
 * answers `/api` calls with a redirect to its sign-in page on another origin. Requests ask `fetch`
 * not to follow redirects, so that arrives as an opaque redirect rather than a CSP-blocked `TypeError`;
 * a 401 from the desk itself means the same. A request that never got an answer is the connection,
 * not the session, and is left to the page's own error state. Returns the function that stops listening.
 */
export function onSessionEnded(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  // The desk never redirects an `/api` call; Access does, when the session has ended.
  const init: RequestInit = { method, headers, credentials: "same-origin", redirect: "manual" };
  // Every mutation must say it is JSON, even with no body, or the server refuses it (`json_required`):
  // a cross-site form cannot set that header, which is the point of the check.
  if (method !== "GET") headers["Content-Type"] = "application/json";
  if (body !== undefined) init.body = JSON.stringify(body);

  const response = await fetch(new URL(path, window.location.href), init);
  if (response.type === "opaqueredirect") {
    sessionEnded();
    throw new ApiError(401, "unauthenticated", { error: "unauthenticated" });
  }
  if (response.status === 204) return undefined as T;
  if (response.status === 401) sessionEnded();

  const parsed: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new ApiError(response.status, codeOf(parsed), problemOf(parsed));
  return parsed as T;
}

function sessionEnded() {
  for (const listener of [...sessionListeners]) listener();
}

function codeOf(body: unknown): ErrorCode {
  const code = (body as { error?: unknown } | undefined)?.error;
  return (ERROR_CODES as readonly unknown[]).includes(code) ? (code as ErrorCode) : "internal";
}

function problemOf(body: unknown): ProblemBody {
  const code = codeOf(body);
  return body && typeof body === "object" ? { ...(body as Record<string, unknown>), error: code } : { error: code };
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  delete: <T = void>(path: string) => request<T>("DELETE", path),
};
