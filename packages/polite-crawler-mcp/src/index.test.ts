import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as root from "./index.ts";

const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<string, unknown>;

describe("the package polite-crawler-mcp", () => {
  it("has the version of package.json, and the name of its MCP registry entry", () => {
    const manifest = read("../package.json");
    const registry = read("../../../server.json") as {
      name: string;
      version: string;
      packages: Array<{ identifier: string; version: string; packageArguments?: unknown }>;
    };
    expect(root.VERSION).toBe(manifest["version"]);
    expect(manifest["mcpName"]).toBe(registry.name);
    expect(registry.packages[0]).toMatchObject({ identifier: "polite-crawler-mcp" });
    expect(registry.packages[0]?.packageArguments).toBeUndefined();
  });

  it("exports the server, the HTTP server, the daemon host and the tools", () => {
    for (const name of [
      "createMcpServer",
      "startMcpServer",
      "startMcpHttpServer",
      "serveMcpHttp",
      "crawlTools",
      "crawlHostOptions",
      "crawlContent",
      "makeToken",
      "sameToken",
      "checkToken",
    ]) {
      expect(typeof (root as Record<string, unknown>)[name], name).toBe("function");
    }
    expect(typeof root.mcpHttpHost.start).toBe("function");
    expect(root.MCP_HTTP_DEFAULTS).toMatchObject({ port: 9307, path: "/mcp", maxSessions: 32 });
  });
});
