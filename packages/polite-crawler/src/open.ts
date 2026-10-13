import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Dispatcher } from "undici";
import type { BlobStore } from "./blobs.ts";
import { checkedRenderer } from "./browser.ts";
import { FileBlobStore } from "./blobs.ts";
import type { CrawlEvent } from "./crawler.ts";
import { Crawler } from "./crawler.ts";
import type { DocVersion, Found, ReadingIndex } from "./docs.ts";
import { DocIndex } from "./docs.ts";
import type { EgressOptions } from "./egress.ts";
import { SqliteHostStateStore } from "./hoststate.ts";
import { CaptureLog } from "./log.ts";
import type { Clock, HostStateStore, PolicyOptions } from "./politeness.ts";
import { MemoryHostStateStore, realClock } from "./politeness.ts";
import type { Renderer } from "./render.ts";
import { playwrightRenderer } from "./render.ts";
import type {
  CrawlRuntime,
  Extractor,
  PageResult,
  ReadOptions,
  ReadResult,
  ReindexResult,
  VerifyOptions,
  VerifyResult,
} from "./runtime.ts";
import {
  Extractors,
  catchUpIndex,
  fetchPage,
  findDocuments,
  readDocument,
  reindex,
  verifyQuote,
} from "./runtime.ts";
import { BOT_PAGE, DEFAULT_TOKEN, VERSION } from "./version.ts";

export type { ReadOptions, ReadResult, VerifyOptions, VerifyResult } from "./runtime.ts";

export { BOT_PAGE, DEFAULT_TOKEN } from "./version.ts";

/**
 * This function gives the default `User-Agent` header. The header names the crawler, its version
 * and the page about it, so a site owner can find out what made each request.
 */
export const defaultUserAgent = (contact?: string): string =>
  `${DEFAULT_TOKEN}/${VERSION} (+${BOT_PAGE}${contact === undefined ? "" : `; ${contact}`})`;

/** A mailbox is `name@host`, or a name and `<name@host>`. A URL is not a mailbox, also when it holds an `@`. */
const MAILBOX = /^(?:[^\s<>@:/]+@[^\s<>@/]+|[^<>]*<[^\s<>@:/]+@[^\s<>@/]+>)$/;

/**
 * This function tells if a contact is a mailbox. The `From` header holds only a mailbox (RFC 9110,
 * section 10.1.2). Thus the crawler sends a mailbox in `From` and in the `User-Agent`, and a URL in
 * the `User-Agent` only.
 */
export const isMailbox = (contact: string): boolean => MAILBOX.test(contact.trim());

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

/**
 * This function changes a duration into milliseconds. The units are `ms`, `s`, `m` (minutes), `h`,
 * `d` and `w`, in any case. The unit `M` is an error, because a month is not a unit. A bare `0`
 * is zero. The function throws an error for a text that it cannot read.
 */
export const durationMs = (duration: Duration): number => {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) throw new Error(`not a duration: ${String(duration)}`);
    return duration;
  }
  if (/^\s*0+(\.0+)?\s*$/.test(duration)) return 0;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/i.exec(duration);
  const unit = match?.[2];
  const factor = unit === undefined || unit === "M" ? undefined : UNITS[unit.toLowerCase()];
  if (match === null || factor === undefined) {
    throw new Error(`not a duration: "${duration}" (write a number and ms, s, m, h, d or w; m is minutes)`);
  }
  return Number(match[1]) * factor;
};

/**
 * These options make a runtime. A store needs a log, a blob store and an index. Give `dir`, and
 * the runtime makes the three parts in it, or give the parts. A part that you give replaces the
 * part in `dir`.
 */
export interface RuntimeOptions {
  /** This folder keeps the capture log (`captures/`), the bodies (`blobs/`), the index (`index.sqlite`) and the state of each host (`hosts.sqlite`). */
  readonly dir?: string | undefined;
  /** This log replaces `<dir>/captures`. */
  readonly log?: CaptureLog | undefined;
  /** This blob store replaces `<dir>/blobs`. */
  readonly blobs?: BlobStore | undefined;
  /** This index replaces `<dir>/index.sqlite`. A runtime takes any `ReadingIndex`. */
  readonly index?: ReadingIndex | undefined;
  /**
   * This store keeps the pace and the stops of each host. The default with `dir` is a SQLite file
   * (`hosts.sqlite`), so the processes on one store share the pace. With no `dir`, it is in memory.
   */
  readonly hostState?: HostStateStore | undefined;
  /** This token is the name that robots.txt rules match. The default is `PoliteCrawler`. */
  readonly token?: string | undefined;
  /** This text is the full `User-Agent` header. The default names the crawler and its page. */
  readonly userAgent?: string | undefined;
  /**
   * This address goes into the `User-Agent` header. A mailbox (`ops@example.com`) also goes into the
   * `From` header, and a URL does not. The crawler sends no contact without it.
   */
  readonly contact?: string | undefined;
  /**
   * This browser renders the pages that need JavaScript. The value `false` turns rendering off. The
   * default checks one time that `playwright-core` and its browser are installed. With no browser,
   * each page that needs JavaScript gets a note at once, with no wait.
   */
  readonly renderer?: Renderer | false | undefined;
  /** This value is the number of sites that the crawler fetches from at one time. The default is 16. */
  readonly maxActive?: number | undefined;
  /** This value is the number of pages that the browser renders at one time. The default is 2: each render holds a browser context. */
  readonly maxRenders?: number | undefined;
  /** This `undici` dispatcher sends the requests. Tests give a mock agent, and a proxy is possible. */
  readonly dispatcher?: Dispatcher | undefined;
  /** This policy controls the addresses that the crawler fetches. By default, it fetches only public addresses. */
  readonly egress?: EgressOptions | undefined;
  /** These values change the limits of the politeness policy, for each host or for some hosts. */
  readonly politeness?: PolicyOptions | undefined;
  /** This clock gives the time to the crawler and to the index. Tests give a clock that they control. */
  readonly clock?: Clock | undefined;
  /** This function gives the random numbers of the jitter. The default is `Math.random`. */
  readonly random?: (() => number) | undefined;
  /** This label goes into each capture record. */
  readonly scope?: string | undefined;
  /** With the value false, the crawler does not also obey the group of `PoliteCrawler` when its `User-Agent` links the bot page (`CrawlerOptions.obeyDefaultToken`). */
  readonly obeyDefaultToken?: boolean | undefined;
  /** This function ranks the scopes, the most private highest. A shared fetch of a robots.txt records the scope with the highest rank (`CrawlerOptions.scopeRank`). */
  readonly scopeRank?: ((scope: string) => number) | undefined;
  /** This function gets an event for each request, response, wait, stop and skip. */
  readonly onEvent?: ((event: CrawlEvent) => void) | undefined;
  /** These extractors read the captures of the recipes of an application. The recipe `page` is built in. */
  readonly extractors?: Readonly<Record<string, Extractor>> | undefined;
}

/** A runtime that a store made. It owns the parts that it made, and it closes them. */
export interface StoreRuntime extends CrawlRuntime {
  readonly hostState: HostStateStore;
  /** This method closes the crawler, the browser, the log, the index and the host state store that the runtime made. A second close does nothing. */
  close(): Promise<void>;
}

/** The parts of a store that can be a symbolic link to a different place only by mistake or by attack. */
const STORE_PARTS = ["captures", "blobs", "index.sqlite", "hosts.sqlite"];

/**
 * This function makes the folder of a store for the owner only, where the system has modes. It
 * refuses a store folder of a different user, and a part of the store that is a symbolic link.
 * The store folder itself can be a link, for example to a larger disk.
 */
const guardStore = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const real = lstatSync(dir).isSymbolicLink() ? realpathSync(dir) : dir;
  const info = statSync(real);
  if (!info.isDirectory()) throw new Error(`the store ${dir} is not a folder`);
  if (process.platform !== "win32" && typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`the store ${dir} belongs to a different user: use a folder of your own`);
  }
  for (const part of STORE_PARTS) {
    let link = false;
    try {
      link = lstatSync(join(dir, part)).isSymbolicLink();
    } catch {
      // a part that is not there yet
    }
    if (link) throw new Error(`${part} in the store ${dir} is a symbolic link: the crawler does not follow it`);
  }
};

/**
 * This function makes a runtime. It is the one place that puts the log, the blob store, the index,
 * the host state, the crawler and the extractors together. The function `openCrawler` uses it.
 * An application that needs the parts uses it too. The runtime and the crawler share one clock.
 */
export const createRuntime = (options: RuntimeOptions): StoreRuntime => {
  const dir = options.dir;
  if (dir === undefined && (options.log === undefined || options.blobs === undefined || options.index === undefined)) {
    throw new Error("a runtime needs dir, or a log, a blob store and an index");
  }
  const contact = options.contact;
  if (contact !== undefined && !/^[\t -~]*$/.test(contact)) {
    throw new Error(`contact "${contact}" has a character that an HTTP header cannot hold: use printable ASCII`);
  }
  if (dir !== undefined) guardStore(dir);
  const owned: Array<() => Promise<void> | void> = [];
  const log = options.log ?? new CaptureLog(join(dir!, "captures"));
  const blobs = options.blobs ?? new FileBlobStore(join(dir!, "blobs"));
  let index = options.index;
  if (index === undefined) {
    const made = new DocIndex(join(dir!, "index.sqlite"));
    owned.push(() => made.close());
    index = made;
  }
  let hostState = options.hostState;
  if (hostState === undefined) {
    if (dir === undefined) hostState = new MemoryHostStateStore();
    else {
      const made = new SqliteHostStateStore(join(dir, "hosts.sqlite"));
      owned.push(() => made.close());
      hostState = made;
    }
  }
  const clock = options.clock ?? realClock;
  // the default browser is checked one time: with none, each page gets its note at once
  const renderer = options.renderer === false ? undefined : (options.renderer ?? checkedRenderer(playwrightRenderer()));
  const crawler = new Crawler({
    token: options.token ?? DEFAULT_TOKEN,
    userAgent: options.userAgent ?? defaultUserAgent(contact),
    from: contact !== undefined && isMailbox(contact) ? contact.trim() : undefined,
    log,
    blobs,
    index,
    renderer,
    maxActive: options.maxActive,
    maxRenders: options.maxRenders,
    dispatcher: options.dispatcher,
    egress: options.egress,
    politeness: options.politeness,
    hostState,
    clock,
    random: options.random,
    scope: options.scope,
    scopeRank: options.scopeRank,
    obeyDefaultToken: options.obeyDefaultToken,
    onEvent: options.onEvent,
  });
  const extractors = new Extractors();
  for (const [recipe, extractor] of Object.entries(options.extractors ?? {})) {
    extractors.register(recipe, extractor);
  }
  let closing: Promise<void> | undefined;
  return {
    crawler,
    index,
    blobs,
    captures: log,
    log,
    extractors,
    hostState,
    now: () => new Date(clock.now()).toISOString(),
    close() {
      closing ??= (async () => {
        // the crawler closes the browser and the log
        await crawler.close();
        for (const close of owned) await close();
      })();
      return closing;
    },
  };
};

/** These options open a crawler on a folder. Only `dir` is necessary. */
export interface OpenOptions extends Omit<RuntimeOptions, "dir" | "log" | "blobs" | "index"> {
  /** This folder keeps the capture log, the response bodies, the search index and the state of each host. */
  readonly dir: string;
  /** These agents get their robots.txt rules applied to each fetch, for example `Claude-User`. */
  readonly onBehalfOf?: readonly string[] | undefined;
}

/** These options control one fetch. */
export interface FetchOptions {
  /** The value `auto` renders a page only when it shows almost nothing without JavaScript. */
  readonly render?: "auto" | "never" | "always" | undefined;
  /**
   * A stored copy younger than this age answers, and the crawler sends no request. The default is
   * `24h`. The value `auto` uses the freshness that the server gave. The value `0s` asks again.
   */
  readonly maxAge?: Duration | undefined;
  /** These agents get their robots.txt rules applied to this fetch, in addition to the defaults. */
  readonly onBehalfOf?: readonly string[] | undefined;
  /** When this signal aborts, the crawler stops the fetch and the render. */
  readonly signal?: AbortSignal | undefined;
  /** This label goes into the capture records of this fetch. */
  readonly scope?: string | undefined;
  /** These labels go into the capture records of this fetch. They are not part of the capture ids. */
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

/** These options control a search. */
export interface FindOptions {
  /** This value is the maximum number of results. The default is 10. */
  readonly limit?: number | undefined;
  /** This value keeps only the documents of one kind, for example `page` or `pdf`. */
  readonly kind?: string | null | undefined;
}

/** A polite crawler fetches each source one time, keeps it, and answers the next questions from the disk. */
export interface PoliteCrawler {
  /** The runtime gives the parts to an application that needs more control. */
  readonly runtime: StoreRuntime;
  /** This method fetches a page, reads it and adds it to the index. */
  fetch(url: string, options?: FetchOptions): Promise<PageResult>;
  /**
   * This method searches the stored documents. It sends no request. A held-back document is not
   * in the results. The syntax of the query is the syntax of `parseQuery`.
   */
  find(q: string, options?: FindOptions): Promise<Found[]>;
  /** This method reads a range of characters of one stored document, the current version or the version of one capture. */
  read(doc: string, options?: ReadOptions): Promise<ReadResult>;
  /**
   * This method finds a quote in a stored document. It ignores case, spaces, typographic
   * punctuation and Unicode forms. It tells which capture holds the quote.
   */
  verify(doc: string, quote: string, options?: VerifyOptions): Promise<VerifyResult>;
  /** This method gives the versions of a stored document, the newest first. A held-back version shows no title. */
  versions(doc: string, options?: { readonly limit?: number }): Promise<DocVersion[]>;
  /**
   * This method builds the index again from the capture log and the stored bodies, with no request.
   * When the crawler rebuilt a stale index at open, the first reindex gives the counts of that
   * rebuild, unless a fetch came before it.
   */
  reindex(): Promise<ReindexResult>;
  /** This method closes the browser, the log files and the index. A second close does nothing. */
  close(): Promise<void>;
}

/**
 * This function opens a crawler on a folder. The folder keeps the capture log (`captures/`), the
 * response bodies (`blobs/`), the search index (`index.sqlite`) and the state of each host
 * (`hosts.sqlite`). The index is a projection: `reindex` makes it again from the log and the bodies.
 * At open, `catchUpIndex` rebuilds an index of an earlier version, and gives an index that is
 * behind the log the captures that it missed.
 *
 * Each method gives a promise, and none throws before its promise. After `close`, each method
 * rejects.
 */
export const openCrawler = (options: OpenOptions): PoliteCrawler => {
  const runtime = createRuntime(options);
  let closed = false;
  // the rebuild at open, which the first reindex() gives when no fetch came before it
  let rebuilt: ReindexResult | undefined;
  const ready: Promise<unknown> = existsSync(join(options.dir, "captures"))
    ? catchUpIndex(runtime).then(
        (done) => {
          if (done?.mode === "rebuild") {
            const { mode, ...counts } = done;
            rebuilt = mode === "rebuild" ? counts : undefined;
          }
        },
        () => undefined,
      )
    : Promise.resolve();
  const live = async (): Promise<void> => {
    if (closed) throw new Error("the crawler is closed");
    await ready;
    if (closed) throw new Error("the crawler is closed");
  };
  return {
    runtime,
    async fetch(url, fetchOptions = {}) {
      await live();
      rebuilt = undefined;
      const maxAge = fetchOptions.maxAge ?? "24h";
      return fetchPage(runtime, url, {
        render: fetchOptions.render ?? "auto",
        maxAgeMs: maxAge === "auto" ? "auto" : durationMs(maxAge),
        onBehalfOf: [...(options.onBehalfOf ?? []), ...(fetchOptions.onBehalfOf ?? [])],
        signal: fetchOptions.signal,
        scope: fetchOptions.scope,
        labels: fetchOptions.labels,
      });
    },
    async find(q, findOptions = {}) {
      await live();
      return findDocuments(runtime, q, findOptions);
    },
    async read(id, readOptions = {}) {
      await live();
      return readDocument(runtime, id, readOptions);
    },
    async verify(id, quote, verifyOptions = {}) {
      await live();
      return verifyQuote(runtime, id, quote, verifyOptions);
    },
    async versions(id, versionOptions = {}) {
      await live();
      // a held-back version shows no title, as a read of its capture does
      const held = runtime.index.get(id)?.ai_input === "no";
      return runtime.index
        .versions(id, versionOptions)
        .map((version) => (held || version.ai_input === "no" ? { ...version, title: "" } : version));
    },
    async reindex() {
      await live();
      // the index that the open rebuilt is the index that a second replay of the log makes
      const done = rebuilt;
      rebuilt = undefined;
      return done ?? reindex(runtime);
    },
    async close() {
      closed = true;
      await ready;
      await runtime.close();
    },
  };
};
