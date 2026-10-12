import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { FileBlobStore } from "./blobs.ts";
import { Crawler } from "./crawler.ts";
import { DocIndex } from "./docs.ts";
import { CaptureLog } from "./log.ts";
import { MemoryHostStateStore } from "./politeness.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";

// A long process (an MCP server) meets many hosts. The state of each host must stay bounded. Set
// MEMORY=1 for a larger run that also passes the limit of the robots.txt cache.
const HOSTS = process.env["MEMORY"] === "1" ? 6000 : 1200;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Insides {
  readonly robots: { readonly size: number };
  readonly meta: { readonly size: number };
  readonly inFlight: Map<unknown, unknown>;
  readonly running: Set<unknown>;
  readonly scheduler: { readonly chains: Map<unknown, unknown> };
}

describe("the memory of a crawler", () => {
  it("stays bounded across many hosts", async () => {
    const server: Server = createServer((request, response) => {
      if (request.url === "/robots.txt") response.end("User-agent: *\nAllow: /\n");
      else response.end("<p>a page</p>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const port = (server.address() as AddressInfo).port;
    // each host name goes to the local server, and no connection stays open long
    const agent = new Agent({
      keepAliveTimeout: 10,
      keepAliveMaxTimeout: 10,
      connect: {
        lookup: (_host, options, done) => {
          if ((options as { all?: boolean }).all === true) done(null, [{ address: "127.0.0.1", family: 4 }]);
          else (done as unknown as (error: null, address: string, family: number) => void)(null, "127.0.0.1", 4);
        },
      },
    });
    cleanups.push(() => agent.close());
    const dir = await tempDir("memory");
    cleanups.push(() => removeDir(dir));
    const log = new CaptureLog(join(dir, "crawl"), { sync: false });
    const index = new DocIndex(":memory:");
    cleanups.push(() => index.close());
    const hosts = new MemoryHostStateStore(100);
    const clock = fakeClock();
    const crawler = new Crawler({
      token: "PoliteCrawler",
      userAgent: "PoliteCrawler/0.1 (test)",
      log,
      blobs: new FileBlobStore(join(dir, "blobs"), { sync: false }),
      index,
      clock,
      random: () => 0.5,
      maxActive: 64,
      dispatcher: agent,
      hostState: hosts,
    });
    cleanups.push(() => crawler.close());
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    const crawl = (from: number, count: number) =>
      Promise.all(
        Array.from({ length: count }, (_, at) =>
          crawler.fetch({ url: `http://h${String(from + at)}.example.test:${String(port)}/`, mode: "page", recipe: "page" }),
        ),
      );
    const results = await crawl(0, HOSTS);
    expect(results.filter((result) => result.outcome !== "ok")).toEqual([]);
    // an hour later the first hosts are idle: the next hosts push them out of the store
    clock.advance(60 * 60 * 1000);
    const later = Math.ceil(HOSTS / 4);
    await crawl(HOSTS, later);
    const insides = crawler as unknown as Insides;
    expect(insides.inFlight.size).toBe(0);
    expect(insides.running.size).toBe(0);
    expect(insides.scheduler.chains.size).toBe(0);
    expect(insides.robots.size).toBeLessThanOrEqual(4096);
    expect(insides.meta.size).toBeLessThanOrEqual(10_000);
    // the store of host state forgets idle hosts past its limit, so it holds about the last batch
    expect(hosts.size).toBeLessThan(HOSTS / 2);
    // with --expose-gc the heap is measured; 200 KB for each host would be a leak
    gc?.();
    const grown = gc === undefined ? 0 : process.memoryUsage().heapUsed - before;
    expect(grown).toBeLessThan(HOSTS * 200 * 1024);
  }, 120_000);
});
