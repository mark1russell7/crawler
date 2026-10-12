import { defineConfig } from "tsdown";

// The build of the package for npm: ES modules and their declarations in build/. The workspace uses the source.
export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  outDir: "build",
  format: "esm",
  platform: "node",
  target: "node22",
  dts: true,
  sourcemap: true,
});
