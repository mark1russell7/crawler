import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { STATUS_CODES } from "node:http";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { BlobStore } from "./blobs.ts";
import { FileBlobStore } from "./blobs.ts";
import type { CaptureReader } from "./log.ts";
import { CaptureLog } from "./log.ts";
import type { CaptureRecord } from "./record.ts";
import { BOT_PAGE, VERSION } from "./version.ts";
import { TalliedFile } from "./zip.ts";

/*
 * This module writes the capture log as WARC/1.1 (ISO 28500:2017). The README tells what goes into
 * the archive and why. These are the records:
 *
 * - One `warcinfo` record names the software and the filters of the export.
 * - A capture with a body gives a `response` record. Its HTTP header block is rebuilt from the
 *   headers that the capture kept, and its payload is the stored body.
 * - A 304 gives a `revisit` record with the profile `server-not-modified`.
 * - A page that the headless browser rendered gives a `conversion` record: the page after
 *   JavaScript, not the body that the server sent.
 * - Each of them has a `metadata` record (`WARC-Concurrent-To`) with the JSON of the capture.
 *
 * Each record is one gzip member. The export reads the log as a stream and holds one body at a time.
 */

const gzipAsync = promisify(gzip);

const HOME = new URL("../", BOT_PAGE).href;
const CRLF = "\r\n";
const END = Buffer.from("\r\n\r\n", "latin1");
const KINDS: ReadonlySet<string> = new Set(["capture", "revisit", "skipped"]);
const HASH = /^[0-9a-f]{64}$/;
/** The revisit records name their original from this count of recent responses. */
const ORIGINALS = 65_536;
const SERVER_NOT_MODIFIED = "http://netpreserve.org/warc/1.1/revisit/server-not-modified";
const HTTP_RESPONSE = "application/http; msgtype=response";

/** The source of an export: the folder of a store, or the capture log and the blob store of a runtime. */
export type ArchiveSource =
  string | { readonly captures: CaptureReader; readonly blobs: BlobStore };

/** These filters select the captures of an export. Each filter that you give makes the selection smaller. */
export interface ArchiveFilter {
  /** The export holds the captures received at this time or later. */
  readonly since?: string | Date | undefined;
  /** The export holds the captures received before this time. */
  readonly until?: string | Date | undefined;
  /** The export holds the captures of this host and of its subdomains, for example `example.com`. */
  readonly host?: string | undefined;
  /** The export holds the captures whose URL starts with this text. */
  readonly urlPrefix?: string | undefined;
  /** The export holds only the captures with these ids. */
  readonly ids?: readonly string[] | undefined;
}

/** These options control an export. Only `out` is necessary. */
export interface ArchiveOptions extends ArchiveFilter {
  /** This file gets the archive. The export writes a temporary file and gives it this name at the end. */
  readonly out: string;
  /**
   * When this value is true, each capture with no body (a refusal, a skip of robots.txt, an error, a
   * redirect) gets a `metadata` record. The default is false: the export leaves them out.
   */
  readonly includeRefusals?: boolean | undefined;
  /** When this value is true, the export replaces a file that exists. The default is false: the export fails. */
  readonly overwrite?: boolean | undefined;
}

/** These counts tell what an export wrote. */
export interface ArchiveCounts {
  /** This value is the count of capture records that the filters selected. */
  readonly captures: number;
  readonly responses: number;
  readonly revisits: number;
  /** This value is the count of rendered pages (`conversion` records). */
  readonly conversions: number;
  readonly metadata: number;
  /** This value is the count of captures with no body: refusals, skips, errors and redirects. */
  readonly bodiless: number;
  /** This value is the count of captures whose body is not in the blob store, or does not agree with its hash. */
  readonly missing: number;
  /** This value is the count of damaged lines of the capture log. */
  readonly damaged: number;
}

/** This is the result of `exportWarc`. */
export interface WarcResult extends ArchiveCounts {
  readonly format: "warc";
  /** This value is the absolute path of the archive. */
  readonly out: string;
  readonly bytes: number;
}

/** These are the facts of a `response` or `revisit` record that the index of a WACZ file needs. */
export interface ArchivedRecord {
  readonly type: "response" | "revisit";
  readonly url: string;
  readonly date: string;
  readonly status: number;
  readonly mime: string;
  readonly digest: string;
  readonly offset: number;
  readonly length: number;
  readonly capture: string;
  /** This value is true for a page of the page list: a 200 response that is not a robots.txt file. */
  readonly page: boolean;
}

/** A plan is a valid filter and an open source. An export makes it before it writes a file. */
export interface ArchivePlan {
  readonly captures: CaptureReader;
  readonly blobs: BlobStore;
  readonly filter: ArchiveSelection;
  readonly includeRefusals: boolean;
}

/** This is a filter after the checks: times in ISO 8601, a lowercase host and a set of ids. */
export interface ArchiveSelection {
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  readonly host?: string | undefined;
  readonly urlPrefix?: string | undefined;
  readonly ids?: ReadonlySet<string> | undefined;
}

const RFC4648 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** This function writes bytes in base 32 (RFC 4648), with capitals and padding. WARC tools write SHA-256 digests in this form. */
export const base32 = (bytes: Uint8Array): string => {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += RFC4648[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) out += RFC4648[(value << (5 - bits)) & 31]!;
  while (out.length % 8 !== 0) out += "=";
  return out;
};

const digestOf = (bytes: Uint8Array): string => `sha256:${base32(bytes)}`;

const sha256Of = (...parts: readonly Uint8Array[]): Buffer => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

/** This function gives a version 5 UUID (RFC 9562): the SHA-1 of a namespace and a name. */
const uuidV5 = (namespace: string, name: string): string => {
  const hash = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(name, "utf8")
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The namespace of the record ids: a UUID of the URL of the site, in the URL namespace of RFC 9562. */
const NAMESPACE = uuidV5("6ba7b811-9dad-11d1-80b4-00c04fd430c8", HOME);

/** The id of a record of a capture is the same at each export: it comes from the hash of the capture. */
const recordId = (record: CaptureRecord, type: string): string =>
  `<urn:uuid:${uuidV5(NAMESPACE, `${record.content_hash || `${record.id}@${record.received_at}`}/${type}`)}>`;

/** A field of a header holds no line break. */
const clean = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

/** This function gives one record: the WARC header, the block and the two line breaks at the end. */
const recordBytes = (
  fields: ReadonlyArray<readonly [string, string]>,
  block: readonly Uint8Array[],
): Buffer => {
  const length = block.reduce((sum, part) => sum + part.length, 0);
  const head = [
    "WARC/1.1",
    ...fields.map(([name, value]) => `${name}: ${clean(value)}`),
    `Content-Length: ${String(length)}`,
    "",
    "",
  ].join(CRLF);
  return Buffer.concat([Buffer.from(head, "utf8"), ...block, END]);
};

/**
 * This function gives an HTTP status line and header block. HTTP headers are Latin-1 bytes, and
 * undici gives each byte as one character. Thus the block gives back the bytes that the server sent.
 */
const httpHead = (status: number, headers: ReadonlyArray<readonly [string, string]>): Buffer =>
  Buffer.from(
    [
      `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? "Unknown"}`,
      ...headers.map(([name, value]) => `${name}: ${clean(value)}`),
      "",
      "",
    ].join(CRLF),
    "latin1",
  );

/** These fields of a capture keep a header of the response. */
const KEPT_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["etag", "ETag"],
  ["last_modified", "Last-Modified"],
  ["cache_control", "Cache-Control"],
  ["expires", "Expires"],
  ["age", "Age"],
  ["date", "Date"],
  ["vary", "Vary"],
];

/** These are the facts of a fetch record that the export reads. */
interface Facts {
  readonly url: string;
  readonly date: string;
  readonly status: number | undefined;
  readonly blob: string | undefined;
  readonly contentType: string | undefined;
  readonly rendered: boolean;
  readonly truncated: boolean;
  readonly cut: boolean;
  readonly revisitOf: string | undefined;
  readonly recipe: string | undefined;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** This function gives the time of a capture in ISO 8601, with milliseconds. WARC/1.1 permits them. */
const isoOf = (value: unknown, fallback: string): string => {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  const other = Date.parse(fallback);
  return Number.isFinite(other) ? new Date(other).toISOString() : fallback;
};

const factsOf = (record: CaptureRecord): Facts | undefined => {
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const fields = payload as Readonly<Record<string, unknown>>;
  const url = text(fields["url"]) ?? text(record.external_id);
  if (url === undefined) return undefined;
  const blob = text(fields["blob"]);
  const status = fields["status"];
  return {
    url,
    date: isoOf(fields["fetched_at"], record.received_at),
    status: typeof status === "number" && Number.isInteger(status) ? status : undefined,
    blob: blob !== undefined && HASH.test(blob) ? blob : undefined,
    contentType: text(fields["content_type"]),
    rendered: fields["rendered"] === true,
    truncated: fields["truncated"] === true,
    cut: fields["cut"] === true,
    revisitOf: text(fields["revisit_of"]),
    recipe: text(fields["recipe"]),
    headers: KEPT_HEADERS.flatMap(([field, name]) => {
      const value = text(fields[field]);
      return value === undefined ? [] : [[name, value] as const];
    }),
  };
};

const timeOf = (name: string, value: string | Date | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) throw new RangeError(`${name} is not a time: "${String(value)}"`);
  return new Date(ms).toISOString();
};

const hostName = (value: string): string | undefined => {
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return undefined;
  }
};

const filterOf = (options: ArchiveFilter): ArchiveSelection => {
  const since = timeOf("since", options.since);
  const until = timeOf("until", options.until);
  let host: string | undefined;
  if (options.host !== undefined) {
    host = options.host.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    if (host === "" || /[/:@\s]/.test(host))
      throw new RangeError(`host is a host name, for example example.com, not "${options.host}"`);
  }
  return {
    since,
    until,
    host,
    urlPrefix: options.urlPrefix === "" ? undefined : options.urlPrefix,
    ids: options.ids === undefined ? undefined : new Set(options.ids),
  };
};

const selected = (record: CaptureRecord, facts: Facts, filter: ArchiveSelection): boolean => {
  if (filter.since !== undefined && record.received_at < filter.since) return false;
  if (filter.until !== undefined && record.received_at >= filter.until) return false;
  if (filter.urlPrefix !== undefined && !facts.url.startsWith(filter.urlPrefix)) return false;
  if (filter.ids !== undefined && !filter.ids.has(record.id)) return false;
  if (filter.host !== undefined) {
    const host = hostName(facts.url);
    if (host === undefined || (host !== filter.host && !host.endsWith(`.${filter.host}`)))
      return false;
  }
  return true;
};

/**
 * This function checks the filters and opens the source. It writes nothing. A folder must hold a
 * capture log, and the export does not make a store.
 */
export const planArchive = (source: ArchiveSource, options: ArchiveOptions): ArchivePlan => {
  const filter = filterOf(options);
  const includeRefusals = options.includeRefusals === true;
  if (typeof source !== "string") {
    return { captures: source.captures, blobs: source.blobs, filter, includeRefusals };
  }
  const dir = resolve(source);
  if (!existsSync(join(dir, "captures")))
    throw new Error(`the store ${dir} has no capture log (captures/)`);
  return {
    captures: new CaptureLog(join(dir, "captures"), { sync: false }),
    blobs: new FileBlobStore(join(dir, "blobs"), { sync: false }),
    filter,
    includeRefusals,
  };
};

/** This function gives the path of the archive and of its temporary file. It fails when the archive exists, unless `overwrite` is true. */
export const outputOf = (
  options: ArchiveOptions,
): { readonly target: string; readonly temporary: string } => {
  if (typeof options.out !== "string" || options.out.trim() === "")
    throw new Error("an export needs out: the file of the archive");
  const target = resolve(options.out);
  if (options.overwrite !== true && existsSync(target))
    throw new Error(`${target} exists: give a different file, or set overwrite`);
  return { target, temporary: `${target}.${randomUUID()}.tmp` };
};

/** This function reads a body from the blob store. It gives no body when the bytes do not agree with the hash. */
const bodyOf = async (
  blobs: BlobStore,
  hash: string,
): Promise<{ readonly bytes: Uint8Array; readonly digest: Buffer } | undefined> => {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await blobs.get(hash);
  } catch {
    return undefined;
  }
  if (bytes === undefined) return undefined;
  const digest = sha256Of(bytes);
  return digest.toString("hex") === hash ? { bytes, digest } : undefined;
};

const mimeOf = (contentType: string | undefined): string =>
  contentType?.split(";")[0]?.trim().toLowerCase() || "-";

/** This function gives the JSON of the metadata record of a capture. The labels and the scope of the application stay out. */
const metadataOf = (record: CaptureRecord, written: Readonly<Record<string, string>>): Buffer =>
  Buffer.from(
    `${JSON.stringify({
      capture: {
        id: record.id,
        source: record.source,
        kind: record.kind,
        ...(record.external_id !== undefined ? { external_id: record.external_id } : {}),
        ...(record.occurred_at !== undefined ? { occurred_at: record.occurred_at } : {}),
        received_at: record.received_at,
        content_hash: record.content_hash,
        payload: record.payload,
      },
      export: written,
    })}\n`,
    "utf8",
  );

/**
 * This function writes the records of an archive into a file: the `warcinfo` record, then the
 * records of each capture that the plan selects. It gives the facts of each `response` and
 * `revisit` record to `onRecord`, for the index of a WACZ file.
 */
export const writeArchive = async (
  plan: ArchivePlan,
  file: TalliedFile,
  filename: string,
  onRecord?: (record: ArchivedRecord) => Promise<void>,
): Promise<ArchiveCounts> => {
  const counts = {
    captures: 0,
    responses: 0,
    revisits: 0,
    conversions: 0,
    metadata: 0,
    bodiless: 0,
    missing: 0,
    damaged: 0,
  };
  const { filter } = plan;
  const put = async (
    bytes: Buffer,
  ): Promise<{ readonly offset: number; readonly length: number }> => {
    const member = await gzipAsync(bytes);
    const offset = file.size;
    await file.write(member);
    return { offset, length: member.length };
  };

  const info = `<urn:uuid:${randomUUID()}>`;
  const shown = Object.fromEntries(
    Object.entries({
      since: filter.since,
      until: filter.until,
      host: filter.host,
      url_prefix: filter.urlPrefix,
      ids: filter.ids === undefined ? undefined : filter.ids.size,
      include_refusals: plan.includeRefusals,
    }).filter(([, value]) => value !== undefined),
  );
  const fields = [
    `software: polite-crawler/${VERSION} (+${HOME})`,
    "format: WARC File Format 1.1",
    "conformsTo: https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/",
    "robots: obey",
    "description: An export of the capture log of polite-crawler. The HTTP headers of each response are rebuilt from the headers that the capture kept.",
    `polite-crawler-filter: ${JSON.stringify(shown)}`,
  ];
  await put(
    recordBytes(
      [
        ["WARC-Type", "warcinfo"],
        ["WARC-Record-ID", info],
        ["WARC-Date", new Date().toISOString()],
        ["WARC-Filename", filename],
        ["Content-Type", "application/warc-fields"],
      ],
      [Buffer.from(`${fields.join(CRLF)}${CRLF}`, "utf8")],
    ),
  );

  // a revisit names its original when the original is one of the recent responses of the export
  const originals = new Map<
    string,
    { readonly id: string; readonly date: string; readonly url: string }
  >();
  const remember = (
    capture: string,
    original: { readonly id: string; readonly date: string; readonly url: string },
  ): void => {
    originals.delete(capture);
    originals.set(capture, original);
    if (originals.size > ORIGINALS) originals.delete(originals.keys().next().value!);
  };

  const scan = plan.captures.scan(
    { source: "fetch", since: filter.since },
    { onDamaged: () => void (counts.damaged += 1) },
  );
  for await (const record of scan) {
    if (record.source !== "fetch" || !KINDS.has(record.kind)) continue;
    const facts = factsOf(record);
    if (facts === undefined || !selected(record, facts, filter)) continue;
    counts.captures += 1;
    const common: Array<readonly [string, string]> = [
      ["WARC-Date", facts.date],
      ["WARC-Target-URI", facts.url],
      ["WARC-Warcinfo-ID", info],
    ];
    const vendor: Array<readonly [string, string]> = [["WARC-Polite-Crawler-Capture", record.id]];
    let main: string | undefined;
    let written: Record<string, string> = { record: "none", reason: "no body" };

    if (record.kind === "revisit" && facts.blob !== undefined) {
      // the 304 confirmed the stored body, so the payload digest is the digest of that body
      const original = facts.revisitOf === undefined ? undefined : originals.get(facts.revisitOf);
      const head = httpHead(304, [
        ...(facts.contentType !== undefined ? [["Content-Type", facts.contentType] as const] : []),
        ...facts.headers,
      ]);
      const digest = digestOf(Buffer.from(facts.blob, "hex"));
      main = recordId(record, "revisit");
      const at = await put(
        recordBytes(
          [
            ["WARC-Type", "revisit"],
            ["WARC-Record-ID", main],
            ...common,
            ["WARC-Profile", SERVER_NOT_MODIFIED],
            ...(original !== undefined ? [["WARC-Refers-To", original.id] as const] : []),
            ["WARC-Refers-To-Target-URI", original?.url ?? facts.url],
            ...(original !== undefined ? [["WARC-Refers-To-Date", original.date] as const] : []),
            ["WARC-Payload-Digest", digest],
            ["WARC-Block-Digest", digestOf(sha256Of(head))],
            ...vendor,
            ["WARC-Polite-Crawler-Headers", "rebuilt"],
            ["Content-Type", HTTP_RESPONSE],
          ],
          [head],
        ),
      );
      counts.revisits += 1;
      written = { record: "revisit", http_headers: "rebuilt" };
      await onRecord?.({
        type: "revisit",
        url: facts.url,
        date: facts.date,
        status: 304,
        mime: "warc/revisit",
        digest,
        ...at,
        capture: record.id,
        page: false,
      });
    } else if (record.kind === "capture" && facts.blob !== undefined) {
      const body = await bodyOf(plan.blobs, facts.blob);
      if (body === undefined) {
        counts.missing += 1;
        written = { record: "none", reason: "body missing" };
      } else if (facts.rendered) {
        // the page after JavaScript is a conversion of the page, not the body that the server sent
        const digest = digestOf(body.digest);
        main = recordId(record, "conversion");
        await put(
          recordBytes(
            [
              ["WARC-Type", "conversion"],
              ["WARC-Record-ID", main],
              ...common,
              ["WARC-Payload-Digest", digest],
              ["WARC-Block-Digest", digest],
              ...vendor,
              ["Content-Type", facts.contentType ?? "text/html; charset=utf-8"],
            ],
            [body.bytes],
          ),
        );
        counts.conversions += 1;
        written = { record: "conversion", body: "rendered" };
      } else if (facts.status !== undefined && facts.status >= 100 && facts.status <= 999) {
        const head = httpHead(facts.status, [
          ...(facts.contentType !== undefined
            ? [["Content-Type", facts.contentType] as const]
            : []),
          ["Content-Length", String(body.bytes.length)],
          ...facts.headers,
        ]);
        const digest = digestOf(body.digest);
        main = recordId(record, "response");
        // a body that the crawler cut at its limit, or that ended early, says so
        const truncated = facts.cut ? "disconnect" : facts.truncated ? "length" : undefined;
        const at = await put(
          recordBytes(
            [
              ["WARC-Type", "response"],
              ["WARC-Record-ID", main],
              ...common,
              ["WARC-Payload-Digest", digest],
              ["WARC-Block-Digest", digestOf(sha256Of(head, body.bytes))],
              ...(truncated !== undefined ? [["WARC-Truncated", truncated] as const] : []),
              ...vendor,
              ["WARC-Polite-Crawler-Headers", "rebuilt"],
              ["Content-Type", HTTP_RESPONSE],
            ],
            [head, body.bytes],
          ),
        );
        counts.responses += 1;
        written = { record: "response", http_headers: "rebuilt", body: "decoded" };
        remember(record.id, { id: main, date: facts.date, url: facts.url });
        await onRecord?.({
          type: "response",
          url: facts.url,
          date: facts.date,
          status: facts.status,
          mime: mimeOf(facts.contentType),
          digest,
          ...at,
          capture: record.id,
          page: facts.status === 200 && facts.recipe !== "robots.txt",
        });
      }
    }

    if (main === undefined) {
      if (written["reason"] === "no body") counts.bodiless += 1;
      if (!plan.includeRefusals) continue;
    }
    const block = metadataOf(record, written);
    await put(
      recordBytes(
        [
          ["WARC-Type", "metadata"],
          ["WARC-Record-ID", recordId(record, "metadata")],
          ...common,
          ...(main !== undefined ? [["WARC-Concurrent-To", main] as const] : []),
          ["WARC-Block-Digest", digestOf(sha256Of(block))],
          ...vendor,
          ["Content-Type", "application/json"],
        ],
        [block],
      ),
    );
    counts.metadata += 1;
  }
  return counts;
};

/**
 * This function gives the SURT key of a URL, as `pywb` and the `surt` library make it with their
 * defaults. The host is reversed with commas and has no `www.` and no default port. The path
 * and the query are lowercase, the path has no slash at the end, and the parts of the query are
 * sorted.
 */
export const surt = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value.toLowerCase();
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\d*\./, "");
  const key = host.startsWith("[") ? host : host.split(".").reverse().join(",");
  let path = url.pathname.toLowerCase();
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const query = url.search.slice(1).toLowerCase().split("&").filter(Boolean).sort().join("&");
  return `${key}${url.port === "" ? "" : `:${url.port}`})${path}${query === "" ? "" : `?${query}`}`;
};

/** This function gives the line of a record in a CDXJ index: the SURT key, the time to the second, and JSON. */
export const cdxjLine = (record: ArchivedRecord, filename: string): string =>
  `${surt(record.url)} ${record.date.slice(0, 19).replace(/\D/g, "")} ${JSON.stringify({
    url: record.url,
    mime: record.mime,
    status: String(record.status),
    digest: record.digest,
    length: String(record.length),
    offset: String(record.offset),
    filename,
  })}`;

/**
 * This function writes the captures of a store as a WARC/1.1 file, with one gzip member for each
 * record (`.warc.gz`). It reads the capture log as a stream, so its memory does not grow with the
 * store. It writes a temporary file and gives it the name `out` at the end, so a failed export
 * leaves no part of a file.
 *
 * The source is the folder of a store, or the capture log and the blob store of a runtime
 * (`crawler.runtime`). The export only reads the store.
 */
export const exportWarc = async (
  source: ArchiveSource,
  options: ArchiveOptions,
): Promise<WarcResult> => {
  const plan = planArchive(source, options);
  const { target, temporary } = outputOf(options);
  const file = await TalliedFile.create(temporary);
  try {
    const counts = await writeArchive(plan, file, basename(target));
    const done = await file.close();
    await rename(temporary, target);
    return { format: "warc", out: target, bytes: done.size, ...counts };
  } catch (error) {
    await file.abandon();
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};
