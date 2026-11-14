import fc from "fast-check";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * Property tests run from a fixed seed so a red run reproduces exactly. Set `FC_SEED` to explore
 * other seeds; `numRuns` is never below 100. Pin every counterexample found as an `examples:` entry.
 */
const seed = Number.parseInt(process.env.FC_SEED ?? "", 10);
fc.configureGlobal({ seed: Number.isFinite(seed) ? seed : 20_261_113, numRuns: 100 });

/**
 * Any test that reaches the network without stubbing `fetch` first fails
 * loudly. This keeps the suite from ever calling Anthropic or a payer portal.
 */
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      throw new Error(`Unexpected network request in a test: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
