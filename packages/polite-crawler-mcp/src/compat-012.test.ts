/*
 * The API of 0.1.2 stays correct after hybrid search. This file is the proof, as compat.test.ts is
 * the proof for 0.1.1.
 *
 * - `pnpm typecheck` compiles this file. It implements `OpenedCrawler` with only the members that
 *   0.1.2 had. Hybrid search adds `HybridCrawler` and optional members, so this object stays correct.
 * - The test gives the object to the MCP server: `crawl_find` then has no rank `hybrid`.
 *
 * Do not add the members of a later version here.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type {
  FindOptions,
  OpenedCrawler,
  PoliteCrawler,
  ReadingIndex,
} from "../../polite-crawler/src/index.ts";
import { openCrawler } from "../../polite-crawler/src/index.ts";
import { createMcpServer } from "./server.ts";
import { removeDir, seedStore, tempDir } from "../../polite-crawler/src/test-surfaces.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A crawler of an application of 0.1.2: the members of `OpenedCrawler` in 0.1.2, and no more. */
const crawlerOf012 = (inner: OpenedCrawler): OpenedCrawler => ({
  runtime: inner.runtime,
  fetch: (url, options) => inner.fetch(url, options),
  // a wrapper of 0.1.2 can give the options of find to a PoliteCrawler of its own
  find: (q, options?: FindOptions) => (inner as PoliteCrawler).find(q, options),
  read: (doc, options) => inner.read(doc, options),
  verify: (doc, quote, options) => inner.verify(doc, quote, options),
  versions: (doc, options) => inner.versions(doc, options),
  reindex: () => inner.reindex(),
  close: () => inner.close(),
  discover: (site, options) => inner.discover(site, options),
  crawl: (seeds, options) => inner.crawl(seeds, options),
  diff: (doc, options) => inner.diff(doc, options),
  watch: inner.watch,
  extract: (doc, fields, options) => inner.extract(doc, fields, options),
});

/** An index of 0.1.2 forwards the rank of `find` and `rankWithin` as it is. */
const forwardRank = (index: ReadingIndex, options: FindOptions): number =>
  index.find("bread", { limit: options.limit ?? 10, rank: options.rank }).length;

describe("the API of 0.1.2", () => {
  it("takes an OpenedCrawler of 0.1.2 in the MCP server, with no rank hybrid", async () => {
    const dir = await tempDir("compat-012");
    await seedStore(dir);
    const inner = openCrawler({ dir, renderer: false });
    cleanups.push(async () => {
      await inner.close();
      await removeDir(dir);
    });
    const crawler = crawlerOf012(inner);
    expect(forwardRank(crawler.runtime.index, { rank: "fast" })).toBe(1);
    const server = createMcpServer(crawler);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const { tools } = await client.listTools();
    const find = tools.find((tool) => tool.name === "crawl_find")!;
    expect(
      (find.inputSchema.properties as Record<string, { enum?: unknown }>)["rank"]?.enum,
    ).toEqual(["exact", "fast"]);
    const result = await client.callTool({ name: "crawl_find", arguments: { q: "bread" } });
    expect(result.isError).not.toBe(true);
  });
});
