import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Unit and integration tests. Pages Functions are called directly as
 * `onRequest({ request, env })` against an in-memory D1 built on sql.js with
 * the real migrations applied. UI tests run in jsdom (per-file
 * `// @vitest-environment jsdom`).
 *
 * Nothing here reaches the network. Every outbound `fetch` is stubbed per
 * test, and a stray real request fails the test (tests/setup.ts).
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}", "server/**/*.test.ts", "functions/**/*.test.ts", "tests/**/*.test.{ts,tsx}", "connector/**/*.test.ts", "mock/**/*.test.ts"],
    exclude: ["node_modules", "dist", ".claude/worktrees/**"],
    setupFiles: ["tests/setup.ts"],
  },
});
