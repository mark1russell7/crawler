import { defineConfig } from "vitest/config";

// The tests start MCP servers, local sites and child processes. On a busy computer (a Windows
// runner in CI) these tests can use more than the default 5 seconds.
const limit = process.env["CI"] === undefined ? 15_000 : 30_000;

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: true,
    testTimeout: limit,
    hookTimeout: limit,
  },
});
