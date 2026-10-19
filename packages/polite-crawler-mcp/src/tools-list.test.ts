import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpTaskStore } from "@procedures/mcp-server";
import { openCrawler } from "polite-crawler";
import { afterEach, describe, expect, it } from "vitest";
import { removeDir, tempDir } from "../../polite-crawler/src/test-surfaces.ts";
import { createMcpServer } from "./server.ts";

// The tool list of polite-crawler 0.1.4: its MCP server (src/mcp.ts of that version) with a task store,
// as an MCP client lists it. The tools of 0.2.0 are procedures on the shared MCP host, and the host
// makes their JSON Schemas with its own converter. The list must not change for a client.

interface Tool {
  readonly name: string;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly inputSchema?: Record<string, unknown> | undefined;
  readonly outputSchema?: Record<string, unknown> | undefined;
  readonly annotations?: unknown;
  readonly execution?: { readonly taskSupport?: unknown } | undefined;
}

const before = JSON.parse(
  readFileSync(new URL("../test/tools-0.1.4.json", import.meta.url), "utf8"),
) as Tool[];

/**
 * This function removes the two differences that mean the same for a client. A schema without
 * `$schema` is a schema of the same draft. No `execution` and `taskSupport: "forbidden"` both tell that
 * the tool is not an MCP task.
 */
const same = (tool: Tool): Tool => {
  const schema = (
    value: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined => {
    if (value === undefined) return undefined;
    const { $schema: _draft, ...rest } = value;
    return rest;
  };
  const task = tool.execution?.taskSupport;
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: schema(tool.inputSchema),
    outputSchema: schema(tool.outputSchema),
    annotations: tool.annotations,
    execution: task === undefined || task === "forbidden" ? undefined : { taskSupport: task },
  };
};

const byName = (a: Tool, b: Tool): number => a.name.localeCompare(b.name);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("the tool list of polite-crawler-mcp", () => {
  it("is the tool list of polite-crawler 0.1.4: names, titles, descriptions, schemas, hints and tasks", async () => {
    const dir = await tempDir("tools-list");
    cleanups.push(() => removeDir(dir));
    const crawler = openCrawler({ dir, renderer: false, contact: "ops@example.com" });
    cleanups.push(() => crawler.close());
    const server = createMcpServer(crawler, { tasks: new McpTaskStore() });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    cleanups.push(() => server.close());
    const client = new Client({ name: "tools-list", version: "0" });
    await client.connect(clientSide);
    cleanups.push(() => client.close());

    const { tools } = await client.listTools();
    expect(before).toHaveLength(9);
    expect((tools as Tool[]).map(same).sort(byName)).toEqual(before.map(same).sort(byName));
  });
});
