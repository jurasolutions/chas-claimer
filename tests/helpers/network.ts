/**
 * The network stub. `tests/setup.ts` makes every `fetch` throw; a test that needs a remote answer
 * names the exact URLs it expects here, and any other URL still throws.
 */
import { vi } from "vitest";

export type Answer = (request: Request) => Response | Promise<Response>;

export function stubNetwork(routes: Record<string, Answer>) {
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const answer = routes[request.url];
    if (!answer) throw new Error(`Unexpected network request in a test: ${request.url}`);
    return answer(request);
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

/**
 * What `fetch` with `redirect: "manual"` resolves to when Access redirects an expired session to its
 * sign-in page: an opaque redirect, status 0 and no body. A real `Response` can't be built with
 * status 0, so the fields are set on one.
 */
export const accessRedirect: Answer = () => {
  const response = new Response(null, { status: 204 });
  Object.defineProperties(response, { type: { value: "opaqueredirect" }, status: { value: 0 }, ok: { value: false } });
  return response;
};

export const jsonAnswer =
  (body: unknown, status = 200): Answer =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
