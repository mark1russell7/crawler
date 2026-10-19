/*
 * The MCP server takes a crawler of an application of polite-crawler 0.1.1. This file is the proof,
 * as compat.test.ts of polite-crawler is the proof for the library.
 *
 * - `pnpm typecheck` compiles this file. It implements `PoliteCrawler` with only the members that
 *   0.1.1 had, the way an application of 0.1.1 did.
 * - The test gives this object to the MCP server: it has no `discover`, `crawl`, `diff`, `watch` or
 *   `extract`, so the tools use the runtime.
 *
 * Do not add the new members of a later version here.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { PoliteCrawler } from "../../polite-crawler/src/index.ts";
import { createMcpServer } from "./server.ts";
import { fakeClock } from "../../polite-crawler/src/test-helpers.ts";
import { htmlPage, testCrawler, testSite, urlset } from "../../polite-crawler/src/test-site.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// ── The shapes of 0.1.1 ──────────────────────────────────────────────────────

/** A crawler of an application of 0.1.1: the eight members of `PoliteCrawler` in 0.1.1, and no more. */
const crawlerOf011 = (inner: PoliteCrawler): PoliteCrawler => ({
  runtime: inner.runtime,
  fetch: (url, options) => inner.fetch(url, options),
  find: (q, options) => inner.find(q, options),
  read: (doc, options) => inner.read(doc, options),
  verify: (doc, quote, options) => inner.verify(doc, quote, options),
  versions: (doc, options) => inner.versions(doc, options),
  reindex: () => inner.reindex(),
  close: () => inner.close(),
});

/** A reading index of 0.1.1 over a `DocIndex`: the members of `ReadingIndex` in 0.1.1, with no `versionAt`. */

describe("the API of 0.1.1 over MCP", () => {
  it("serves the MCP tools over a PoliteCrawler of 0.1.1, through the runtime", async () => {
    const clock = fakeClock();
    let hits = 0;
    const site = await testSite((path, origin) => {
      if (path === "/robots.txt")
        return {
          type: "text/plain",
          body: `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
        };
      if (path === "/sitemap.xml")
        return { type: "application/xml", body: urlset([[`${origin}/a`, "2026-10-01"]]) };
      if (path === "/a") {
        hits += 1;
        return {
          type: "text/html",
          body: htmlPage(hits === 1 ? "Bread at seven" : "Bread at eight"),
        };
      }
      return undefined;
    }, clock);
    cleanups.push(() => site.close());
    const { crawler, close } = await testCrawler({ clock });
    cleanups.push(close);
    const server = createMcpServer(crawlerOf011(crawler));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return result.structuredContent as Record<string, unknown>;
    };

    const discovered = await call("crawl_discover", { site: site.origin });
    expect((discovered["urls"] as Array<{ url: string }>).map((url) => url.url)).toEqual([
      `${site.origin}/a`,
    ]);
    const crawled = await call("crawl_site", { urls: [`${site.origin}/a`], max_pages: 1 });
    expect(crawled["summary"]).toMatchObject({ pages: 1, fetched: 1 });
    // a second capture with a new text, so the document has two versions to compare
    await call("crawl_fetch", { urls: [`${site.origin}/a`], max_age: "0" });
    const doc = `url:${site.origin}/a`;
    const diff = await call("crawl_diff", { doc });
    expect(diff["same"]).toBe(false);
    expect((diff["summary"] as { words_added: number }).words_added).toBeGreaterThan(0);
    expect(await call("crawl_watch_list", {})).toMatchObject({ entries: [] });
    const extracted = await call("crawl_extract", {
      doc,
      fields: { title: { value: "Bread at eight" } },
    });
    expect(extracted["summary"]).toMatchObject({ fields: 1, verified: 1 });
  });
});
