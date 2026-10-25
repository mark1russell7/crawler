/*
 * The cost of the MCP server one time in each session: the instructions and the tool list
 * (`tools/list`) that the client gives to the model. A session reads this text again at each turn.
 *
 * - The count `total` is the count of `tool_definitions` in part A of the eval (`eval/measure.mts`
 *   of polite-crawler): the cl100k proxy tokenizer of `gpt-tokenizer`, over the instructions and
 *   the JSON of the tool list.
 * - The count `sent` is the instructions and only the fields of a tool that the Claude API takes:
 *   the name, the description and the input schema. A client does not send the output schema,
 *   the title or the hints to the model.
 * - The server is the server of part A: no task store and no embedder.
 * - The test prints the counts. Start it alone to see them:
 *   `pnpm --filter polite-crawler-mcp exec vitest run src/tool-cost.test.ts --silent=false`
 * - The limits stop the cost from growing again. Change a limit only with the reason in the
 *   changelog.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openCrawler } from "polite-crawler";
import { describe, expect, it } from "vitest";
import type { Count, ToolDefinitionCount } from "../../polite-crawler/eval/measure.mts";
import { countText, countToolDefinitions } from "../../polite-crawler/eval/measure.mts";
import { removeDir, tempDir } from "../../polite-crawler/src/test-surfaces.ts";
import type { CrawlServerOptions } from "./server.ts";
import { createMcpServer } from "./server.ts";

/** The counts of one server: the instructions, the tool list, the two together, and each tool. */
interface ToolCost extends ToolDefinitionCount {
  /** This count is the instructions and the name, the description and the input schema of each tool. */
  readonly sent: Count;
  /** These counts are the JSON of each tool, all its fields. */
  readonly each: Readonly<Record<string, Count>>;
}

/** This function lists the tools of a new server, as an MCP client lists them, and counts the text. */
const toolCost = async (options: CrawlServerOptions = {}): Promise<ToolCost> => {
  const dir = await tempDir("tool-cost");
  const crawler = openCrawler({ dir, renderer: false });
  try {
    const server = createMcpServer(crawler, { onBehalfOf: ["Claude-User"], ...options });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "tool-cost", version: "0" });
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      const instructions = client.getInstructions();
      const sent = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
      return {
        ...countToolDefinitions(instructions, tools),
        sent: countText(`${instructions ?? ""}\n${JSON.stringify(sent)}`),
        each: Object.fromEntries(tools.map((tool) => [tool.name, countText(JSON.stringify(tool))])),
      };
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await crawler.close();
    await removeDir(dir);
  }
};

const report = (label: string, cost: ToolCost): string =>
  [
    `${label}: ${String(cost.total.tokens)} tokens (${String(cost.total.chars)} characters)`,
    `  instructions: ${String(cost.instructions.tokens)} tokens`,
    `  tool list: ${String(cost.tools.tokens)} tokens`,
    `  sent to the model (name, description, input schema): ${String(cost.sent.tokens)} tokens`,
    ...Object.entries(cost.each).map(([name, count]) => `    ${name}: ${String(count.tokens)}`),
  ].join("\n");

describe("the cost of the tool definitions", () => {
  it("stays below the limits with all the tools", async () => {
    const all = await toolCost();
    console.info(report("all the tools", all));
    expect(Object.keys(all.each)).toHaveLength(9);
    // 8,268 tokens before the short text (polite-crawler-mcp 0.2.2): 220 + 8,048, and 3,351 sent
    expect(all.instructions.tokens).toBeLessThanOrEqual(150);
    expect(all.tools.tokens).toBeLessThanOrEqual(6000);
    expect(all.total.tokens).toBeLessThanOrEqual(6100);
    expect(all.sent.tokens).toBeLessThanOrEqual(2500);
  });

  it("stays below the limits with the tools of quote", async () => {
    const quote = await toolCost({ tools: ["quote"] });
    console.info(report("--tools quote", quote));
    expect(Object.keys(quote.each)).toEqual([
      "crawl_fetch",
      "crawl_find",
      "crawl_read",
      "crawl_verify",
    ]);
    expect(quote.total.tokens).toBeLessThanOrEqual(2500);
    expect(quote.sent.tokens).toBeLessThanOrEqual(1100);
  });
});
