/**
 * The download of a pinned file: a file that a client names by the SHA-256 of its bytes. The SHA-256 decides, so each source that
 * gives the same bytes is correct: a mirror, the origin, or a copy that a cache kept. Thus the download tries the mirrors first, and
 * the origin gets fewer requests. Project Gutenberg, for example, asks each automated download to use a mirror.
 *
 * Each request goes through `send` of `polite-crawler/api`, so it keeps the pace of its host. A host gets one request at a time, and
 * a 429 or an error of the server starts the backoff of the scheduler. The download does not read robots.txt: it requests files
 * that the client names, and it does not crawl.
 *
 * When no source gives the bytes, the download throws a `NoRead` with each try. A gate that needs the file shows it as no read: it
 * is not a result of the change that the gate examines. The module imports `node:fs` and `node:crypto`. Each export is beta: a
 * minor version can change it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// The entry imports the entries /api and /politeness by the name of the package, not by a path. Thus its build imports them
// and does not copy them, and its declarations give their types from those entries.
import type { Pace, Reply, Transport } from "polite-crawler/api";
import { fetchTransport, isApiError, send, statusLine } from "polite-crawler/api";
import type { Clock } from "polite-crawler/politeness";
import { HostScheduler, realClock } from "polite-crawler/politeness";

// The types of the signatures of this entry, so a client needs no second import.
export type { ApiScheduler, Exchange, Pace, Reply, Signal, Transport } from "polite-crawler/api";
export type {
  Clock,
  HostCounts,
  HostResult,
  HostStateStore,
  HostStop,
  Paced,
  PolicyOptions,
  PolitenessPolicy,
  QuotaRecord,
  QuotaStore,
  ValidatorAnswer,
  ValidatorMemo,
  ValidatorReport,
  ValidatorVerdict,
} from "polite-crawler/politeness";

/**
 * This function gives the SHA-256 of bytes in lowercase hexadecimal.
 *
 * @beta
 */
export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The sources of a pinned file: its URL, the URLs of mirrors with the same bytes, and the SHA-256 of the bytes.
 *
 * @beta
 */
export interface PinnedSource {
  /** This value is the URL of the origin. The download tries it after the mirrors. */
  readonly url: string;
  /** This value is the SHA-256 of the bytes, in lowercase hexadecimal. */
  readonly sha256: string;
  /** These URLs give the same bytes as `url`. The download tries them in this order, before `url`. */
  readonly mirrors?: readonly string[] | undefined;
}

/**
 * One try of a download: the URL and what it gave.
 *
 * @beta
 */
export interface PinnedTry {
  /** This value is the URL of the request. */
  readonly url: string;
  /** This value tells what the try gave, for example `503 Service Unavailable` or a different SHA-256. */
  readonly result: string;
}

/**
 * No source gave the pinned bytes of a file. A gate shows it as no read, not as a pass and not as a result of the change.
 *
 * @beta
 */
export class NoRead extends Error {
  /** This value is the name of the file. */
  readonly file: string;
  /** These are the tries, in order. */
  readonly tries: readonly PinnedTry[];

  constructor(file: string, tries: readonly PinnedTry[]) {
    const list = tries.map((one) => `${one.url}: ${one.result}`).join("; ");
    super(`no read: no source gave the pinned bytes of ${file}. ${list}`);
    this.name = "NoRead";
    this.file = file;
    this.tries = tries;
  }
}

/**
 * This function tells if a value is a `NoRead`.
 *
 * @beta
 */
export const isNoRead = (value: unknown): value is NoRead => value instanceof NoRead;

/**
 * The pace and the transport of the downloads of a client. One client for all the downloads of a process keeps one pace for each
 * host.
 *
 * @beta
 */
export interface PinnedClient {
  /** This pace keeps one request at a time for each host, with the backoff of the scheduler. */
  readonly pace: Pace;
  /** This transport sends each request and reads its body as bytes. */
  readonly transport: Transport;
}

/**
 * The options of `pinnedClient`.
 *
 * @beta
 */
export interface PinnedClientOptions {
  /** This value names the client and its contact, for example `example-tests/1.0 (+https://example.com/tests)`. */
  readonly userAgent: string;
  /** This value is the time limit of one request and its body, in milliseconds. The default is `PINNED_TIMEOUT_MS`. */
  readonly timeoutMs?: number | undefined;
  /** This value is the number of hosts with a request in progress at one time. The default is 2. */
  readonly maxActive?: number | undefined;
  /** This clock gives the time and the waits of the backoff. The default is the real clock. */
  readonly clock?: Clock | undefined;
}

/**
 * The default time limit of one request of a pinned file and its body: 5 minutes. A pinned file can be tens of megabytes, and a
 * mirror can be slow.
 *
 * @beta
 */
export const PINNED_TIMEOUT_MS = 300_000;

/**
 * This function makes the pace and the transport of the downloads of a client.
 *
 * @beta
 */
export function pinnedClient(options: PinnedClientOptions): PinnedClient {
  const clock = options.clock ?? realClock;
  const timeoutMs = options.timeoutMs ?? PINNED_TIMEOUT_MS;
  // The lease of a slot is longer than the time limit of a request, so a slow download keeps its slot.
  const scheduler = new HostScheduler(clock, options.maxActive ?? 2, {
    leaseMs: timeoutMs + 60_000,
  });
  return {
    pace: { scheduler, now: clock.now },
    transport: fetchTransport({ userAgent: options.userAgent, timeoutMs }),
  };
}

/**
 * The options of one download.
 *
 * @beta
 */
export interface DownloadOptions {
  /** This value is the number of requests to one source before the next source. The default is 3. */
  readonly tries?: number | undefined;
  /** This value is the number of redirects that one source can give. The default is 5. */
  readonly redirects?: number | undefined;
  /** This signal stops the download. */
  readonly signal?: AbortSignal | undefined;
}

/** A status that can change at the next request: a time-out, a request to wait, or an error of the server. */
const retryable = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500;

/** This function gives the URL of a redirect, or undefined when the answer is no redirect or goes to a scheme that is not HTTP. */
function redirectOf(reply: Reply, url: string): string | undefined {
  const location = reply.headers["location"];
  if (reply.status < 300 || reply.status >= 400 || location === undefined) return undefined;
  const next = new URL(location, url);
  return next.protocol === "https:" || next.protocol === "http:" ? next.href : undefined;
}

/**
 * This function downloads the bytes of a pinned file. It tries each mirror, then the URL. A request to wait, an error of the server
 * and a request with no answer get more tries, after the backoff of the host. A redirect is not a try. Bytes with a different
 * SHA-256 and each other status go to the next source.
 *
 * @throws `NoRead` when no source gives the bytes.
 * @beta
 */
export async function downloadPinned(
  client: PinnedClient,
  name: string,
  source: PinnedSource,
  options: DownloadOptions = {},
): Promise<Uint8Array> {
  const limit = options.tries ?? 3;
  const redirectLimit = options.redirects ?? 5;
  const tries: PinnedTry[] = [];
  for (const start of [...(source.mirrors ?? []), source.url]) {
    let url = start;
    let redirects = 0;
    let attempt = 0;
    while (attempt < limit) {
      let reply: Reply;
      try {
        ({ reply } = await send(
          client.pace,
          client.transport,
          {
            source: name,
            host: new URL(url).host,
            what: `the file ${name}`,
            exchange: { method: "GET", url, headers: {}, body: null, read: "bytes" },
          },
          options.signal,
        ));
      } catch (error) {
        if (!isApiError(error)) throw error;
        tries.push({ url, result: error.message });
        attempt += 1;
        continue;
      }
      const next = redirectOf(reply, url);
      if (next !== undefined && redirects < redirectLimit) {
        tries.push({ url, result: `${statusLine(reply)} to ${next}` });
        url = next;
        redirects += 1;
        continue;
      }
      attempt += 1;
      if (reply.status >= 200 && reply.status < 300) {
        const bytes = reply.bytes ?? new Uint8Array();
        const sha = sha256Of(bytes);
        if (sha === source.sha256) return bytes;
        tries.push({ url, result: `the SHA-256 is ${sha}, not ${source.sha256}` });
        break;
      }
      tries.push({ url, result: statusLine(reply) });
      if (!retryable(reply.status)) break;
    }
  }
  throw new NoRead(name, tries);
}

/**
 * This function gives the bytes of a pinned file in `folder`. When the folder does not have the correct bytes, it downloads them
 * and writes the file. The write goes to a temporary file first, so a stopped run leaves no part of a file.
 *
 * @throws `NoRead` when no source gives the bytes.
 * @beta
 */
export async function pinnedFile(
  client: PinnedClient,
  folder: string,
  name: string,
  source: PinnedSource,
  options?: DownloadOptions,
): Promise<Uint8Array> {
  const path = join(folder, name);
  if (existsSync(path)) {
    const kept = new Uint8Array(readFileSync(path));
    if (sha256Of(kept) === source.sha256) return kept;
  }
  const bytes = await downloadPinned(client, name, source, options);
  mkdirSync(folder, { recursive: true });
  const temporary = `${path}.${process.pid}.part`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
  return bytes;
}
