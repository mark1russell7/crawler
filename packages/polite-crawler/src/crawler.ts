import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import type { Dispatcher } from "undici";
import { Agent, request } from "undici";
import type { BlobStore } from "./blobs.ts";
import type { Outcome } from "./classify.ts";
import { STOPS_HOST, classify } from "./classify.ts";
import type { DocIndex } from "./docs.ts";
import type { CaptureLog } from "./log.ts";
import type { Renderer } from "./render.ts";
import type { Clock, Paced } from "./politeness.ts";
import { makeRecord } from "./record.ts";
import { HostScheduler, HostStopped, backoffMs, realClock } from "./politeness.ts";
import type { Robots } from "./robots.ts";
import { decide, robotsFromStatus, unreachableRobots } from "./robots.ts";
import type { Signals } from "./signals.ts";
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
 * - A maximum size for each body.
 */

export type FetchOutcome = Outcome | "skipped";

export interface FetchRequest {
  readonly url: string;
  /** The value `api` is a documented API with its own terms. The value `page` is a web page, and robots.txt applies. */
  readonly mode: "api" | "page";
  /** This recipe reads the capture again. The function `reindex` uses it to replay the capture. */
  readonly recipe: string;
  readonly accept?: string | undefined;
  /** These are more request headers. The crawler does not write them into the capture. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** These query parameters contain secrets. Each capture shows `REDACTED` in their place. */
  readonly secretParams?: readonly string[] | undefined;
  /** This value is the documented pace of the source: the shortest time between two of its requests. */
  readonly minIntervalMs?: number | undefined;
  /** A stored capture younger than this age answers, and the crawler sends no request. */
  readonly maxAgeMs?: number | undefined;
  readonly maxBytes?: number | undefined;
  /**
   * These are the product tokens of an agent that the fetch acts for, for example `Claude-User`.
   * The robots.txt rules for these tokens apply too.
   */
  readonly onBehalfOf?: readonly string[] | undefined;
  /** This name connects the captures to the job that asked for them. */
  readonly job?: string | undefined;
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
}

export interface CrawlerOptions {
  /** This product token is the name that robots.txt rules match. */
  readonly token: string;
  /** This text is the full `User-Agent` header. */
  readonly userAgent: string;
  /** This contact goes into the `From` header. Without it, the crawler sends no `From` header. */
  readonly from?: string | undefined;
  readonly log: CaptureLog;
  readonly blobs: BlobStore;
  readonly index: DocIndex;
  readonly clock?: Clock | undefined;
  readonly random?: (() => number) | undefined;
  /** This value is the number of hosts that get requests at one time. The default is 16. */
  readonly maxActive?: number | undefined;
  readonly dispatcher?: Dispatcher | undefined;
  /** This label goes into each capture record as it is. */
  readonly scope?: string | undefined;
  /** This browser renders the pages that need JavaScript. Without it, the crawler renders no page. */
  readonly renderer?: Renderer | undefined;
}

export interface RenderRequest {
  readonly url: string;
  readonly recipe: string;
  readonly maxAgeMs?: number | undefined;
  readonly onBehalfOf?: readonly string[] | undefined;
  readonly job?: string | undefined;
}

/** This key keeps the cache entry of a rendered page apart from the entry of the plain fetch. */
export const renderedKey = (url: string): string => `${url}#rendered`;

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const ERROR_BODY_BYTES = 64 * 1024;
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REDIRECTS = 5;

/** This text tells why the crawler did not fetch a page: a rule of the site, or no robots.txt to read. */
const robotsRefusal = (robots: Robots, by: string): string =>
  robots.unreachable === undefined
    ? `robots.txt disallows it for ${by}`
    : `robots.txt could not be read (${robots.unreachable}), so nothing on the site is fetched`;
/** After this number of failures in sequence, the crawler stops the host for the run. */
const MAX_FAILURES = 5;

export const redact = (url: URL, secretParams: readonly string[] = []): string => {
  const copy = new URL(url.href);
  for (const name of secretParams) {
    if (copy.searchParams.has(name)) copy.searchParams.set(name, "REDACTED");
  }
  return copy.href;
};

const headerOf =
  (headers: Readonly<Record<string, string | string[] | undefined>>) =>
  (name: string): string | undefined => {
    const value = headers[name.toLowerCase()];
    return Array.isArray(value) ? value.join(", ") : value;
  };

const readCapped = async (
  body: AsyncIterable<Uint8Array> & { destroy?: () => void },
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) {
      body.destroy?.();
      return { bytes: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(Buffer.from(chunk));
  }
  return { bytes: Buffer.concat(chunks), truncated: false };
};

const decode = (bytes: Buffer, encoding: string | undefined, maxBytes: number): Buffer => {
  const kind = (encoding ?? "").trim().toLowerCase();
  const options = { maxOutputLength: maxBytes };
  if (kind === "" || kind === "identity") return bytes;
  if (kind === "gzip" || kind === "x-gzip") return gunzipSync(bytes, options);
  if (kind === "br") return brotliDecompressSync(bytes, options);
  if (kind === "deflate") {
    try {
      return inflateSync(bytes, options);
    } catch {
      return inflateRawSync(bytes, options);
    }
  }
  throw new Error(`unsupported content-encoding "${kind}"`);
};

export class Crawler {
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly scheduler: HostScheduler;
  private readonly dispatcher: Dispatcher;
  private readonly ownsDispatcher: boolean;
  private readonly robots = new Map<string, { at: number; robots: Promise<Robots> }>();

  constructor(private readonly options: CrawlerOptions) {
    this.clock = options.clock ?? realClock;
    this.random = options.random ?? Math.random;
    this.scheduler = new HostScheduler(this.clock, options.maxActive ?? 16);
    this.ownsDispatcher = options.dispatcher === undefined;
    this.dispatcher =
      options.dispatcher ??
      new Agent({
        // past the per-host delay, or every polite request reconnects
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: 120_000,
        allowH2: true,
        connect: { timeout: 10_000 },
        headersTimeout: 30_000,
        bodyTimeout: 60_000,
      });
  }

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private async record(
    kind: "capture" | "revisit" | "skipped",
    payload: Record<string, unknown>,
    url: string,
  ): Promise<string> {
    const at = this.iso();
    const record = makeRecord({
      source: "fetch",
      kind,
      payload: { ...payload, fetched_at: at },
      received_at: at,
      occurred_at: at,
      external_id: url,
      ...(this.options.scope !== undefined ? { scope: this.options.scope } : {}),
    });
    await this.options.log.append(record);
    return record.id;
  }

  /** This method fetches a URL. It follows a maximum of five redirects, and each step is a separate decision. */
  async fetch(request_: FetchRequest): Promise<Fetched> {
    let url = new URL(request_.url);
    for (let hop = 0; ; hop += 1) {
      const result = await this.fetchOnce({ ...request_, url: url.href });
      if (result.outcome !== "redirect" || hop >= MAX_REDIRECTS) return result;
      const location = result.note?.startsWith("location ") ? result.note.slice(9) : undefined;
      if (location === undefined) return result;
      url = new URL(location, url);
    }
  }

  /**
   * This method starts one request in the queue of its host. A host can stop while a request waits,
   * or while the crawler reads its robots.txt. The crawler then skips the request, as it skips
   * each request to a stopped host. It does not throw an error.
   */
  private async paced(
    host: string,
    skipped: (note: string) => Promise<Fetched>,
    task: () => Promise<Paced<Fetched>>,
  ): Promise<Fetched> {
    try {
      return await this.scheduler.run(host, task);
    } catch (error) {
      if (error instanceof HostStopped) return skipped(`host stopped this run: ${error.reason}`);
      throw error;
    }
  }

  private async robotsFor(target: URL): Promise<Robots> {
    const cached = this.robots.get(target.origin);
    if (cached !== undefined && this.clock.now() - cached.at < ROBOTS_TTL_MS) return cached.robots;
    const robots = this.fetchRobots(new URL("/robots.txt", target.origin));
    this.robots.set(target.origin, { at: this.clock.now(), robots });
    return robots;
  }

  private async fetchRobots(robotsUrl: URL): Promise<Robots> {
    let url = robotsUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const result = await this.fetchOnce({
        url: url.href,
        mode: "api",
        recipe: "robots.txt",
        accept: "text/plain",
        maxBytes: 512 * 1024,
        minIntervalMs: 1000,
      });
      if (result.outcome === "redirect" && result.note?.startsWith("location ")) {
        url = new URL(result.note.slice(9), url);
        continue;
      }
      if (result.status === 0) return unreachableRobots(result.note ?? "no response");
      const text =
        result.body === undefined ? undefined : new TextDecoder("utf-8").decode(result.body);
      // a 304 confirms the copy kept from the last fetch, which still holds
      // (a restarted crawler asks with its ETag, and some sites answer 304)
      if (result.outcome === "not-modified" && text !== undefined)
        return robotsFromStatus(200, text);
      return robotsFromStatus(result.status, text);
    }
    return unreachableRobots(`more than ${String(MAX_REDIRECTS)} redirects`);
  }

  private async fetchOnce(request_: FetchRequest): Promise<Fetched> {
    const target = new URL(request_.url);
    const url = redact(target, request_.secretParams);
    const host = target.host;
    const maxBytes = request_.maxBytes ?? DEFAULT_MAX_BYTES;
    const base = {
      recipe: request_.recipe,
      mode: request_.mode,
      ...(request_.job ? { job: request_.job } : {}),
    };

    const latest = this.options.index.latest(url);
    if (
      request_.maxAgeMs !== undefined &&
      latest?.blob !== undefined &&
      latest.blob !== null &&
      latest.status >= 200 &&
      latest.status < 300 &&
      this.clock.now() - Date.parse(latest.fetched_at) <= request_.maxAgeMs
    ) {
      const body = await this.options.blobs.get(latest.blob);
      if (body !== undefined) {
        return {
          url,
          status: latest.status,
          outcome: "ok",
          fromCache: true,
          capture: latest.capture,
          blob: latest.blob,
          body,
          contentType: latest.content_type ?? undefined,
          signals: { ai_input: latest.ai_input ?? "unset", raw: [] },
          note: undefined,
        };
      }
    }

    const skipped = async (note: string): Promise<Fetched> => ({
      url,
      status: 0,
      outcome: "skipped",
      fromCache: false,
      capture: await this.record("skipped", { ...base, url, note }, url),
      blob: undefined,
      body: undefined,
      contentType: undefined,
      signals: NO_SIGNALS,
      note,
    });

    const stopped = this.scheduler.stoppedReason(host);
    if (stopped !== undefined) return skipped(`host stopped this run: ${stopped}`);

    let robotsLines: readonly string[] = [];
    let crawlDelayMs = 0;
    if (request_.mode === "page") {
      const robots = await this.robotsFor(target);
      const tokens =
        [this.options.token, ...(request_.onBehalfOf ?? [])];
      const decision = decide(robots, tokens, `${target.pathname}${target.search}`);
      if (!decision.allowed)
        return skipped(robotsRefusal(robots, decision.by ?? this.options.token));
      robotsLines = robots.signals;
      crawlDelayMs = Math.min(60_000, (decision.crawlDelaySeconds ?? 0) * 1000);
    }

    return this.paced(host, skipped, async () => {
      const started = this.clock.now();
      const headers: Record<string, string> = {
        "user-agent": this.options.userAgent,
        accept: request_.accept ?? "*/*",
        "accept-encoding": "gzip, deflate, br",
        ...(this.options.from !== undefined ? { from: this.options.from } : {}),
        ...(latest?.etag ? { "if-none-match": latest.etag } : {}),
        ...(latest?.last_modified ? { "if-modified-since": latest.last_modified } : {}),
        ...request_.headers,
      };
      const floorMs = Math.max(
        request_.minIntervalMs ?? (request_.mode === "page" ? 3000 : 1000),
        crawlDelayMs,
      );

      let response: Dispatcher.ResponseData;
      try {
        response = await request(target, {
          method: "GET",
          headers,
          dispatcher: this.dispatcher,
          signal: AbortSignal.timeout(90_000),
        });
      } catch (error) {
        const failures = this.scheduler.failed(host);
        if (failures >= MAX_FAILURES)
          this.scheduler.stop(host, `${String(failures)} failures in a row`);
        const note = `no response: ${error instanceof Error ? error.message : String(error)}`;
        const capture = await this.record(
          "capture",
          { ...base, url, status: 0, outcome: "error", note },
          url,
        );
        return {
          value: {
            url,
            status: 0,
            outcome: "error" as const,
            fromCache: false,
            capture,
            blob: undefined,
            body: undefined,
            contentType: undefined,
            signals: NO_SIGNALS,
            note,
          },
          delayMs: Math.max(floorMs, backoffMs(failures, 2000, 120_000, this.random)),
        };
      }

      const header = headerOf(response.headers as Record<string, string | string[] | undefined>);
      const classified = classify(response.statusCode, header, this.clock.now());
      const elapsedMs = this.clock.now() - started;
      const contentType = header("content-type");
      let blob: string | undefined;
      let body: Uint8Array | undefined;
      let note = classified.note;
      if (classified.outcome === "ok") {
        const raw = await readCapped(response.body, maxBytes);
        try {
          const decoded = decode(raw.bytes, header("content-encoding"), maxBytes);
          body = new Uint8Array(decoded);
          blob = (await this.options.blobs.put(body)).hash;
          if (raw.truncated) note = `truncated at ${String(maxBytes)} bytes`;
        } catch (error) {
          note = `undecodable body: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else {
        await readCapped(response.body, ERROR_BODY_BYTES).catch(() => undefined);
      }
      if (classified.outcome === "not-modified" && latest?.blob) {
        blob = latest.blob;
        body = await this.options.blobs.get(latest.blob);
      }
      if (classified.outcome === "redirect") {
        const location = header("location");
        if (location !== undefined) note = `location ${location}`;
      }

      const signals = readSignals(robotsLines, header);
      const etag = header("etag") ?? null;
      const lastModified = header("last-modified") ?? null;
      const capture = await this.record(
        classified.outcome === "not-modified" ? "revisit" : "capture",
        {
          ...base,
          url,
          status: response.statusCode,
          outcome: classified.outcome,
          elapsed_ms: elapsedMs,
          content_type: contentType ?? null,
          bytes: body?.length ?? 0,
          blob: blob ?? null,
          etag,
          last_modified: lastModified,
          ...(classified.outcome === "not-modified" && latest
            ? { revisit_of: latest.capture }
            : {}),
          robots: request_.mode === "page" ? "allowed" : "not-checked",
          signals,
          ...(note !== undefined ? { note } : {}),
        },
        url,
      );
      if (
        (classified.outcome === "ok" || classified.outcome === "not-modified") &&
        blob !== undefined
      ) {
        this.options.index.setLatest({
          url,
          capture,
          blob,
          etag: etag ?? latest?.etag ?? null,
          last_modified: lastModified ?? latest?.last_modified ?? null,
          content_type: contentType ?? latest?.content_type ?? null,
          fetched_at: this.iso(),
          status:
            classified.outcome === "not-modified" ? (latest?.status ?? 200) : response.statusCode,
          ai_input: signals.ai_input,
        });
      }

      let delayMs = floorMs;
      if (request_.mode === "page") delayMs = Math.max(delayMs, Math.min(30_000, 5 * elapsedMs));
      if (classified.outcome === "rate-limited" || classified.outcome === "unavailable") {
        const failures = this.scheduler.failed(host);
        delayMs = Math.max(
          delayMs,
          classified.retryAfterMs ?? backoffMs(failures, 5000, 300_000, this.random),
        );
      } else if (classified.outcome === "error") {
        const failures = this.scheduler.failed(host);
        if (failures >= MAX_FAILURES)
          this.scheduler.stop(host, `${String(failures)} failures in a row`);
        delayMs = Math.max(delayMs, backoffMs(failures, 2000, 120_000, this.random));
      } else {
        this.scheduler.succeeded(host);
      }
      if (STOPS_HOST.has(classified.outcome)) this.scheduler.stop(host, classified.outcome);

      return {
        value: {
          url,
          status: response.statusCode,
          outcome: classified.outcome,
          fromCache: false,
          capture,
          blob,
          body,
          contentType,
          signals,
          note,
        },
        delayMs,
      };
    });
  }

  /**
   * This method renders a page in the headless browser and captures what the page shows. The rules
   * of a fetch apply: robots.txt, one request at a time for each host, and a capture for each
   * decision. A render costs the site more than a fetch, so the host rests longer after one.
   */
  async render(request_: RenderRequest): Promise<Fetched> {
    const target = new URL(request_.url);
    const url = target.href;
    const host = target.host;
    const key = renderedKey(url);
    const base = {
      recipe: request_.recipe,
      mode: "page" as const,
      rendered: true,
      ...(request_.job ? { job: request_.job } : {}),
    };
    const latest = this.options.index.latest(key);
    if (
      request_.maxAgeMs !== undefined &&
      latest?.blob !== undefined &&
      latest.blob !== null &&
      this.clock.now() - Date.parse(latest.fetched_at) <= request_.maxAgeMs
    ) {
      const body = await this.options.blobs.get(latest.blob);
      if (body !== undefined) {
        return {
          url,
          status: latest.status,
          outcome: "ok",
          fromCache: true,
          capture: latest.capture,
          blob: latest.blob,
          body,
          contentType: "text/html",
          signals: { ai_input: latest.ai_input, raw: [] },
          note: undefined,
        };
      }
    }
    const skipped = async (note: string): Promise<Fetched> => ({
      url,
      status: 0,
      outcome: "skipped",
      fromCache: false,
      capture: await this.record("skipped", { ...base, url, note }, url),
      blob: undefined,
      body: undefined,
      contentType: undefined,
      signals: NO_SIGNALS,
      note,
    });
    const renderer = this.options.renderer;
    if (renderer === undefined) return skipped("no browser configured for rendering");
    const stopped = this.scheduler.stoppedReason(host);
    if (stopped !== undefined) return skipped(`host stopped this run: ${stopped}`);
    const robots = await this.robotsFor(target);
    const tokens =
      [this.options.token, ...(request_.onBehalfOf ?? [])];
    const decision = decide(robots, tokens, `${target.pathname}${target.search}`);
    if (!decision.allowed) return skipped(robotsRefusal(robots, decision.by ?? this.options.token));
    const floorMs = Math.max(5000, Math.min(60_000, (decision.crawlDelaySeconds ?? 0) * 1000));

    return this.paced(host, skipped, async () => {
      const started = this.clock.now();
      let rendered;
      try {
        rendered = await renderer.render(url, {
          userAgent: this.options.userAgent,
          timeoutMs: 20_000,
        });
      } catch (error) {
        const failures = this.scheduler.failed(host);
        if (failures >= MAX_FAILURES)
          this.scheduler.stop(host, `${String(failures)} failures in a row`);
        const firstLine =
          error instanceof Error ? (error.message.split(/\r?\n/)[0] ?? "") : String(error);
        const note = `render failed: ${firstLine}`;
        const capture = await this.record(
          "capture",
          { ...base, url, status: 0, outcome: "error", note },
          url,
        );
        return {
          value: {
            url,
            status: 0,
            outcome: "error" as const,
            fromCache: false,
            capture,
            blob: undefined,
            body: undefined,
            contentType: undefined,
            signals: NO_SIGNALS,
            note,
          },
          delayMs: Math.max(floorMs, backoffMs(failures, 5000, 120_000, this.random)),
        };
      }
      const header = (name: string): string | undefined => rendered.headers[name.toLowerCase()];
      const classified =
        rendered.status === null
          ? { outcome: "ok" as const, retryAfterMs: undefined, note: undefined }
          : classify(rendered.status, header, this.clock.now());
      const elapsedMs = this.clock.now() - started;
      let blob: string | undefined;
      let body: Uint8Array | undefined;
      if (classified.outcome === "ok") {
        body = new TextEncoder().encode(rendered.html);
        blob = (await this.options.blobs.put(body)).hash;
      }
      const signals = readSignals(robots.signals, header);
      const capture = await this.record(
        "capture",
        {
          ...base,
          url,
          final_url: rendered.finalUrl,
          status: rendered.status ?? 200,
          outcome: classified.outcome,
          elapsed_ms: elapsedMs,
          content_type: "text/html",
          bytes: body?.length ?? 0,
          blob: blob ?? null,
          robots: "allowed",
          signals,
          ...(classified.note !== undefined ? { note: classified.note } : {}),
        },
        url,
      );
      if (blob !== undefined) {
        this.options.index.setLatest({
          url: key,
          capture,
          blob,
          etag: null,
          last_modified: null,
          content_type: "text/html",
          fetched_at: this.iso(),
          status: rendered.status ?? 200,
          ai_input: signals.ai_input,
        });
        this.scheduler.succeeded(host);
      }
      if (STOPS_HOST.has(classified.outcome)) this.scheduler.stop(host, classified.outcome);
      return {
        value: {
          url,
          status: rendered.status ?? 200,
          outcome: classified.outcome,
          fromCache: false,
          capture,
          blob,
          body,
          contentType: "text/html",
          signals,
          note: classified.note,
        },
        delayMs: Math.max(floorMs, Math.min(30_000, 5 * elapsedMs)),
      };
    });
  }

  async close(): Promise<void> {
    await this.options.renderer?.close();
    await this.options.log.close();
    if (this.ownsDispatcher) await this.dispatcher.close();
  }
}
