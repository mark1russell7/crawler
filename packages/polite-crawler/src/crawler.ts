import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from "node:zlib";
import type { Dispatcher } from "undici";
import { Agent, request } from "undici";
import type { BlobStore } from "./blobs.ts";
import type { Classified, Outcome } from "./classify.ts";
import { classify, isClientError, parseHttpDate } from "./classify.ts";
import type { Variant } from "./docs.ts";
import type { EgressOptions } from "./egress.ts";
import { checkEgress, egressError, egressLookup, egressRefusal } from "./egress.ts";
import type {
  Clock,
  HostResult,
  HostStateStore,
  Paced,
  PolicyOptions,
  PolitenessPolicy,
  RestInput,
} from "./politeness.ts";
import {
  DEFAULT_POLICY,
  HostScheduler,
  HostStopped,
  checkPolicy,
  equalJitterMs,
  policyFor,
  realClock,
  restAfter,
} from "./politeness.ts";
import type { CaptureRecord } from "./record.ts";
import { makeRecord } from "./record.ts";
import type { Rendered, Renderer } from "./render.ts";
import type { RefusedReason } from "./render.ts";
import { NO_PLAYWRIGHT, RenderRefused } from "./render.ts";
import type { Robots, RobotsDecision } from "./robots.ts";
import { decide, isProductToken, robotsFromResponse, robotsFromStatus, signalsFor, unreachableRobots } from "./robots.ts";
import type { AiInput, Signals } from "./signals.ts";
import { NO_SIGNALS, metaSignals, readSignals } from "./signals.ts";
import { cacheKeyOf } from "./urls.ts";

/**
 * The crawler is a polite fetcher. It sends one request at a time to each host, and it obeys
 * robots.txt for web pages. Its `User-Agent` header tells what it is. It asks again with the
 * validators of the stored copy, and it stops when a site refuses. Each decision goes into the
 * capture log, and a fetch that the crawler declines goes there too.
 *
 * There are two kinds of request. A documented public API (`api`) has its own terms and rate
 * limits. A web page (`page`) obeys robots.txt. The settings come from measurements:
 *
 * - The `request` function of undici on one `Agent`.
 * - A keep-alive time longer than the delay for each host. With the default of 4 seconds, each
 *   polite request opens a new connection.
 * - A backoff with jitter in the queue, not the retry handler of undici. That handler limits
 *   Retry-After to 30 seconds and adds no jitter.
 * - A maximum size for each body, after decompression. The crawler keeps the first part of a
 *   longer body and marks it as truncated.
 *
 * A fetch and a render go through one admission. It examines the URL, the egress policy, the
 * product tokens, robots.txt, the cache and the stops of the host. Only the transport is
 * different: an HTTP request or the headless browser.
 *
 * The egress policy (`EgressOptions`) keeps the crawler on public addresses by default. The
 * politeness policy (`PolitenessPolicy`) holds each limit, and a host can have its own values.
 * The fetch and the render do not throw an error: each problem is an outcome with a note.
 */

/**
 * The outcome of a fetch or a render. A `skipped` request did not go out. A render of a URL that
 * gives a file and not a page is `not-html`.
 */
export type FetchOutcome = Outcome | "skipped" | "not-html";

export interface FetchRequest {
  readonly url: string;
  /** The value `api` is a documented API with its own terms. The value `page` is a web page, and robots.txt applies. */
  readonly mode: "api" | "page";
  /** This recipe reads the capture again. The function `reindex` uses it to replay the capture. */
  readonly recipe: string;
  readonly accept?: string | undefined;
  /**
   * These are more request headers. The crawler does not write them into the capture. They
   * cannot replace `User-Agent`, `From`, `Accept-Encoding` or the validators. A redirect to a
   * different origin removes `Authorization`, `Cookie` and `Proxy-Authorization`.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * These query parameters contain secrets. Each capture shows `REDACTED` in their place. The
   * names in `DEFAULT_SECRET_PARAMS` get the same treatment with no list.
   */
  readonly secretParams?: readonly string[] | undefined;
  /** This value is the documented pace of the source: the shortest time between two of its requests. */
  readonly minIntervalMs?: number | undefined;
  /**
   * A stored capture younger than this age answers, and the crawler sends no request. The value
   * `auto` uses the freshness that the server gave (RFC 9111): `Cache-Control`, `Expires`, or 10
   * percent of the age of `Last-Modified`.
   */
  readonly maxAgeMs?: number | "auto" | undefined;
  readonly maxBytes?: number | undefined;
  /**
   * These are the product tokens of an agent that the fetch acts for, for example `Claude-User`.
   * The robots.txt rules for these tokens apply too.
   */
  readonly onBehalfOf?: readonly string[] | undefined;
  /** This name connects the captures to the job that asked for them. */
  readonly job?: string | undefined;
  /** When this signal aborts, the crawler stops the fetch. The result is then `skipped` or `error`, with a note. */
  readonly signal?: AbortSignal | undefined;
  /** This label goes into each capture record of the request. It replaces the `scope` of the crawler. */
  readonly scope?: string | undefined;
  /** These labels go into each capture record of the request, for example its lineage. They are not part of the capture id. */
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

export interface Fetched {
  /** This URL is the URL of the capture. Its secrets show as `REDACTED`. */
  readonly url: string;
  readonly status: number;
  readonly outcome: FetchOutcome;
  /** This value is true when a stored capture answered, with no request. */
  readonly fromCache: boolean;
  /** This id is the capture record behind the body. A citation names it. */
  readonly capture: string | undefined;
  readonly blob: string | undefined;
  readonly body: Uint8Array | undefined;
  readonly contentType: string | undefined;
  readonly signals: Signals;
  readonly note: string | undefined;
  /** This value is true when the body was longer than the maximum, so the crawler kept only its first part. */
  readonly truncated?: boolean | undefined;
  /** This time (ISO 8601) is the time of the fetch of the body. For a stored copy, it is the time of that copy. */
  readonly fetchedAt?: string | undefined;
  /** This label is the scope of the capture. */
  readonly scope?: string | undefined;
  /** These labels are the labels of the capture. */
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

/** The crawler writes each record to a capture writer. The class `CaptureLog` is one. */
export interface CaptureWriter {
  append(record: CaptureRecord): Promise<void>;
  close?(): Promise<void>;
}

/** A cache entry is the last answer for a URL: its capture, its body and its validators. */
export interface CacheEntry {
  /** This text is the cache key: the canonical URL, with its secrets as `REDACTED`. */
  readonly url: string;
  readonly capture: string;
  readonly blob: string | null;
  readonly etag: string | null;
  readonly last_modified: string | null;
  readonly content_type: string | null;
  readonly fetched_at: string;
  readonly status: number;
  /** This value is what the page said about AI input at the time of the fetch. */
  readonly ai_input: AiInput;
  /** This URL is the target of a stored redirect. Its secrets show as `REDACTED`. */
  readonly location?: string | null | undefined;
  /** This value is true when the stored body is only the first part of the response. */
  readonly truncated?: boolean | undefined;
  /** This time (ISO 8601) is the end of the freshness that the server gave. */
  readonly fresh_until?: string | null | undefined;
  /** This text holds the request headers that the response varies on (`Vary`), with their values. */
  readonly vary_key?: string | null | undefined;
  /** This value tells a plain response from a page that the browser rendered. The default is `plain`. */
  readonly variant?: Variant | undefined;
}

/**
 * The cache index holds the last answer for each URL. The crawler reads it before a request, and
 * it writes it after an answer. The class `DocIndex` is one. An index that keeps only the
 * necessary fields of `CacheEntry` works, and the crawler keeps the other fields in memory.
 */
export interface CacheIndex {
  latest(url: string, variant?: Variant): CacheEntry | undefined;
  setLatest(entry: CacheEntry): void;
}

/** An event tells a listener what the crawler does. The listener cannot change it. */
export type CrawlEvent =
  | {
      readonly type: "request";
      readonly url: string;
      readonly host: string;
      readonly transport: "http" | "browser";
    }
  | {
      readonly type: "response";
      readonly url: string;
      readonly host: string;
      readonly status: number;
      readonly outcome: FetchOutcome;
      readonly elapsedMs: number;
    }
  | { readonly type: "wait"; readonly host: string; readonly ms: number; readonly reason: string }
  | { readonly type: "stop"; readonly host: string; readonly until: number; readonly reason: string }
  | { readonly type: "skip"; readonly url: string; readonly note: string };

export interface CrawlerOptions {
  /** This product token is the name that robots.txt rules match. It contains only letters, `_` and `-` (RFC 9309). */
  readonly token: string;
  /** This text is the full `User-Agent` header. */
  readonly userAgent: string;
  /** This contact goes into the `From` header. Without it, the crawler sends no `From` header. */
  readonly from?: string | undefined;
  readonly log: CaptureWriter;
  readonly blobs: BlobStore;
  readonly index: CacheIndex;
  readonly clock?: Clock | undefined;
  readonly random?: (() => number) | undefined;
  /** This value is the number of hosts that get requests at one time. The default is 16. */
  readonly maxActive?: number | undefined;
  /**
   * This value is the number of pages that the browser renders at one time. The default is 2. Each
   * render is a browser context of its own, which holds much memory. A render waits for a slot before
   * the lease of its host, so the wait does not count toward the time of the host.
   */
  readonly maxRenders?: number | undefined;
  /**
   * This undici dispatcher sends the requests. With a dispatcher of your own, the crawler checks
   * only literal addresses. Put `egressLookup` in its connection options to check the address after DNS.
   */
  readonly dispatcher?: Dispatcher | undefined;
  /** This label goes into each capture record as it is. */
  readonly scope?: string | undefined;
  /**
   * This function ranks the scopes of the requests, the most private scope highest. One fetch of a
   * robots.txt can serve requests of different scopes. Its record then takes the scope with the
   * highest rank, and the labels of each request. With no function, the first request gives the scope.
   */
  readonly scopeRank?: ((scope: string) => number) | undefined;
  /** This browser renders the pages that need JavaScript. Without it, the crawler renders no page. */
  readonly renderer?: Renderer | undefined;
  /** This policy controls the addresses that the crawler fetches. By default, the crawler fetches only public addresses. */
  readonly egress?: EgressOptions | undefined;
  /** These values change the limits of the politeness policy, for each host or for some hosts. */
  readonly politeness?: PolicyOptions | undefined;
  /** This store keeps the pace, the counts and the stops of each host. The default keeps them in memory. */
  readonly hostState?: HostStateStore | undefined;
  /** This function gets an event for each request, response, wait, stop and skip. An error in it does not stop the crawler. */
  readonly onEvent?: ((event: CrawlEvent) => void) | undefined;
}

export interface RenderRequest {
  readonly url: string;
  readonly recipe: string;
  /** A stored render younger than this age answers. The value `auto` uses the freshness that the server gave. */
  readonly maxAgeMs?: number | "auto" | undefined;
  readonly onBehalfOf?: readonly string[] | undefined;
  readonly job?: string | undefined;
  /** When this signal aborts, the crawler stops the render, and the browser stops the page. */
  readonly signal?: AbortSignal | undefined;
  /** This label goes into the capture record of the render. It replaces the `scope` of the crawler. */
  readonly scope?: string | undefined;
  /** These labels go into the capture record of the render. */
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

/**
 * This function gives the key of the cache entry of a rendered page in the form of version 0.1.
 * The index keeps the variant in a column of its own, and it reads this form too.
 */
export const renderedKey = (url: string): string => `${url}#rendered`;

/** This value is the version of the payload of the records that the crawler writes. A record with no `schema` is version 1. */
export const CAPTURE_SCHEMA = 2;

/** The content type of a rendered page: the browser gives its text as UTF-8. */
export const RENDERED_TYPE = "text/html; charset=utf-8";

/**
 * These query parameters hold secrets in many APIs. The crawler writes `REDACTED` in place of
 * their values in each capture, in addition to the names of `secretParams`.
 */
export const DEFAULT_SECRET_PARAMS: readonly string[] = [
  "access_token",
  "api-key",
  "api_key",
  "apikey",
  "auth",
  "auth_token",
  "client_secret",
  "id_token",
  "passwd",
  "password",
  "pwd",
  "refresh_token",
  "secret",
  "session",
  "session_id",
  "sessionid",
  "sig",
  "signature",
  "token",
  "x-amz-credential",
  "x-amz-security-token",
  "x-amz-signature",
  "x-goog-credential",
  "x-goog-signature",
];

const ERROR_BODY_BYTES = 64 * 1024;
const ROBOTS_BYTES = 512 * 1024;
/** This value is the longest stop that a `Retry-After` can give: 30 days. */
const MAX_STOP_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_DATE_MS = 8.64e15;
const WEB_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);
const HEADER_TEXT = /^[\t -~]*$/;
const PERMANENT_REDIRECTS: ReadonlySet<number> = new Set([301, 308]);
const HEURISTIC_STATUSES: ReadonlySet<number> = new Set([
  200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501,
]);
/** A caller cannot set these headers. The crawler sets them, or HTTP does. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "user-agent",
  "from",
  "accept-encoding",
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since",
  "if-range",
  "range",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "te",
  "upgrade",
  "keep-alive",
]);
/** A redirect to a different origin removes these headers, as the Fetch standard does. */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(["authorization", "cookie", "proxy-authorization"]);
/** The crawler sends the same value of these headers in each request, so a `Vary` on them changes nothing. */
const CONSTANT_HEADERS: ReadonlySet<string> = new Set(["accept-encoding", "user-agent", "from"]);
/**
 * These content codings change nothing in the body. A server that stored an object with
 * `aws-chunked` can send the name with the decoded body.
 */
const IDENTITY_CODINGS: ReadonlySet<string> = new Set(["identity", "aws-chunked"]);

/**
 * This function tells if an answer is a web page that the request did not ask for. The answer is
 * HTML, and the `Accept` of the request admits no HTML (`application/json`). A login or an error
 * page in place of the data of an API is such an answer. A media range with `q=0` admits nothing.
 */
const unaskedPage = (accept: string | undefined, contentType: string | undefined): boolean => {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (accept === undefined || accept.trim() === "" || (type !== "text/html" && type !== "application/xhtml+xml")) return false;
  return !accept.split(",").some((range) => {
    const [media = "", ...params] = range.split(";").map((part) => part.trim().toLowerCase());
    const q = params.find((param) => param.startsWith("q="));
    if (q !== undefined && Number(q.slice(2)) === 0) return false;
    return media === "*/*" || media === type || (media.endsWith("/*") && type.startsWith(media.slice(0, -1)));
  });
};

/** This function reads the TDMRep `<meta>` tags at the start of an HTML body. */
const pageSignals = (body: Uint8Array | undefined, contentType: string | undefined): string[] =>
  body === undefined || !/html/i.test(contentType ?? "")
    ? []
    : metaSignals(new TextDecoder("latin1").decode(body.subarray(0, 65_536)));

/** A count of slots: `max` holders at one time at most, and the others wait in sequence. */
class Slots {
  private used = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  /** This method gives a function that frees the slot. It rejects when the signal aborts before a slot is free. */
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.used < this.max) {
      this.used += 1;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const stop = (): void => {
        const at = this.waiting.indexOf(go);
        if (at !== -1) this.waiting.splice(at, 1);
        reject(signal.reason instanceof Error ? signal.reason : new Error("cancelled"));
      };
      const go = (): void => {
        signal.removeEventListener("abort", stop);
        resolve();
      };
      if (signal.aborted) {
        stop();
        return;
      }
      this.waiting.push(go);
      signal.addEventListener("abort", stop, { once: true });
    });
    // the slot of the holder that freed it passes to this waiter, so the count stays
    return this.releaser();
  }

  private releaser(): () => void {
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      const next = this.waiting.shift();
      if (next !== undefined) next();
      else this.used -= 1;
    };
  }
}

/** This function tells if an error of a renderer says that it has no browser: no `playwright-core`, or no browser on the disk. */
const missingBrowser = (message: string): boolean =>
  message.startsWith(NO_PLAYWRIGHT) ||
  /Executable doesn't exist|Cannot find (?:module|package) 'playwright-core'/.test(message);

/** This text tells why the crawler did not fetch a page: a rule of the site, or no robots.txt to read. */
const robotsRefusal = (robots: Robots, by: string): string =>
  robots.unreachable === undefined
    ? `robots.txt disallows it for ${by}`
    : `robots.txt could not be read (${robots.unreachable}), so nothing on the site is fetched`;

const messageOf = (error: unknown): string =>
  error instanceof Error ? (error.message.split(/\r?\n/)[0] ?? "") : String(error);

const isoOf = (ms: number): string | undefined =>
  Number.isFinite(ms) && Math.abs(ms) < LAST_DATE_MS ? new Date(ms).toISOString() : undefined;

const stopNote = (reason: string, until: number): string => {
  const end = isoOf(until);
  return end === undefined ? `host stopped: ${reason}` : `host stopped until ${end}: ${reason}`;
};

const secretSet = (secretParams: readonly string[]): Set<string> =>
  new Set([...DEFAULT_SECRET_PARAMS, ...secretParams].map((name) => name.toLowerCase()));

const nameOfParam = (raw: string): string => {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " ")).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
};

/**
 * This function gives the URL of a capture. It removes a user name and a password, and it writes
 * `REDACTED` in place of the value of each secret parameter. The other parameters stay as they
 * were written.
 */
export const redact = (url: URL, secretParams: readonly string[] = []): string => {
  const copy = new URL(url.href);
  copy.username = "";
  copy.password = "";
  if (copy.search.length > 1) {
    const secrets = secretSet(secretParams);
    const parts = copy.search
      .slice(1)
      .split("&")
      .map((part) => {
        const equals = part.indexOf("=");
        if (equals === -1) return part;
        const name = part.slice(0, equals);
        return secrets.has(nameOfParam(name)) ? `${name}=REDACTED` : part;
      });
    copy.search = `?${parts.join("&")}`;
  }
  return copy.href;
};

/** This function tells if a URL holds a secret: a user name, a password or a secret parameter. */
const holdsSecrets = (url: URL, secretParams: readonly string[]): boolean => {
  if (url.username !== "" || url.password !== "") return true;
  const secrets = secretSet(secretParams);
  return url.search
    .slice(1)
    .split("&")
    .some((part) => part.includes("=") && secrets.has(nameOfParam(part.slice(0, part.indexOf("=")))));
};

/** The pace, the stops and the robots.txt of a host do not change with a trailing dot or the case of the name. */
const hostKey = (url: URL): string =>
  `${url.hostname.toLowerCase().replace(/\.$/, "")}${url.port === "" ? "" : `:${url.port}`}`;

const originKey = (url: URL): string => `${url.protocol}//${hostKey(url)}`;

const headerOf =
  (headers: Readonly<Record<string, string | string[] | undefined>>) =>
  (name: string): string | undefined => {
    const value = headers[name.toLowerCase()];
    return Array.isArray(value) ? value.join(", ") : value;
  };

class Lru<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  keys(): K[] {
    return [...this.map.keys()];
  }

  get size(): number {
    return this.map.size;
  }
}

/** A body failed in transport (a reset, a timeout) or in decompression. */
class BodyError extends Error {
  constructor(
    readonly kind: "transport" | "decode",
    cause: unknown,
  ) {
    super(messageOf(cause), { cause });
  }
}

/** RFC 9110 says that `deflate` is the zlib format, but some servers send raw deflate. This stream reads both. */
const inflateAny = (): Transform => {
  let inner: Transform | undefined;
  const outer: Transform = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (inner === undefined) {
        const zlib =
          chunk.length >= 2 && (chunk[0]! & 0x0f) === 8 && ((chunk[0]! << 8) | chunk[1]!) % 31 === 0;
        inner = zlib ? createInflate() : createInflateRaw();
        inner.on("data", (data: Buffer) => outer.push(data));
        inner.on("error", (error) => outer.destroy(error));
      }
      inner.write(chunk, () => done());
    },
    flush(done) {
      if (inner === undefined) {
        done();
        return;
      }
      inner.once("end", () => done());
      inner.end();
    },
    destroy(error, callback) {
      inner?.destroy();
      callback(error);
    },
  });
  return outer;
};

const decoderFor = (coding: string): Transform => {
  if (coding === "gzip" || coding === "x-gzip") return createGunzip();
  if (coding === "br") return createBrotliDecompress();
  if (coding === "deflate") return inflateAny();
  throw new BodyError("decode", new Error(`unsupported content-encoding "${coding}"`));
};

/** This function tells if a decoder stopped because the compressed body ended early: the server cut it. */
const endedEarly = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error.code === "Z_BUF_ERROR" || /unexpected end of file/i.test(messageOf(error)));

/**
 * This function reads a body as a stream and decodes each content coding in sequence. It counts
 * the decoded bytes and keeps at most `maxBytes`. Thus a decompression bomb stops at the
 * maximum, and a long page keeps its first part. A body that fails gives a `BodyError`. A
 * compressed body that ends early gives the part that it decoded, marked `cut`.
 */
const readBody = async (
  body: Readable,
  encoding: string | undefined,
  maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean; readonly cut: boolean }> => {
  const codings = (encoding ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding.length > 0 && !IDENTITY_CODINGS.has(coding))
    .reverse();
  // undici gives an error when a body that did not end is destroyed; the loop below reports real errors
  body.on("error", () => undefined);
  let decoders: Transform[];
  try {
    decoders = codings.map(decoderFor);
  } catch (error) {
    body.destroy();
    throw error;
  }
  // a compressed stream that gives almost no output stops at this length of input
  const rawCap = maxBytes * 4 + 65_536;
  let rawBytes = 0;
  let stream: Readable = body;
  if (decoders.length > 0) {
    body.on("data", (chunk: Buffer) => {
      rawBytes += chunk.length;
    });
    for (const decoder of decoders) {
      const source = stream;
      source.on("error", (error) => decoder.destroy(error));
      stream = source.pipe(decoder);
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let cut = false;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const room = maxBytes - size;
      if (chunk.length > room) {
        // the chunk that crosses the maximum gives its first part
        if (room > 0) chunks.push(chunk.subarray(0, room));
        size += Math.max(0, room);
        truncated = true;
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
      if (rawBytes > rawCap) {
        truncated = true;
        break;
      }
    }
  } catch (error) {
    const transport = body.errored !== null || decoders.length === 0;
    // a server that closes a compressed body early: the part before the end is still the page
    if (!transport && size > 0 && endedEarly(error)) {
      cut = true;
      truncated = true;
    } else {
      throw new BodyError(transport ? "transport" : "decode", error);
    }
  } finally {
    body.destroy();
    for (const decoder of decoders) decoder.destroy();
  }
  // one copy into a buffer of its own, so no reader sees the shared pool of Node.js
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, truncated, cut };
};

const directives = (value: string | undefined): Map<string, string> => {
  const out = new Map<string, string>();
  for (const part of (value ?? "").split(",")) {
    const equals = part.indexOf("=");
    const name = (equals === -1 ? part : part.slice(0, equals)).trim().toLowerCase();
    if (name.length === 0) continue;
    const raw = equals === -1 ? "" : part.slice(equals + 1).trim();
    out.set(name, raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw);
  }
  return out;
};

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * This function gives the end of the freshness of a response, as RFC 9111 §4.2 calculates it.
 * The sources in sequence are `max-age`, `Expires`, and 10 percent of the age of
 * `Last-Modified`, with a maximum. A response with `no-store` or `no-cache` is stale at once. A
 * response with no freshness gives null.
 */
const freshUntil = (
  header: (name: string) => string | undefined,
  status: number,
  fetchedAt: number,
  lastModified: string | null | undefined,
  capMs: number,
): string | null => {
  const control = directives(header("cache-control"));
  if (control.has("no-store") || control.has("no-cache")) return isoOf(fetchedAt) ?? null;
  const ageText = header("age")?.trim() ?? "";
  const age = /^\d+$/.test(ageText) ? Number(ageText) * 1000 : 0;
  const date = parseHttpDate(header("date")) ?? fetchedAt;
  let lifetime: number | undefined;
  const maxAge = control.get("max-age");
  const expires = header("expires");
  if (maxAge !== undefined && /^\d+$/.test(maxAge)) lifetime = Number(maxAge) * 1000;
  else if (expires !== undefined) {
    // an Expires that is not a date means that the response is already stale
    const at = parseHttpDate(expires);
    lifetime = at === undefined ? 0 : at - date;
  } else if (HEURISTIC_STATUSES.has(status)) {
    const modified = parseHttpDate(lastModified ?? undefined);
    if (modified !== undefined && modified < date) lifetime = Math.min(capMs, (date - modified) / 10);
    else if (PERMANENT_REDIRECTS.has(status)) lifetime = capMs;
  }
  if (lifetime === undefined) return null;
  return isoOf(fetchedAt + Math.max(0, Math.min(lifetime, TEN_YEARS_MS) - age)) ?? null;
};

/** This function gives the request headers that a response varies on, with their values. A `Vary: *` gives `*`. */
const varyKeyOf = (vary: string | undefined, sent: Readonly<Record<string, string>>): string | null => {
  if (vary === undefined) return null;
  const names = vary
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0 && !CONSTANT_HEADERS.has(name));
  if (names.includes("*")) return "*";
  if (names.length === 0) return null;
  return [...new Set(names)]
    .sort()
    .map((name) => `${name}=${sent[name] ?? ""}`)
    .join("\n");
};

const varyMatches = (stored: string | null | undefined, sent: Readonly<Record<string, string>>): boolean => {
  if (stored === undefined || stored === null) return true;
  if (stored === "*") return false;
  return stored.split("\n").every((line) => {
    const equals = line.indexOf("=");
    return (sent[line.slice(0, equals)] ?? "") === line.slice(equals + 1);
  });
};

const withoutCredentials = (
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined =>
  headers === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())),
      );

const invalidNumber = (name: string, value: number | "auto" | undefined, auto: boolean): string | undefined => {
  if (value === undefined || (auto && value === "auto")) return undefined;
  return typeof value === "number" && value >= 0 ? undefined : `invalid option: ${name} is ${String(value)}`;
};

const closedResult = (url: string): Fetched => ({
  url,
  status: 0,
  outcome: "skipped",
  fromCache: false,
  capture: undefined,
  blob: undefined,
  body: undefined,
  contentType: undefined,
  signals: NO_SIGNALS,
  note: "crawler closed",
});

/** One step of a fetch: the answer for one URL, and the next URL when the answer is a redirect to follow. */
interface Step {
  readonly fetched: Fetched;
  /** This URL is the target of the redirect, with its secrets. It stays in memory. */
  readonly next?: string | undefined;
  readonly retryAfterMs?: number | undefined;
}

/** A robots verdict is a parsed robots.txt and the capture that holds it. */
interface RobotsVerdict {
  readonly robots: Robots;
  readonly capture: string | undefined;
  /** When the crawler could not read robots.txt and used a stored copy, this text gives the reason. */
  readonly stale?: string | undefined;
}

/** The scope and the labels of the requests that wait for one fetch of a robots.txt. The record of the fetch reads them when it is written. */
interface Waiting {
  scope: string | undefined;
  labels: Record<string, string> | undefined;
}

interface RobotsEntry {
  readonly at: number;
  readonly waiting: Waiting;
  ttlMs: number;
  verdict: Promise<RobotsVerdict>;
  value: RobotsVerdict | undefined;
  /** This value counts the unreachable verdicts in sequence, for the backoff. */
  misses: number;
  /** This verdict is the last good robots.txt, with its time. */
  good: { readonly verdict: RobotsVerdict; readonly at: number } | undefined;
}

interface Settle {
  readonly outcome: FetchOutcome;
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  /** The pace of the host: the kind of the request, its duration, the crawl delay and the documented interval. */
  readonly rest: RestInput;
  /** A 401 or a 403 on robots.txt means "no robots.txt" (RFC 9309), so it does not stop the host. */
  readonly robotsFile: boolean;
  /** This result replaces the result that the outcome gives. */
  readonly result?: HostResult | undefined;
}

type RenderDone =
  | {
      readonly kind: "rendered";
      readonly rendered: Rendered;
      readonly classified: Classified;
      readonly elapsedMs: number;
    }
  | { readonly kind: "failed"; readonly note: string; readonly elapsedMs: number }
  | {
      readonly kind: "refused";
      readonly reason: RefusedReason;
      readonly note: string;
      /** This URL is the request that the renderer refused. */
      readonly url?: string | undefined;
      readonly elapsedMs: number;
    }
  | { readonly kind: "cancelled"; readonly elapsedMs: number }
  | { readonly kind: "closed" };

/** These are the parts of a request that the admission reads. */
interface AdmitSpec {
  readonly transport: "http" | "browser";
  readonly url: string;
  readonly mode: "api" | "page";
  readonly base: Record<string, unknown>;
  readonly secretParams: readonly string[];
  readonly invalid: string | undefined;
  readonly onBehalfOf: readonly string[] | undefined;
  readonly scope: string | undefined;
  readonly labels: Readonly<Record<string, string>> | undefined;
  /** This function answers from the cache, when the stored copy is young enough. */
  readonly cached: (url: string) => Promise<Step | undefined>;
}

/** A request that the admission let through: the facts that the transport needs. */
interface Admitted {
  readonly target: URL;
  readonly url: string;
  readonly host: string;
  readonly policy: PolitenessPolicy;
  readonly tokens: readonly string[];
  readonly verdict: RobotsVerdict | undefined;
  readonly check: Record<string, unknown> | undefined;
  readonly robotsLines: readonly string[];
  readonly crawlDelaySeconds: number;
  readonly skip: (note: string, extra?: Record<string, unknown>) => Promise<Fetched>;
}

const robotsCheck = (
  verdict: RobotsVerdict,
  tokens: readonly string[],
  decision: RobotsDecision,
): Record<string, unknown> => ({
  capture: verdict.capture ?? null,
  tokens,
  rule:
    decision.rule === undefined
      ? null
      : { line: decision.rule.line ?? null, pattern: decision.rule.pattern, allow: decision.rule.allow },
  group_line: decision.groups?.[0]?.line ?? null,
  ...(verdict.robots.unreachable !== undefined ? { unreachable: verdict.robots.unreachable } : {}),
  ...(verdict.stale !== undefined ? { stale: verdict.stale } : {}),
});

const raceAbort = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
};

/** The result of reading robots.txt: the rules, the capture that holds them, and the wait that the server asked for. */
export interface RobotsRead {
  readonly robots: Robots;
  readonly capture: string | undefined;
  readonly retryAfterMs: number | undefined;
}

export class Crawler {
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly scheduler: HostScheduler;
  private readonly dispatcher: Dispatcher;
  private readonly ownsDispatcher: boolean;
  private readonly egress: EgressOptions;
  private readonly robots = new Lru<string, RobotsEntry>(4096);
  /** The fields of a cache entry that the index does not keep, and the raw target of a redirect. */
  private readonly meta = new Lru<string, { readonly entry: CacheEntry; readonly location?: string | undefined }>(
    10_000,
  );
  private readonly inFlight = new Map<string, Promise<Step>>();
  private readonly running = new Set<Promise<unknown>>();
  private readonly closing = new AbortController();
  private closed = false;
  private closingDone: Promise<void> | undefined;
  /** This note tells why the renderer has no browser. After the first page that finds it, the crawler renders nothing. */
  private renderOff: string | undefined;
  /** The renders that run at one time (`maxRenders`). */
  private readonly renders: Slots;

  constructor(private readonly options: CrawlerOptions) {
    if (!isProductToken(options.token)) {
      throw new Error(
        `the token "${options.token}" is not a product token: use only letters, "_" and "-" (RFC 9309)`,
      );
    }
    for (const [name, value] of [
      ["userAgent", options.userAgent],
      ["from", options.from],
    ] as const) {
      if (value !== undefined && !HEADER_TEXT.test(value)) {
        throw new Error(`${name} "${value}" has a character that an HTTP header cannot hold: use printable ASCII`);
      }
    }
    checkPolicy(options.politeness);
    this.clock = options.clock ?? realClock;
    this.random = options.random ?? Math.random;
    this.egress = options.egress ?? {};
    this.scheduler = new HostScheduler(this.clock, options.maxActive ?? 16, {
      store: options.hostState,
    });
    const maxRenders = options.maxRenders ?? 2;
    if (!Number.isInteger(maxRenders) || maxRenders < 1) {
      throw new RangeError(`maxRenders must be an integer of 1 or more, not ${String(maxRenders)}`);
    }
    this.renders = new Slots(maxRenders);
    this.ownsDispatcher = options.dispatcher === undefined;
    this.dispatcher =
      options.dispatcher ??
      new Agent({
        // past the per-host delay, or every polite request reconnects
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: 120_000,
        allowH2: true,
        // the egress policy checks each address after DNS, at the time of the connection
        connect: { timeout: 10_000, lookup: egressLookup(this.egress) },
        headersTimeout: 30_000,
        bodyTimeout: 60_000,
      });
  }

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private policyOf(url: URL): PolitenessPolicy {
    return policyFor(this.options.politeness, url.hostname);
  }

  private emit(event: CrawlEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // a listener that fails does not change the crawl
    }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.running.add(work);
    void work.then(
      () => this.running.delete(work),
      () => this.running.delete(work),
    );
    return work;
  }

  private stopHost(host: string, until: number, reason: string): void {
    this.scheduler.store.stop(host, until, reason);
    this.emit({ type: "stop", host, until, reason });
  }

  private async record(
    kind: "capture" | "revisit" | "skipped",
    payload: Record<string, unknown>,
    url: string,
    labels: { readonly scope?: string | undefined; readonly labels?: Readonly<Record<string, string>> | undefined } = {},
  ): Promise<string | undefined> {
    // a closed crawler writes nothing, so its log stays closed
    if (this.closed) return undefined;
    const at = this.iso();
    const scope = labels.scope ?? this.options.scope;
    const record = makeRecord({
      source: "fetch",
      kind,
      payload: { schema: CAPTURE_SCHEMA, ...payload, fetched_at: at },
      received_at: at,
      occurred_at: at,
      external_id: url,
      ...(scope !== undefined ? { scope } : {}),
      ...(labels.labels !== undefined ? { labels: labels.labels } : {}),
    });
    await this.options.log.append(record);
    return record.id;
  }

  private async skip(
    base: Record<string, unknown>,
    url: string,
    note: string,
    extra: Record<string, unknown> = {},
    labels: { readonly scope?: string | undefined; readonly labels?: Readonly<Record<string, string>> | undefined } = {},
  ): Promise<Fetched> {
    this.emit({ type: "skip", url, note });
    return {
      url,
      status: 0,
      outcome: "skipped",
      fromCache: false,
      capture: await this.record("skipped", { ...base, url, note, ...extra }, url, labels),
      blob: undefined,
      body: undefined,
      contentType: undefined,
      signals: NO_SIGNALS,
      note,
    };
  }

  /** This method reads the cache entry of a URL, with the fields that the crawler keeps in memory. */
  private lookup(url: string, variant: Variant = "plain"): CacheEntry | undefined {
    const key = cacheKeyOf(url);
    const row = this.options.index.latest(key, variant);
    if (row === undefined) return undefined;
    const meta = this.meta.get(`${variant} ${key}`);
    if (meta === undefined || meta.entry.capture !== row.capture) return row;
    const kept = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
    return { ...meta.entry, ...kept } as CacheEntry;
  }

  private store(entry: CacheEntry, location?: string): void {
    const variant = entry.variant ?? "plain";
    const keyed = { ...entry, url: cacheKeyOf(entry.url), variant };
    this.options.index.setLatest(keyed);
    this.meta.set(`${variant} ${keyed.url}`, { entry: keyed, ...(location !== undefined ? { location } : {}) });
  }

  /** This method gives the target of a stored redirect, when the crawler can follow it. */
  private followable(entry: CacheEntry, secretParams: readonly string[]): string | undefined {
    const meta = this.meta.peek(`${entry.variant ?? "plain"} ${cacheKeyOf(entry.url)}`);
    if (meta?.location !== undefined && meta.entry.capture === entry.capture) return meta.location;
    if (entry.location === undefined || entry.location === null) return undefined;
    try {
      const target = new URL(entry.location);
      // a stored target with secrets holds REDACTED in their place, and is not the real target
      return holdsSecrets(target, secretParams) ? undefined : target.href;
    } catch {
      return undefined;
    }
  }

  /** This method answers from the cache, when the stored entry is young or fresh enough. */
  private async fromCache(
    url: string,
    variant: Variant,
    maxAge: number | "auto" | undefined,
    sent: Readonly<Record<string, string>>,
    secretParams: readonly string[],
  ): Promise<Step | undefined> {
    if (maxAge === undefined) return undefined;
    const entry = this.lookup(url, variant);
    if (entry === undefined || !varyMatches(entry.vary_key, sent)) return undefined;
    const now = this.clock.now();
    const fetchedAt = Date.parse(entry.fetched_at);
    if (!Number.isFinite(fetchedAt)) return undefined;
    const age = now - fetchedAt;
    const until =
      entry.fresh_until === undefined || entry.fresh_until === null ? Number.NaN : Date.parse(entry.fresh_until);
    const fresh = Number.isFinite(until) && until > now;
    const redirect = entry.status >= 300 && entry.status < 400;
    // an explicit age wins; `auto` uses the freshness of the server; a temporary redirect needs both
    const young =
      maxAge === "auto"
        ? fresh
        : redirect && !PERMANENT_REDIRECTS.has(entry.status)
          ? fresh && age < maxAge
          : age < maxAge;
    if (!young) return undefined;
    if (redirect) {
      const next = this.followable(entry, secretParams);
      if (next === undefined) return undefined;
      return {
        fetched: {
          url,
          status: entry.status,
          outcome: "redirect",
          fromCache: true,
          capture: entry.capture,
          blob: undefined,
          body: undefined,
          contentType: undefined,
          signals: NO_SIGNALS,
          note: `location ${entry.location ?? redact(new URL(next), secretParams)}`,
          fetchedAt: entry.fetched_at,
        },
        next,
      };
    }
    if (entry.blob === null || entry.status < 200 || entry.status >= 300) return undefined;
    const body = await this.options.blobs.get(entry.blob);
    if (body === undefined) return undefined;
    return {
      fetched: {
        url,
        status: entry.status,
        outcome: "ok",
        fromCache: true,
        capture: entry.capture,
        blob: entry.blob,
        body,
        contentType: entry.content_type ?? undefined,
        signals: { ai_input: entry.ai_input ?? "unset", raw: [] },
        note: entry.truncated === true ? "a truncated copy" : undefined,
        ...(entry.truncated === true ? { truncated: true } : {}),
        fetchedAt: entry.fetched_at,
      },
    };
  }

  private requestHeaders(request_: FetchRequest): Record<string, string> {
    const headers: Record<string, string> = {};
    // the caller's headers go first, so the crawler's own headers replace them
    for (const [name, value] of Object.entries(request_.headers ?? {})) {
      const lower = name.toLowerCase();
      if (!RESERVED_HEADERS.has(lower)) headers[lower] = value;
    }
    headers["accept"] = request_.accept ?? headers["accept"] ?? "*/*";
    headers["user-agent"] = this.options.userAgent;
    headers["accept-encoding"] = "gzip, deflate, br";
    if (this.options.from !== undefined) headers["from"] = this.options.from;
    return headers;
  }

  /**
   * This method records the result of a request for the host, and it gives the rest of the host.
   * The rest comes from `restAfter`. A 429 or 503 waits, an error counts toward a stop, and a
   * refusal stops the host for a time.
   */
  private settle(host: string, policy: PolitenessPolicy, step: Settle): number {
    const store = this.scheduler.store;
    const now = this.clock.now();
    const rest = restAfter(policy, step.rest);
    const delayMs = rest.ms;
    const waited = (ms: number, reason: string): number => {
      if (ms > delayMs) this.emit({ type: "wait", host, ms, reason });
      return ms;
    };
    if (step.result !== undefined) {
      store.record(host, step.result);
      return delayMs;
    }
    const outcome = step.outcome;
    if (outcome === "rate-limited" || outcome === "unavailable") {
      const { waits } = store.record(host, "wait");
      const asked = step.retryAfterMs;
      if (asked !== undefined && asked > policy.maxRetryAfterMs) {
        // a wait longer than the budget stops the host, so no request sleeps for days
        this.stopHost(host, now + Math.min(asked, MAX_STOP_MS), `asked to wait ${String(Math.round(asked / 1000))} s`);
        return delayMs;
      }
      return waited(
        Math.max(delayMs, asked ?? equalJitterMs(waits, policy.backoffBaseMs, policy.backoffCapMs, this.random)),
        asked === undefined ? "backoff" : "retry-after",
      );
    }
    if (outcome === "error") {
      if (isClientError(step.status)) {
        store.record(host, "neutral");
        return delayMs;
      }
      const { failures } = store.record(host, "failure");
      if (failures >= policy.maxFailures)
        this.stopHost(host, now + policy.failureStopMs, `${String(failures)} failures in a row`);
      return waited(
        Math.max(delayMs, equalJitterMs(failures, policy.backoffBaseMs, policy.backoffCapMs, this.random)),
        "backoff",
      );
    }
    if (outcome === "challenge") this.stopHost(host, now + policy.challengeStopMs, outcome);
    else if (outcome === "payment-required") this.stopHost(host, now + policy.paymentStopMs, outcome);
    else if (outcome === "blocked" && !step.robotsFile) this.stopHost(host, now + policy.blockedStopMs, outcome);
    store.record(host, "success");
    return delayMs;
  }

  /**
   * This method stops the host of a URL as a challenge does: for the `challengeStopMs` of the policy.
   * The runtime uses it when a page that answered 200 is a bot check (`meta.blocked`).
   */
  reportBlocked(url: string, what: string): void {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return;
    }
    const policy = this.policyOf(target);
    this.stopHost(hostKey(target), this.clock.now() + policy.challengeStopMs, `challenge (${what})`);
  }

  /**
   * This method applies the rules that a fetch and a render share. The sequence is the URL, the
   * options, the egress policy, the product tokens and the rules for an agent. Then come the
   * cache, the stops of the host and robots.txt. It gives the answer when a rule decides, or the
   * facts that the transport needs.
   */
  private async admit(
    spec: AdmitSpec,
    extra?: (admitted: Omit<Admitted, "verdict" | "check" | "robotsLines" | "crawlDelaySeconds">) => Promise<Fetched | undefined>,
  ): Promise<{ readonly answer: Step } | { readonly admitted: Admitted }> {
    const marks = { scope: spec.scope, labels: spec.labels };
    let target: URL;
    try {
      target = new URL(spec.url);
    } catch {
      return { answer: { fetched: await this.skip(spec.base, spec.url, "not a valid URL", {}, marks) } };
    }
    if (!WEB_PROTOCOLS.has(target.protocol)) {
      return {
        answer: {
          fetched: await this.skip(spec.base, redact(target, spec.secretParams), "not an http(s) URL", {}, marks),
        },
      };
    }
    // a fragment never goes to the server, so it is not part of the cache key
    target.hash = "";
    const url = redact(target, spec.secretParams);
    const skip = (note: string, extra_?: Record<string, unknown>): Promise<Fetched> =>
      this.skip(spec.base, url, note, extra_, marks);
    const answer = async (note: string, extra_?: Record<string, unknown>) => ({
      answer: { fetched: await skip(note, extra_) },
    });
    if (spec.invalid !== undefined) return answer(spec.invalid);
    const refused = egressRefusal(this.egress, target.hostname);
    if (refused !== undefined) return answer(refused);
    const tokens = [this.options.token, ...(spec.onBehalfOf ?? [])];
    const badToken = tokens.find((token) => !isProductToken(token));
    if (spec.mode === "page" && badToken !== undefined) return answer(`not a valid product token: "${badToken}"`);
    const host = hostKey(target);
    const policy = this.policyOf(target);
    const path = `${target.pathname}${target.search}`;

    // the rules for an agent apply before a stored copy answers it
    let verdict: RobotsVerdict | undefined;
    if (spec.mode === "page") {
      verdict = tokens.length > 1 ? await this.robotsFor(target, policy, spec) : this.knownRobots(target);
      if (verdict !== undefined) {
        const decision = decide(verdict.robots, tokens, path);
        if (!decision.allowed) {
          return answer(robotsRefusal(verdict.robots, decision.by ?? this.options.token), {
            robots_check: robotsCheck(verdict, tokens, decision),
          });
        }
      }
    }
    const cached = await spec.cached(url);
    if (cached !== undefined) return { answer: cached };

    const stop = this.scheduler.stopOf(host);
    if (stop !== undefined) return answer(stopNote(stop.reason, stop.until));
    const early = await extra?.({ target, url, host, policy, tokens, skip });
    if (early !== undefined) return { answer: { fetched: early } };

    let robotsLines: readonly string[] = [];
    let crawlDelaySeconds = 0;
    let check: Record<string, unknown> | undefined;
    if (spec.mode === "page") {
      verdict ??= await this.robotsFor(target, policy, spec);
      const decision = decide(verdict.robots, tokens, path);
      check = robotsCheck(verdict, tokens, decision);
      if (!decision.allowed) {
        return answer(robotsRefusal(verdict.robots, decision.by ?? this.options.token), { robots_check: check });
      }
      robotsLines = signalsFor(verdict.robots, tokens, path);
      crawlDelaySeconds = decision.crawlDelaySeconds ?? 0;
    }
    if (this.closed) return { answer: { fetched: closedResult(url) } };
    return {
      admitted: { target, url, host, policy, tokens, verdict, check, robotsLines, crawlDelaySeconds, skip },
    };
  }

  /** This method fetches a URL. It follows the redirects up to the maximum, and each step is a separate decision. */
  async fetch(request_: FetchRequest): Promise<Fetched> {
    if (this.closed) return closedResult(request_.url);
    return this.track(this.follow(request_));
  }

  private async follow(request_: FetchRequest): Promise<Fetched> {
    const signal =
      request_.signal === undefined
        ? this.closing.signal
        : AbortSignal.any([request_.signal, this.closing.signal]);
    let url = request_.url;
    let headers = request_.headers;
    let origin: string | undefined;
    let maxRedirects = DEFAULT_POLICY.maxRedirects;
    try {
      const first = new URL(url);
      origin = first.origin;
      maxRedirects = this.policyOf(first).maxRedirects;
    } catch {
      // fetchOnce records the URL that does not parse
    }
    try {
      for (let hop = 0; ; hop += 1) {
        const step = await this.hop({ ...request_, url, headers }, signal);
        if (step.next === undefined) return step.fetched;
        if (hop >= maxRedirects) {
          return { ...step.fetched, outcome: "error", note: `more than ${String(maxRedirects)} redirects` };
        }
        const next = new URL(step.next);
        // a credential for one origin does not go to a different origin
        if (next.origin !== origin) headers = withoutCredentials(headers);
        origin = next.origin;
        url = step.next;
      }
    } catch (error) {
      if (this.closed) return closedResult(request_.url);
      return {
        ...closedResult(request_.url),
        outcome: "error",
        note: `crawler error: ${messageOf(error)}`,
      };
    }
  }

  /** This method joins a request to an equal request in progress, so one URL gets one request at a time. */
  private hop(request_: FetchRequest, signal: AbortSignal): Promise<Step> {
    // a request with a signal of its own runs alone, so its cancellation stops only that request
    if (request_.signal !== undefined) return this.fetchOnce(request_, signal);
    const key = JSON.stringify([
      cacheKeyOf(request_.url.split("#")[0] ?? request_.url),
      request_.mode,
      request_.recipe,
      request_.accept ?? null,
      request_.headers ?? null,
      request_.secretParams ?? null,
      request_.minIntervalMs ?? null,
      request_.maxAgeMs ?? null,
      request_.maxBytes ?? null,
      request_.onBehalfOf ?? null,
      request_.job ?? null,
      request_.scope ?? null,
      request_.labels ?? null,
    ]);
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const work = this.fetchOnce(request_, signal).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  private knownRobots(target: URL): RobotsVerdict | undefined {
    const entry = this.robots.peek(originKey(target));
    return entry !== undefined && this.clock.now() - entry.at < entry.ttlMs ? entry.value : undefined;
  }

  /**
   * This method gives the robots.txt of the origin of a URL. A good copy stays for the TTL of the
   * policy. An unreachable verdict stays for some minutes, with a backoff and the `Retry-After`
   * of the server. During that time the last good copy applies, when there is one (RFC 9309 §2.4).
   */
  private robotsFor(
    target: URL,
    policy: PolitenessPolicy,
    marks: { readonly scope?: string | undefined; readonly labels?: Readonly<Record<string, string>> | undefined } = {},
  ): Promise<RobotsVerdict> {
    const key = originKey(target);
    const now = this.clock.now();
    const cached = this.robots.get(key);
    if (cached !== undefined && now - cached.at < cached.ttlMs) {
      // a request that joins a fetch in progress adds its scope and its labels to the record
      if (cached.value === undefined) this.join(cached.waiting, marks);
      return cached.verdict;
    }
    const waiting: Waiting = { scope: undefined, labels: undefined };
    this.join(waiting, marks);
    const entry: RobotsEntry = {
      at: now,
      waiting,
      ttlMs: policy.robotsTtlMs,
      verdict: Promise.resolve({ robots: unreachableRobots("not read yet"), capture: undefined }),
      value: undefined,
      misses: cached?.misses ?? 0,
      good: cached?.good,
    };
    entry.verdict = this.fetchRobots(target, policy, waiting)
      .catch((error: unknown) => ({
        robots: unreachableRobots(`robots.txt failed: ${messageOf(error)}`),
        capture: undefined,
        retryAfterMs: undefined,
      }))
      .then(async (read): Promise<RobotsVerdict> => {
        let verdict: RobotsVerdict = { robots: read.robots, capture: read.capture };
        if (read.robots.unreachable === undefined) {
          entry.misses = 0;
          entry.good = { verdict, at: this.clock.now() };
        } else {
          entry.misses += 1;
          const backoff = equalJitterMs(entry.misses, policy.robotsRetryMs, policy.robotsRetryCapMs, this.random);
          entry.ttlMs = Math.min(policy.robotsRetryCapMs, Math.max(read.retryAfterMs ?? 0, backoff));
          const good =
            entry.good !== undefined && this.clock.now() - entry.good.at <= policy.robotsStaleMs
              ? entry.good.verdict
              : await this.storedRobots(target, policy);
          if (good !== undefined) verdict = { ...good, stale: read.robots.unreachable };
        }
        entry.value = verdict;
        return verdict;
      });
    this.robots.set(key, entry);
    return entry.verdict;
  }

  /**
   * This method gives the robots.txt rules that apply to a URL, as the crawler applies them. They
   * come from its memory, or from a fetch of `/robots.txt` with its redirects. A robots.txt that
   * the crawler cannot read gives rules that permit nothing, and `unreachable` gives the reason.
   */
  async readRobots(url: string): Promise<{ readonly robots: Robots; readonly capture: string | undefined; readonly stale?: string | undefined }> {
    const target = new URL(url);
    if (!WEB_PROTOCOLS.has(target.protocol)) return { robots: unreachableRobots("not an http(s) URL"), capture: undefined };
    return this.robotsFor(target, this.policyOf(target));
  }

  /** This method reads the stored copy of a robots.txt, when it is younger than the limit of the policy. */
  private async storedRobots(target: URL, policy: PolitenessPolicy): Promise<RobotsVerdict | undefined> {
    try {
      const row = this.lookup(redact(new URL("/robots.txt", target.origin)));
      if (row === undefined || row.blob === null || row.status < 200 || row.status >= 300) return undefined;
      if (this.clock.now() - Date.parse(row.fetched_at) > policy.robotsStaleMs) return undefined;
      const body = await this.options.blobs.get(row.blob);
      if (body === undefined) return undefined;
      const robots = robotsFromResponse(200, row.content_type, body);
      return robots.unreachable === undefined ? { robots, capture: row.capture } : undefined;
    } catch {
      return undefined;
    }
  }

  /** This method adds the scope and the labels of one request to the requests that wait for a robots.txt. The most private scope wins. */
  private join(
    waiting: Waiting,
    marks: { readonly scope?: string | undefined; readonly labels?: Readonly<Record<string, string>> | undefined },
  ): void {
    const scope = marks.scope ?? this.options.scope;
    const rank = this.options.scopeRank;
    if (waiting.scope === undefined) waiting.scope = scope;
    else if (scope !== undefined && rank !== undefined && rank(scope) > rank(waiting.scope)) waiting.scope = scope;
    if (marks.labels !== undefined) waiting.labels = { ...marks.labels, ...waiting.labels };
  }

  private async fetchRobots(target: URL, policy: PolitenessPolicy, waiting: Waiting): Promise<RobotsRead> {
    let url = new URL("/robots.txt", target.origin);
    const unreachable = (reason: string, capture: string | undefined, retryAfterMs?: number): RobotsRead => ({
      robots: unreachableRobots(reason),
      capture,
      retryAfterMs,
    });
    for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
      const step = await this.fetchOnce(
        {
          url: url.href,
          mode: "api",
          recipe: "robots.txt",
          accept: "text/plain",
          maxBytes: ROBOTS_BYTES,
          minIntervalMs: policy.apiIntervalMs,
          // the record reads the requests that wait at the time that it is written, not at the start
          get scope() {
            return waiting.scope;
          },
          get labels() {
            return waiting.labels;
          },
        },
        this.closing.signal,
      );
      const result = step.fetched;
      if (result.outcome === "redirect") {
        if (step.next === undefined)
          return unreachable(result.note ?? "a redirect with no Location header", result.capture);
        url = new URL(step.next);
        continue;
      }
      if (result.outcome === "skipped" || result.status === 0)
        return unreachable(result.note ?? "no response", result.capture);
      // a body that the crawler cannot read is not an empty robots.txt: the site stays closed
      if (result.outcome === "error" && result.status >= 200 && result.status < 300)
        return unreachable(result.note ?? "the body could not be read", result.capture);
      // a body that the server cut can have lost a rule
      if (result.note?.startsWith("the compressed body ended early") === true)
        return unreachable(result.note, result.capture);
      if (result.outcome === "not-modified") {
        return result.body === undefined
          ? unreachable("status 304, and no stored copy", result.capture)
          : { robots: robotsFromResponse(200, result.contentType ?? null, result.body), capture: result.capture, retryAfterMs: undefined };
      }
      const robots =
        result.status >= 200 && result.status < 300
          ? robotsFromResponse(result.status, result.contentType ?? null, result.body ?? new Uint8Array())
          : robotsFromStatus(result.status, undefined);
      return { robots, capture: result.capture, retryAfterMs: step.retryAfterMs };
    }
    return unreachable(`more than ${String(policy.maxRedirects)} redirects`, undefined);
  }

  private async fetchOnce(request_: FetchRequest, signal: AbortSignal): Promise<Step> {
    const base = {
      recipe: request_.recipe,
      mode: request_.mode,
      ...(request_.job ? { job: request_.job } : {}),
    };
    const secretParams = request_.secretParams ?? [];
    const sent = this.requestHeaders(request_);
    // read when a record is written: more requests can wait for the fetch of a robots.txt by then
    const marks = {
      get scope() {
        return request_.scope;
      },
      get labels() {
        return request_.labels;
      },
    };
    const admission = await this.admit({
      transport: "http",
      url: request_.url,
      mode: request_.mode,
      base,
      secretParams,
      invalid:
        invalidNumber("minIntervalMs", request_.minIntervalMs, false) ??
        invalidNumber("maxBytes", request_.maxBytes, false) ??
        invalidNumber("maxAgeMs", request_.maxAgeMs, true),
      onBehalfOf: request_.onBehalfOf,
      scope: request_.scope,
      labels: request_.labels,
      cached: (url) => this.fromCache(url, "plain", request_.maxAgeMs, sent, secretParams),
    });
    if ("answer" in admission) return admission.answer;
    const { target, url, host, policy, check, robotsLines, crawlDelaySeconds, skip } = admission.admitted;
    const maxBytes = request_.maxBytes ?? policy.maxBytes;
    const rest = (elapsedMs: number): RestInput => ({
      kind: request_.mode,
      elapsedMs,
      crawlDelaySeconds,
      minIntervalMs: request_.minIntervalMs,
    });
    const robotsFile = request_.recipe === "robots.txt";

    try {
      return await this.scheduler.run(
        host,
        async (): Promise<Paced<Step>> => {
          // an equal request that waited in the queue can find a fresh copy now
          const again = await this.fromCache(url, "plain", request_.maxAgeMs, sent, secretParams);
          if (again !== undefined) return { value: again, delayMs: 0 };
          const latest = this.lookup(url);
          // validators go only with a stored body of the same variant, so a 304 always has a body
          const usable =
            latest !== undefined && latest.truncated !== true && varyMatches(latest.vary_key, sent)
              ? latest
              : undefined;
          let stored: Uint8Array | undefined;
          if (usable?.blob && (usable.etag || usable.last_modified))
            stored = await this.options.blobs.get(usable.blob);
          const headers: Record<string, string> = { ...sent };
          if (stored !== undefined && usable?.etag) headers["if-none-match"] = usable.etag;
          if (stored !== undefined && usable?.last_modified) headers["if-modified-since"] = usable.last_modified;
          const started = this.clock.now();
          const timeout = AbortSignal.timeout(policy.requestTimeoutMs);
          const abort = AbortSignal.any([timeout, signal]);
          const cancelled = (): boolean => request_.signal?.aborted === true;
          const failedNote = (prefix: string, error: unknown): string =>
            timeout.aborted
              ? `${prefix}: timed out after ${String(Math.round(policy.requestTimeoutMs / 1000))} s`
              : `${prefix}: ${messageOf(error)}`;

          this.emit({ type: "request", url, host, transport: "http" });
          let response: Dispatcher.ResponseData;
          try {
            response = await request(target, { method: "GET", headers, dispatcher: this.dispatcher, signal: abort });
          } catch (error) {
            const egress = egressError(error);
            if (egress !== undefined) return { value: { fetched: await skip(egress.message) }, delayMs: 0 };
            if (this.closed) return { value: { fetched: closedResult(url) }, delayMs: 0 };
            const elapsedMs = this.clock.now() - started;
            const note = cancelled() ? "cancelled by the caller" : failedNote("no response", error);
            const delayMs = this.settle(host, policy, {
              outcome: "error",
              status: 0,
              retryAfterMs: undefined,
              rest: rest(elapsedMs),
              robotsFile,
              ...(cancelled() ? { result: "neutral" as const } : {}),
            });
            this.emit({ type: "response", url, host, status: 0, outcome: "error", elapsedMs });
            const capture = await this.record(
              "capture",
              { ...base, url, status: 0, outcome: "error", note, elapsed_ms: elapsedMs, ...(check ? { robots_check: check } : {}) },
              url,
              marks,
            );
            return {
              value: {
                fetched: {
                  url,
                  status: 0,
                  outcome: "error",
                  fromCache: false,
                  capture,
                  blob: undefined,
                  body: undefined,
                  contentType: undefined,
                  signals: NO_SIGNALS,
                  note,
                  fetchedAt: new Date(started).toISOString(),
                  ...marks,
                },
              },
              delayMs,
            };
          }

          const header = headerOf(response.headers as Record<string, string | string[] | undefined>);
          const ttfbMs = this.clock.now() - started;
          const classified = classify(response.statusCode, header, this.clock.now());
          let outcome: Outcome = classified.outcome;
          let note = classified.note;
          let body: Uint8Array | undefined;
          let blob: string | undefined;
          let truncated = false;
          let cut = false;
          let next: string | undefined;
          let result: HostResult | undefined;
          if (outcome === "ok") {
            try {
              const read = await readBody(response.body, header("content-encoding"), maxBytes);
              body = read.bytes;
              truncated = read.truncated;
              cut = read.cut;
              if (read.cut) note = `the compressed body ended early, so the crawler keeps the ${String(read.bytes.length)} bytes before the end`;
              else if (truncated) note = `truncated at ${String(maxBytes)} bytes`;
            } catch (error) {
              if (this.closed) return { value: { fetched: closedResult(url) }, delayMs: 0 };
              outcome = "error";
              if (cancelled()) {
                note = "cancelled by the caller";
                result = "neutral";
              } else {
                const decode = error instanceof BodyError && error.kind === "decode";
                note = failedNote(decode ? "undecodable body" : "body failed", error);
              }
            }
            if (body !== undefined) {
              try {
                blob = (await this.options.blobs.put(body)).hash;
              } catch (error) {
                // a full disk is not a fault of the host
                outcome = "error";
                note = `blob store: ${messageOf(error)}`;
                body = undefined;
                result = "neutral";
              }
            }
          } else {
            try {
              await readBody(response.body, undefined, ERROR_BODY_BYTES);
            } catch {
              // the body of an error answer is not kept
            }
          }
          const elapsedMs = this.clock.now() - started;
          if (outcome === "not-modified") {
            if (stored !== undefined && usable?.blob) {
              body = stored;
              blob = usable.blob;
            } else note = "not modified, but the crawler has no stored copy";
          }
          let location: string | undefined;
          if (outcome === "redirect") {
            const raw = header("location");
            if (raw === undefined) note = "a redirect with no Location header";
            else {
              try {
                const resolved = new URL(raw, target);
                next = resolved.href;
                location = redact(resolved, secretParams);
                note = `location ${location}`;
              } catch {
                outcome = "error";
                note = "bad redirect target";
              }
            }
          }

          const revisit = outcome === "not-modified" && usable !== undefined;
          let signals = readSignals(robotsLines, header, pageSignals(body, header("content-type")));
          if (revisit) {
            // a 304 updates the stored answer and does not replace it (RFC 9111 §4.3.4)
            const merged: AiInput =
              signals.ai_input === "no" || usable.ai_input === "no"
                ? "no"
                : signals.ai_input !== "unset"
                  ? signals.ai_input
                  : usable.ai_input;
            signals = { ...signals, ai_input: merged };
          }
          const contentType = header("content-type") ?? (revisit ? (usable.content_type ?? undefined) : undefined);
          // a web page in place of the data of an API (a login or an error page) is not the stored copy
          const unasked = request_.mode === "api" && outcome === "ok" && unaskedPage(request_.accept, contentType);
          if (unasked) {
            const said = `the server sent ${contentType ?? ""}, and the request accepts ${request_.accept ?? ""}, so the crawler keeps no stored copy of it`;
            note = note === undefined ? said : `${note}; ${said}`;
          }
          const etag = header("etag") ?? (revisit ? usable.etag : null) ?? null;
          const lastModified = header("last-modified") ?? (revisit ? usable.last_modified : null) ?? null;
          const fetchedAt = this.clock.now();
          const freshness = freshUntil(header, response.statusCode, fetchedAt, lastModified, policy.heuristicFreshnessCapMs);
          const varyKey =
            header("vary") !== undefined ? varyKeyOf(header("vary"), sent) : revisit ? (usable.vary_key ?? null) : null;
          const cacheHeaders = Object.fromEntries(
            ["cache-control", "expires", "age", "date", "vary"].flatMap((name) => {
              const value = header(name);
              return value === undefined ? [] : [[name.replace("-", "_"), value]];
            }),
          );
          this.emit({ type: "response", url, host, status: response.statusCode, outcome, elapsedMs });
          const capture = await this.record(
            revisit ? "revisit" : "capture",
            {
              ...base,
              url,
              status: response.statusCode,
              outcome,
              elapsed_ms: elapsedMs,
              ttfb_ms: ttfbMs,
              content_type: contentType ?? null,
              bytes: body?.length ?? 0,
              blob: blob ?? null,
              etag,
              last_modified: lastModified,
              ...(revisit ? { revisit_of: usable.capture } : {}),
              robots: request_.mode === "page" ? "allowed" : "not-checked",
              ...(check !== undefined ? { robots_check: check } : {}),
              signals,
              ...(truncated ? { truncated: true } : {}),
              ...(cut ? { cut: true } : {}),
              ...(unasked ? { unasked: true } : {}),
              ...cacheHeaders,
              ...(freshness !== null ? { fresh_until: freshness } : {}),
              ...(varyKey !== null ? { vary_key: varyKey } : {}),
              ...(location !== undefined ? { location } : {}),
              ...(note !== undefined ? { note } : {}),
            },
            url,
            marks,
          );
          const fetchedIso = new Date(fetchedAt).toISOString();
          // a body that the server cut is not a copy to keep: the next request asks for the whole body
          if (capture !== undefined && (outcome === "ok" || outcome === "not-modified") && blob !== undefined && !cut && !unasked) {
            this.store({
              url,
              capture,
              blob,
              // a truncated body keeps no validators, so a later request gets the whole body again
              etag: truncated ? null : etag,
              last_modified: truncated ? null : lastModified,
              content_type: contentType ?? null,
              fetched_at: fetchedIso,
              // an index that a replay built can hold 304 as the status of the stored body
              status: revisit ? (usable.status === 304 ? 200 : usable.status) : response.statusCode,
              ai_input: signals.ai_input,
              truncated: truncated ? true : undefined,
              fresh_until: freshness,
              vary_key: varyKey,
            });
          }
          if (
            capture !== undefined &&
            outcome === "redirect" &&
            next !== undefined &&
            (PERMANENT_REDIRECTS.has(response.statusCode) || freshness !== null)
          ) {
            this.store(
              {
                url,
                capture,
                blob: null,
                etag: null,
                last_modified: null,
                content_type: null,
                fetched_at: fetchedIso,
                status: response.statusCode,
                ai_input: "unset",
                location: location ?? null,
                fresh_until: freshness,
                vary_key: varyKey,
              },
              next,
            );
          }
          const delayMs = this.settle(host, policy, {
            outcome,
            status: response.statusCode,
            retryAfterMs: classified.retryAfterMs,
            rest: rest(elapsedMs),
            robotsFile,
            ...(result !== undefined ? { result } : {}),
          });
          return {
            value: {
              fetched: {
                url,
                status: response.statusCode,
                outcome,
                fromCache: false,
                capture,
                blob,
                body,
                contentType,
                signals,
                note,
                ...(truncated ? { truncated: true } : {}),
                fetchedAt: fetchedIso,
                ...marks,
              },
              next,
              retryAfterMs: classified.retryAfterMs,
            },
            delayMs,
          };
        },
        signal,
      );
    } catch (error) {
      if (error instanceof HostStopped) return { fetched: await skip(stopNote(error.reason, error.until)) };
      if (this.closed) return { fetched: closedResult(url) };
      if (request_.signal?.aborted === true) return { fetched: await skip("cancelled by the caller") };
      throw error;
    }
  }

  /**
   * This method gives the function that decides each request of a rendered page. It refuses an
   * address that the egress policy refuses, and a URL of the page's host that robots.txt
   * disallows. For a different host, it uses a robots.txt that the crawler holds, when there is one.
   */
  private allowRequestFor(
    page: URL,
    robots: Robots,
    tokens: readonly string[],
    signal: AbortSignal,
    tally: { allowed: number; refused: number; readonly hosts: Set<string> },
  ): (url: string) => Promise<boolean> {
    const pageOrigin = originKey(page);
    const checked = new Map<string, Promise<string | undefined>>();
    const refuse = (): boolean => {
      tally.refused += 1;
      return false;
    };
    return async (raw: string): Promise<boolean> => {
      if (signal.aborted) return false;
      let target: URL;
      try {
        target = new URL(raw);
      } catch {
        return refuse();
      }
      if (target.protocol === "data:" || target.protocol === "blob:" || target.protocol === "about:") return true;
      const web = WEB_PROTOCOLS.has(target.protocol);
      if (!web && target.protocol !== "ws:" && target.protocol !== "wss:") return refuse();
      let check = checked.get(target.hostname);
      if (check === undefined) {
        check = checkEgress(this.egress, target);
        checked.set(target.hostname, check);
      }
      if ((await check) !== undefined) return refuse();
      if (web) {
        const rules = originKey(target) === pageOrigin ? robots : this.knownRobots(target)?.robots;
        if (rules !== undefined && !decide(rules, tokens, `${target.pathname}${target.search}`).allowed)
          return refuse();
      }
      tally.allowed += 1;
      if (tally.hosts.size < 50) tally.hosts.add(hostKey(target));
      return true;
    };
  }

  /**
   * This method tells why the browser did not go on to a URL that the page moved to: the egress
   * policy or robots.txt. For a different site, it uses a robots.txt that the crawler holds. It
   * gives undefined for the page itself, or for a URL that it cannot read.
   */
  private async movedRefusal(
    raw: string,
    page: URL,
    robots: Robots,
    tokens: readonly string[],
  ): Promise<{ readonly note: string; readonly url: string } | undefined> {
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      return undefined;
    }
    target.hash = "";
    if (target.href === page.href) return undefined;
    const url = redact(target);
    const moved = `the page moved to ${url}`;
    if (!WEB_PROTOCOLS.has(target.protocol)) return { note: `${moved}, which is not an http(s) URL`, url };
    const egress = await checkEgress(this.egress, target);
    if (egress !== undefined) return { note: `${moved}: ${egress}`, url };
    const rules = originKey(target) === originKey(page) ? robots : this.knownRobots(target)?.robots;
    if (rules !== undefined) {
      const decision = decide(rules, tokens, `${target.pathname}${target.search}`);
      if (!decision.allowed) return { note: `${moved}: ${robotsRefusal(rules, decision.by ?? this.options.token)}`, url };
    }
    return undefined;
  }

  /**
   * This method renders a page in the headless browser and captures what the page shows. The rules
   * of a fetch apply:
   *
   * - the egress policy and robots.txt, for the page, its final URL and each request of the page
   * - one request at a time for each host
   * - the backoff after a 429 or a 503
   * - a capture for each decision
   *
   * A render costs the site more than a fetch, so the host rests longer after one. A render that
   * the browser refuses (`RenderRefused`) does not count against the host.
   */
  async render(request_: RenderRequest): Promise<Fetched> {
    if (this.closed) return closedResult(request_.url);
    return this.track(
      this.renderOnce(request_).catch((error: unknown) =>
        this.closed
          ? closedResult(request_.url)
          : { ...closedResult(request_.url), outcome: "error" as const, note: `crawler error: ${messageOf(error)}` },
      ),
    );
  }

  private async renderOnce(request_: RenderRequest): Promise<Fetched> {
    const base = {
      recipe: request_.recipe,
      mode: "page" as const,
      rendered: true,
      ...(request_.job ? { job: request_.job } : {}),
    };
    const marks = { scope: request_.scope, labels: request_.labels };
    const renderer = this.options.renderer;
    const admission = await this.admit(
      {
        transport: "browser",
        url: request_.url,
        mode: "page",
        base,
        secretParams: [],
        invalid: invalidNumber("maxAgeMs", request_.maxAgeMs, true),
        onBehalfOf: request_.onBehalfOf,
        scope: request_.scope,
        labels: request_.labels,
        cached: async (url) => {
          const cached = await this.fromCache(url, "rendered", request_.maxAgeMs, {}, []);
          if (cached === undefined || cached.fetched.body === undefined) return undefined;
          return { fetched: { ...cached.fetched, url, contentType: RENDERED_TYPE } };
        },
      },
      async ({ target, skip }) => {
        if (renderer === undefined) return skip("no browser configured for rendering");
        if (this.renderOff !== undefined) return skip(this.renderOff);
        // the browser does its own DNS, so the check here resolves the name too
        const resolved = await checkEgress(this.egress, target);
        return resolved === undefined ? undefined : skip(resolved);
      },
    );
    if ("answer" in admission) return admission.answer.fetched;
    const { target, url, host, policy, tokens, check, crawlDelaySeconds, skip } = admission.admitted;
    const verdict = admission.admitted.verdict!;
    const signal =
      request_.signal === undefined
        ? this.closing.signal
        : AbortSignal.any([request_.signal, this.closing.signal]);
    const tally = { allowed: 0, refused: 0, hosts: new Set<string>() };
    const allowRequest = this.allowRequestFor(target, verdict.robots, tokens, signal, tally);
    const rest = (elapsedMs: number): RestInput => ({ kind: "render", elapsedMs, crawlDelaySeconds });

    // the wait for a slot of the browser comes before the lease of the host, so the host does not wait for it
    let release: () => void;
    try {
      release = await this.renders.acquire(signal);
    } catch {
      if (this.closed) return closedResult(url);
      return skip("cancelled by the caller");
    }
    let done: RenderDone;
    try {
      done = await this.scheduler.run(
        host,
        async (): Promise<Paced<RenderDone>> => {
          const started = this.clock.now();
          this.emit({ type: "request", url, host, transport: "browser" });
          try {
            const rendered = await raceAbort(
              renderer!.render(target.href, {
                userAgent: this.options.userAgent,
                timeoutMs: policy.renderTimeoutMs,
                ...(this.options.from !== undefined ? { headers: { from: this.options.from } } : {}),
                allowRequest,
                maxRedirects: policy.maxRedirects,
                signal,
              }),
              signal,
            );
            const header = (name: string): string | undefined => rendered.headers[name.toLowerCase()];
            const classified: Classified =
              rendered.status === null
                ? { outcome: "ok", retryAfterMs: undefined, note: undefined }
                : classify(rendered.status, header, this.clock.now());
            const elapsedMs = this.clock.now() - started;
            const delayMs = this.settle(host, policy, {
              outcome: classified.outcome,
              status: rendered.status ?? 200,
              retryAfterMs: classified.retryAfterMs,
              rest: rest(elapsedMs),
              robotsFile: false,
            });
            return { value: { kind: "rendered", rendered, classified, elapsedMs }, delayMs };
          } catch (error) {
            const elapsedMs = this.clock.now() - started;
            if (this.closed) return { value: { kind: "closed" }, delayMs: 0 };
            if (request_.signal?.aborted === true) {
              return { value: { kind: "cancelled", elapsedMs }, delayMs: restAfter(policy, rest(0)).ms };
            }
            // a renderer of an application that has no browser is no fault of the host either
            const refused =
              error instanceof RenderRefused
                ? error
                : missingBrowser(messageOf(error))
                  ? new RenderRefused("browser", `rendering needs a browser: ${messageOf(error)}`)
                  : undefined;
            if (refused !== undefined) {
              if (refused.reason === "browser") this.renderOff = refused.message;
              // a refused navigation, a file, a scheme or no browser is no fault of the host
              const delayMs = this.settle(host, policy, {
                outcome: "skipped",
                status: 0,
                retryAfterMs: undefined,
                rest: rest(0),
                robotsFile: false,
                result: "neutral",
              });
              return {
                value: { kind: "refused", reason: refused.reason, note: refused.message, url: refused.url, elapsedMs },
                delayMs,
              };
            }
            const delayMs = this.settle(host, policy, {
              outcome: "error",
              status: 0,
              retryAfterMs: undefined,
              rest: rest(elapsedMs),
              robotsFile: false,
            });
            return { value: { kind: "failed", note: `render failed: ${messageOf(error)}`, elapsedMs }, delayMs };
          }
        },
        signal,
      );
    } catch (error) {
      if (error instanceof HostStopped) return skip(stopNote(error.reason, error.until));
      if (this.closed) return closedResult(url);
      if (request_.signal?.aborted === true) return skip("cancelled by the caller");
      throw error;
    } finally {
      release();
    }

    if (done.kind === "closed" || this.closed) return closedResult(url);
    const subrequests = { allowed: tally.allowed, refused: tally.refused, hosts: [...tally.hosts] };
    if (done.kind === "refused") {
      this.emit({ type: "response", url, host, status: 0, outcome: done.reason === "download" ? "not-html" : "skipped", elapsedMs: done.elapsedMs });
      if (done.reason !== "download") {
        const moved = done.url === undefined ? undefined : await this.movedRefusal(done.url, target, verdict.robots, tokens);
        return skip(moved?.note ?? done.note, { robots_check: check, subrequests, ...(moved === undefined ? {} : { final_url: moved.url }) });
      }
      const capture = await this.record(
        "capture",
        { ...base, url, status: 0, outcome: "not-html", note: done.note, elapsed_ms: done.elapsedMs, robots_check: check, subrequests },
        url,
        marks,
      );
      return { ...closedResult(url), outcome: "not-html", capture, note: done.note, ...marks };
    }
    if (done.kind === "failed" || done.kind === "cancelled") {
      const note = done.kind === "failed" ? done.note : "cancelled by the caller";
      this.emit({ type: "response", url, host, status: 0, outcome: "error", elapsedMs: done.elapsedMs });
      const capture = await this.record(
        "capture",
        { ...base, url, status: 0, outcome: "error", note, elapsed_ms: done.elapsedMs, robots_check: check, subrequests },
        url,
        marks,
      );
      return {
        url,
        status: 0,
        outcome: "error",
        fromCache: false,
        capture,
        blob: undefined,
        body: undefined,
        contentType: undefined,
        signals: NO_SIGNALS,
        note,
        ...marks,
      };
    }

    const { rendered, classified, elapsedMs } = done;
    const header = (name: string): string | undefined => rendered.headers[name.toLowerCase()];
    // the page can move to a different URL: the same rules apply to it
    let finalTarget = target;
    let finalVerdict = verdict;
    try {
      finalTarget = new URL(rendered.finalUrl);
      finalTarget.hash = "";
    } catch {
      finalTarget = target;
    }
    const finalUrl = redact(finalTarget);
    const finalPath = `${finalTarget.pathname}${finalTarget.search}`;
    if (finalTarget.href !== target.href) {
      const moved = `the page moved to ${finalUrl}`;
      if (!WEB_PROTOCOLS.has(finalTarget.protocol)) return skip(`${moved}, which is not an http(s) URL`, { final_url: finalUrl });
      const refusal = await checkEgress(this.egress, finalTarget);
      if (refusal !== undefined) return skip(`${moved}: ${refusal}`, { final_url: finalUrl });
      if (originKey(finalTarget) !== originKey(target)) {
        finalVerdict = await this.robotsFor(finalTarget, this.policyOf(finalTarget), request_);
      }
      const finalDecision = decide(finalVerdict.robots, tokens, finalPath);
      if (!finalDecision.allowed) {
        return skip(`${moved}: ${robotsRefusal(finalVerdict.robots, finalDecision.by ?? this.options.token)}`, {
          final_url: finalUrl,
          robots_check: robotsCheck(finalVerdict, tokens, finalDecision),
        });
      }
    }
    let outcome: Outcome = classified.outcome;
    let note = classified.note;
    let body: Uint8Array | undefined;
    let blob: string | undefined;
    if (outcome === "ok") {
      body = new TextEncoder().encode(rendered.html);
      try {
        blob = (await this.options.blobs.put(body)).hash;
      } catch (error) {
        outcome = "error";
        note = `blob store: ${messageOf(error)}`;
        body = undefined;
      }
    }
    const signals = readSignals(signalsFor(finalVerdict.robots, tokens, finalPath), header, metaSignals(rendered.html));
    const status = rendered.status ?? 200;
    const fetchedAt = this.clock.now();
    const freshness = freshUntil(header, status, fetchedAt, header("last-modified"), policy.heuristicFreshnessCapMs);
    this.emit({ type: "response", url, host, status, outcome, elapsedMs });
    const capture = await this.record(
      "capture",
      {
        ...base,
        url,
        final_url: finalUrl,
        status,
        outcome,
        elapsed_ms: elapsedMs,
        content_type: RENDERED_TYPE,
        bytes: body?.length ?? 0,
        blob: blob ?? null,
        robots: "allowed",
        robots_check: check,
        signals,
        subrequests,
        ...(freshness !== null ? { fresh_until: freshness } : {}),
        ...(note !== undefined ? { note } : {}),
      },
      url,
      marks,
    );
    const fetchedIso = new Date(fetchedAt).toISOString();
    if (capture !== undefined && blob !== undefined) {
      this.store({
        url,
        variant: "rendered",
        capture,
        blob,
        etag: null,
        last_modified: null,
        content_type: RENDERED_TYPE,
        fetched_at: fetchedIso,
        status,
        ai_input: signals.ai_input,
        fresh_until: freshness,
      });
    }
    return {
      url,
      status,
      outcome,
      fromCache: false,
      capture,
      blob,
      body,
      contentType: RENDERED_TYPE,
      signals,
      note,
      fetchedAt: fetchedIso,
      ...marks,
    };
  }

  /**
   * This method removes the stops and the failure counts of one host, or of each host. It also
   * forgets the robots.txt verdicts that came from an unreachable robots.txt. The pace of each host
   * stays. A process that runs for a long time uses it, for example after the network comes back.
   */
  resetHosts(host?: string): void {
    const name = host?.toLowerCase().replace(/\.$/, "");
    this.scheduler.reset(name);
    for (const key of this.robots.keys()) {
      const entry = this.robots.peek(key);
      const unreachable = entry?.value?.robots.unreachable !== undefined || entry?.value?.stale !== undefined;
      if (unreachable && (name === undefined || key.endsWith(`//${name}`))) this.robots.delete(key);
    }
  }

  /**
   * This method closes the crawler. Work in the queue ends as `skipped` with the note
   * `crawler closed`, and the crawler writes no capture after the close. Then it closes the
   * browser, the log and its own dispatcher. A second close waits for the first.
   */
  close(): Promise<void> {
    if (this.closingDone === undefined) {
      this.closed = true;
      this.closing.abort(new Error("crawler closed"));
      this.closingDone = (async () => {
        await Promise.allSettled(this.running);
        await this.options.renderer?.close();
        await this.options.log.close?.();
        if (this.ownsDispatcher) await this.dispatcher.close();
      })();
    }
    return this.closingDone;
  }
}
