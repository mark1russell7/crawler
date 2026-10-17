import { MockAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrawlEvent } from "./crawler.ts";
import type { CrawlPage, CrawlRun, CrawlSummary } from "./frontier.ts";
import { fakeClock } from "./test-helpers.ts";
import type { Reply, TestSite } from "./test-site.ts";
import { htmlPage, pagesOf, testCrawler, testSite, urlset } from "./test-site.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const HTML = "text/html";

/** This function starts local sites and a crawler with one fake clock. */
const setup = async (
  routes: ReadonlyArray<(path: string, origin: string) => Reply | undefined>,
  robots = "User-agent: *\nAllow: /\n",
) => {
  const clock = fakeClock();
  const sites: TestSite[] = [];
  for (const route of routes) sites.push(await testSite(route, clock, robots));
  const events: Array<CrawlEvent & { readonly at: number }> = [];
  const made = await testCrawler({
    clock,
    onEvent: (event) => events.push({ ...event, at: clock.now() }),
  });
  cleanups.push(async () => {
    await made.close();
    for (const site of sites) await site.close();
  });
  return { sites, site: sites[0]!, events, ...made };
};

/** This function runs a crawl to its end, and gives its pages and its summary. */
const drain = async (
  run: CrawlRun,
): Promise<{ readonly pages: CrawlPage[]; readonly summary: CrawlSummary }> => {
  const pages: CrawlPage[] = [];
  for await (const page of run) pages.push(page);
  return { pages, summary: await run.summary };
};

/** A site where each page links to `/n/<k>` for the next numbers: a page of depth d links two pages of depth d + 1. */
const tree = (path: string): Reply | undefined => {
  if (path === "/robots.txt") return undefined;
  const at = path === "/" ? 1 : Number(/^\/n\/(\d+)$/.exec(path)?.[1] ?? Number.NaN);
  if (!Number.isFinite(at)) return undefined;
  return {
    type: HTML,
    body: htmlPage(`Page ${String(at)}`, [`/n/${String(at * 2)}`, `/n/${String(at * 2 + 1)}`]),
  };
};

describe("crawl", () => {
  it("stops at maxPages, the lower depth first", async () => {
    const { site, crawler } = await setup([tree]);
    const { pages, summary } = await drain(crawler.crawl(`${site.origin}/`, { maxPages: 5 }));
    expect(
      pages.map((page) => [page.url.slice(site.origin.length), page.depth, page.source]),
    ).toEqual([
      ["/", 0, "seed"],
      ["/n/2", 1, "link"],
      ["/n/3", 1, "link"],
      ["/n/4", 2, "link"],
      ["/n/5", 2, "link"],
    ]);
    expect(pages[1]!.referrer).toBe(`${site.origin}/`);
    expect(summary).toMatchObject({
      pages: 5,
      fetched: 5,
      refused: 0,
      failed: 0,
      stopped: "max-pages",
    });
    expect(summary.queued).toBeGreaterThan(0);
    expect(summary.reason).toBe("the crawl gave 5 pages, its limit (maxPages)");
    expect(pagesOf(site)).toEqual(["/", "/n/2", "/n/3", "/n/4", "/n/5"]);
  });

  it("stops at maxDepth, and depth 0 fetches only the seeds", async () => {
    const { site, crawler } = await setup([tree]);
    const deep = await drain(crawler.crawl(`${site.origin}/`, { maxDepth: 2, maxPages: 50 }));
    expect(deep.pages.map((page) => page.url.slice(site.origin.length))).toEqual([
      "/",
      "/n/2",
      "/n/3",
      "/n/4",
      "/n/5",
      "/n/6",
      "/n/7",
    ]);
    expect(deep.summary).toMatchObject({ stopped: "done", queued: 0 });
    expect(deep.summary.skips.depth).toBe(8);
    const seeds = await drain(
      crawler.crawl([`${site.origin}/n/2`, `${site.origin}/n/3`], { maxDepth: 0 }),
    );
    expect(seeds.pages.map((page) => page.depth)).toEqual([0, 0]);
    expect(seeds.summary.skips.depth).toBe(4);
  });

  it("starts no request after the budget, on the fake clock", async () => {
    const { site, crawler, clock } = await setup([tree]);
    const started = clock.now();
    const { pages, summary } = await drain(
      crawler.crawl(`${site.origin}/`, { budgetMs: 10_000, maxPages: 50 }),
    );
    // robots.txt at 0 s, then a page at 1 s, 4 s and 7 s: the next page would start at 10 s
    expect(site.hits.map((hit) => [hit.path, hit.at - started])).toEqual([
      ["/robots.txt", 0],
      ["/", 1000],
      ["/n/2", 4000],
      ["/n/3", 7000],
    ]);
    expect(pages).toHaveLength(3);
    expect(summary).toMatchObject({
      stopped: "budget",
      pages: 3,
      reason: "the budget of 10000 ms ended (budgetMs)",
    });
    expect(summary.queued).toBeGreaterThan(0);
    expect(summary.elapsed_ms).toBeLessThan(10_000);
    await expect(
      crawler.crawl(`${site.origin}/`, { budgetMs: -1 })[Symbol.asyncIterator]().next(),
    ).rejects.toThrow(RangeError);
  });

  it("stays on the site of the seeds, and follows more hosts with allowHosts", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const hits: string[] = [];
    const host = (origin: string, links: readonly string[]) =>
      agent
        .get(origin)
        .intercept({ path: () => true, method: "GET" })
        .reply((request) => {
          hits.push(`${origin}${request.path}`);
          const body =
            request.path === "/robots.txt"
              ? `# ${origin}\nUser-agent: *\nAllow: /\n`
              : htmlPage(origin, request.path === "/" ? links : []);
          return {
            statusCode: 200,
            data: body,
            responseOptions: { headers: { "content-type": HTML } },
          };
        })
        .persist();
    host("https://site.example", [
      "https://www.site.example/",
      "https://cdn.example/",
      "https://other.example/",
      "mailto:a@site.example",
    ]);
    for (const origin of [
      "https://www.site.example",
      "https://cdn.example",
      "https://other.example",
    ])
      host(origin, []);
    const { crawler } = await testCrawler({ dispatcher: agent });
    cleanups.push(async () => {
      await crawler.close();
      await agent.close();
    });
    // the hosts answer at the same time, so the order of their pages is not fixed
    const urls = (pages: readonly CrawlPage[]): string[] => pages.map((page) => page.url).sort();
    const same = await drain(crawler.crawl("https://site.example/"));
    expect(urls(same.pages)).toEqual(["https://site.example/", "https://www.site.example/"]);
    expect(same.summary.skips.scope).toBe(2);
    expect(
      hits.some(
        (hit) => hit.startsWith("https://cdn.example") || hit.startsWith("https://other.example"),
      ),
    ).toBe(false);
    const wider = await drain(
      crawler.crawl("https://site.example/", { allowHosts: ["cdn.example"], maxAge: 0 }),
    );
    expect(urls(wider.pages)).toEqual([
      "https://cdn.example/",
      "https://site.example/",
      "https://www.site.example/",
    ]);
    const any = await drain(crawler.crawl("https://site.example/", { sameSite: false }));
    expect(any.pages).toHaveLength(4);
  });

  it("follows only the links that include permits and exclude does not refuse", async () => {
    const { site, crawler } = await setup([
      (path) =>
        path === "/"
          ? {
              type: HTML,
              body: htmlPage("Home", [
                "/blog/one",
                "/blog/two.pdf",
                "/shop/item",
                "/blog/three?page=2",
                "/news/blog/x",
              ]),
            }
          : path.startsWith("/") && path !== "/robots.txt"
            ? { type: HTML, body: htmlPage(path) }
            : undefined,
    ]);
    const { pages, summary } = await drain(
      crawler.crawl(`${site.origin}/`, {
        include: ["/blog/*", /\/news\//],
        exclude: ["*.pdf$", "*?page="],
      }),
    );
    expect(pages.map((page) => page.url.slice(site.origin.length))).toEqual([
      "/",
      "/blog/one",
      "/news/blog/x",
    ]);
    expect(summary.skips.pattern).toBe(3);
  });

  it("fetches each page one time: fragments, tracking parameters, the canonical URL and a redirect", async () => {
    const { site, crawler } = await setup([
      (path, origin) => {
        if (path === "/")
          return {
            type: HTML,
            body: htmlPage("Home", [
              "/a#one",
              "/a#two",
              "/a?utm_source=mail",
              "/b",
              "/c",
              "/old",
              "/new",
              "/",
            ]),
          };
        if (path === "/b")
          return {
            type: HTML,
            body: htmlPage("B", ["/a"], `<link rel="canonical" href="${origin}/c">`),
          };
        if (path === "/old") return { status: 301, headers: { location: `${origin}/new` } };
        if (path === "/a" || path === "/c" || path === "/new")
          return { type: HTML, body: htmlPage(path) };
        return undefined;
      },
    ]);
    // the page reader gives each link one time; the frontier knows the seeds with a fragment too
    const { pages, summary } = await drain(
      crawler.crawl([`${site.origin}/`, `${site.origin}/#top`, `${site.origin}/?utm_source=x`]),
    );
    expect(pages.map((page) => page.url.slice(site.origin.length))).toEqual([
      "/",
      "/a",
      "/b",
      "/old",
    ]);
    // /c is the canonical URL of /b, and /new is the target of /old: neither is fetched again
    expect(pagesOf(site)).toEqual(["/", "/a", "/b", "/old", "/new"]);
    expect(summary.skips.duplicate).toBe(2);
  });

  it("keeps one request in progress for each host, at the pace of each host", async () => {
    const page = (other: () => string) => (path: string) =>
      path === "/robots.txt"
        ? undefined
        : { type: HTML, body: htmlPage(path, ["/1", "/2", "/3", `${other()}/1`, `${other()}/2`]) };
    let second = "";
    let first = "";
    const { sites, crawler, events } = await setup([page(() => second), page(() => first)]);
    first = sites[0]!.origin;
    second = sites[1]!.origin;
    const { summary } = await drain(crawler.crawl([`${first}/`, `${second}/`], { maxPages: 12 }));
    expect(summary).toMatchObject({ pages: 8, fetched: 8, stopped: "done" });
    for (const site of sites) {
      expect(site.maxInFlight()).toBe(1);
      const host = new URL(site.origin).host;
      const starts = events
        .filter(
          (event) =>
            event.type === "request" && event.host === host && !event.url.endsWith("/robots.txt"),
        )
        .map((event) => event.at);
      expect(starts).toHaveLength(4);
      // the default pace of a host is 3 s between two pages
      for (let at = 1; at < starts.length; at += 1)
        expect(starts[at]! - starts[at - 1]!).toBeGreaterThanOrEqual(3000);
    }
  });

  it("does not follow the links that robots.txt refuses, nor the links of a page that refuses AI input", async () => {
    const { site, crawler } = await setup(
      [
        (path) => {
          if (path === "/")
            return { type: HTML, body: htmlPage("Home", ["/private/a", "/members", "/open"]) };
          if (path === "/members")
            return {
              type: HTML,
              headers: { "content-signal": "ai-input=no" },
              body: htmlPage("Members", ["/secret"]),
            };
          if (path === "/open" || path === "/secret") return { type: HTML, body: htmlPage(path) };
          return undefined;
        },
      ],
      "User-agent: *\nDisallow: /private\n",
    );
    const { pages, summary } = await drain(crawler.crawl(`${site.origin}/`));
    expect(pages.map((page) => [page.url.slice(site.origin.length), page.held_back])).toEqual([
      ["/", false],
      ["/members", true],
      ["/open", false],
    ]);
    expect(summary).toMatchObject({ refused: 1, skips: { held_back: 1 } });
    expect(pagesOf(site)).toEqual(["/", "/members", "/open"]);
  });

  it("adds the pages of the sitemaps, the newest first, after the seeds", async () => {
    const { site, crawler } = await setup([
      (path, origin) => {
        if (path === "/robots.txt")
          return {
            type: "text/plain",
            body: `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
          };
        if (path === "/sitemap.xml")
          return {
            type: "application/xml",
            body: urlset([
              [`${origin}/old`, "2025-01-01"],
              [`${origin}/new`, "2026-10-01"],
              [`${origin}/undated`],
              ["https://elsewhere.example/x"],
            ]),
          };
        return { type: HTML, body: htmlPage(path, path === "/" ? ["/linked"] : []) };
      },
    ]);
    const { pages, summary } = await drain(crawler.crawl(`${site.origin}/`, { useSitemaps: true }));
    expect(pages.map((page) => [page.url.slice(site.origin.length), page.source])).toEqual([
      ["/", "seed"],
      ["/new", "sitemap"],
      ["/old", "sitemap"],
      ["/undated", "sitemap"],
      ["/linked", "link"],
    ]);
    expect(summary.sitemap_urls).toBe(3);
  });

  it("stops at a cancel and at a break, and ends the fetch in progress", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const slowStarted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { site, crawler } = await setup([
      (path) => {
        if (path === "/") return { type: HTML, body: htmlPage("Home", ["/slow", "/next"]) };
        if (path === "/slow") {
          reached();
          return { type: HTML, body: htmlPage("Slow"), after: held };
        }
        if (path === "/next") return { type: HTML, body: htmlPage("Next") };
        return undefined;
      },
    ]);
    cleanups.push(async () => release());
    const controller = new AbortController();
    const run = crawler.crawl(`${site.origin}/`, { signal: controller.signal });
    const pages: CrawlPage[] = [];
    const loop = (async () => {
      for await (const page of run) pages.push(page);
    })();
    await slowStarted;
    controller.abort();
    await loop;
    const summary = await run.summary;
    expect(summary).toMatchObject({
      stopped: "cancelled",
      pages: 1,
      reason: "the caller cancelled the crawl",
    });
    expect(pages.map((page) => page.url)).toEqual([`${site.origin}/`]);
    expect(pagesOf(site)).toEqual(["/", "/slow"]);
    // the server sees the end of the connection after the crawler stops the request
    await vi.waitFor(() => expect(site.dropped).toEqual(["/slow"]));

    // a break in the loop stops the crawl too
    const broken = crawler.crawl(`${site.origin}/`, { maxAge: "1h" });
    for await (const page of broken) {
      expect(page.from_cache).toBe(true);
      break;
    }
    expect(await broken.summary).toMatchObject({
      stopped: "cancelled",
      reason: "the caller stopped the loop",
    });
    expect(() => broken[Symbol.asyncIterator]()).toThrow(/runs one time/);
  });
});
