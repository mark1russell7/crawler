import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_POINTER, McpPackageMissing, loadMcpPackage } from "./mcp-package.ts";
import { removeDir, runCli, tempDir } from "./test-surfaces.ts";

// The MCP server is the package polite-crawler-mcp since 0.2.0. polite-crawler loads it only for
// `polite-crawler mcp` and the MCP server of the daemon, and it tells where the server is when the
// package is not there. polite-crawler-mcp tests the server.

const SRC = dirname(fileURLToPath(import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("the MCP server of polite-crawler 0.2.0", () => {
  it("tells where the MCP server is when polite-crawler-mcp is not there", async () => {
    const dir = await tempDir("no-mcp");
    cleanups.push(() => removeDir(dir));
    await expect(loadMcpPackage(dir)).rejects.toBeInstanceOf(McpPackageMissing);
    await expect(loadMcpPackage(dir)).rejects.toThrow(/npx polite-crawler-mcp/);
    const ran = await runCli(["mcp", "--dir", join(dir, "store")], { cwd: dir });
    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain(MCP_POINTER);
    expect(ran.stdout).toBe("");
  }, 60_000);

  it("loads no MCP SDK and no zod: the package does not depend on them", () => {
    const manifest = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      exports: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies)).not.toContain("@modelcontextprotocol/sdk");
    expect(Object.keys(manifest.dependencies)).not.toContain("zod");
    expect(Object.keys(manifest.exports)).not.toContain("./mcp");
    // no source file of the package imports them; the tests and their helpers can
    const sources = readdirSync(SRC).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.startsWith("test-"),
    );
    for (const name of sources) {
      const text = readFileSync(join(SRC, name), "utf8");
      expect(text, name).not.toMatch(/from "(?:zod|@modelcontextprotocol\/sdk[^"]*)"/);
    }
  });
});
