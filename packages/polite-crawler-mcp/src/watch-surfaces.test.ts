import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "./server.ts";
import type { PoliteCrawler } from "../../polite-crawler/src/open.ts";
import { realClock } from "../../polite-crawler/src/politeness.ts";
import { fakeClock } from "../../polite-crawler/src/test-helpers.ts";
import type { Reply } from "../../polite-crawler/src/test-site.ts";
import { htmlPage, testCrawler, testSite } from "../../polite-crawler/src/test-site.ts";

// The MCP tools of the time travel, the diff and the watch list, on the fake clock. polite-crawler
// tests the command line.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const site = async (route: (path: string) => Reply | undefined, clock = realClock) => {
  const made = await testSite((path) => route(path), clock);
  cleanups.push(() => made.close());
  return made;
};

/** A page whose text the test changes. */
const changing = async (clock = realClock) => {
  const state = { text: "Hours: Tuesday to Sunday" };
  const made = await site(
    (path) => (path === "/" ? { type: "text/html", body: htmlPage(state.text) } : undefined),
    clock,
  );
  return { made, state, url: `${made.origin}/`, doc: `url:${made.origin}/` };
};

describe("the MCP tools crawl_diff and crawl_watch_list, and at", () => {
  const connect = async (crawler: PoliteCrawler) => {
    const server = createMcpServer(crawler);
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
      const content = result.content as Array<{ type: string; text: string }>;
      return {
        isError: result.isError === true,
        json: content[0]?.text ?? "",
        web: content[1]?.text ?? "",
        structured: result.structuredContent as Record<string, unknown> | undefined,
      };
    };
    return { client, call };
  };

  const local = async () => {
    const clock = fakeClock();
    const page = await changing(clock);
    const { crawler, close } = await testCrawler({ clock });
    cleanups.push(close);
    return { clock, ...page, crawler, ...(await connect(crawler)) };
  };

  it("lists the watched pages, and no tool adds a watch", async () => {
    const { client, call, crawler, url } = await local();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("crawl_watch_list");
    expect(names.filter((name) => /watch/.test(name))).toEqual(["crawl_watch_list"]);
    expect((await call("crawl_watch_list", {})).structured?.["entries"]).toEqual([]);
    await crawler.watch!.add(url, { every: "1h", scope: "private", labels: { lineage: "secret" } });
    const listed = await call("crawl_watch_list", {});
    expect(listed.isError).toBe(false);
    const entries = listed.structured?.["entries"] as Array<Record<string, unknown>>;
    expect(entries).toEqual([
      expect.objectContaining({ url, every_ms: 3_600_000, confirm: 2, checks: 0, pending: null }),
    ]);
    // the scope and the labels can name a private lineage
    expect(listed.json).not.toMatch(/private|secret|lineage/);
  });

  it("gives a diff with the page text in the envelope only, and reads and verifies at a time", async () => {
    const { call, crawler, clock, state, url, doc } = await local();
    const first = await crawler.fetch(url);
    clock.advance(86_400_000);
    state.text = "Hours: Wednesday to Sunday";
    await crawler.fetch(url, { maxAge: 0 });

    const diff = await call("crawl_diff", { doc });
    expect(diff.isError).toBe(false);
    expect(diff.structured).toMatchObject({
      doc,
      held_back: false,
      same: false,
      summary: { lines_changed: 1 },
      from: { capture: first.capture },
    });
    expect(diff.json).not.toMatch(/Tuesday|Wednesday/);
    expect(diff.web).toMatch(/^Text from web pages follows/);
    expect(diff.web).toContain("~ Hours: [-Tuesday-]{+Wednesday+} to Sunday");
    const pinned = await call("crawl_diff", { doc, from_at: first.fetched_at, to: first.capture });
    expect(pinned.structured).toMatchObject({ same: true, hunks: 0 });
    expect(
      (await call("crawl_diff", { doc, from: first.capture, from_at: first.fetched_at })).isError,
    ).toBe(true);
    expect((await call("crawl_diff", { doc: "url:https://none.example/" })).isError).toBe(true);

    const early = await call("crawl_read", { doc, at: "2026-01-01T00:00:00Z" });
    expect(early.structured).toMatchObject({
      before_first: true,
      at: "2026-01-01T00:00:00.000Z",
      capture: null,
      next_from: null,
    });
    expect(early.web).toBe("");
    const then = await call("crawl_read", { doc, at: first.fetched_at });
    expect(then.structured).toMatchObject({ capture: first.capture, before_first: false });
    expect(then.web).toContain("Tuesday");
    const verified = await call("crawl_verify", {
      doc,
      quote: "Tuesday to Sunday",
      at: first.fetched_at,
    });
    expect(verified.structured).toMatchObject({
      found: true,
      capture: first.capture,
      stale: false,
    });
    const both = await call("crawl_read", { doc, at: first.fetched_at, capture: first.capture });
    expect(both.isError).toBe(true);
  });
});
