import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "./mcp.ts";
import type { PoliteCrawler } from "./open.ts";
import { openCrawler } from "./open.ts";
import { fakeEmbedder, fakeVector } from "./test-embedder.ts";
import type { LocalSite } from "./test-surfaces.ts";
import { childEnv, localSite, removeDir, runCli, seedStore, tempDir } from "./test-surfaces.ts";

// The surfaces of hybrid search: the command line with a mock Ollama server, and the MCP tool.

let store: string;
let ollama: LocalSite;
/** These are the texts that the mock Ollama server got. */
const inputs: string[] = [];

beforeAll(async () => {
  store = await tempDir("hybrid-cli");
  await seedStore(store);
  ollama = await localSite((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url !== "/api/embed") {
        response.writeHead(404).end("404 page not found");
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        model: string;
        input: string[];
      };
      inputs.push(...body.input);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ embeddings: body.input.map((text) => [...fakeVector(text)]) }));
    });
  });
}, 60_000);

afterAll(async () => {
  await ollama.close();
  await removeDir(store);
});

const OLLAMA = (): string[] => [
  "--embedder",
  "ollama",
  "--embed-model",
  "fake-embed",
  "--ollama-url",
  ollama.origin,
];

describe("the command line of hybrid search", () => {
  it("embeds the store, and finds with --rank hybrid", async () => {
    const embedded = await runCli(["embed", ...OLLAMA(), "--dir", store, "--json"]);
    expect(embedded.stderr).toBe("");
    expect(embedded.code).toBe(0);
    const result = JSON.parse(embedded.stdout) as Record<string, unknown>;
    expect(result).toMatchObject({
      embedder: "ollama:fake-embed",
      held_back: 1,
      stopped: "done",
    });
    expect(result["embedded"]).toBeGreaterThanOrEqual(1);
    // the page that asks not to be AI input never goes to the model
    expect(inputs.some((text) => text.includes("7319") || text.includes("members only"))).toBe(
      false,
    );
    const found = await runCli(["find", "loaf", "--rank", "hybrid", ...OLLAMA(), "--dir", store]);
    expect(found.code).toBe(0);
    expect(found.stdout).toContain("url:https://bakery.example/");
    expect(found.stdout).toMatch(/\[passage \d+–\d+\]/);
    expect(inputs.at(-1)).toBe("loaf");
    const again = await runCli(["embed", ...OLLAMA(), "--dir", store]);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/^0 texts got vectors \(0 chunks\)/);
    expect(again.stdout).toContain("Stopped (done).");
  }, 60_000);

  it("refuses hybrid with no embedder, a remote Ollama, and says ollama serve when it is down", async () => {
    // a port with no server: a local site that closed
    const closed = await localSite(() => undefined);
    await closed.close();
    const [noEmbedder, noEmbed, remote, down] = await Promise.all([
      runCli(["find", "bread", "--rank", "hybrid", "--dir", store]),
      runCli(["embed", "--dir", store]),
      runCli([
        "find",
        "bread",
        "--embedder",
        "ollama",
        "--ollama-url",
        "http://10.0.0.5:11434",
        "--dir",
        store,
      ]),
      runCli(["find", "bread", "--rank", "hybrid", "--dir", store], {
        env: childEnv({
          POLITE_CRAWLER_EMBEDDER: "ollama",
          POLITE_CRAWLER_EMBED_MODEL: "fake-embed",
          POLITE_CRAWLER_OLLAMA_URL: closed.origin,
        }),
      }),
    ]);
    expect(noEmbedder.code).toBe(2);
    expect(noEmbedder.stderr).toContain("--rank hybrid wants --embedder transformers or ollama");
    expect(noEmbed.code).toBe(2);
    expect(noEmbed.stderr).toContain("embed wants --embedder transformers or ollama");
    expect(remote.code).toBe(2);
    expect(remote.stderr).toMatch(
      /--embedder ollama: the Ollama URL http:\/\/10\.0\.0\.5:11434 is not on this computer/,
    );
    expect(down.code).toBe(1);
    expect(down.stderr).toMatch(/ollama serve/);
  }, 60_000);
});

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
