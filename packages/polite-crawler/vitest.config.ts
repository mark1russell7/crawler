import { defineConfig } from "vitest/config";

// Some tests pace their requests on the real clock, and the renderer test starts a browser.
// On a busy computer (a Windows runner in CI) these tests can use more than the default 5 seconds.
const limit = process.env["CI"] === undefined ? 15_000 : 30_000;

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: true,
    testTimeout: limit,
    hookTimeout: limit,
    // `pnpm test:coverage` measures the source. Each threshold is a little below the measured value.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.spec.ts"],
      reporter: ["text", "html", "json-summary"],
      thresholds: { statements: 84, branches: 72, functions: 82, lines: 88 },
    },
  },
});
