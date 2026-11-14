import { describe, expect, it, vi } from "vitest";
import { MAX_ATTEMPTS, RETRY, withRetry } from "./retry";

describe("withRetry", () => {
  it("returns the first attempt's answer that is not a retry", async () => {
    const attempt = vi.fn<() => Promise<string | typeof RETRY>>().mockResolvedValueOnce(RETRY).mockResolvedValueOnce("landed");

    await expect(withRetry(attempt, () => new Error("exhausted"))).resolves.toBe("landed");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("gives up after three attempts with the caller's error", async () => {
    const attempt = vi.fn(async () => RETRY);

    await expect(withRetry(attempt, () => new Error("kept changing"))).rejects.toThrow("kept changing");
    expect(attempt).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(MAX_ATTEMPTS).toBe(3);
  });

  it("lets an attempt's own error through without trying again", async () => {
    const attempt = vi.fn(async () => {
      throw new Error("disk on fire");
    });

    await expect(withRetry(attempt, () => new Error("exhausted"))).rejects.toThrow("disk on fire");
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
