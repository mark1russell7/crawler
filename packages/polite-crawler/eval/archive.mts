/**
 * This module reads a WACZ file that `exportWacz` wrote, with no network and no store. The eval
 * replays the captures of the file, so a past run gives the same numbers again.
 *
 * - A WACZ file is a ZIP file. The WARC file is the member `archive/data.warc.gz`.
 * - A WARC file is a sequence of records, and each record is one gzip member.
 * - A `response` record holds the HTTP status line, the headers that the capture kept and the body.
 * - A `metadata` record holds the JSON of a capture. With `includeRefusals`, the export also writes
 *   one for each capture with no body. The eval reads the redirects from them.
 *
 * The reader reads only what the eval needs. It is not a general WARC or ZIP reader: it refuses a
 * Zip64 file and a compression other than store and deflate.
 */
import { readFile } from "node:fs/promises";
import { gunzipSync, inflateRawSync } from "node:zlib";

/** This is one response of the archive. The body is the stored body, with no content encoding. */
export interface ArchivedResponse {
  readonly url: string;
  /** This time (ISO 8601) is the fetch time of the capture (`WARC-Date`). */
  readonly date: string;
  readonly status: number;
  /** These headers are the headers that the capture kept, in their order in the record. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Buffer;
}

/** This is one redirect of the archive, from the `metadata` record of a capture with no body. */
export interface ArchivedRedirect {
  readonly url: string;
  readonly date: string;
  readonly status: number;
  readonly location: string;
}

/** This is the content of a WACZ file that the eval replays. */
export interface Archive {
  /** These are the responses, by `replayKey` of the URL. A later capture of a URL replaces an earlier one. */
  readonly responses: ReadonlyMap<string, ArchivedResponse>;
  /** These are the redirects, by `replayKey` of the URL. */
  readonly redirects: ReadonlyMap<string, ArchivedRedirect>;
  /** This time (milliseconds since the epoch) is the first `WARC-Date` of a response or a redirect. */
  readonly start: number;
  /** This text is the `software` of `datapackage.json`, for example `polite-crawler 0.1.2`. */
  readonly software: string | null;
}

/** One record of a WARC file: the fields of its header, with lowercase names, and its block. */
export interface WarcRecord {
  readonly fields: ReadonlyMap<string, string>;
  readonly block: Buffer;
}

const MAX32 = 0xffffffff;
const END_OF_CENTRAL = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const WARC_MEMBER = "archive/data.warc.gz";

/** This function gives the key of a URL in the replay: the origin, the path and the query. */
export const replayKey = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
};

/** This function reads the members of a ZIP file into memory, by name. */
export const readZip = (bytes: Buffer): Map<string, Buffer> => {
  let end = -1;
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= lowest; at -= 1) {
    if (bytes.readUInt32LE(at) === END_OF_CENTRAL) {
      end = at;
      break;
    }
  }
  if (end === -1)
    throw new Error("this file is not a ZIP file: it has no end of central directory");
  const count = bytes.readUInt16LE(end + 10);
  const offset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || offset === MAX32) {
    throw new Error("this ZIP file has Zip64 records: the eval reads only a small archive");
  }
  const members = new Map<string, Buffer>();
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(at) !== CENTRAL) throw new Error(`no central header at byte ${at}`);
    const method = bytes.readUInt16LE(at + 10);
    const compressed = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    if (compressed === MAX32 || local === MAX32) {
      throw new Error(`the member ${name} has Zip64 sizes: the eval reads only a small archive`);
    }
    if (bytes.readUInt32LE(local) !== LOCAL) throw new Error(`no local header for ${name}`);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + compressed);
    if (method === 0) members.set(name, data);
    else if (method === 8) members.set(name, inflateRawSync(data));
    else throw new Error(`the member ${name} has the compression method ${method}`);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return members;
};

/** This function reads the records of a WARC file. Each record of the file is one gzip member. */
export const readWarc = (gzipped: Buffer): WarcRecord[] => {
  const data = gunzipSync(gzipped);
  const records: WarcRecord[] = [];
  let at = 0;
  while (at < data.length) {
    const headEnd = data.indexOf("\r\n\r\n", at, "latin1");
    if (headEnd === -1) break;
    const lines = data.subarray(at, headEnd).toString("utf8").split("\r\n");
    if (!(lines[0] ?? "").startsWith("WARC/")) throw new Error(`no WARC record at byte ${at}`);
    const fields = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon > 0)
        fields.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    const length = Number(fields.get("content-length"));
    if (!Number.isInteger(length) || length < 0) {
      throw new Error(`the WARC record at byte ${at} has no valid Content-Length`);
    }
    const start = headEnd + 4;
    records.push({ fields, block: data.subarray(start, start + length) });
    at = start + length + 4;
  }
  return records;
};

/** This function splits the block of a `response` record into the status, the headers and the body. */
const httpOf = (
  block: Buffer,
): { status: number; headers: Array<readonly [string, string]>; body: Buffer } => {
  const split = block.indexOf("\r\n\r\n", 0, "latin1");
  if (split === -1) throw new Error("a response record has no end of the HTTP header block");
  const lines = block.subarray(0, split).toString("latin1").split("\r\n");
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(lines[0] ?? "")?.[1]);
  if (!Number.isInteger(status))
    throw new Error(`a response record has the status line "${lines[0]}"`);
  const headers = lines.slice(1).flatMap((line) => {
    const colon = line.indexOf(":");
    return colon > 0 ? [[line.slice(0, colon).trim(), line.slice(colon + 1).trim()] as const] : [];
  });
  return { status, headers, body: block.subarray(split + 4) };
};

/** This function gives the redirect of the JSON of a `metadata` record, when the capture is one. */
const redirectOf = (block: Buffer, url: string, date: string): ArchivedRedirect | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.toString("utf8"));
  } catch {
    return undefined;
  }
  const payload = (parsed as { capture?: { payload?: Record<string, unknown> } }).capture?.payload;
  const status = payload?.["status"];
  const location = payload?.["location"];
  if (typeof status !== "number" || status < 300 || status > 399) return undefined;
  if (typeof location !== "string" || location.length === 0) return undefined;
  return { url, date, status, location };
};

/** This function reads a WACZ file into memory: its responses and its redirects. */
export const readWacz = async (file: string): Promise<Archive> => {
  const members = readZip(await readFile(file));
  const warc = members.get(WARC_MEMBER);
  if (warc === undefined) throw new Error(`${file} has no ${WARC_MEMBER}: it is not a WACZ file`);
  let software: string | null = null;
  const datapackage = members.get("datapackage.json");
  if (datapackage !== undefined) {
    const parsed = JSON.parse(datapackage.toString("utf8")) as { software?: unknown };
    software = typeof parsed.software === "string" ? parsed.software : null;
  }
  const responses = new Map<string, ArchivedResponse>();
  const redirects = new Map<string, ArchivedRedirect>();
  let start = Number.POSITIVE_INFINITY;
  for (const record of readWarc(warc)) {
    const type = record.fields.get("warc-type");
    const url = record.fields.get("warc-target-uri");
    const date = record.fields.get("warc-date");
    if (url === undefined || date === undefined) continue;
    const time = Date.parse(date);
    if (type === "response") {
      const key = replayKey(url);
      const earlier = responses.get(key);
      if (earlier === undefined || earlier.date <= date) {
        responses.set(key, { url, date, ...httpOf(record.block) });
      }
      start = Math.min(start, time);
    } else if (type === "metadata" && !record.fields.has("warc-concurrent-to")) {
      const redirect = redirectOf(record.block, url, date);
      if (redirect !== undefined) {
        redirects.set(replayKey(url), redirect);
        start = Math.min(start, time);
      }
    }
  }
  if (!Number.isFinite(start)) throw new Error(`${file} has no response to replay`);
  return { responses, redirects, start, software };
};
