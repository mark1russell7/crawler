import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import type { Fetched, FetchRequest } from "./crawler.ts";
import { redact } from "./crawler.ts";
import type { Doc, ExtractedDoc } from "./docs.ts";
import type { CrawlRuntime, Extractor, Indexed, PageOptions, PageResult } from "./runtime.ts";
import { HELD_BACK, fetchAndIndex, isHeldBack, pageExtractor } from "./runtime.ts";
import { readSignals } from "./signals.ts";
import { canonicalUrl } from "./urls.ts";

/**
 * The archived fallback. When a site refuses a page, or is down, the crawler can give a copy from a
 * public web archive: the Wayback Machine, then Common Crawl. The crawler does not show the copy as a fresh fetch:
 *
 * - It is a document of its own (`archive:<url>`), of the kind `archived`. Its metadata and each
 *   result that shows it have `archived`: the archive, the date of the copy and its URL there.
 * - The result keeps the outcome of the live fetch (`blocked`, for example), and its note names the
 *   archive and the date.
 *
 * The fallback is opt-in (`fallback: "archive"`). The archives are third-party APIs with their own
 * politeness, so each request to them is a fetch of the same crawler. Their robots.txt, the pace of
 * each host, the egress policy and the identity of the crawler apply, and the capture log records
 * each request.
 *
 * By default, the crawler gives no archived copy of a page that the current robots.txt of its site
 * disallows for this agent. Only a stop, an error or a dead host gets the fallback.
 * `archiveDespiteRobots` widens it. The usage signals of the copy apply as for a live page.
 */

/** The public web archives of the fallback. */
export type WebArchive = "wayback" | "commoncrawl";

/** An archived copy: the archive, the time when the archive captured the page, and where the copy is. */
export interface Archived {
  readonly source: WebArchive;
  /** This time (ISO 8601) is when the archive captured the page. It is not the time of the fetch from the archive. */
  readonly timestamp: string;
  /** This URL is the copy in the archive: a Wayback Machine page, or the Common Crawl WARC file. */
  readonly url: string;
  /** This URL is the page that the archive captured. */
  readonly original: string;
  /** This id is the `WARC-Record-ID` of a Common Crawl copy in its WARC file. */
  readonly record?: string | undefined;
}

/** The recipe of the request for an archived copy. Its extractor reads a Wayback Machine copy or a Common Crawl WARC record. */
export const ARCHIVE_COPY_RECIPE = "archive-copy";

/** The recipe of the requests to the indexes of the archives. They give no document. */
export const ARCHIVE_INDEX_RECIPE = "archive-index";

/** The kind of the document of an archived copy. */
export const ARCHIVED_KIND = "archived";

/**
 * This function gives the document id of the archived copy of a page.
 *
 * @beta
 */
export const archivedDocId = (url: string): string => `archive:${canonicalUrl(url)}`;

/** The addresses of the archives. */
const WAYBACK_AVAILABLE = "https://archive.org/wayback/available";
const WAYBACK = "https://web.archive.org/web/";
const CC_INDEX = "https://index.commoncrawl.org/";
const CC_DATA = "https://data.commoncrawl.org/";

/** The Common Crawl indexes that the fallback asks, the newest first. */
const CC_INDEXES = 3;
/** The largest compressed WARC record that the fallback asks for. */
const MAX_RECORD_BYTES = 5 * 1024 * 1024;
/** The largest decompressed WARC record or body that the fallback reads. */
const MAX_INFLATED_BYTES = 20 * 1024 * 1024;

/** The Wayback Machine path of a raw copy: the 14 digits of the time, `id_`, and the URL of the page. */
const WAYBACK_RAW = /^\/web\/(\d{14})id_\/(https?:\/\/.+)$/s;
const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";
const JSON_ACCEPT = "application/json";

/** These are the reasons of a refusal that can get an archived copy. */
export type FallbackReason =
  | "robots"
  | "unreachable"
  | "stopped"
  | "blocked"
  | "challenge"
  | "payment-required"
  | "unavailable"
  | "error";

// The notes of the crawler that tell why it did not send a request. The tests make sure that they agree.
const ROBOTS_DISALLOW = "robots.txt disallows it";
const ROBOTS_UNREACHABLE = "robots.txt could not be read";
const HOST_STOPPED = "host stopped";

/**
 * This function tells if the result of a live fetch can get an archived copy, and why. These
 * refusals can: robots.txt, a stop of the host, a 401, a 402, a 403 and a challenge. A 502, 503 or
 * 504, a 5xx error and a dead host can too. A 404, a 429, a cancel and a refusal of the egress
 * policy cannot.
 */
export const fallbackReason = (indexed: Indexed): FallbackReason | undefined => {
  const { fetched } = indexed;
  if (indexed.blocked !== undefined) return "challenge";
  const note = fetched.note ?? "";
  switch (fetched.outcome) {
    case "skipped":
      if (note.startsWith(ROBOTS_DISALLOW)) return "robots";
      if (note.startsWith(ROBOTS_UNREACHABLE)) return "unreachable";
      if (note.startsWith(HOST_STOPPED)) return "stopped";
      return undefined;
    case "blocked":
    case "challenge":
    case "payment-required":
    case "unavailable":
      return fetched.outcome;
    case "error":
      if (fetched.status === 0 && note.startsWith("no response")) return "unreachable";
      return fetched.status >= 500 ? "error" : undefined;
    default:
      return undefined;
  }
};

/** This function gives the `archived` of the metadata of a document, when the document is an archived copy. */
export const archivedOf = (meta: Readonly<Record<string, unknown>>): Archived | undefined => {
  const value = meta["archived"];
  if (typeof value !== "object" || value === null) return undefined;
  const { source, timestamp, url, original, record } = value as Record<string, unknown>;
  if (
    (source !== "wayback" && source !== "commoncrawl") ||
    typeof timestamp !== "string" ||
    typeof url !== "string" ||
    typeof original !== "string"
  )
    return undefined;
  return { source, timestamp, url, original, ...(typeof record === "string" ? { record } : {}) };
};

const ARCHIVE_NAMES: Readonly<Record<WebArchive, string>> = {
  wayback: "the Wayback Machine",
  commoncrawl: "Common Crawl",
};

/** This function gives the note of an archived copy: the archive and the date, and that it is not a fresh fetch. */
export const archivedNote = (archived: Archived): string =>
  `an archived copy from ${ARCHIVE_NAMES[archived.source]}, captured ${archived.timestamp}, not a fresh fetch of the page`;

/** This function gives an ISO 8601 time with no milliseconds, or undefined for a time that is not valid. */
const isoSeconds = (ms: number): string | undefined =>
  Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined;

/** This function reads the 14 digits of a Wayback Machine time (`20240131235959`) as an ISO 8601 time. */
const waybackTime = (digits: string): string | undefined => {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(digits);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const iso = isoSeconds(ms);
  // a date such as 20240231 rolls over; it is not the date that the archive wrote
  return iso !== undefined && iso.replace(/\D/g, "").startsWith(digits) ? iso : undefined;
};

const httpUrlOf = (text: string): string | undefined => {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

// ── the reader of a WARC record (Common Crawl) ──

interface WarcResponse {
  readonly target: string;
  readonly date: string;
  readonly record: string | undefined;
  readonly status: number;
  readonly header: (name: string) => string | undefined;
  readonly body: Uint8Array;
}

const CRLF2 = Buffer.from("\r\n\r\n");

/** This function reads the header lines of a block as a map. A name can be in any case, and two lines of one name join with ", ". */
const headerMap = (text: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const known = out.get(name);
    out.set(name, known === undefined ? value : `${known}, ${value}`);
  }
  return out;
};

/** This function joins the chunks of a body with `Transfer-Encoding: chunked`. A body that is not in that form gives undefined. */
const dechunk = (body: Buffer): Buffer | undefined => {
  const parts: Buffer[] = [];
  let at = 0;
  let total = 0;
  for (;;) {
    const end = body.indexOf("\r\n", at);
    if (end === -1) return undefined;
    const size = Number.parseInt(
      body.subarray(at, end).toString("latin1").split(";")[0]!.trim(),
      16,
    );
    if (!Number.isFinite(size) || size < 0) return undefined;
    if (size === 0) return Buffer.concat(parts);
    const start = end + 2;
    if (start + size > body.length) return undefined;
    total += size;
    if (total > MAX_INFLATED_BYTES) return undefined;
    parts.push(body.subarray(start, start + size));
    at = start + size + 2;
  }
};

/** This function decodes the content coding of an archived body, with a limit on the output. */
const decodeCoding = (body: Buffer, coding: string | undefined): Buffer | undefined => {
  const options = { maxOutputLength: MAX_INFLATED_BYTES };
  let out = body;
  for (const name of (coding ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0 && part !== "identity")
    .reverse()) {
    if (name === "gzip" || name === "x-gzip") out = gunzipSync(out, options);
    else if (name === "br") out = brotliDecompressSync(out, options);
    else if (name === "deflate") {
      try {
        out = inflateSync(out, options);
      } catch {
        out = inflateRawSync(out, options);
      }
    } else return undefined;
  }
  return out;
};

/**
 * This function reads one WARC record of the type `response`, as Common Crawl gives it. The
 * record is a gzip member with the WARC headers, the HTTP headers and the body. It gives undefined for a different
 * record, or for bytes that do not decode. Common Crawl keeps the decoded body and renames
 * `Content-Encoding` to `X-Crawler-Content-Encoding`. A record with the original codings is decoded too.
 */
export const readWarcResponse = (bytes: Uint8Array): WarcResponse | undefined => {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return undefined;
  let record: Buffer;
  try {
    record = gunzipSync(bytes, { maxOutputLength: MAX_INFLATED_BYTES });
  } catch {
    return undefined;
  }
  if (!record.subarray(0, 8).toString("latin1").startsWith("WARC/1.")) return undefined;
  const warcEnd = record.indexOf(CRLF2);
  if (warcEnd === -1) return undefined;
  const warc = headerMap(record.subarray(0, warcEnd).toString("utf8"));
  if (warc.get("warc-type")?.toLowerCase() !== "response") return undefined;
  const target = httpUrlOf(warc.get("warc-target-uri")?.replace(/^<|>$/g, "") ?? "");
  const date = isoSeconds(Date.parse(warc.get("warc-date") ?? ""));
  if (target === undefined || date === undefined) return undefined;
  const length = Number(warc.get("content-length") ?? Number.NaN);
  const start = warcEnd + 4;
  const block = record.subarray(
    start,
    Number.isInteger(length) && length >= 0
      ? Math.min(record.length, start + length)
      : record.length,
  );
  const httpEnd = block.indexOf(CRLF2);
  if (httpEnd === -1) return undefined;
  const head = block.subarray(0, httpEnd).toString("latin1");
  const statusLine = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head);
  if (statusLine === null) return undefined;
  const headers = headerMap(head.slice(head.indexOf("\n") + 1));
  let body: Buffer | undefined = block.subarray(httpEnd + 4);
  try {
    if (/\bchunked\b/i.test(headers.get("transfer-encoding") ?? "")) body = dechunk(body);
    if (body !== undefined) body = decodeCoding(body, headers.get("content-encoding"));
  } catch {
    body = undefined;
  }
  if (body === undefined) return undefined;
  return {
    target,
    date,
    record: warc.get("warc-record-id")?.replace(/^<|>$/g, ""),
    status: Number(statusLine[1]),
    header: (name) => headers.get(name.toLowerCase()),
    body: new Uint8Array(body),
  };
};

// ── the extractor of the recipe `archive-copy` ──

/** This function changes the documents of an archived body into the documents of the copy. A bot check is not the content, so it gives no document. */
const asArchived = (
  docs: ReadonlyArray<ExtractedDoc>,
  archived: Archived,
  aiInput: "no" | undefined,
): ExtractedDoc[] =>
  docs
    .filter((doc) => typeof doc.meta["blocked"] !== "string" || doc.meta["blocked"] === "")
    .map((doc) => ({
      ...doc,
      doc: archivedDocId(archived.original),
      kind: ARCHIVED_KIND,
      url: archived.url,
      meta: { ...doc.meta, archived_kind: doc.kind, archived },
      ...(aiInput === "no" ? { ai_input: "no" as const } : {}),
    }));

/**
 * This extractor reads the captures of the recipe `archive-copy`. It has no side effects, so
 * `reindex` replays them. It reads two forms:
 *
 * - A Wayback Machine copy in the raw form (`/web/<time>id_/<url>`). The body is the body of the page.
 * - A Common Crawl WARC record (a gzip member). It reads the HTTP headers and the body from the record.
 *
 * It reads the body with the page reader, and gives a document of the kind `archived` with
 * `archived` in its metadata. The usage signals of the HTTP headers in a WARC record apply too.
 *
 * @beta
 */
export const archiveExtractor: Extractor = async (body, capture) => {
  let url: URL;
  try {
    url = new URL(capture.url);
  } catch {
    return [];
  }
  const raw = WAYBACK_RAW.exec(`${url.pathname}${url.search}`);
  if (raw !== null) {
    const timestamp = waybackTime(raw[1]!);
    const original = httpUrlOf(raw[2]!);
    if (timestamp === undefined || original === undefined) return [];
    const archived: Archived = {
      source: "wayback",
      timestamp,
      url: `${url.origin}/web/${raw[1]!}/${original}`,
      original,
    };
    return asArchived(
      await pageExtractor(body, { url: original, contentType: capture.contentType }),
      archived,
      undefined,
    );
  }
  const response = readWarcResponse(body);
  if (response === undefined || response.status < 200 || response.status >= 300) return [];
  const archived: Archived = {
    source: "commoncrawl",
    timestamp: response.date,
    url: capture.url,
    original: response.target,
    ...(response.record === undefined ? {} : { record: response.record }),
  };
  const signals = readSignals([], response.header);
  return asArchived(
    await pageExtractor(response.body, {
      url: response.target,
      contentType: response.header("content-type") ?? null,
    }),
    archived,
    signals.ai_input === "no" ? "no" : undefined,
  );
};

// ── the fallback ──

/** The result of `archivedCopy`. */
export interface ArchiveAnswer {
  /** This document is the archived copy, when an archive had one. */
  readonly doc?: Doc | undefined;
  readonly archived?: Archived | undefined;
  /** This value is true when the store answered, with no request. */
  readonly fromCache: boolean;
  /** These notes tell what each archive answered, and why no copy came. */
  readonly notes: readonly string[];
}

/** The parts of each request to an archive: the identity of the request, its budget and its labels. */
const common = (
  options: PageOptions,
): Pick<
  FetchRequest,
  "maxAgeMs" | "onBehalfOf" | "job" | "signal" | "scope" | "labels" | "deadline"
> => ({
  maxAgeMs: options.maxAgeMs,
  onBehalfOf: options.onBehalfOf,
  job: options.job,
  signal: options.signal,
  scope: options.scope,
  labels: options.labels,
  deadline: options.deadline,
});

const got = (fetched: Fetched): boolean =>
  (fetched.outcome === "ok" || fetched.outcome === "not-modified") && fetched.body !== undefined;

const said = (fetched: Fetched): string =>
  `${fetched.outcome}${fetched.status > 0 ? ` ${String(fetched.status)}` : ""}${fetched.note === undefined ? "" : `: ${fetched.note}`}`;

const jsonOf = (fetched: Fetched): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(fetched.body)) as unknown;
  } catch {
    return undefined;
  }
};

/** This function gives the archived document of a fetch of a copy, or a note that tells why there is none. */
const copyOf = (
  indexed: Indexed,
  name: string,
): { readonly doc: Doc; readonly archived: Archived } | { readonly note: string } => {
  const doc = indexed.docs.find((one) => one.kind === ARCHIVED_KIND);
  const archived = doc === undefined ? undefined : archivedOf(doc.meta);
  if (doc !== undefined && archived !== undefined) return { doc, archived };
  if (!got(indexed.fetched))
    return { note: `${name}: the copy did not come (${said(indexed.fetched)})` };
  return {
    note: `${name}: the copy gave no text${indexed.error === undefined ? " (a bot check or an empty page)" : ` (${indexed.error})`}`,
  };
};

/** This function asks the Wayback Machine for its newest copy of a page, and fetches the raw copy. */
const fromWayback = async (
  runtime: CrawlRuntime,
  url: string,
  signalLines: readonly string[],
  options: PageOptions,
): Promise<
  | { readonly doc: Doc; readonly archived: Archived; readonly fromCache: boolean }
  | { readonly note: string }
> => {
  const name = ARCHIVE_NAMES.wayback;
  const lookup = await runtime.crawler.fetch({
    url: `${WAYBACK_AVAILABLE}?url=${encodeURIComponent(url)}`,
    mode: "page",
    recipe: ARCHIVE_INDEX_RECIPE,
    accept: JSON_ACCEPT,
    ...common(options),
  });
  if (!got(lookup)) return { note: `${name}: the index did not answer (${said(lookup)})` };
  const closest = (
    jsonOf(lookup) as { archived_snapshots?: { closest?: Record<string, unknown> } } | undefined
  )?.archived_snapshots?.closest;
  if (closest === undefined || closest["available"] === false) return { note: `${name}: no copy` };
  const status = closest["status"];
  if (status !== undefined && status !== "200")
    return {
      note: `${name}: the newest copy has the status ${JSON.stringify(status) ?? "unknown"}, not 200`,
    };
  const digits = typeof closest["timestamp"] === "string" ? closest["timestamp"] : "";
  const shown = typeof closest["url"] === "string" ? closest["url"] : "";
  const original = httpUrlOf(/\/web\/\d{14}[a-z_]*\/(.+)$/s.exec(shown)?.[1] ?? "");
  if (waybackTime(digits) === undefined || original === undefined)
    return { note: `${name}: the index gave no usable time or URL` };
  const copy = await fetchAndIndex(runtime, {
    url: `${WAYBACK}${digits}id_/${original}`,
    mode: "page",
    recipe: ARCHIVE_COPY_RECIPE,
    accept: HTML_ACCEPT,
    originalHeaderPrefix: "x-archive-orig-",
    signalLines,
    ...common(options),
  });
  const found = copyOf(copy, name);
  return "note" in found
    ? found
    : { ...found, fromCache: lookup.fromCache && copy.fetched.fromCache };
};

interface CdxEntry {
  readonly timestamp: string;
  readonly filename: string;
  readonly offset: number;
  readonly length: number;
}

/** This function reads the JSON lines of a Common Crawl index answer, and gives the newest copy with the status 200. */
const newestOf = (fetched: Fetched): CdxEntry | undefined => {
  const text = new TextDecoder().decode(fetched.body);
  let best: CdxEntry | undefined;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const { timestamp, filename, status } = row;
    const offset = Number(row["offset"]);
    const length = Number(row["length"]);
    // the file name comes from a third party: only a path of the crawl data, on the host of the data
    if (
      status !== "200" ||
      typeof timestamp !== "string" ||
      !/^\d{14}$/.test(timestamp) ||
      typeof filename !== "string" ||
      !/^crawl-data\/[\w\-./]+\.warc\.gz$/.test(filename) ||
      filename.includes("..") ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > MAX_RECORD_BYTES
    )
      continue;
    if (best === undefined || timestamp > best.timestamp)
      best = { timestamp, filename, offset, length };
  }
  return best;
};

/** This function asks the newest Common Crawl indexes for a page, and fetches its WARC record with a range request. */
const fromCommonCrawl = async (
  runtime: CrawlRuntime,
  url: string,
  signalLines: readonly string[],
  options: PageOptions,
): Promise<
  | { readonly doc: Doc; readonly archived: Archived; readonly fromCache: boolean }
  | { readonly note: string }
> => {
  const name = ARCHIVE_NAMES.commoncrawl;
  const info = await runtime.crawler.fetch({
    url: `${CC_INDEX}collinfo.json`,
    mode: "page",
    recipe: ARCHIVE_INDEX_RECIPE,
    accept: JSON_ACCEPT,
    ...common(options),
  });
  if (!got(info)) return { note: `${name}: the list of indexes did not come (${said(info)})` };
  const listed = jsonOf(info);
  const apis = (Array.isArray(listed) ? listed : [])
    .map((entry: unknown) =>
      typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>)["cdx-api"]
        : undefined,
    )
    .filter((api): api is string => typeof api === "string" && api.startsWith(CC_INDEX))
    .slice(0, CC_INDEXES);
  if (apis.length === 0) return { note: `${name}: the list of indexes is empty` };
  let entry: CdxEntry | undefined;
  let fromCache = info.fromCache;
  const misses: string[] = [];
  for (const api of apis) {
    const query = await runtime.crawler.fetch({
      url: `${api}?url=${encodeURIComponent(url)}&output=json`,
      mode: "page",
      recipe: ARCHIVE_INDEX_RECIPE,
      accept: JSON_ACCEPT,
      ...common(options),
    });
    fromCache &&= query.fromCache;
    if (got(query)) entry = newestOf(query);
    else if (query.outcome !== "not-found") misses.push(said(query));
    if (entry !== undefined) break;
    if (query.outcome === "skipped") break;
  }
  if (entry === undefined)
    return {
      note: `${name}: no copy in the ${String(apis.length)} newest indexes${misses.length > 0 ? ` (${misses.join("; ")})` : ""}`,
    };
  const copy = await fetchAndIndex(runtime, {
    url: `${CC_DATA}${entry.filename}`,
    mode: "page",
    recipe: ARCHIVE_COPY_RECIPE,
    accept: "*/*",
    range: { offset: entry.offset, length: entry.length },
    signalLines,
    ...common(options),
  });
  if (got(copy.fetched) && copy.fetched.status !== 206)
    return {
      note: `${name}: the server sent the status ${String(copy.fetched.status)}, not the part of the file`,
    };
  const found = copyOf(copy, name);
  return "note" in found ? found : { ...found, fromCache: false };
};

/**
 * This function gives an archived copy of a page after a refusal. It applies the rule for
 * robots.txt first: with no `archiveDespiteRobots`, a page that the current robots.txt of its site
 * disallows gets no copy. A stored copy younger than `maxAgeMs` answers with no request. Then it asks
 * the Wayback Machine, then Common Crawl, each one with polite fetches of the crawler.
 */
export const archivedCopy = async (
  runtime: CrawlRuntime,
  url: string,
  reason: FallbackReason,
  options: PageOptions,
): Promise<ArchiveAnswer> => {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { fromCache: false, notes: [] };
  }
  target.hash = "";
  // an archive is a third party: a URL with a password or a token does not go to it
  if (redact(target) !== target.href)
    return {
      fromCache: false,
      notes: ["the URL holds a secret, so the crawler does not send it to a web archive"],
    };
  const despite = options.archiveDespiteRobots === true;
  const refused =
    "the current robots.txt of the site disallows the page for this agent, so the crawler gives no archived copy (archiveDespiteRobots permits one)";
  if (reason === "robots" && !despite) return { fromCache: false, notes: [refused] };
  // the rules now: a stop does not tell them, and the content signals of the site apply to the copy
  let rules: Awaited<ReturnType<CrawlRuntime["crawler"]["robotsAllow"]>>;
  try {
    rules = await runtime.crawler.robotsAllow(target.href, {
      onBehalfOf: options.onBehalfOf,
      scope: options.scope,
      labels: options.labels,
      signal: options.signal,
    });
  } catch {
    // a cancel during the check: the result of the live fetch stays, with no copy
    return { fromCache: false, notes: ["the fallback stopped before it read robots.txt"] };
  }
  if (!rules.allowed && (rules.note ?? "").startsWith(ROBOTS_DISALLOW) && !despite)
    return { fromCache: false, notes: [refused] };
  const signalLines = rules.signals ?? [];
  // the store answers first, as for a live page
  const known = runtime.index.get(archivedDocId(target.href));
  const archivedKnown = known === undefined ? undefined : archivedOf(known.meta);
  if (
    known !== undefined &&
    archivedKnown !== undefined &&
    typeof options.maxAgeMs === "number" &&
    Date.parse(runtime.now()) - Date.parse(known.fetched_at) < options.maxAgeMs
  )
    return { doc: known, archived: archivedKnown, fromCache: true, notes: [] };
  const notes: string[] = [];
  for (const ask of [fromWayback, fromCommonCrawl]) {
    if (options.signal?.aborted === true) break;
    const answer = await ask(runtime, target.href, signalLines, options);
    if ("note" in answer) notes.push(answer.note);
    else return { doc: answer.doc, archived: answer.archived, fromCache: answer.fromCache, notes };
  }
  return { fromCache: false, notes: [`no archived copy: ${notes.join("; ")}`] };
};

/**
 * This function gives the result of a page after a refusal, with an archived copy when an archive
 * had one. The result keeps the outcome and the status of the live fetch. It gives undefined when
 * the refusal gets no copy, and `notes` tell why.
 */
export const archivedPage = async (
  runtime: CrawlRuntime,
  url: string,
  live: Indexed,
  options: PageOptions,
): Promise<{ readonly page?: PageResult | undefined; readonly notes: readonly string[] }> => {
  const reason = fallbackReason(live);
  if (reason === undefined) return { notes: [] };
  const answer = await archivedCopy(runtime, url, reason, options);
  if (answer.doc === undefined || answer.archived === undefined) return { notes: answer.notes };
  const doc = runtime.index.get(answer.doc.doc) ?? answer.doc;
  const archived = archivedOf(doc.meta) ?? answer.archived;
  const held = isHeldBack(doc);
  const types = doc.meta["jsonld_types"];
  const links = doc.meta["links"];
  const note = [
    live.fetched.note,
    live.error,
    ...answer.notes,
    archivedNote(archived),
    ...(held ? [HELD_BACK] : []),
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return {
    page: {
      url,
      doc: doc.doc,
      outcome: live.fetched.outcome,
      status: live.fetched.status,
      title: held ? null : doc.title,
      chars: doc.text.length,
      rendered: false,
      structured: Array.isArray(types) ? (types as string[]) : [],
      links: Array.isArray(links) ? links.length : 0,
      captures: [...doc.captures],
      capture: doc.capture,
      capture_count: doc.capture_count,
      fetched_at: doc.fetched_at,
      from_cache: answer.fromCache,
      held_back: held,
      archived,
      note: note.join("; "),
    },
    notes: [],
  };
};
