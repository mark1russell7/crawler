import { defineConfig } from "tsdown";

// The build of the package for npm: ES modules and their declarations in build/. The workspace uses the source.
export default defineConfig({
  // The parts with no Node.js dependency are entry points of their own, so a browser can import them.
  // The MCP server is an entry point of its own too, so only `polite-crawler/mcp` loads the MCP SDK and zod.
  entry: [
    "src/index.ts",
    "src/mcp.ts",
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
  // A declaration map points at src/, and the package does not contain src/. Thus the build makes no declaration maps.
  dts: { sourcemap: false },
  sourcemap: true,
});
