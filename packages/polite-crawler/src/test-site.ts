/*
 * The tests of discovery and of the crawl use these helpers. A local site is a real HTTP server
 * on 127.0.0.1. It records each request with the time of the clock of the test, and the most
 * requests in progress at one time for each host. No test uses the network.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { openCrawler } from "./open.ts";
import type { OpenOptions, PoliteCrawler } from "./open.ts";
import type { Clock } from "./politeness.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";

/** The answer of a local site to one path. */
export interface Reply {
  readonly status?: number | undefined;
  readonly type?: string | undefined;
  readonly body?: string | Uint8Array | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** When this promise is given, the site answers after it resolves. */
  readonly after?: Promise<unknown> | undefined;
}

/** One request that a local site got. */
export interface Hit {
  readonly path: string;
  /** This time is the time of the clock of the test when the request came. */
  readonly at: number;
}

export interface TestSite {
  readonly origin: string;
  readonly hits: Hit[];
  /** This value is the most requests in progress at one time. */
  readonly maxInFlight: () => number;
  /** These paths are the requests that ended before the site answered: the client stopped them. */
  readonly dropped: string[];
  readonly close: () => Promise<void>;
}

/** This function gives the paths of the hits, without robots.txt. */
export const pagesOf = (site: TestSite): string[] =>
  site.hits.map((hit) => hit.path).filter((path) => path !== "/robots.txt");

/**
 * This function starts a local site. The function `route` gives the reply for each path, and a
 * path that it does not know gives a 404. The site gives `robots` for `/robots.txt` unless `route`
 * gives a reply for it.
 */
export const testSite = async (
  route: (path: string, origin: string, request: IncomingMessage) => Reply | undefined,
  clock: Clock,
  robots = "User-agent: *\nAllow: /\n",
): Promise<TestSite> => {
  const hits: Hit[] = [];
  const dropped: string[] = [];
  let inFlight = 0;
  let most = 0;
  let origin = "";
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "/";
    hits.push({ path, at: clock.now() });
    inFlight += 1;
    most = Math.max(most, inFlight);
    let ended = false;
    response.on("close", () => {
      inFlight -= 1;
      if (!ended) dropped.push(path);
    });
    const reply: Reply =
      route(path, origin, request) ??
      (path === "/robots.txt"
        ? { type: "text/plain", body: robots }
        : { status: 404, type: "text/plain", body: "no such page" });
    const send = (): void => {
      if (response.destroyed) return;
      response.writeHead(reply.status ?? 200, {
        ...(reply.type === undefined ? {} : { "content-type": reply.type }),
        ...reply.headers,
      });
      ended = true;
      response.end(reply.body ?? "");
    };
    if (reply.after === undefined) send();
    else void reply.after.then(send);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    origin,
    hits,
    dropped,
    maxInFlight: () => most,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

/** This function gives an HTML page with a title, some text and links. */
export const htmlPage = (title: string, links: readonly string[] = [], head = ""): string =>
  `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body><h1>${title}</h1><p>${"The words of a plain page for the tests. ".repeat(8)}</p>${links.map((link) => `<a href="${link}">${link}</a>`).join(" ")}</body></html>`;

/** This function gives the XML of a sitemap with these URLs and dates. */
export const urlset = (entries: ReadonlyArray<readonly [string, string?]>): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries
    .map(
      ([loc, lastmod]) =>
        `<url><loc>${loc}</loc>${lastmod === undefined ? "" : `<lastmod>${lastmod}</lastmod>`}</url>`,
    )
    .join("")}</urlset>`;

/** This function gives the XML of a sitemap index with these sitemaps and dates. */
export const sitemapIndex = (entries: ReadonlyArray<readonly [string, string?]>): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries
    .map(
      ([loc, lastmod]) =>
        `<sitemap><loc>${loc}</loc>${lastmod === undefined ? "" : `<lastmod>${lastmod}</lastmod>`}</sitemap>`,
    )
    .join("")}</sitemapindex>`;

export interface TestCrawler {
  readonly crawler: PoliteCrawler;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly dir: string;
  readonly close: () => Promise<void>;
}

/** This function opens a crawler on a new store, with the fake clock and private addresses permitted. */
export const testCrawler = async (
  options: Partial<OpenOptions> & { readonly clock?: ReturnType<typeof fakeClock> } = {},
): Promise<TestCrawler> => {
  const dir = await tempDir("discover");
  const clock = options.clock ?? fakeClock();
  const crawler = openCrawler({
    renderer: false,
    egress: { allowPrivate: true },
    random: () => 0.5,
    ...options,
    dir,
    clock,
  });
  return {
    crawler,
    clock,
    dir,
    close: async () => {
      await crawler.close();
      await removeDir(dir);
    },
  };
};
