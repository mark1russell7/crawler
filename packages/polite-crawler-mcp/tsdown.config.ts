import { defineConfig } from "tsdown";

// The build of the package for npm: ES modules and their declarations in build/. The workspace uses the source.
export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  outDir: "build",
  format: "esm",
  platform: "node",
  target: "node22",
  // A declaration map points at src/, and the package does not contain src/. Thus the build makes no declaration maps.
  dts: { sourcemap: false },
  sourcemap: true,
});
