import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "./server.ts";
import type { PoliteCrawler } from "../../polite-crawler/src/open.ts";
import { openCrawler } from "../../polite-crawler/src/open.ts";
import { fakeEmbedder } from "../../polite-crawler/src/test-embedder.ts";
import { removeDir, seedStore, tempDir } from "../../polite-crawler/src/test-surfaces.ts";

// The MCP tool crawl_find with an embedder. polite-crawler tests the command line.

describe("the MCP tool crawl_find with an embedder", () => {
  const connect = async (crawler: PoliteCrawler) => {
    const server = createMcpServer(crawler);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    return { client, server };
  };

  it("takes rank hybrid only when the server has an embedder", async () => {
    const dir = await tempDir("hybrid-mcp");
    await seedStore(dir);
    const embedder = fakeEmbedder();
    const hybrid = openCrawler({ dir, renderer: false, embedder });
    const plain = openCrawler({ dir, renderer: false });
    const one = await connect(hybrid);
    const two = await connect(plain);
    try {
      const rankOf = async (client: Client): Promise<unknown> => {
        const { tools } = await client.listTools();
        const find = tools.find((tool) => tool.name === "crawl_find")!;
        return (find.inputSchema.properties as Record<string, { enum?: unknown }>)["rank"]?.enum;
      };
      expect(await rankOf(one.client)).toEqual(["exact", "fast", "hybrid"]);
      expect(await rankOf(two.client)).toEqual(["exact", "fast"]);
      const result = await one.client.callTool({
        name: "crawl_find",
        arguments: { q: "bread", rank: "hybrid" },
      });
      expect(result.isError).not.toBe(true);
      const hits = (result.structuredContent as { hits: Array<Record<string, unknown>> }).hits;
      expect(hits[0]).toMatchObject({
        doc: "url:https://bakery.example/",
        passage: { start: expect.any(Number), end: expect.any(Number) },
      });
      const content = result.content as Array<{ text: string }>;
      expect(content[1]!.text).toContain("<untrusted-web-content");
      expect(embedder.documents().join(" ")).not.toContain("7319");
      const refused = await two.client.callTool({
        name: "crawl_find",
        arguments: { q: "bread", rank: "hybrid" },
      });
      expect(refused.isError).toBe(true);
    } finally {
      await one.client.close();
      await two.client.close();
      await one.server.close();
      await two.server.close();
      await hybrid.close();
      await plain.close();
      await removeDir(dir);
    }
  }, 60_000);
});
