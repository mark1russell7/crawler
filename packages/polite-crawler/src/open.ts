import { join } from "node:path";
import type { Dispatcher } from "undici";
import { FileBlobStore } from "./blobs.ts";
import { Crawler } from "./crawler.ts";
import type { Found } from "./docs.ts";
import { DocIndex, locate } from "./docs.ts";
import { CaptureLog } from "./log.ts";
import { makeRecord } from "./record.ts";
import type { Renderer } from "./render.ts";
import { playwrightRenderer } from "./render.ts";
import type { CrawlRuntime, PageResult } from "./runtime.ts";
import { Extractors, fetchPage, reindex } from "./runtime.ts";
import type { AiInput } from "./signals.ts";
import { VERSION } from "./version.ts";

/** This is the product token that robots.txt rules match when an application gives no token. */
export const DEFAULT_TOKEN = "PoliteCrawler";

/** This page tells a site owner what the crawler is and how to control it. */
export const BOT_PAGE = "https://mark1russell7.github.io/crawler/bot/";

/**
 * This function gives the default `User-Agent` header. The header names the crawler, its version
 * and the page about it, so a site owner can find out what made each request.
 */
export const defaultUserAgent = (contact?: string): string =>
  `${DEFAULT_TOKEN}/${VERSION} (+${BOT_PAGE}${contact === undefined ? "" : `; ${contact}`})`;

/** A duration is a count of milliseconds, or a text, for example `"30m"`, `"24h"` or `"7d"`. */
export type Duration = number | string;

const UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** This function changes a duration into milliseconds. It throws an error for a text that it cannot read. */
export const durationMs = (duration: Duration): number => {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) throw new Error(`not a duration: ${String(duration)}`);
    return duration;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/i.exec(duration);
  const unit = match?.[2]?.toLowerCase();
  const factor = unit === undefined ? undefined : UNITS[unit];
  if (match === null || factor === undefined) {
    throw new Error(`not a duration: "${duration}" (write a number and ms, s, m, h, d or w)`);
  }
  return Number(match[1]) * factor;
};

/** These options open a crawler on a folder. Only `dir` is necessary. */
export interface OpenOptions {
  /** This folder keeps the capture log, the response bodies and the search index. */
  readonly dir: string;
  /** This token is the name that robots.txt rules match. The default is `PoliteCrawler`. */
  readonly token?: string | undefined;
  /** This text is the full `User-Agent` header. The default names the crawler and its page. */
  readonly userAgent?: string | undefined;
  /** This address goes into the `From` header and the `User-Agent` header. The crawler sends no contact without it. */
  readonly contact?: string | undefined;
  /** This browser renders the pages that need JavaScript. The value `false` turns rendering off. */
  readonly renderer?: Renderer | false | undefined;
  /** This value is the number of sites that the crawler fetches from at one time. The default is 16. */
  readonly maxActive?: number | undefined;
  /** These agents get their robots.txt rules applied to each fetch, for example `Claude-User`. */
  readonly onBehalfOf?: readonly string[] | undefined;
  /** This `undici` dispatcher sends the requests. Tests give a mock agent, and a proxy is possible. */
  readonly dispatcher?: Dispatcher | undefined;
}

/** These options control one fetch. */
export interface FetchOptions {
  /** The value `auto` renders a page only when it shows almost nothing without JavaScript. */
  readonly render?: "auto" | "never" | "always" | undefined;
  /** A stored copy younger than this age answers, and the crawler sends no request. The default is `24h`. */
  readonly maxAge?: Duration | undefined;
  /** These agents get their robots.txt rules applied to this fetch, in addition to the defaults. */
  readonly onBehalfOf?: readonly string[] | undefined;
}

/** This result is a part of one stored document. */
export interface ReadResult {
  readonly doc: string;
  readonly kind: string;
  readonly title: string;
  readonly url: string | null;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly from: number;
  readonly to: number;
  readonly total: number;
  readonly text: string;
  readonly captures: readonly string[];
  readonly ai_input: AiInput;
  /** This value is true when the page asked not to be AI input. The text is then empty. */
  readonly held_back: boolean;
  readonly note: string | null;
}

/** This result tells if a quote is in a stored document, and where. */
export interface VerifyResult {
  readonly doc: string;
  readonly found: boolean;
  readonly start: number | null;
  readonly end: number | null;
  readonly excerpt: string | null;
  readonly url: string | null;
  readonly captures: readonly string[];
}

/** A polite crawler fetches each source one time, keeps it, and answers the next questions from the disk. */
export interface PoliteCrawler {
  /** The runtime gives the parts to an application that needs more control. */
  readonly runtime: CrawlRuntime;
  /** This method fetches a page, reads it and adds it to the index. */
  fetch(url: string, options?: FetchOptions): Promise<PageResult>;
  /** This method searches the stored documents. It sends no request. */
  find(q: string, options?: { readonly limit?: number; readonly kind?: string | null }): Found[];
  /** This method reads a range of characters of one stored document. */
  read(
    doc: string,
    options?: { readonly from?: number; readonly length?: number; readonly userProvided?: boolean },
  ): Promise<ReadResult>;
  /** This method finds a quote in a stored document. It ignores case, spaces and typographic punctuation. */
  verify(doc: string, quote: string): VerifyResult;
  /** This method builds the index again from the capture log and the stored bodies, with no request. */
  reindex(): Promise<{ readonly captures: number; readonly docs: number; readonly urls: number }>;
  /** This method closes the browser, the log files and the index. */
  close(): Promise<void>;
}

const HELD_BACK =
  "This page asked not to be used as AI input, so its text is held back. Open the URL to read it, or read again with userProvided when a person gave this URL directly (the crawler logs that).";

/**
 * This function opens a crawler on a folder. The folder keeps the capture log (`captures/`), the
 * response bodies (`blobs/`) and the search index (`index.sqlite`). The index is a projection:
 * `reindex` makes it again from the other two.
 */
export const openCrawler = (options: OpenOptions): PoliteCrawler => {
  const log = new CaptureLog(join(options.dir, "captures"));
  const blobs = new FileBlobStore(join(options.dir, "blobs"));
  const index = new DocIndex(join(options.dir, "index.sqlite"));
  const renderer = options.renderer === false ? undefined : (options.renderer ?? playwrightRenderer());
  const crawler = new Crawler({
    token: options.token ?? DEFAULT_TOKEN,
    userAgent: options.userAgent ?? defaultUserAgent(options.contact),
    from: options.contact,
    log,
    blobs,
    index,
    renderer,
    maxActive: options.maxActive,
    dispatcher: options.dispatcher,
  });
  const runtime: CrawlRuntime = {
    crawler,
    index,
    blobs,
    captures: log,
    log,
    extractors: new Extractors(),
    now: () => new Date().toISOString(),
  };
  const known = (id: string) => {
    const doc = index.get(id);
    if (doc === undefined) throw new Error(`no stored document ${id}: find one with find(), or fetch its page`);
    return doc;
  };
  return {
    runtime,
    fetch: (url, fetchOptions = {}) =>
      fetchPage(runtime, url, {
        render: fetchOptions.render ?? "auto",
        maxAgeMs: durationMs(fetchOptions.maxAge ?? "24h"),
        onBehalfOf: [...(options.onBehalfOf ?? []), ...(fetchOptions.onBehalfOf ?? [])],
      }),
    find: (q, findOptions = {}) =>
      index.find(q, { limit: findOptions.limit ?? 10, kind: findOptions.kind ?? null }),
    async read(id, readOptions = {}) {
      const doc = known(id);
      const from = readOptions.from ?? 0;
      const length = readOptions.length ?? 4000;
      const userProvided = readOptions.userProvided ?? false;
      const held = doc.ai_input === "no" && !userProvided;
      if (doc.ai_input === "no" && userProvided) {
        const at = runtime.now();
        await log.append(
          makeRecord({
            source: "fetch",
            kind: "override",
            payload: { doc: doc.doc, url: doc.url, reason: "a person provided this URL", at },
            received_at: at,
            external_id: doc.url ?? doc.doc,
          }),
        );
      }
      const to = held ? from : Math.min(doc.text.length, from + length);
      return {
        doc: doc.doc,
        kind: doc.kind,
        title: doc.title,
        url: doc.url,
        meta: doc.meta,
        from,
        to,
        total: doc.text.length,
        text: held ? "" : doc.text.slice(from, to),
        captures: doc.captures,
        ai_input: doc.ai_input,
        held_back: held,
        note: held ? HELD_BACK : null,
      };
    },
    verify(id, quote) {
      const doc = known(id);
      const hit = locate(doc.text, quote);
      return {
        doc: doc.doc,
        found: hit.found,
        start: hit.start,
        end: hit.end,
        // a held-back page confirms the quote but shows nothing around it
        excerpt: doc.ai_input === "no" ? null : hit.excerpt,
        url: doc.url,
        captures: doc.captures,
      };
    },
    reindex: () => reindex(runtime),
    async close() {
      await crawler.close();
      index.close();
    },
  };
};
