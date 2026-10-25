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
//
// The text of the descriptions is not part of the contract: a model reads it, and a program does not.
// A session reads the tool list at each turn, so the descriptions are shorter than in 0.1.4
// (tool-cost.test.ts counts them). The names, the titles, the schemas, the hints and the tasks stay.

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

/** This function removes the text of each `description` keyword of a schema, at each depth. */
const noText = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(noText);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      // a property named description has a schema as its value, not a string
      .filter(([key, inner]) => key !== "description" || typeof inner !== "string")
      .map(([key, inner]) => [key, noText(inner)]),
  );
};

/**
 * This function removes the differences that mean the same for a client. A schema without
 * `$schema` is a schema of the same draft. No `execution` and `taskSupport: "forbidden"` both tell that
 * the tool is not an MCP task. The text of the descriptions can change.
 */
const same = (tool: Tool): Tool => {
  const schema = (
    value: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined => {
    if (value === undefined) return undefined;
    const { $schema: _draft, ...rest } = value;
    return noText(rest) as Record<string, unknown>;
  };
  const task = tool.execution?.taskSupport;
  return {
    name: tool.name,
    title: tool.title,
    description: typeof tool.description === "string" && tool.description !== "",
    inputSchema: schema(tool.inputSchema),
    outputSchema: schema(tool.outputSchema),
    annotations: tool.annotations,
    execution: task === undefined || task === "forbidden" ? undefined : { taskSupport: task },
  };
};

/** This function gives the paths of the input properties that have a description. */
const described = (tool: Tool): string[] =>
  Object.entries(
    (tool.inputSchema?.["properties"] ?? {}) as Record<string, { description?: unknown }>,
  )
    .filter(([, property]) => typeof property.description === "string")
    .map(([name]) => `${tool.name}.${name}`);

const byName = (a: Tool, b: Tool): number => a.name.localeCompare(b.name);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("the tool list of polite-crawler-mcp", () => {
  it("is the tool list of polite-crawler 0.1.4: names, titles, schemas, hints and tasks", async () => {
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
    // each parameter that had a description in 0.1.4 still has one
    expect((tools as Tool[]).flatMap(described).sort()).toEqual(before.flatMap(described).sort());
  });
});
