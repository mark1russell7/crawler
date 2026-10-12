import { defineConfig } from "tsdown";

// The build of the package for npm: ES modules and their declarations in build/. The workspace uses the source.
export default defineConfig({
  // the parts with no Node.js dependency are entry points of their own, so a browser can import them
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/robots.ts",
    "src/hours.ts",
    "src/html.ts",
    "src/classify.ts",
    "src/politeness.ts",
    "src/signals.ts",
  ],
  outDir: "build",
  format: "esm",
  platform: "node",
  target: "node22",
  dts: true,
  sourcemap: true,
});
