import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureLog } from "./log.ts";
import type { CaptureRecord } from "./record.ts";
import { fakeClock } from "./test-helpers.ts";
import type { Reply } from "./test-site.ts";
import { htmlPage, pagesOf, sitemapIndex, testCrawler, testSite, urlset } from "./test-site.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const XML = "application/xml";

/** This function starts a local site and a crawler with one fake clock. */
const setup = async (
  route: (path: string, origin: string) => Reply | undefined,
  robots?: (origin: string) => string,
) => {
  const clock = fakeClock();
  const site = await testSite(
    (path, origin) =>
      path === "/robots.txt" && robots !== undefined
        ? { type: "text/plain", body: robots(origin) }
        : route(path, origin),
    clock,
  );
  const made = await testCrawler({ clock });
  cleanups.push(async () => {
    await made.close();
    await site.close();
  });
  return { site, ...made };
};

describe("discover", () => {
  it("follows a sitemap index, the newest sitemap first, and reads a gzip sitemap", async () => {
    const { site, crawler } = await setup(
      (path, origin) => {
        if (path === "/") return { type: "text/html", body: htmlPage("Home") };
        if (path === "/index.xml")
          return {
            type: XML,
            body: sitemapIndex([
              [`${origin}/old.xml`, "2025-01-01"],
              [`${origin}/new.xml.gz`, "2026-09-01"],
              [`${origin}/nested.xml`],
            ]),
          };
        if (path === "/old.xml")
          return { type: XML, body: urlset([[`${origin}/a`, "2025-01-02"]]) };
        if (path === "/new.xml.gz")
          return {
            type: "application/x-gzip",
            body: gzipSync(
              urlset([
                [`${origin}/b`, "2026-09-02"],
                [`${origin}/a`, "2026-09-03"],
              ]),
            ),
          };
        if (path === "/nested.xml")
          return { type: XML, body: sitemapIndex([[`${origin}/deep.xml`]]) };
        if (path === "/deep.xml") return { type: XML, body: urlset([[`${origin}/c`]]) };
        return undefined;
      },
      (origin) => `User-agent: *\nAllow: /\nSitemap: ${origin}/index.xml\n`,
    );
    const found = await crawler.discover(`${site.origin}/`);
    expect(found.stopped).toBe("done");
    expect(found.site).toBe(site.origin);
    // the newest lastmod first; a page in two files keeps the later date and its first source
    expect(found.urls).toEqual([
      {
        url: `${site.origin}/a`,
        lastmod: "2026-09-03T00:00:00.000Z",
        changefreq: null,
        via: "sitemap",
        source: `${site.origin}/new.xml.gz`,
      },
      {
        url: `${site.origin}/b`,
        lastmod: "2026-09-02T00:00:00.000Z",
        changefreq: null,
        via: "sitemap",
        source: `${site.origin}/new.xml.gz`,
      },
      {
        url: `${site.origin}/c`,
        lastmod: null,
        changefreq: null,
        via: "sitemap",
        source: `${site.origin}/deep.xml`,
      },
    ]);
    expect(
      found.sources.map((source) => [
        source.url.slice(site.origin.length),
        source.from,
        source.kind,
      ]),
    ).toEqual([
      ["/index.xml", "robots.txt", "sitemapindex"],
      ["/new.xml.gz", "index", "urlset"],
      ["/old.xml", "index", "urlset"],
      ["/nested.xml", "index", "sitemapindex"],
      ["/deep.xml", "index", "urlset"],
    ]);
    expect(found.dropped.duplicate).toBe(1);
    // robots.txt, the page for its feeds, then each file; no page of the list
    expect(pagesOf(site)).toEqual([
      "/",
      "/index.xml",
      "/new.xml.gz",
      "/old.xml",
      "/nested.xml",
      "/deep.xml",
    ]);

    // a second discovery answers from the store, with no request
    const before = site.hits.length;
    const again = await crawler.discover(`${site.origin}/`);
    expect(again.urls).toEqual(found.urls);
    expect(again.sources.every((source) => source.from_cache)).toBe(true);
    expect(site.hits.length).toBe(before);
  });

  it("reads /sitemap.xml when robots.txt names no sitemap, and keeps each limit", async () => {
    const { site, crawler } = await setup((path, origin) => {
      if (path === "/sitemap.xml")
        return {
          type: XML,
          body: sitemapIndex(
            Array.from(
              { length: 5 },
              (_, at) => [`${origin}/s${String(at)}.xml`, `2026-0${String(at + 1)}-01`] as const,
            ),
          ),
        };
      const match = /^\/s(\d)\.xml$/.exec(path);
      if (match !== null)
        return {
          type: XML,
          body: urlset(
            Array.from(
              { length: 4 },
              (_, at) => [`${origin}/p${match[1]!}-${String(at)}`] as const,
            ),
          ),
        };
      return undefined;
    });
    const files = await crawler.discover(site.origin, { maxFiles: 3, linkedFeeds: false });
    expect(files.stopped).toBe("max-files");
    expect(files.note).toBe("discovery read 3 files, its limit, and 3 more files wait");
    expect(files.sources.map((source) => source.url.slice(site.origin.length))).toEqual([
      "/sitemap.xml",
      "/s4.xml",
      "/s3.xml",
    ]);
    expect(files.sources[0]!.from).toBe("default");
    expect(files.urls).toHaveLength(8);

    const few = await crawler.discover(site.origin, { maxUrls: 6, linkedFeeds: false });
    expect(few.stopped).toBe("max-urls");
    expect(few.urls).toHaveLength(6);

    const flat = await crawler.discover(site.origin, { maxNesting: 0, linkedFeeds: false });
    expect(flat.urls).toEqual([]);
    expect(flat.dropped.limit).toBe(5);
    expect(flat.sources[0]!.note).toBe(
      "the files of the index are deeper than maxNesting (0), so discovery reads none of them",
    );

    await expect(crawler.discover(site.origin, { maxFiles: 0 })).rejects.toThrow(RangeError);
    await expect(crawler.discover("ftp://site.example/")).rejects.toThrow(/http\(s\) URL/);
  });

  it("stops a large file and a gzip bomb at maxBytes, and stays bounded on hostile XML", async () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE urlset [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>`;
    const { site, crawler } = await setup(
      (path, origin) => {
        if (path === "/big.xml")
          return {
            type: XML,
            body: urlset(
              Array.from({ length: 4000 }, (_, at) => [`${origin}/big/${String(at)}`] as const),
            ),
          };
        if (path === "/bomb.xml.gz")
          return {
            type: "application/gzip",
            body: gzipSync(`<urlset>${" ".repeat(8 * 1024 * 1024)}</urlset>`),
          };
        if (path === "/laughs.xml")
          return {
            type: XML,
            body: `${laughs}<urlset><url><loc>${origin}/&c;</loc></url><url><loc>${origin}/fine</loc></url></urlset>`,
          };
        if (path === "/deep.xml") return { type: XML, body: `<urlset>${"<url>".repeat(5000)}` };
        return undefined;
      },
      (origin) =>
        ["big", "bomb.xml.gz", "laughs", "deep"]
          .map((name) => `Sitemap: ${origin}/${name.includes(".") ? name : `${name}.xml`}`)
          .join("\n"),
    );
    const found = await crawler.discover(site.origin, { maxBytes: 64 * 1024, linkedFeeds: false });
    const [big, bomb, laughsFile, deep] = found.sources;
    expect(big).toMatchObject({ kind: "urlset", truncated: true });
    expect(big!.note).toMatch(
      /^the file is longer than 65536 bytes, so discovery read its first part; the file ends inside an element/,
    );
    expect(big!.urls).toBeGreaterThan(100);
    expect(big!.urls).toBeLessThan(4000);
    expect(bomb).toMatchObject({ kind: "urlset", truncated: true, entries: 0 });
    expect(laughsFile!.note).toBe(
      "the file declares a DTD: the reader ignores it and expands no entity",
    );
    expect(laughsFile!.urls).toBe(1);
    expect(deep!.note).toBe("the elements nest deeper than 32");
    expect(found.urls.some((url) => url.url === `${site.origin}/fine`)).toBe(true);
    expect(found.dropped.invalid).toBe(1);
  });

  it("reads the RSS and Atom feeds that the page links, and a feed given directly", async () => {
    const { site, crawler } = await setup((path, origin) => {
      if (path === "/blog/")
        return {
          type: "text/html",
          body: htmlPage(
            "Blog",
            [],
            `<link rel="alternate" type="application/rss+xml" href="rss.xml"><link rel="alternate" type="application/atom+xml" href="/atom.xml"><link rel="alternate" type="application/rss+xml" href="https://elsewhere.example/feed">`,
          ),
        };
      if (path === "/blog/rss.xml")
        return {
          type: "application/rss+xml",
          body: `<rss version="2.0"><channel><item><link>post-1</link><pubDate>Tue, 07 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>`,
        };
      if (path === "/atom.xml")
        return {
          type: "application/atom+xml",
          body: `<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="${origin}/post-2"/><updated>2026-10-08T00:00:00Z</updated></entry></feed>`,
        };
      if (path === "/given.xml")
        return {
          type: XML,
          body: `<rss version="2.0"><channel><item><link>${origin}/post-3</link></item></channel></rss>`,
        };
      return undefined;
    });
    const found = await crawler.discover(`${site.origin}/blog/`, {
      feeds: [`${site.origin}/given.xml`],
    });
    expect(found.urls.map((url) => [url.url.slice(site.origin.length), url.via])).toEqual([
      ["/post-2", "feed"],
      ["/blog/post-1", "feed"],
      ["/post-3", "feed"],
    ]);
    expect(
      found.sources.map((source) => [
        source.url.slice(site.origin.length),
        source.from,
        source.kind,
      ]),
    ).toEqual([
      ["/blog/rss.xml", "page", "rss"],
      ["/atom.xml", "page", "atom"],
      ["/given.xml", "given", "rss"],
      ["/sitemap.xml", "default", null],
    ]);
    expect(found.sources[3]).toMatchObject({ outcome: "not-found", status: 404 });
    // the feed on a different site is not read
    expect(found.dropped.scope).toBe(1);
  });

  it("obeys robots.txt for each file and for each URL, with the rules of onBehalfOf too", async () => {
    const { site, crawler, dir } = await setup(
      (path, origin) => {
        if (path === "/sitemap.xml")
          return {
            type: XML,
            body: urlset([
              [`${origin}/open`],
              [`${origin}/private/a`],
              [`${origin}/assistant/b`],
              ["https://elsewhere.example/c"],
            ]),
          };
        return undefined;
      },
      (origin) =>
        `User-agent: *\nDisallow: /private\n\nUser-agent: Claude-User\nDisallow: /assistant\n\nSitemap: ${origin}/private/sitemap.xml\nSitemap: ${origin}/sitemap.xml\n`,
    );
    const found = await crawler.discover(site.origin, {
      linkedFeeds: false,
      onBehalfOf: ["Claude-User"],
    });
    expect(found.urls.map((url) => url.url)).toEqual([`${site.origin}/open`]);
    expect(found.dropped).toMatchObject({ robots: 2, scope: 1 });
    expect(found.sources[0]).toMatchObject({
      url: `${site.origin}/private/sitemap.xml`,
      outcome: "skipped",
      kind: null,
      note: "robots.txt disallows it for PoliteCrawler",
    });
    expect(pagesOf(site)).toEqual(["/sitemap.xml"]);

    // each decision about a file is a capture with the recipe of discovery, and a rebuild knows the recipe
    const records: CaptureRecord[] = [];
    for await (const record of new CaptureLog(join(dir, "captures")).scan({ source: "fetch" }))
      records.push(record);
    const files = records
      .map((record) => ({
        kind: record.kind,
        ...(record.payload as { url: string; recipe: string }),
      }))
      .filter((payload) => payload.recipe === "sitemap")
      .map((payload) => [payload.kind, payload.url.slice(site.origin.length)]);
    expect(files).toEqual([
      ["skipped", "/private/sitemap.xml"],
      ["capture", "/sitemap.xml"],
    ]);
    expect((await crawler.reindex()).unknown_recipes).toEqual([]);
  });

  it("gives up on a site whose robots.txt does not read, and stops at the budget and at a cancel", async () => {
    const { site, crawler } = await setup((path, origin) => {
      if (path === "/robots.txt") return { status: 500, body: "down" };
      if (path === "/sitemap.xml") return { type: XML, body: urlset([[`${origin}/x`]]) };
      return undefined;
    });
    const closed = await crawler.discover(site.origin);
    expect(closed).toMatchObject({ stopped: "robots", urls: [] });
    expect(closed.note).toMatch(/^robots\.txt could not be read/);
    expect(pagesOf(site)).toEqual([]);

    const aborted = new AbortController();
    aborted.abort();
    const { crawler: second, site: other } = await setup((path, origin) => {
      if (path === "/robots.txt") return undefined;
      return path === "/sitemap.xml"
        ? { type: XML, body: sitemapIndex([[`${origin}/a.xml`], [`${origin}/b.xml`]]) }
        : { type: XML, body: urlset([[`${origin}/p${path}`]]) };
    });
    const cancelled = await second.discover(other.origin, { signal: aborted.signal });
    expect(cancelled.stopped).toBe("cancelled");
    expect(other.hits).toEqual([]);

    // the pace is 3 s for each file: the budget of 5 s ends before the third file
    const timed = await second.discover(other.origin, { budgetMs: 5000, linkedFeeds: false });
    expect(timed.stopped).toBe("budget");
    expect(timed.sources.map((source) => source.url.slice(other.origin.length))).toEqual([
      "/sitemap.xml",
      "/a.xml",
      "/b.xml",
    ]);
    expect(timed.sources[2]!.note).toMatch(/^deadline reached: the host is free at /);
    expect(pagesOf(other)).toEqual(["/sitemap.xml", "/a.xml"]);
  });
});

describe("the scope of discover", () => {
  it("keeps the URLs of the same site by default, and of more hosts with allowHosts", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const reply = (origin: string, answer: (path: string) => { status: number; body: string }) =>
      agent
        .get(origin)
        .intercept({ path: () => true, method: "GET" })
        .reply((request) => {
          const { status, body } =
            request.path === "/robots.txt"
              ? { status: 200, body: `# ${origin}\nUser-agent: *\nAllow: /\n` }
              : answer(request.path);
          return {
            statusCode: status,
            data: body,
            responseOptions: { headers: { "content-type": XML } },
          };
        })
        .persist();
    reply("https://site.example", (path) =>
      path === "/sitemap.xml"
        ? {
            status: 200,
            body: urlset([
              ["https://site.example/a"],
              ["https://www.site.example/b"],
              ["https://cdn.example/c"],
              ["https://blog.cdn.example/d"],
              ["https://other.example/e"],
            ]),
          }
        : { status: 404, body: "" },
    );
    for (const origin of [
      "https://www.site.example",
      "https://cdn.example",
      "https://blog.cdn.example",
      "https://other.example",
    ])
      reply(origin, () => ({ status: 404, body: "" }));
    const { crawler } = await testCrawler({ dispatcher: agent });
    cleanups.push(async () => {
      await crawler.close();
      await agent.close();
    });
    const same = await crawler.discover("https://site.example/", { linkedFeeds: false });
    expect(same.urls.map((url) => url.url)).toEqual([
      "https://site.example/a",
      "https://www.site.example/b",
    ]);
    expect(same.dropped.scope).toBe(3);
    const wider = await crawler.discover("https://site.example/", {
      linkedFeeds: false,
      allowHosts: ["*.cdn.example", "cdn.example"],
    });
    expect(wider.urls.map((url) => url.url)).toEqual([
      "https://site.example/a",
      "https://www.site.example/b",
      "https://cdn.example/c",
      "https://blog.cdn.example/d",
    ]);
    const any = await crawler.discover("https://site.example/", {
      linkedFeeds: false,
      sameSite: false,
    });
    expect(any.urls).toHaveLength(5);
  });
});
