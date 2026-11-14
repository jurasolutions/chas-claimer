import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "./hosts";

describe("isLoopbackHost", () => {
  it("is true for this machine's names only, as URL.hostname gives them", () => {
    for (const url of ["http://localhost:8788/", "http://127.0.0.1/", "http://[::1]:8788/"]) expect(isLoopbackHost(new URL(url).hostname)).toBe(true);
    for (const url of ["https://claims.example.test/", "http://localhost.example.test/", "http://127.0.0.2/", "http://10.0.0.1/"]) {
      expect(isLoopbackHost(new URL(url).hostname)).toBe(false);
    }
  });
});
