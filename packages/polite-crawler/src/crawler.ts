import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from "node:zlib";
import type { Dispatcher } from "undici";
import { Agent, request } from "undici";
import type { BlobStore } from "./blobs.ts";
import type { Classified, Outcome } from "./classify.ts";
import { classify, isClientError, parseHttpDate } from "./classify.ts";
import type { EgressOptions } from "./egress.ts";
import { checkEgress, egressError, egressLookup, egressRefusal } from "./egress.ts";
import type {
  Clock,
  HostResult,
  HostStateStore,
  Paced,
  PolicyOptions,
  PolitenessPolicy,
} from "./politeness.ts";
import {
  DEFAULT_POLICY,
  HostScheduler,
  HostStopped,
  checkPolicy,
  equalJitterMs,
  policyFor,
  realClock,
} from "./politeness.ts";
import type { CaptureRecord } from "./record.ts";
import { makeRecord } from "./record.ts";
import type { Rendered, Renderer } from "./render.ts";
import type { Robots, RobotsDecision } from "./robots.ts";
import { decide, parseRobots, robotsFromStatus, signalsFor, unreachableRobots } from "./robots.ts";
import type { AiInput, Signals } from "./signals.ts";
import { NO_SIGNALS, readSignals } from "./signals.ts";

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
 * The egress policy (`EgressOptions`) keeps the crawler on public addresses by default. The
 * politeness policy (`PolitenessPolicy`) holds each limit, and a host can have its own values.
 * The fetch and the render do not throw an error: each problem is an outcome with a note.
 */

export type FetchOutcome = Outcome | "skipped";

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
}

/** The crawler writes each record to a capture writer. The class `CaptureLog` is one. */
export interface CaptureWriter {
  append(record: CaptureRecord): Promise<void>;
  close?(): Promise<void>;
}

/** A cache entry is the last answer for a URL: its capture, its body and its validators. */
export interface CacheEntry {
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
}

/**
 * The cache index holds the last answer for each URL. The crawler reads it before a request, and
 * it writes it after an answer. The class `DocIndex` is one. An index that keeps only the
 * necessary fields of `CacheEntry` works, and the crawler keeps the other fields in memory.
 */
export interface CacheIndex {
  latest(url: string): CacheEntry | undefined;
  setLatest(entry: CacheEntry): void;
}

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
   * This undici dispatcher sends the requests. With a dispatcher of your own, the crawler checks
   * only literal addresses. Put `egressLookup` in its connection options to check the address after DNS.
   */
  readonly dispatcher?: Dispatcher | undefined;
  /** This label goes into each capture record as it is. */
  readonly scope?: string | undefined;
  /** This browser renders the pages that need JavaScript. Without it, the crawler renders no page. */
  readonly renderer?: Renderer | undefined;
  /** This policy controls the addresses that the crawler fetches. By default, the crawler fetches only public addresses. */
  readonly egress?: EgressOptions | undefined;
  /** These values change the limits of the politeness policy, for each host or for some hosts. */
  readonly politeness?: PolicyOptions | undefined;
  /** This store keeps the pace, the counts and the stops of each host. The default keeps them in memory. */
  readonly hostState?: HostStateStore | undefined;
}

export interface RenderRequest {
  readonly url: string;
  readonly recipe: string;
  /** A stored render younger than this age answers. The value `auto` uses the freshness that the server gave. */
  readonly maxAgeMs?: number | "auto" | undefined;
  readonly onBehalfOf?: readonly string[] | undefined;
  readonly job?: string | undefined;
  /** When this signal aborts, the crawler stops the render. */
  readonly signal?: AbortSignal | undefined;
}

/** This key keeps the cache entry of a rendered page apart from the entry of the plain fetch. */
export const renderedKey = (url: string): string => `${url}#rendered`;

/** This value is the version of the payload of the records that the crawler writes. A record with no `schema` is version 1. */
export const CAPTURE_SCHEMA = 2;

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
const PRODUCT_TOKEN = /^[A-Za-z_-]+$/;
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

/**
 * This function reads a body as a stream and decodes each content coding in sequence. It counts
 * the decoded bytes and keeps at most `maxBytes`. Thus a decompression bomb stops at the
 * maximum, and a long page keeps its first part. A body that fails gives a `BodyError`.
 */
const readBody = async (
  body: Readable,
  encoding: string | undefined,
  maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> => {
  const codings = (encoding ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding.length > 0 && coding !== "identity")
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
    throw new BodyError(body.errored !== null || decoders.length === 0 ? "transport" : "decode", error);
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
  return { bytes, truncated };
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

interface RobotsEntry {
  readonly at: number;
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
  readonly floorMs: number;
  readonly elapsedMs: number;
  /** A page and a render rest longer after a slow answer. */
  readonly slow: boolean;
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
  | { readonly kind: "cancelled"; readonly elapsedMs: number }
  | { readonly kind: "closed" };

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

  constructor(private readonly options: CrawlerOptions) {
    if (!PRODUCT_TOKEN.test(options.token)) {
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

  private track<T>(work: Promise<T>): Promise<T> {
    this.running.add(work);
    void work.then(
      () => this.running.delete(work),
      () => this.running.delete(work),
    );
    return work;
  }

  private async record(
    kind: "capture" | "revisit" | "skipped",
    payload: Record<string, unknown>,
    url: string,
  ): Promise<string | undefined> {
    // a closed crawler writes nothing, so its log stays closed
    if (this.closed) return undefined;
    const at = this.iso();
    const record = makeRecord({
      source: "fetch",
      kind,
      payload: { schema: CAPTURE_SCHEMA, ...payload, fetched_at: at },
      received_at: at,
      occurred_at: at,
      external_id: url,
      ...(this.options.scope !== undefined ? { scope: this.options.scope } : {}),
    });
    await this.options.log.append(record);
    return record.id;
  }

  private async skip(
    base: Record<string, unknown>,
    url: string,
    note: string,
    extra: Record<string, unknown> = {},
  ): Promise<Fetched> {
    return {
      url,
      status: 0,
      outcome: "skipped",
      fromCache: false,
      capture: await this.record("skipped", { ...base, url, note, ...extra }, url),
      blob: undefined,
      body: undefined,
      contentType: undefined,
      signals: NO_SIGNALS,
      note,
    };
  }

  /** This method reads the cache entry of a URL, with the fields that the crawler keeps in memory. */
  private lookup(url: string): CacheEntry | undefined {
    const row = this.options.index.latest(url);
    if (row === undefined) return undefined;
    const meta = this.meta.get(url);
    if (meta === undefined || meta.entry.capture !== row.capture) return row;
    const kept = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
    return { ...meta.entry, ...kept } as CacheEntry;
  }

  private store(entry: CacheEntry, location?: string): void {
    this.options.index.setLatest(entry);
    this.meta.set(entry.url, { entry, ...(location !== undefined ? { location } : {}) });
  }

  /** This method gives the target of a stored redirect, when the crawler can follow it. */
  private followable(entry: CacheEntry, secretParams: readonly string[]): string | undefined {
    const meta = this.meta.peek(entry.url);
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
    maxAge: number | "auto" | undefined,
    sent: Readonly<Record<string, string>>,
    secretParams: readonly string[],
  ): Promise<Step | undefined> {
    if (maxAge === undefined) return undefined;
    const entry = this.lookup(url);
    if (entry === undefined || !varyMatches(entry.vary_key, sent)) return undefined;
    const now = this.clock.now();
    const fetchedAt = Date.parse(entry.fetched_at);
    if (!Number.isFinite(fetchedAt)) return undefined;
    const age = now - fetchedAt;
    const until = entry.fresh_until === undefined || entry.fresh_until === null ? Number.NaN : Date.parse(entry.fresh_until);
    const fresh = Number.isFinite(until) && until > now;
    const redirect = entry.status >= 300 && entry.status < 400;
    // an explicit age wins; `auto` uses the freshness of the server; a temporary redirect needs both
    const young =
      maxAge === "auto"
        ? fresh
        : redirect && !PERMANENT_REDIRECTS.has(entry.status)
          ? fresh && age <= maxAge
          : age <= maxAge;
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
   * A 429 or 503 waits, an error counts toward a stop, and a refusal stops the host for a time.
   */
  private settle(host: string, policy: PolitenessPolicy, step: Settle): number {
    const store = this.scheduler.store;
    const now = this.clock.now();
    let delayMs = step.floorMs;
    if (step.slow) delayMs = Math.max(delayMs, Math.min(policy.elapsedCapMs, policy.elapsedFactor * step.elapsedMs));
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
        store.stop(host, now + Math.min(asked, MAX_STOP_MS), `asked to wait ${String(Math.round(asked / 1000))} s`);
        return delayMs;
      }
      return Math.max(delayMs, asked ?? equalJitterMs(waits, policy.backoffBaseMs, policy.backoffCapMs, this.random));
    }
    if (outcome === "error") {
      if (isClientError(step.status)) {
        store.record(host, "neutral");
        return delayMs;
      }
      const { failures } = store.record(host, "failure");
      if (failures >= policy.maxFailures)
        store.stop(host, now + policy.failureStopMs, `${String(failures)} failures in a row`);
      return Math.max(delayMs, equalJitterMs(failures, policy.backoffBaseMs, policy.backoffCapMs, this.random));
    }
    if (outcome === "challenge") store.stop(host, now + policy.challengeStopMs, outcome);
    else if (outcome === "payment-required") store.stop(host, now + policy.paymentStopMs, outcome);
    else if (outcome === "blocked" && !step.robotsFile) store.stop(host, now + policy.blockedStopMs, outcome);
    store.record(host, "success");
    return delayMs;
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
      request_.url.split("#")[0],
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
  private robotsFor(target: URL, policy: PolitenessPolicy): Promise<RobotsVerdict> {
    const key = originKey(target);
    const now = this.clock.now();
    const cached = this.robots.get(key);
    if (cached !== undefined && now - cached.at < cached.ttlMs) return cached.verdict;
    const entry: RobotsEntry = {
      at: now,
      ttlMs: policy.robotsTtlMs,
      verdict: Promise.resolve({ robots: unreachableRobots("not read yet"), capture: undefined }),
      value: undefined,
      misses: cached?.misses ?? 0,
      good: cached?.good,
    };
    entry.verdict = this.fetchRobots(target, policy)
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

  /** This method reads the stored copy of a robots.txt, when it is younger than the limit of the policy. */
  private async storedRobots(target: URL, policy: PolitenessPolicy): Promise<RobotsVerdict | undefined> {
    try {
      const row = this.lookup(redact(new URL("/robots.txt", target.origin)));
      if (row === undefined || row.blob === null || row.status < 200 || row.status >= 300) return undefined;
      if (this.clock.now() - Date.parse(row.fetched_at) > policy.robotsStaleMs) return undefined;
      const body = await this.options.blobs.get(row.blob);
      if (body === undefined) return undefined;
      return { robots: parseRobots(new TextDecoder("utf-8").decode(body)), capture: row.capture };
    } catch {
      return undefined;
    }
  }

  private async fetchRobots(
    target: URL,
    policy: PolitenessPolicy,
  ): Promise<{ readonly robots: Robots; readonly capture: string | undefined; readonly retryAfterMs: number | undefined }> {
    let url = new URL("/robots.txt", target.origin);
    const unreachable = (reason: string, capture: string | undefined, retryAfterMs?: number) => ({
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
      const text = result.body === undefined ? undefined : new TextDecoder("utf-8").decode(result.body);
      if (result.outcome === "not-modified") {
        return text === undefined
          ? unreachable("status 304, and no stored copy", result.capture)
          : { robots: parseRobots(text), capture: result.capture, retryAfterMs: undefined };
      }
      return {
        robots: robotsFromStatus(result.status, text),
        capture: result.capture,
        retryAfterMs: step.retryAfterMs,
      };
    }
    return unreachable(`more than ${String(policy.maxRedirects)} redirects`, undefined);
  }

  private async fetchOnce(request_: FetchRequest, signal: AbortSignal): Promise<Step> {
    const base = {
      recipe: request_.recipe,
      mode: request_.mode,
      ...(request_.job ? { job: request_.job } : {}),
    };
    let target: URL;
    try {
      target = new URL(request_.url);
    } catch {
      return { fetched: await this.skip(base, request_.url, "not a valid URL") };
    }
    const secretParams = request_.secretParams ?? [];
    if (!WEB_PROTOCOLS.has(target.protocol))
      return { fetched: await this.skip(base, redact(target, secretParams), "not an http(s) URL") };
    // a fragment never goes to the server, so it is not part of the cache key
    target.hash = "";
    const url = redact(target, secretParams);
    const skipped = (note: string, extra?: Record<string, unknown>): Promise<Fetched> =>
      this.skip(base, url, note, extra);
    const skip = async (note: string, extra?: Record<string, unknown>): Promise<Step> => ({
      fetched: await skipped(note, extra),
    });
    const invalid =
      invalidNumber("minIntervalMs", request_.minIntervalMs, false) ??
      invalidNumber("maxBytes", request_.maxBytes, false) ??
      invalidNumber("maxAgeMs", request_.maxAgeMs, true);
    if (invalid !== undefined) return skip(invalid);
    const refused = egressRefusal(this.egress, target.hostname);
    if (refused !== undefined) return skip(refused);
    const tokens = [this.options.token, ...(request_.onBehalfOf ?? [])];
    const badToken = tokens.find((token) => !PRODUCT_TOKEN.test(token));
    if (request_.mode === "page" && badToken !== undefined)
      return skip(`not a valid product token: "${badToken}"`);
    const host = hostKey(target);
    const policy = this.policyOf(target);
    const sent = this.requestHeaders(request_);
    const path = `${target.pathname}${target.search}`;

    // the rules for an agent apply before a stored copy answers it
    let verdict: RobotsVerdict | undefined;
    if (request_.mode === "page") {
      verdict = tokens.length > 1 ? await this.robotsFor(target, policy) : this.knownRobots(target);
      if (verdict !== undefined) {
        const decision = decide(verdict.robots, tokens, path);
        if (!decision.allowed) {
          return skip(robotsRefusal(verdict.robots, decision.by ?? this.options.token), {
            robots_check: robotsCheck(verdict, tokens, decision),
          });
        }
      }
    }
    const cached = await this.fromCache(url, request_.maxAgeMs, sent, secretParams);
    if (cached !== undefined) return cached;

    const stop = this.scheduler.stopOf(host);
    if (stop !== undefined) return skip(stopNote(stop.reason, stop.until));

    let robotsLines: string[] = [];
    let crawlDelayMs = 0;
    let check: Record<string, unknown> | undefined;
    if (request_.mode === "page") {
      verdict ??= await this.robotsFor(target, policy);
      const decision = decide(verdict.robots, tokens, path);
      check = robotsCheck(verdict, tokens, decision);
      if (!decision.allowed)
        return skip(robotsRefusal(verdict.robots, decision.by ?? this.options.token), { robots_check: check });
      robotsLines = signalsFor(verdict.robots, tokens, path);
      crawlDelayMs = Math.min(policy.crawlDelayCapMs, (decision.crawlDelaySeconds ?? 0) * 1000);
    }
    if (this.closed) return { fetched: closedResult(url) };
    const floorMs = Math.max(
      request_.minIntervalMs ?? (request_.mode === "page" ? policy.pageIntervalMs : policy.apiIntervalMs),
      crawlDelayMs,
    );
    const maxBytes = request_.maxBytes ?? policy.maxBytes;
    const settleBase = {
      floorMs,
      slow: request_.mode === "page",
      robotsFile: request_.recipe === "robots.txt",
    };

    try {
      return await this.scheduler.run(
        host,
        async (): Promise<Paced<Step>> => {
          // an equal request that waited in the queue can find a fresh copy now
          const again = await this.fromCache(url, request_.maxAgeMs, sent, secretParams);
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

          let response: Dispatcher.ResponseData;
          try {
            response = await request(target, { method: "GET", headers, dispatcher: this.dispatcher, signal: abort });
          } catch (error) {
            const egress = egressError(error);
            if (egress !== undefined) return { value: { fetched: await skipped(egress.message) }, delayMs: 0 };
            if (this.closed) return { value: { fetched: closedResult(url) }, delayMs: 0 };
            const elapsedMs = this.clock.now() - started;
            const note = cancelled() ? "cancelled by the caller" : failedNote("no response", error);
            const delayMs = this.settle(host, policy, {
              ...settleBase,
              outcome: "error",
              status: 0,
              retryAfterMs: undefined,
              elapsedMs,
              ...(cancelled() ? { result: "neutral" as const } : {}),
            });
            const capture = await this.record(
              "capture",
              { ...base, url, status: 0, outcome: "error", note, elapsed_ms: elapsedMs, ...(check ? { robots_check: check } : {}) },
              url,
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
          let next: string | undefined;
          let result: HostResult | undefined;
          if (outcome === "ok") {
            try {
              const read = await readBody(response.body, header("content-encoding"), maxBytes);
              body = read.bytes;
              truncated = read.truncated;
              if (truncated) note = `truncated at ${String(maxBytes)} bytes`;
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
          if (outcome === "redirect") {
            const location = header("location");
            if (location === undefined) note = "a redirect with no Location header";
            else {
              try {
                const resolved = new URL(location, target);
                next = resolved.href;
                note = `location ${redact(resolved, secretParams)}`;
              } catch {
                outcome = "error";
                note = "bad redirect target";
              }
            }
          }

          const revisit = outcome === "not-modified" && usable !== undefined;
          let signals = readSignals(robotsLines, header);
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
          const etag = header("etag") ?? (revisit ? usable.etag : null) ?? null;
          const lastModified = header("last-modified") ?? (revisit ? usable.last_modified : null) ?? null;
          const fetchedAt = this.clock.now();
          const freshness = freshUntil(header, response.statusCode, fetchedAt, lastModified, policy.heuristicFreshnessCapMs);
          const varyKey = header("vary") !== undefined ? varyKeyOf(header("vary"), sent) : revisit ? (usable.vary_key ?? null) : null;
          const cacheHeaders = Object.fromEntries(
            ["cache-control", "expires", "age", "date", "vary"].flatMap((name) => {
              const value = header(name);
              return value === undefined ? [] : [[name.replace("-", "_"), value]];
            }),
          );
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
              ...cacheHeaders,
              ...(note !== undefined ? { note } : {}),
            },
            url,
          );
          if (capture !== undefined && (outcome === "ok" || outcome === "not-modified") && blob !== undefined) {
            this.store({
              url,
              capture,
              blob,
              // a truncated body keeps no validators, so a later request gets the whole body again
              etag: truncated ? null : etag,
              last_modified: truncated ? null : lastModified,
              content_type: contentType ?? null,
              fetched_at: new Date(fetchedAt).toISOString(),
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
                fetched_at: new Date(fetchedAt).toISOString(),
                status: response.statusCode,
                ai_input: "unset",
                location: redact(new URL(next), secretParams),
                fresh_until: freshness,
                vary_key: varyKey,
              },
              next,
            );
          }
          const delayMs = this.settle(host, policy, {
            ...settleBase,
            outcome,
            status: response.statusCode,
            retryAfterMs: classified.retryAfterMs,
            elapsedMs,
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
      if (error instanceof HostStopped) return skip(stopNote(error.reason, error.until));
      if (this.closed) return { fetched: closedResult(url) };
      if (request_.signal?.aborted === true) return skip("cancelled by the caller");
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
   * This method renders a page in the headless browser and captures what the page shows. The rules
   * of a fetch apply:
   *
   * - the egress policy and robots.txt, for the page, its final URL and each request of the page
   * - one request at a time for each host
   * - the backoff after a 429 or a 503
   * - a capture for each decision
   *
   * A render costs the site more than a fetch, so the host rests longer after one.
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
    let target: URL;
    try {
      target = new URL(request_.url);
    } catch {
      return this.skip(base, request_.url, "not a valid URL");
    }
    if (!WEB_PROTOCOLS.has(target.protocol)) return this.skip(base, redact(target), "not an http(s) URL");
    target.hash = "";
    const url = redact(target);
    const skip = (note: string, extra?: Record<string, unknown>): Promise<Fetched> =>
      this.skip(base, url, note, extra);
    const invalid = invalidNumber("maxAgeMs", request_.maxAgeMs, true);
    if (invalid !== undefined) return skip(invalid);
    const literal = egressRefusal(this.egress, target.hostname);
    if (literal !== undefined) return skip(literal);
    const tokens = [this.options.token, ...(request_.onBehalfOf ?? [])];
    const badToken = tokens.find((token) => !PRODUCT_TOKEN.test(token));
    if (badToken !== undefined) return skip(`not a valid product token: "${badToken}"`);
    const host = hostKey(target);
    const policy = this.policyOf(target);
    const path = `${target.pathname}${target.search}`;
    let verdict = tokens.length > 1 ? await this.robotsFor(target, policy) : this.knownRobots(target);
    if (verdict !== undefined) {
      const decision = decide(verdict.robots, tokens, path);
      if (!decision.allowed) {
        return skip(robotsRefusal(verdict.robots, decision.by ?? this.options.token), {
          robots_check: robotsCheck(verdict, tokens, decision),
        });
      }
    }
    const key = renderedKey(url);
    const cached = await this.fromCache(key, request_.maxAgeMs, {}, []);
    if (cached !== undefined && cached.fetched.body !== undefined) {
      return { ...cached.fetched, url, contentType: "text/html" };
    }
    const renderer = this.options.renderer;
    if (renderer === undefined) return skip("no browser configured for rendering");
    const stop = this.scheduler.stopOf(host);
    if (stop !== undefined) return skip(stopNote(stop.reason, stop.until));
    // the browser does its own DNS, so the check here resolves the name too
    const resolved = await checkEgress(this.egress, target);
    if (resolved !== undefined) return skip(resolved);
    verdict ??= await this.robotsFor(target, policy);
    const decision = decide(verdict.robots, tokens, path);
    const check = robotsCheck(verdict, tokens, decision);
    if (!decision.allowed)
      return skip(robotsRefusal(verdict.robots, decision.by ?? this.options.token), { robots_check: check });
    if (this.closed) return closedResult(url);
    const floorMs = Math.max(
      policy.renderIntervalMs,
      Math.min(policy.crawlDelayCapMs, (decision.crawlDelaySeconds ?? 0) * 1000),
    );
    const signal =
      request_.signal === undefined
        ? this.closing.signal
        : AbortSignal.any([request_.signal, this.closing.signal]);
    const tally = { allowed: 0, refused: 0, hosts: new Set<string>() };
    const allowRequest = this.allowRequestFor(target, verdict.robots, tokens, signal, tally);
    const settleBase = { floorMs, slow: true, robotsFile: false };

    let done: RenderDone;
    try {
      done = await this.scheduler.run(
        host,
        async (): Promise<Paced<RenderDone>> => {
          const started = this.clock.now();
          try {
            const rendered = await raceAbort(
              renderer.render(target.href, {
                userAgent: this.options.userAgent,
                timeoutMs: policy.renderTimeoutMs,
                ...(this.options.from !== undefined ? { headers: { from: this.options.from } } : {}),
                allowRequest,
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
              ...settleBase,
              outcome: classified.outcome,
              status: rendered.status ?? 200,
              retryAfterMs: classified.retryAfterMs,
              elapsedMs,
            });
            return { value: { kind: "rendered", rendered, classified, elapsedMs }, delayMs };
          } catch (error) {
            const elapsedMs = this.clock.now() - started;
            if (this.closed) return { value: { kind: "closed" }, delayMs: 0 };
            if (request_.signal?.aborted === true) return { value: { kind: "cancelled", elapsedMs }, delayMs: floorMs };
            const delayMs = this.settle(host, policy, {
              ...settleBase,
              outcome: "error",
              status: 0,
              retryAfterMs: undefined,
              elapsedMs,
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
    }

    if (done.kind === "closed" || this.closed) return closedResult(url);
    const subrequests = { allowed: tally.allowed, refused: tally.refused, hosts: [...tally.hosts] };
    if (done.kind === "failed" || done.kind === "cancelled") {
      const note = done.kind === "failed" ? done.note : "cancelled by the caller";
      const capture = await this.record(
        "capture",
        { ...base, url, status: 0, outcome: "error", note, elapsed_ms: done.elapsedMs, robots_check: check, subrequests },
        url,
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
        finalVerdict = await this.robotsFor(finalTarget, this.policyOf(finalTarget));
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
    const signals = readSignals(signalsFor(finalVerdict.robots, tokens, finalPath), header);
    const status = rendered.status ?? 200;
    const fetchedAt = this.clock.now();
    const capture = await this.record(
      "capture",
      {
        ...base,
        url,
        final_url: finalUrl,
        status,
        outcome,
        elapsed_ms: elapsedMs,
        content_type: "text/html",
        bytes: body?.length ?? 0,
        blob: blob ?? null,
        robots: "allowed",
        robots_check: check,
        signals,
        subrequests,
        ...(note !== undefined ? { note } : {}),
      },
      url,
    );
    if (capture !== undefined && blob !== undefined) {
      this.store({
        url: key,
        capture,
        blob,
        etag: null,
        last_modified: null,
        content_type: "text/html",
        fetched_at: new Date(fetchedAt).toISOString(),
        status,
        ai_input: signals.ai_input,
        fresh_until: freshUntil(header, status, fetchedAt, header("last-modified"), policy.heuristicFreshnessCapMs),
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
      contentType: "text/html",
      signals,
      note,
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
        await Promise.allSettled([...this.running]);
        await this.options.renderer?.close();
        await this.options.log.close?.();
        if (this.ownsDispatcher) await this.dispatcher.close();
      })();
    }
    return this.closingDone;
  }
}
