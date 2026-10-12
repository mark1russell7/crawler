import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { FileBlobStore } from "./blobs.ts";
import type { CrawlerOptions } from "./crawler.ts";
import { Crawler } from "./crawler.ts";
import { DocIndex } from "./docs.ts";
import { CaptureLog } from "./log.ts";
import type { Clock } from "./politeness.ts";
import type { CaptureRecord } from "./record.ts";
import type { RenderOptions, Rendered, Renderer } from "./render.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fakeClock = (): Clock & { slept: number[] } => {
  let now = Date.parse("2026-10-07T12:00:00Z");
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
};

/** a stand-in browser: it asks the crawler about each request of the page, as a real browser does */
const browser = (
  answer: (url: string) => Partial<Rendered>,
  requests: readonly string[] = [],
): Renderer & { calls: Array<{ url: string; options: RenderOptions; decided: Record<string, boolean> }> } => {
  const calls: Array<{ url: string; options: RenderOptions; decided: Record<string, boolean> }> = [];
  return {
    calls,
    async render(url, options) {
      const decided: Record<string, boolean> = {};
      for (const request of [url, ...requests]) decided[request] = (await options.allowRequest?.(request)) ?? true;
      calls.push({ url, options, decided });
      return { html: "<p>shown</p>", finalUrl: url, status: 200, headers: {}, ...answer(url) };
    },
    close: () => Promise.resolve(),
  };
};

const make = async (renderer: Renderer, options: Partial<CrawlerOptions> = {}) => {
  const dir = await mkdtemp(join(tmpdir(), "polite-crawler-render-"));
  const agent = new MockAgent();
  agent.disableNetConnect();
  const log = new CaptureLog(join(dir, "crawl"));
  const index = new DocIndex(":memory:");
  const clock = fakeClock();
  const crawler = new Crawler({
    token: "PoliteCrawler",
    userAgent: "PoliteCrawler/0.1 (test)",
    from: "ops@example.com",
    log,
    blobs: new FileBlobStore(join(dir, "blobs")),
    index,
    clock,
    random: () => 0.5,
    dispatcher: agent,
    renderer,
    // the test hosts have no DNS, so the egress policy names them
    egress: { allowHosts: ["shop.example", "cdn.example", "other.example", "unknown.example"] },
    ...options,
  });
  cleanups.push(async () => {
    await crawler.close();
    index.close();
    await rm(dir, { recursive: true, force: true });
  });
  const robots = (origin: string, text: string): void => {
    agent.get(origin).intercept({ path: "/robots.txt", method: "GET" }).reply(200, text).persist();
  };
  const captures = async (): Promise<CaptureRecord[]> => {
    const rows: CaptureRecord[] = [];
    for await (const row of new CaptureLog(join(dir, "crawl")).scan({ source: "fetch" })) rows.push(row);
    return rows;
  };
  return { crawler, agent, clock, robots, captures };
};

describe("the rules of a fetch, applied to a render", () => {
  it("decides each request of the page with the egress policy and robots.txt", async () => {
    const page = "https://shop.example/item";
    const requests = [
      "https://shop.example/api/price",
      "https://shop.example/private/cart",
      "https://cdn.example/app.js",
      "https://cdn.example/secret/x.js",
      "https://unknown.example/tracker.js",
      "http://127.0.0.1:8080/admin",
      "http://169.254.169.254/latest/meta-data/",
      "file:///etc/passwd",
      "data:text/plain,hello",
    ];
    const renderer = browser(() => ({}), requests);
    const { crawler, agent, robots, captures } = await make(renderer);
    robots("https://shop.example", "User-agent: *\nDisallow: /private\n");
    robots("https://cdn.example", "User-agent: *\nDisallow: /secret\n");
    // the crawler holds the robots.txt of the CDN after one fetch there
    agent.get("https://cdn.example").intercept({ path: "/index.html", method: "GET" }).reply(200, "cdn");
    await crawler.fetch({ url: "https://cdn.example/index.html", mode: "page", recipe: "page" });
    const shown = await crawler.render({ url: page, recipe: "page" });
    expect(shown.outcome).toBe("ok");
    const call = renderer.calls[0]!;
    expect(call.options.headers).toEqual({ from: "ops@example.com" });
    expect(call.decided).toEqual({
      [page]: true,
      "https://shop.example/api/price": true,
      "https://shop.example/private/cart": false,
      "https://cdn.example/app.js": true,
      "https://cdn.example/secret/x.js": false,
      "https://unknown.example/tracker.js": true,
      "http://127.0.0.1:8080/admin": false,
      "http://169.254.169.254/latest/meta-data/": false,
      "file:///etc/passwd": false,
      "data:text/plain,hello": true,
    });
    const capture = (await captures()).find((row) => (row.payload as { rendered?: boolean }).rendered === true)!;
    // the page and three requests went out; a data: URL is not a request on the network
    expect(capture.payload).toMatchObject({ subrequests: { allowed: 4, refused: 5 } });
  });

  it("refuses a private page before the browser opens it", async () => {
    const renderer = browser(() => ({}));
    const { crawler } = await make(renderer);
    const shown = await crawler.render({ url: "http://192.168.1.1/admin", recipe: "page" });
    expect(shown).toMatchObject({
      outcome: "skipped",
      note: "egress policy: 192.168.1.1 is a private address; set allowPrivate to fetch it",
    });
    expect(renderer.calls).toEqual([]);
  });

  it("keeps nothing when the page moves to a URL that robots.txt or the egress policy refuses", async () => {
    const renderer = browser((url) => ({
      finalUrl: url.endsWith("/a") ? "https://other.example/private/a" : "http://10.0.0.7/b",
    }));
    const { crawler, robots } = await make(renderer);
    robots("https://shop.example", "User-agent: *\nAllow: /\n");
    robots("https://other.example", "User-agent: *\nDisallow: /private\n");
    const moved = await crawler.render({ url: "https://shop.example/a", recipe: "page" });
    expect(moved).toMatchObject({
      outcome: "skipped",
      body: undefined,
      note: "the page moved to https://other.example/private/a: robots.txt disallows it for PoliteCrawler",
    });
    const inside = await crawler.render({ url: "https://shop.example/b", recipe: "page" });
    expect(inside).toMatchObject({
      outcome: "skipped",
      note: "the page moved to http://10.0.0.7/b: egress policy: 10.0.0.7 is a private address; set allowPrivate to fetch it",
    });
  });

  it("waits the Retry-After of a 429 before the next render, and backs off after a 503", async () => {
    let round = 0;
    const renderer = browser(() => {
      round += 1;
      if (round === 1) return { status: 429, headers: { "retry-after": "600" } };
      if (round === 2) return { status: 503, headers: {} };
      return {};
    });
    const { crawler, clock, robots } = await make(renderer);
    robots("https://shop.example", "User-agent: *\nAllow: /\n");
    const first = await crawler.render({ url: "https://shop.example/1", recipe: "page" });
    expect(first.outcome).toBe("rate-limited");
    await crawler.render({ url: "https://shop.example/2", recipe: "page" });
    await crawler.render({ url: "https://shop.example/3", recipe: "page" });
    // 1 s after robots.txt, 600 s after the 429, then the backoff of a second wait in a row:
    // half of 10 s and half of the rest at random 0.5, more than the 5 s floor
    expect(clock.slept).toEqual([1000, 600_000, 7500]);
  });

  it("stops a render when the caller aborts it, and closes with no capture", async () => {
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow: Renderer = {
      render: (url) =>
        new Promise<Rendered>((resolve) => {
          started();
          release = () => resolve({ html: "", finalUrl: url, status: 200, headers: {} });
        }),
      close: () => Promise.resolve(),
    };
    const { crawler, robots, captures } = await make(slow);
    robots("https://shop.example", "User-agent: *\nAllow: /\n");
    const controller = new AbortController();
    const pending = crawler.render({ url: "https://shop.example/x", recipe: "page", signal: controller.signal });
    await opened;
    controller.abort();
    // the browser had the page, so the render is an error, and the host does not count it
    expect(await pending).toMatchObject({ outcome: "error", note: "cancelled by the caller" });
    const closing = crawler.render({ url: "https://shop.example/y", recipe: "page" });
    setTimeout(() => void crawler.close(), 20);
    expect(await closing).toMatchObject({ outcome: "skipped", note: "crawler closed", capture: undefined });
    release();
    const kinds = (await captures()).map((row) => [row.kind, (row.payload as { note?: string }).note ?? ""]);
    expect(kinds).toEqual([
      ["capture", ""],
      ["capture", "cancelled by the caller"],
    ]);
  });
});
