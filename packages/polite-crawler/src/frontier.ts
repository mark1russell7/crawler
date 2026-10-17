import { discoverSite, pastDeadline } from "./discover.ts";
import type { Duration } from "./duration.ts";
import { durationMs } from "./duration.ts";
import { matchesPattern } from "./robots.ts";
import type { CrawlRuntime, PageResult } from "./runtime.ts";
import { fetchPage, isHeldBack } from "./runtime.ts";
import type { ScopeOptions } from "./urls.ts";
import { cacheKeyOf, scopeTest } from "./urls.ts";

/**
 * The frontier is a small crawl of a site. It starts at the seeds. It follows the links of each page
 * that it fetched, to a maximum of pages, a maximum depth and a maximum time.
 *
 * Each page is a fetch of the crawler, so each polite rule applies. These rules are robots.txt, one
 * request at a time for each host, the pace, the stops, the egress policy and the capture log. The
 * frontier does not start a second request to a host with a request in progress. The crawler
 * limits the hosts in progress (`maxActive`).
 *
 * The state of the frontier is in memory, for one call. A later version can make it resumable.
 */

/** These are the default limits of `crawl`, and the limits of the memory of the frontier. */
export const CRAWL_LIMITS = {
  /** The most pages that one crawl gives. */
  maxPages: 100,
  /** The most links from a seed to a page. A seed has the depth 0. */
  maxDepth: 3,
  /** The longest time of one crawl: 10 minutes. */
  budgetMs: 600_000,
  /** The most hosts that get a request of the crawl at one time. */
  hostsAtOnce: 16,
  /** The most URLs that wait in the frontier. */
  maxQueue: 10_000,
  /** The most URLs that the frontier remembers, so it fetches none of them two times. */
  maxSeen: 100_000,
} as const;

/**
 * A pattern for the URLs of a crawl. A text that starts with `/` matches the path and the query.
 * A different text matches the whole URL. In a text, `*` matches any characters and a `$` at the
 * end matches the end, as in robots.txt. A regular expression tests the whole URL.
 */
export type UrlPattern = string | RegExp;

/** These options control a crawl. Each limit has a default in `CRAWL_LIMITS`. */
export interface CrawlOptions extends ScopeOptions {
  /** This value is the most pages that the crawl gives. The default is 100. */
  readonly maxPages?: number | undefined;
  /** This value is the most links from a seed to a page. The default is 3, and 0 fetches only the seeds. */
  readonly maxDepth?: number | undefined;
  /** This value is the longest time of the crawl in milliseconds. No request starts after it. The default is 10 minutes. */
  readonly budgetMs?: number | undefined;
  /** When this list is not empty, the crawl follows only a URL that matches a pattern of it. */
  readonly include?: readonly UrlPattern[] | undefined;
  /** The crawl follows no URL that matches a pattern of this list. */
  readonly exclude?: readonly UrlPattern[] | undefined;
  /** With the value true, the crawl adds the pages of the sitemaps of each site of the seeds (`discover`). */
  readonly useSitemaps?: boolean | undefined;
  /** The value `auto` renders a page only when it shows almost nothing without JavaScript. */
  readonly render?: "auto" | "never" | "always" | undefined;
  /** A stored copy younger than this age answers, with no request. The default is `24h`. */
  readonly maxAge?: Duration | undefined;
  /** These agents get their robots.txt rules applied to each fetch. */
  readonly onBehalfOf?: readonly string[] | undefined;
  /** When this signal aborts, the crawl stops the fetches in progress and ends. */
  readonly signal?: AbortSignal | undefined;
  /** This label goes into the capture records of the crawl. */
  readonly scope?: string | undefined;
  /** These labels go into the capture records of the crawl. */
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

/** These options control `crawlSite`: the options of `crawl`, and a step before the first fetch. */
export interface CrawlRunOptions extends CrawlOptions {
  /** This function operates before the first fetch. `openCrawler` waits there for the open of the store. */
  readonly ready?: (() => Promise<void>) | undefined;
}

/** A page of a crawl: the result of its fetch, and the place of the page in the crawl. */
export interface CrawlPage extends PageResult {
  /** This value is the number of links from a seed to the page. */
  readonly depth: number;
  /** This value tells if the page is a seed, a page of a sitemap, or the target of a link. */
  readonly source: "seed" | "sitemap" | "link";
  /** This URL is the page whose link the crawl followed, or null. */
  readonly referrer: string | null;
}

/** The reason that a crawl stopped. */
export type CrawlStop = "done" | "max-pages" | "budget" | "cancelled" | "closed" | "error";

/** The summary of a crawl. */
export interface CrawlSummary {
  /** This value is the number of pages that the crawl gave. */
  readonly pages: number;
  /** This value counts the pages with a document: `ok` or `not-modified`, from the store too. */
  readonly fetched: number;
  /** This value counts the pages that a stored copy answered, with no request. */
  readonly from_cache: number;
  /**
   * This value counts the refusals. These are the links that robots.txt does not permit, and the
   * pages that the crawler declined (`skipped`). The pages that the site refused (`blocked`,
   * `challenge`, `payment-required`) are refusals too.
   */
  readonly refused: number;
  /** This value counts the pages with a different outcome, for example `error` or `not-found`. */
  readonly failed: number;
  /** This value counts the links that the crawl did not follow. `skips` gives the reasons. */
  readonly skipped: number;
  readonly skips: {
    /** The links to a host that is not in scope. */
    readonly scope: number;
    /** The links that `include` or `exclude` left out. */
    readonly pattern: number;
    /** The links deeper than `maxDepth`. */
    readonly depth: number;
    /** The pages that asked not to be AI input: the crawl does not follow their links. */
    readonly held_back: number;
    /** The links over the limits of the memory of the frontier. */
    readonly limit: number;
    /** The URLs that a fetched page had as its final or its canonical URL. */
    readonly duplicate: number;
  };
  /** This value counts the URLs that waited in the frontier at the stop. */
  readonly queued: number;
  /** This value counts the URLs that the sitemaps gave, with `useSitemaps`. */
  readonly sitemap_urls: number;
  readonly stopped: CrawlStop;
  /** This text tells why the crawl stopped. */
  readonly reason: string;
  /** This value is the time of the crawl in milliseconds, on the clock of the crawler. */
  readonly elapsed_ms: number;
}

/**
 * A crawl in progress. A `for await` loop gets each page when its fetch ends. `summary` resolves
 * when the loop ends: at the last page, at a stop or at a `break`. The crawl starts at the first
 * step of the loop, and each crawl operates one time only.
 */
export interface CrawlRun extends AsyncIterable<CrawlPage> {
  readonly summary: Promise<CrawlSummary>;
}

interface Item {
  readonly url: string;
  /** This key is the canonical form of the URL, with no fragment. */
  readonly key: string;
  readonly host: string;
  readonly depth: number;
  /** The seeds come first (0), then the URLs of the sitemaps (1), then the links (2). */
  readonly tier: number;
  readonly lastmod: number;
  readonly seq: number;
  readonly source: CrawlPage["source"];
  readonly referrer: string | null;
}

type Done =
  | { readonly kind: "page"; readonly item: Item; readonly page: PageResult }
  | { readonly kind: "refused"; readonly item: Item }
  | { readonly kind: "aborted"; readonly item: Item };

/** The lower depth first, then the lower tier, then the newer `lastmod`, then the first found. */
const before = (a: Item, b: Item): number =>
  a.depth - b.depth || a.tier - b.tier || b.lastmod - a.lastmod || a.seq - b.seq;

/** A binary heap of the URLs of one host, the first URL to fetch at the top. */
class Heap {
  private readonly items: Item[] = [];

  get size(): number {
    return this.items.length;
  }

  peek(): Item | undefined {
    return this.items[0];
  }

  push(item: Item): void {
    const items = this.items;
    items.push(item);
    let at = items.length - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (before(items[at]!, items[parent]!) >= 0) break;
      [items[at], items[parent]] = [items[parent]!, items[at]!];
      at = parent;
    }
  }

  pop(): Item | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined || items.length === 0) return top;
    items[0] = last;
    let at = 0;
    for (;;) {
      const left = at * 2 + 1;
      const right = left + 1;
      let first = at;
      if (left < items.length && before(items[left]!, items[first]!) < 0) first = left;
      if (right < items.length && before(items[right]!, items[first]!) < 0) first = right;
      if (first === at) return top;
      [items[at], items[first]] = [items[first]!, items[at]!];
      at = first;
    }
  }
}

const hostOf = (url: URL): string =>
  `${url.hostname.toLowerCase().replace(/\.$/, "")}${url.port === "" ? "" : `:${url.port}`}`;

const matcher = (pattern: UrlPattern): ((url: URL) => boolean) => {
  if (pattern instanceof RegExp) {
    return (url) => {
      pattern.lastIndex = 0;
      return pattern.test(url.href);
    };
  }
  if (typeof pattern !== "string" || pattern.length === 0)
    throw new RangeError("a URL pattern is a regular expression or a text that is not empty");
  return pattern.startsWith("/")
    ? (url) => matchesPattern(pattern, `${url.pathname}${url.search}`)
    : (url) => matchesPattern(pattern, url.href);
};

const whole = (name: string, value: number | undefined, fallback: number, min: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(
      `${name} must be an integer of ${String(min)} or more, not ${String(value)}`,
    );
  }
  return value;
};

const failedPage = (url: string, note: string): PageResult => ({
  url,
  doc: null,
  outcome: "error",
  status: 0,
  title: null,
  chars: 0,
  rendered: false,
  structured: [],
  links: 0,
  captures: [],
  capture: null,
  capture_count: 0,
  fetched_at: null,
  from_cache: false,
  held_back: false,
  note,
});

const REFUSALS: ReadonlySet<string> = new Set([
  "skipped",
  "blocked",
  "challenge",
  "payment-required",
]);

/**
 * This function crawls a site from its seeds. `PoliteCrawler.crawl` uses it. It gives each page
 * when its fetch ends, and a summary at the end. The seeds come first, then the pages of the
 * sitemaps (the newest first), then the links, the lower depth first.
 */
export const crawlSite = (
  runtime: CrawlRuntime,
  seeds: string | readonly string[],
  options: CrawlRunOptions = {},
): CrawlRun => {
  let resolveSummary: (summary: CrawlSummary) => void = () => undefined;
  const summary = new Promise<CrawlSummary>((resolve) => {
    resolveSummary = resolve;
  });
  let used = false;

  async function* pages(): AsyncGenerator<CrawlPage, void, undefined> {
    const now = (): number => Date.parse(runtime.now());
    const startedAt = now();
    const abort = new AbortController();
    const outer = options.signal;
    const cancel = (): void => abort.abort(outer?.reason);
    if (outer?.aborted === true) cancel();
    outer?.addEventListener("abort", cancel, { once: true });
    const inflight = new Map<string, Promise<Done>>();
    const heaps = new Map<string, Heap>();
    const seen = new Set<string>();
    const counts = { pages: 0, fetched: 0, from_cache: 0, refused: 0, failed: 0, sitemap_urls: 0 };
    const skips = { scope: 0, pattern: 0, depth: 0, held_back: 0, limit: 0, duplicate: 0 };
    // the final and the canonical URLs of the fetched pages: a URL that waits for one of them is not fetched
    const got = new Set<string>();
    let queued = 0;
    let returned = 0;
    let seq = 0;
    let started = 0;
    let stopping: CrawlStop | undefined;
    let reason: string | undefined;
    let finished = false;
    let maxPages: number = CRAWL_LIMITS.maxPages;
    let budgetMs: number = CRAWL_LIMITS.budgetMs;

    const crawler = runtime.crawler;
    const marks = { scope: options.scope, labels: options.labels };

    try {
      await options.ready?.();
      maxPages = whole("maxPages", options.maxPages, CRAWL_LIMITS.maxPages, 1);
      const maxDepth = whole("maxDepth", options.maxDepth, CRAWL_LIMITS.maxDepth, 0);
      budgetMs = options.budgetMs ?? CRAWL_LIMITS.budgetMs;
      if (!(budgetMs >= 0))
        throw new RangeError(`budgetMs must be 0 or more, not ${String(budgetMs)}`);
      const maxAge = options.maxAge ?? "24h";
      const maxAgeMs = maxAge === "auto" ? "auto" : durationMs(maxAge);
      const includes = (options.include ?? []).map(matcher);
      const excludes = (options.exclude ?? []).map(matcher);
      const deadline = startedAt + budgetMs;
      const list = typeof seeds === "string" ? [seeds] : [...seeds];
      if (list.length === 0) throw new RangeError("a crawl needs one seed URL or more");
      const starts = list.flatMap((seed) => {
        try {
          const url = new URL(seed);
          return url.protocol === "http:" || url.protocol === "https:" ? [url] : [];
        } catch {
          return [];
        }
      });
      const inScope = scopeTest(starts, options);
      const followed = (url: URL): boolean =>
        (includes.length === 0 || includes.some((test) => test(url))) &&
        !excludes.some((test) => test(url));

      /** This function adds a URL to the frontier, when it is new, in scope and not too deep. */
      const offer = (
        raw: string,
        depth: number,
        tier: number,
        lastmod: number,
        source: Item["source"],
        referrer: string | null,
      ): void => {
        let url: URL | undefined;
        try {
          url = new URL(raw);
        } catch {
          url = undefined;
        }
        const web = url !== undefined && (url.protocol === "http:" || url.protocol === "https:");
        if (!web && source !== "seed") return;
        // a fragment, a tracking parameter or a default port does not make a different page
        const key = cacheKeyOf(url?.href ?? raw);
        if (seen.has(key)) return;
        if (seen.size >= CRAWL_LIMITS.maxSeen) {
          skips.limit += 1;
          return;
        }
        seen.add(key);
        if (source !== "seed" && url !== undefined) {
          if (!inScope(url)) {
            skips.scope += 1;
            return;
          }
          if (!followed(url)) {
            skips.pattern += 1;
            return;
          }
          if (depth > maxDepth) {
            skips.depth += 1;
            return;
          }
        }
        if (queued >= CRAWL_LIMITS.maxQueue) {
          skips.limit += 1;
          return;
        }
        const host = url === undefined || !web ? `not-web:${raw}` : hostOf(url);
        let heap = heaps.get(host);
        if (heap === undefined) {
          heap = new Heap();
          heaps.set(host, heap);
        }
        seq += 1;
        heap.push({ url: raw, key, host, depth, tier, lastmod, seq, source, referrer });
        queued += 1;
      };

      /** This function gives the first URL of a host with no request of the crawl in progress. */
      const pick = (): Item | undefined => {
        for (;;) {
          let best: { readonly host: string; readonly heap: Heap } | undefined;
          for (const [host, heap] of heaps) {
            if (inflight.has(host)) continue;
            const top = heap.peek();
            if (top === undefined) continue;
            if (best === undefined || before(top, best.heap.peek()!) < 0) best = { host, heap };
          }
          if (best === undefined) return undefined;
          const item = best.heap.pop()!;
          queued -= 1;
          if (best.heap.size === 0) heaps.delete(best.host);
          if (!got.has(item.key)) return item;
          skips.duplicate += 1;
        }
      };

      const fetchItem = async (item: Item): Promise<Done> => {
        try {
          // a seed is the choice of the caller; a link that robots.txt refuses costs no fetch
          if (item.source !== "seed") {
            const verdict = await crawler.robotsAllow(item.url, {
              onBehalfOf: options.onBehalfOf,
              signal: abort.signal,
              ...marks,
            });
            if (!verdict.allowed) return { kind: "refused", item };
          }
          const page = await fetchPage(runtime, item.url, {
            render: options.render ?? "auto",
            maxAgeMs,
            onBehalfOf: options.onBehalfOf,
            signal: abort.signal,
            scope: options.scope,
            labels: options.labels,
            deadline,
          });
          return { kind: "page", item, page };
        } catch (error) {
          if (abort.signal.aborted) return { kind: "aborted", item };
          const message = error instanceof Error ? error.message : String(error);
          return { kind: "page", item, page: failedPage(item.url, `crawl error: ${message}`) };
        }
      };

      /** This function adds the links of a page to the frontier. The canonical URL of the page is known after its fetch. */
      const follow = (page: PageResult, item: Item): void => {
        if (page.doc === null) return;
        const doc = runtime.index.get(page.doc);
        if (doc === undefined) return;
        for (const same of [doc.url, doc.meta["canonical"]]) {
          if (typeof same !== "string") continue;
          seen.add(cacheKeyOf(same));
          got.add(cacheKeyOf(same));
        }
        const links = doc.meta["links"];
        if (!Array.isArray(links) || links.length === 0) return;
        // the links of a page that asked not to be AI input are held back with its text
        if (isHeldBack(doc)) {
          skips.held_back += 1;
          return;
        }
        for (const link of links as ReadonlyArray<{ readonly href?: unknown }>) {
          if (typeof link?.href === "string")
            offer(link.href, item.depth + 1, 2, Number.NEGATIVE_INFINITY, "link", page.url);
        }
      };

      for (const seed of list) offer(seed, 0, 0, Number.NEGATIVE_INFINITY, "seed", null);
      if (options.useSitemaps === true) {
        const sites = [...new Set(starts.map((start) => start.origin))];
        for (const site of sites) {
          if (abort.signal.aborted || now() >= deadline) break;
          try {
            const found = await discoverSite(runtime, site, {
              sameSite: options.sameSite,
              allowHosts: options.allowHosts,
              maxUrls: Math.min(10_000, Math.max(50, maxPages * 4)),
              // the crawl fetches the seed page itself, and never two times
              linkedFeeds: false,
              maxAge,
              onBehalfOf: options.onBehalfOf,
              signal: abort.signal,
              scope: options.scope,
              labels: options.labels,
              deadline,
            });
            counts.sitemap_urls += found.urls.length;
            for (const url of found.urls) {
              offer(
                url.url,
                0,
                1,
                url.lastmod === null ? Number.NEGATIVE_INFINITY : Date.parse(url.lastmod),
                "sitemap",
                null,
              );
            }
          } catch {
            // a site whose sitemaps do not read is crawled from its seeds
          }
        }
      }

      for (;;) {
        if (stopping === undefined && abort.signal.aborted) stopping = "cancelled";
        if (stopping === undefined && now() >= deadline) stopping = "budget";
        while (
          stopping === undefined &&
          inflight.size < CRAWL_LIMITS.hostsAtOnce &&
          started < maxPages
        ) {
          const item = pick();
          if (item === undefined) break;
          started += 1;
          inflight.set(item.host, fetchItem(item));
        }
        if (inflight.size === 0) break;
        const done = await Promise.race(inflight.values());
        inflight.delete(done.item.host);
        if (done.kind === "aborted") {
          started -= 1;
          stopping ??= "cancelled";
          continue;
        }
        if (done.kind === "refused") {
          started -= 1;
          counts.refused += 1;
          continue;
        }
        const page = done.page;
        if (pastDeadline(page.note)) {
          // the host was not free before the end of the budget: the page waits, and the crawl stops
          started -= 1;
          returned += 1;
          stopping ??= "budget";
          continue;
        }
        if (abort.signal.aborted) {
          started -= 1;
          stopping ??= "cancelled";
          continue;
        }
        if (page.outcome === "skipped" && page.note === "crawler closed") {
          started -= 1;
          stopping ??= "closed";
          continue;
        }
        counts.pages += 1;
        if (page.outcome === "ok" || page.outcome === "not-modified") {
          counts.fetched += 1;
          if (page.from_cache) counts.from_cache += 1;
        } else if (REFUSALS.has(page.outcome)) counts.refused += 1;
        else counts.failed += 1;
        follow(page, done.item);
        yield {
          ...page,
          depth: done.item.depth,
          source: done.item.source,
          referrer: done.item.referrer,
        };
      }
      stopping ??= queued > 0 && started >= maxPages ? "max-pages" : "done";
      finished = true;
    } catch (error) {
      stopping = "error";
      reason = error instanceof Error ? error.message : String(error);
      finished = true;
      throw error;
    } finally {
      // a loop that stopped early (a break) cancels the crawl
      if (!finished) {
        stopping ??= "cancelled";
        reason ??= "the caller stopped the loop";
      }
      outer?.removeEventListener("abort", cancel);
      abort.abort(new Error("the crawl ended"));
      // the fetches in progress end and write their records before the summary
      await Promise.allSettled(inflight.values());
      const stop = stopping ?? "done";
      reason ??=
        stop === "done"
          ? "the crawl fetched each page in scope that it found"
          : stop === "max-pages"
            ? `the crawl gave ${String(maxPages)} pages, its limit (maxPages)`
            : stop === "budget"
              ? `the budget of ${String(budgetMs)} ms ended (budgetMs)`
              : stop === "cancelled"
                ? "the caller cancelled the crawl"
                : "the crawler closed";
      resolveSummary({
        ...counts,
        skipped:
          skips.scope +
          skips.pattern +
          skips.depth +
          skips.held_back +
          skips.limit +
          skips.duplicate,
        skips,
        queued: queued + returned,
        stopped: stop,
        reason,
        elapsed_ms: Math.max(0, now() - startedAt),
      });
    }
  }

  return {
    summary,
    [Symbol.asyncIterator]() {
      if (used) throw new Error("a crawl runs one time: call crawl again for a new crawl");
      used = true;
      return pages();
    },
  };
};
