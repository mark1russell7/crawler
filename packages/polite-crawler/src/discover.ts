import { createGunzip } from "node:zlib";
import type { Fetched } from "./crawler.ts";
import { DEADLINE_NOTE } from "./crawler.ts";
import { extractPage } from "./html.ts";
import type { Duration } from "./duration.ts";
import { durationMs } from "./duration.ts";
import type { CrawlRuntime } from "./runtime.ts";
import { fetchAndIndex, isHeldBack } from "./runtime.ts";
import type { Changefreq, SitemapKind, SitemapRead } from "./sitemaps.ts";
import { readSitemap } from "./sitemaps.ts";
import { decodeBody } from "./text.ts";
import type { ScopeOptions } from "./urls.ts";
import { cacheKeyOf, scopeTest } from "./urls.ts";

/**
 * Discovery finds the pages of a site from its sitemaps and its feeds. Each file is a fetch of the
 * crawler, so each polite rule applies to it. These rules are robots.txt, one request at a time for
 * each host, the pace, the stops, the egress policy and the capture log. These are the sources, in sequence:
 *
 * 1. The page at the URL of the site, for the RSS and Atom feeds that it links.
 * 2. The feeds that the caller gives.
 * 3. The sitemaps that the caller gives, and the `Sitemap:` lines of robots.txt. When there are
 *    none, `/sitemap.xml`.
 * 4. The sitemaps of each sitemap index, the newest first, to a maximum depth.
 *
 * Discovery keeps a URL only when it is in scope (the same site by default) and robots.txt permits
 * it. It stops at a maximum of files, a maximum of URLs and a maximum time.
 */

/**
 * These are the default limits of `discover`.
 *
 * @beta
 */
export const DISCOVER_LIMITS = {
  /** The most sitemap and feed files that one discovery reads. */
  maxFiles: 20,
  /** The most URLs that one discovery gives. */
  maxUrls: 10_000,
  /** The most bytes of one file, after decompression: 10 MiB. */
  maxBytes: 10_485_760,
  /** The most levels of sitemap index under a file that discovery found first. */
  maxNesting: 3,
  /** The longest time of one discovery: 1 minute. */
  budgetMs: 60_000,
  /** The most origins whose robots.txt one discovery reads for the URLs that it finds. */
  maxOrigins: 10,
  /** The most feeds that discovery reads from the links of the page. */
  maxLinkedFeeds: 5,
} as const;

/** These options control a discovery. Each limit has a default in `DISCOVER_LIMITS`. */
export interface DiscoverOptions extends ScopeOptions {
  /** This value is the most sitemap and feed files to read. The default is 20. */
  readonly maxFiles?: number | undefined;
  /** This value is the most URLs to give. The default is 10,000. */
  readonly maxUrls?: number | undefined;
  /** This value is the most bytes of one file, after decompression. The default is 10 MiB. */
  readonly maxBytes?: number | undefined;
  /** This value is the most levels of sitemap index to follow. The default is 3. */
  readonly maxNesting?: number | undefined;
  /** This value is the longest time of the discovery, in milliseconds. The default is 1 minute. */
  readonly budgetMs?: number | undefined;
  /** These sitemaps are read too, in addition to the `Sitemap:` lines of robots.txt. */
  readonly sitemaps?: readonly string[] | undefined;
  /** These RSS or Atom feeds are read too. */
  readonly feeds?: readonly string[] | undefined;
  /** With the default value true, discovery reads the page of the site for the feeds that it links. */
  readonly linkedFeeds?: boolean | undefined;
  /**
   * A stored copy of a file younger than this age answers, with no request. The default is `24h`.
   * The value `auto` uses the freshness that the server gave.
   */
  readonly maxAge?: Duration | undefined;
  /** These agents get their robots.txt rules applied to each fetch and to each URL. */
  readonly onBehalfOf?: readonly string[] | undefined;
  /** When this signal aborts, the discovery stops, and it gives what it found. */
  readonly signal?: AbortSignal | undefined;
  /** This label goes into the capture records of the discovery. */
  readonly scope?: string | undefined;
  /** These labels go into the capture records of the discovery. */
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

/**
 * These options control `discoverSite`: the options of `discover`, and a deadline.
 *
 * @beta
 */
export interface DiscoverRunOptions extends DiscoverOptions {
  /** This time (milliseconds since the epoch) ends the discovery when it comes before the end of `budgetMs`. */
  readonly deadline?: number | undefined;
}

/** One URL that a discovery found. */
export interface DiscoveredUrl {
  /** This URL is the canonical form of the URL of the page. */
  readonly url: string;
  /** This time (ISO 8601) is the last change that the file gave, or null. */
  readonly lastmod: string | null;
  readonly changefreq: Changefreq | null;
  /** This value tells if a sitemap or a feed listed the URL. */
  readonly via: "sitemap" | "feed";
  /** This URL is the file that listed the URL first. */
  readonly source: string;
}

/** One sitemap or feed file that a discovery read, or tried to read. */
export interface DiscoverSource {
  readonly url: string;
  readonly via: "sitemap" | "feed";
  /** This value tells how discovery found the file. */
  readonly from: "robots.txt" | "default" | "given" | "page" | "index";
  /** This value is the kind that the reader found, or null for a file that the crawler did not get. */
  readonly kind: SitemapKind | null;
  /** This value is the outcome of the fetch: `ok`, `not-modified`, `skipped`, `not-found` and others. */
  readonly outcome: string;
  readonly status: number;
  /** This id is the capture of the file. */
  readonly capture: string | null;
  readonly fetched_at: string | null;
  readonly from_cache: boolean;
  /** This value is the number of entries that the file listed. */
  readonly entries: number;
  /** This value is the number of new URLs that discovery kept from the file. */
  readonly urls: number;
  /** This value is true when the file was longer than `maxBytes`, so the reader read only its first part. */
  readonly truncated: boolean;
  readonly note: string | null;
}

/** The reason that a discovery stopped. */
export type DiscoverStop =
  "done" | "max-files" | "max-urls" | "budget" | "cancelled" | "closed" | "robots";

/** The result of a discovery. */
export interface DiscoverResult {
  /** This URL is the origin of the site. */
  readonly site: string;
  /** These URLs are the pages that discovery found, the newest `lastmod` first. */
  readonly urls: readonly DiscoveredUrl[];
  /** These are the files that discovery read, in the sequence of the reads. */
  readonly sources: readonly DiscoverSource[];
  /** These values count the URLs that discovery did not keep, for each reason. */
  readonly dropped: {
    /** The URLs on a different site, and the files of an index on a different site. */
    readonly scope: number;
    /** The URLs that robots.txt does not permit. */
    readonly robots: number;
    /** The URLs that discovery found before. */
    readonly duplicate: number;
    /** The entries with no valid http(s) URL. */
    readonly invalid: number;
    /** The URLs and the files over a limit: the origins, the depth of the index, or the URLs. */
    readonly limit: number;
  };
  readonly stopped: DiscoverStop;
  /** This text tells why the discovery stopped early, or null. */
  readonly note: string | null;
}

const PAGE_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";
const SITEMAP_ACCEPT = "application/xml,text/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5";
const FEED_ACCEPT =
  "application/rss+xml,application/atom+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5";
const FEED_KINDS: ReadonlySet<SitemapKind> = new Set(["rss", "atom", "rdf"]);

interface Pending {
  readonly url: string;
  readonly via: "sitemap" | "feed";
  readonly from: DiscoverSource["from"];
  readonly nesting: number;
}

const whole = (name: string, value: number | undefined, fallback: number, min: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(
      `${name} must be an integer of ${String(min)} or more, not ${String(value)}`,
    );
  }
  return value;
};

/**
 * This function reads a body that is gzip data (a `.xml.gz` sitemap). It keeps at most `maxBytes`
 * of the decompressed data, so a decompression bomb stops at the limit.
 */
const gunzipBounded = async (
  body: Uint8Array,
  maxBytes: number,
): Promise<{
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
  readonly error?: string;
}> => {
  const gunzip = createGunzip();
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let error: string | undefined;
  gunzip.end(body);
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      const room = maxBytes - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size += room;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
  } catch (caught) {
    // gzip data that the crawler cut at its limit ends early: the part before the end stays
    error = caught instanceof Error ? caught.message : String(caught);
    truncated = true;
  } finally {
    gunzip.destroy();
  }
  return {
    bytes: Buffer.concat(chunks, size),
    truncated,
    ...(error === undefined ? {} : { error }),
  };
};

const isGzip = (body: Uint8Array): boolean => body[0] === 0x1f && body[1] === 0x8b;

const parsedUrl = (value: string, base?: string): URL | undefined => {
  try {
    const url = base === undefined ? new URL(value.trim()) : new URL(value.trim(), base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};

/** This function gives the value of a promise, or rejects when the signal aborts first. */
const untilAbort = <T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => reject(signal.reason);
    if (signal.aborted) cancel();
    signal.addEventListener("abort", cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
};

/** This function tells if the note of a fetch says that its deadline came first. */
export const pastDeadline = (note: string | null | undefined): boolean =>
  note?.startsWith(DEADLINE_NOTE) === true;

/**
 * This function finds the pages of a site from its sitemaps and its feeds. `PoliteCrawler.discover`
 * uses it. Each file is a fetch of the crawler with the recipe `sitemap` or `feed`, so the
 * capture log records it, and robots.txt applies to it.
 *
 * @beta
 */
export const discoverSite = async (
  runtime: CrawlRuntime,
  site: string,
  options: DiscoverRunOptions = {},
): Promise<DiscoverResult> => {
  const start = parsedUrl(site);
  if (start === undefined) throw new Error(`discover wants an http(s) URL, not "${site}"`);
  const maxFiles = whole("maxFiles", options.maxFiles, DISCOVER_LIMITS.maxFiles, 1);
  const maxUrls = whole("maxUrls", options.maxUrls, DISCOVER_LIMITS.maxUrls, 1);
  const maxBytes = whole("maxBytes", options.maxBytes, DISCOVER_LIMITS.maxBytes, 1);
  const maxNesting = whole("maxNesting", options.maxNesting, DISCOVER_LIMITS.maxNesting, 0);
  const maxAge = options.maxAge ?? "24h";
  const maxAgeMs = maxAge === "auto" ? "auto" : durationMs(maxAge);
  const budgetMs = options.budgetMs ?? DISCOVER_LIMITS.budgetMs;
  if (!(budgetMs >= 0)) throw new RangeError(`budgetMs must be 0 or more, not ${String(budgetMs)}`);
  const now = (): number => Date.parse(runtime.now());
  const deadline = Math.min(now() + budgetMs, options.deadline ?? Number.POSITIVE_INFINITY);
  const crawler = runtime.crawler;
  const signal = options.signal;
  // a function, so the check reads the signal again after each wait
  const cancelled = (): boolean => signal?.aborted === true;
  const marks = { scope: options.scope, labels: options.labels };
  const inScope = scopeTest([start], options);

  const urls = new Map<string, DiscoveredUrl>();
  const sources: DiscoverSource[] = [];
  const dropped = { scope: 0, robots: 0, duplicate: 0, invalid: 0, limit: 0 };
  const origins = new Set<string>();
  const queued = new Set<string>();
  const pending: Pending[] = [];
  let stopped: DiscoverStop | undefined;
  let note: string | null = null;
  let files = 0;
  let next = 0;
  const stopNote = (): string | null => {
    switch (stopped) {
      case "max-files":
        return `discovery read ${String(maxFiles)} files, its limit, and ${String(pending.length - next)} more files wait`;
      case "max-urls":
        return `discovery found ${String(maxUrls)} URLs, its limit`;
      case "budget":
        return `the budget of ${String(budgetMs)} ms ended`;
      case "cancelled":
        return "the caller cancelled the discovery";
      case "closed":
        return "the crawler closed";
      default:
        return null;
    }
  };
  const result = (): DiscoverResult => ({
    site: start.origin,
    urls: [...urls.values()]
      .map((url, order) => ({ url, order }))
      .sort(
        (a, b) =>
          (b.url.lastmod === null ? -Infinity : Date.parse(b.url.lastmod)) -
            (a.url.lastmod === null ? -Infinity : Date.parse(a.url.lastmod)) || a.order - b.order,
      )
      .map(({ url }) => url),
    sources,
    dropped,
    stopped: stopped ?? "done",
    note: note ?? stopNote(),
  });
  /** This function sets the reason of the stop from the note of a fetch, when the note gives one. */
  const stoppedBy = (fetched: { readonly note?: string | null | undefined }): boolean => {
    if (cancelled()) stopped = "cancelled";
    else if (pastDeadline(fetched.note)) stopped = "budget";
    else if (fetched.note === "crawler closed") stopped = "closed";
    else return false;
    return true;
  };
  const enqueue = (url: string, via: Pending["via"], from: Pending["from"], nesting = 0): void => {
    const parsed = parsedUrl(url, start.href);
    if (parsed === undefined) {
      dropped.invalid += 1;
      return;
    }
    const key = cacheKeyOf(parsed.href);
    if (queued.has(key)) return;
    queued.add(key);
    pending.push({ url: parsed.href, via, from, nesting });
  };

  if (cancelled()) {
    stopped = "cancelled";
    return result();
  }
  // robots.txt first: it names the sitemaps, and a site whose robots.txt does not read is closed
  let sitemapLines: readonly string[] = [];
  try {
    const robots = await untilAbort(crawler.readRobots(start.href, marks), signal);
    if (robots.robots.unreachable === "crawler closed") {
      stopped = "closed";
      return result();
    }
    if (robots.robots.unreachable !== undefined) {
      stopped = "robots";
      note = `robots.txt could not be read (${robots.robots.unreachable}), so nothing on the site is fetched`;
      return result();
    }
    sitemapLines = robots.robots.sitemaps;
  } catch {
    stopped = cancelled() ? "cancelled" : "closed";
    return result();
  }

  const fetchFile = (url: string, recipe: "sitemap" | "feed"): Promise<Fetched> =>
    crawler.fetch({
      url,
      mode: "page",
      recipe,
      accept: recipe === "feed" ? FEED_ACCEPT : SITEMAP_ACCEPT,
      maxBytes,
      maxAgeMs,
      onBehalfOf: options.onBehalfOf,
      signal,
      scope: options.scope,
      labels: options.labels,
      deadline,
    });

  // the page of the site names its feeds
  if (options.linkedFeeds !== false) {
    const page = await fetchAndIndex(runtime, {
      url: start.href,
      mode: "page",
      recipe: "page",
      accept: PAGE_ACCEPT,
      maxAgeMs,
      onBehalfOf: options.onBehalfOf,
      signal,
      scope: options.scope,
      labels: options.labels,
      deadline,
    });
    if (stoppedBy(page.fetched)) return result();
    const doc = page.docs[0];
    const body = page.fetched.body;
    const html = /html/i.test(page.fetched.contentType ?? "text/html");
    // the links of a page that asked not to be AI input are held back, its feeds too
    if (body !== undefined && html && doc !== undefined && !isHeldBack(doc)) {
      let linked: readonly string[] = [];
      try {
        linked =
          extractPage(decodeBody(body, page.fetched.contentType ?? null), page.fetched.url).feeds ??
          [];
      } catch {
        // a page that the reader cannot read names no feed
      }
      let taken = 0;
      for (const feed of linked) {
        const parsed = parsedUrl(feed);
        if (parsed === undefined || !inScope(parsed)) {
          dropped.scope += 1;
          continue;
        }
        if (taken >= DISCOVER_LIMITS.maxLinkedFeeds) {
          dropped.limit += 1;
          continue;
        }
        taken += 1;
        enqueue(parsed.href, "feed", "page");
      }
    }
  }
  for (const feed of options.feeds ?? []) enqueue(feed, "feed", "given");
  for (const sitemap of options.sitemaps ?? []) enqueue(sitemap, "sitemap", "given");
  for (const sitemap of sitemapLines) enqueue(sitemap, "sitemap", "robots.txt");
  if ((options.sitemaps ?? []).length === 0 && sitemapLines.length === 0)
    enqueue(new URL("/sitemap.xml", start.origin).href, "sitemap", "default");

  /** This function keeps the page URLs of one file that are new, in scope and permitted. */
  const keep = async (
    read: SitemapRead,
    source: string,
    via: "sitemap" | "feed",
  ): Promise<number> => {
    let kept = 0;
    dropped.invalid += read.invalid;
    for (const entry of read.entries) {
      if (urls.size >= maxUrls) {
        stopped = "max-urls";
        return kept;
      }
      const known = urls.get(entry.url);
      if (known !== undefined) {
        dropped.duplicate += 1;
        // the same page in two files keeps the later change
        if (
          entry.lastmod !== null &&
          (known.lastmod === null || Date.parse(entry.lastmod) > Date.parse(known.lastmod))
        )
          urls.set(entry.url, { ...known, lastmod: entry.lastmod });
        continue;
      }
      const url = new URL(entry.url);
      if (!inScope(url)) {
        dropped.scope += 1;
        continue;
      }
      if (!origins.has(url.origin)) {
        if (origins.size >= DISCOVER_LIMITS.maxOrigins) {
          dropped.limit += 1;
          continue;
        }
        origins.add(url.origin);
      }
      let allowed: boolean;
      try {
        allowed = (
          await crawler.robotsAllow(entry.url, {
            onBehalfOf: options.onBehalfOf,
            signal,
            ...marks,
          })
        ).allowed;
      } catch {
        stopped = "cancelled";
        return kept;
      }
      if (!allowed) {
        dropped.robots += 1;
        continue;
      }
      urls.set(entry.url, {
        url: entry.url,
        lastmod: entry.lastmod,
        changefreq: entry.changefreq,
        via,
        source,
      });
      kept += 1;
    }
    return kept;
  };

  for (; next < pending.length && stopped === undefined; next += 1) {
    if (cancelled()) {
      stopped = "cancelled";
      break;
    }
    if (now() >= deadline) {
      stopped = "budget";
      break;
    }
    if (files >= maxFiles) {
      stopped = "max-files";
      break;
    }
    const file = pending[next]!;
    files += 1;
    const fetched = await fetchFile(file.url, file.via);
    const base = {
      url: fetched.url,
      via: file.via,
      from: file.from,
      outcome: fetched.outcome,
      status: fetched.status,
      capture: fetched.capture ?? null,
      fetched_at: fetched.fetchedAt ?? null,
      from_cache: fetched.fromCache,
    };
    if (stoppedBy(fetched)) {
      sources.push({
        ...base,
        kind: null,
        entries: 0,
        urls: 0,
        truncated: false,
        note: fetched.note ?? null,
      });
      break;
    }
    const body = fetched.body;
    if ((fetched.outcome !== "ok" && fetched.outcome !== "not-modified") || body === undefined) {
      sources.push({
        ...base,
        kind: null,
        entries: 0,
        urls: 0,
        truncated: false,
        note: fetched.note ?? `${fetched.outcome} ${String(fetched.status)}`,
      });
      continue;
    }
    let bytes = body;
    let truncated = fetched.truncated === true;
    const notes: string[] = [];
    if (isGzip(body)) {
      const unzipped = await gunzipBounded(body, maxBytes);
      bytes = unzipped.bytes;
      truncated ||= unzipped.truncated;
      if (unzipped.error !== undefined) notes.push(`the gzip data ended early (${unzipped.error})`);
    }
    const read = readSitemap(
      decodeBody(bytes, isGzip(body) ? null : (fetched.contentType ?? null)),
      fetched.url,
    );
    if (truncated)
      notes.push(
        `the file is longer than ${String(maxBytes)} bytes, so discovery read its first part`,
      );
    notes.push(...read.notes);
    let kept = 0;
    if (read.kind === "sitemapindex") {
      // the newest sitemaps first, so a limit leaves out the oldest
      const children = [...read.entries].sort(
        (a, b) =>
          (b.lastmod === null ? -Infinity : Date.parse(b.lastmod)) -
          (a.lastmod === null ? -Infinity : Date.parse(a.lastmod)),
      );
      for (const child of children) {
        const parsed = new URL(child.url);
        if (!inScope(parsed)) dropped.scope += 1;
        else if (file.nesting + 1 > maxNesting) dropped.limit += 1;
        else enqueue(child.url, "sitemap", "index", file.nesting + 1);
      }
      if (file.nesting + 1 > maxNesting && children.length > 0)
        notes.push(
          `the files of the index are deeper than maxNesting (${String(maxNesting)}), so discovery reads none of them`,
        );
    } else if (read.kind !== "unknown") {
      kept = await keep(read, fetched.url, FEED_KINDS.has(read.kind) ? "feed" : "sitemap");
    }
    sources.push({
      ...base,
      kind: read.kind,
      entries: read.entries.length,
      urls: kept,
      truncated,
      note: notes.length > 0 ? notes.join("; ") : null,
    });
  }
  if (stopped === undefined && urls.size >= maxUrls) stopped = "max-urls";
  return result();
};
