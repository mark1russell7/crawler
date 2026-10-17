import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { MockAgent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileBlobStore } from "./blobs.ts";
import { CaptureLog } from "./log.ts";
import { openCrawler } from "./open.ts";
import type { CaptureRecord } from "./record.ts";
import { makeRecord, sha256, stableStringify } from "./record.ts";
import { LineSorter } from "./sorter.ts";
import { fakeClock } from "./test-helpers.ts";
import { childEnv, removeDir, runCli, tempDir } from "./test-surfaces.ts";
import { VERSION } from "./version.ts";
import type { WaczResult } from "./wacz.ts";
import { exportWacz } from "./wacz.ts";
import type { ArchiveOptions, WarcResult } from "./warc.ts";
import { base32, exportWarc, surt } from "./warc.ts";
import { crc32, memberOf, tableCrc32, writeZip } from "./zip.ts";

// When POLITE_CRAWLER_ARCHIVE_OUT names a folder, the tests copy their archives into it. The CI
// step "Validate the WARC and WACZ exports" then gives them to warcio, py-wacz and zipfile.
const SAMPLES = process.env["POLITE_CRAWLER_ARCHIVE_OUT"];
const SLOW = 60_000;
const MAX32 = 0xffffffff;

// ---- the readers of the test: gzip members, WARC records and ZIP files ----

interface Member {
  readonly offset: number;
  readonly length: number;
  readonly data: Buffer;
}

/** The members of a gzip file, one at a time, with the offset and the length of each. */
const membersOf = (file: Buffer): Member[] => {
  const members: Member[] = [];
  let at = 0;
  while (at < file.length) {
    assert.deepEqual([...file.subarray(at, at + 4)], [0x1f, 0x8b, 8, 0], "a plain gzip header");
    const { buffer, engine } = zlib.inflateRawSync(file.subarray(at + 10), {
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const end = at + 10 + engine.bytesWritten + 8;
    assert.equal(file.readUInt32LE(end - 8), zlib.crc32(buffer), "the CRC of the member");
    assert.equal(file.readUInt32LE(end - 4), buffer.length, "the size of the member");
    members.push({ offset: at, length: end - at, data: buffer });
    at = end;
  }
  return members;
};

interface Record_ {
  readonly fields: ReadonlyMap<string, string>;
  readonly block: Buffer;
  readonly member: Member;
}

/** One WARC record: exactly one in each gzip member, with two line breaks at its end. */
const recordOf = (member: Member): Record_ => {
  const data = member.data;
  const headEnd = data.indexOf("\r\n\r\n");
  const lines = data.subarray(0, headEnd).toString("utf8").split("\r\n");
  assert.equal(lines[0], "WARC/1.1");
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).toLowerCase();
    assert.equal(fields.has(name), false, `one ${name}`);
    fields.set(name, line.slice(colon + 1).trim());
  }
  const length = Number(fields.get("content-length"));
  const block = data.subarray(headEnd + 4, headEnd + 4 + length);
  assert.equal(data.subarray(headEnd + 4 + length).toString("latin1"), "\r\n\r\n");
  return { fields, block, member };
};

const recordsOf = async (path: string): Promise<Record_[]> =>
  membersOf(await readFile(path)).map(recordOf);

const field = (record: Record_, name: string): string => {
  const value = record.fields.get(name.toLowerCase());
  assert.notEqual(value, undefined, `the field ${name}`);
  return value!;
};

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A base-32 decoder of RFC 4648 that the test writes itself, to check the encoder of the export. */
const fromBase32 = (text: string): Buffer => {
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const char of text.replace(/=+$/, "")) {
    value = (value << 5) | B32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

/** This function tells if a digest field is the SHA-256 of the bytes. */
const digests = (value: string, bytes: Uint8Array): boolean =>
  value.startsWith("sha256:") &&
  value.length === 7 + 56 &&
  fromBase32(value.slice(7)).equals(createHash("sha256").update(bytes).digest());

/** The payload of an HTTP block: the bytes after the header block. */
const payloadOf = (block: Buffer): Buffer => block.subarray(block.indexOf("\r\n\r\n") + 4);

interface Entry {
  readonly method: number;
  readonly data: Buffer;
  readonly zip64: boolean;
}

/** The members of a ZIP file, read from the central directory, with Zip64 and the CRC checked. */
const readZip = (zip: Buffer): Map<string, Entry> => {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let count = zip.readUInt16LE(eocd + 10);
  let size = zip.readUInt32LE(eocd + 12);
  let start = zip.readUInt32LE(eocd + 16);
  let directoryEnd = eocd;
  if (count === 0xffff || size === MAX32 || start === MAX32) {
    assert.equal(zip.readUInt32LE(eocd - 20), 0x07064b50, "the Zip64 locator");
    const record = Number(zip.readBigUInt64LE(eocd - 12));
    assert.equal(zip.readUInt32LE(record), 0x06064b50, "the Zip64 end record");
    count = Number(zip.readBigUInt64LE(record + 32));
    size = Number(zip.readBigUInt64LE(record + 40));
    start = Number(zip.readBigUInt64LE(record + 48));
    directoryEnd = record;
  }
  assert.equal(start + size, directoryEnd, "the central directory ends at the end records");
  const entries = new Map<string, Entry>();
  let at = start;
  for (let n = 0; n < count; n += 1) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    let compressed = zip.readUInt32LE(at + 20);
    let plain = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    let offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const extra = zip.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    let zip64 = false;
    for (let e = 0; e < extra.length; e += 4 + extra.readUInt16LE(e + 2)) {
      if (extra.readUInt16LE(e) !== 1) continue;
      zip64 = true;
      let p = e + 4;
      const next = (): number => {
        const value = Number(extra.readBigUInt64LE(p));
        p += 8;
        return value;
      };
      if (plain === MAX32) plain = next();
      if (compressed === MAX32) compressed = next();
      if (offset === MAX32) offset = next();
    }
    assert.equal(zip.readUInt32LE(offset), 0x04034b50, "a local header");
    assert.equal(zip.readUInt32LE(offset + 14), crc, "the local header holds the CRC");
    const dataStart = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const stored = zip.subarray(dataStart, dataStart + compressed);
    const data = method === 8 ? zlib.inflateRawSync(stored) : Buffer.from(stored);
    assert.equal(data.length, plain, `the size of ${name}`);
    assert.equal(zlib.crc32(data), crc, `the CRC of ${name}`);
    entries.set(name, { method, data, zip64 });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

// ---- a store with real captures of a mock site, and some records that the test writes ----

const minimalPdf = (line: string): Buffer => {
  const stream = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
};

const SITE = "https://site.example";
const HOME_PAGE = `<!doctype html><html lang="en"><head><title>Home</title></head><body><p>${"Words on the home page. ".repeat(30)}</p></body></html>`;
const PDF = minimalPdf("A paper about archives");
const JSON_BODY = '{"items":["warc","wacz"]}';
const RENDERED = "<!doctype html><html><body><p>Text that JavaScript wrote.</p></body></html>";
const LAST_MODIFIED = "Mon, 05 Oct 2026 10:00:00 GMT";

interface Built {
  readonly dir: string;
  /** The capture ids, by name. */
  readonly ids: Readonly<Record<string, string>>;
  /** The time between the first crawl and the 304. */
  readonly middle: string;
}

const buildStore = async (dir: string): Promise<Built> => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get(SITE)
    .intercept({ path: () => true, method: "GET" })
    .reply((request) => {
      const headers = (request.headers ?? {}) as Record<string, string>;
      const reply = (
        statusCode: number,
        data: string | Buffer,
        replyHeaders: Record<string, string>,
      ) => ({ statusCode, data, responseOptions: { headers: replyHeaders } });
      switch (request.path) {
        case "/robots.txt":
          return reply(200, "User-agent: *\nDisallow: /private/\n", {
            "content-type": "text/plain",
          });
        case "/":
          return headers["if-none-match"] === '"v1"'
            ? reply(304, "", { etag: '"v1"', "cache-control": "max-age=60" })
            : reply(200, HOME_PAGE, {
                "content-type": "text/html; charset=utf-8",
                etag: '"v1"',
                "last-modified": LAST_MODIFIED,
                "cache-control": "max-age=60",
              });
        case "/paper.pdf":
          return reply(200, PDF, { "content-type": "application/pdf" });
        case "/data.json":
          return reply(200, JSON_BODY, { "content-type": "application/json" });
        case "/big":
          return reply(200, "x".repeat(1000), { "content-type": "text/plain" });
        default:
          return reply(404, "not here", { "content-type": "text/plain" });
      }
    })
    .persist();
  const clock = fakeClock("2026-10-07T12:00:00Z");
  const crawler = openCrawler({ dir, renderer: false, dispatcher: agent, clock });
  const ids: Record<string, string> = {};
  let middle: string;
  try {
    ids["home"] = (await crawler.fetch(`${SITE}/`)).capture!;
    ids["pdf"] = (
      await crawler.fetch(`${SITE}/paper.pdf`, {
        scope: "private-scope",
        labels: { lineage: "secret-lineage" },
      })
    ).capture!;
    ids["json"] = (await crawler.runtime.crawler.fetch({
      url: `${SITE}/data.json`,
      mode: "api",
      recipe: "data",
      accept: "application/json",
    }))!.capture!;
    ids["big"] = (await crawler.runtime.crawler.fetch({
      url: `${SITE}/big`,
      mode: "page",
      recipe: "page",
      maxBytes: 100,
    }))!.capture!;
    const refused = await crawler.fetch(`${SITE}/private/secret`);
    assert.equal(refused.outcome, "skipped", "robots.txt refuses the private page");
    clock.advance(60 * 60 * 1000);
    middle = new Date(clock.now()).toISOString();
    clock.advance(60 * 1000);
    ids["revisit"] = (await crawler.fetch(`${SITE}/`, { maxAge: 0 })).capture!;
  } finally {
    await crawler.close();
    await agent.close();
  }

  // records that a crawl with no browser cannot make: a rendered page, a lost body, and others
  const log = new CaptureLog(join(dir, "captures"), { sync: false });
  const blobs = new FileBlobStore(join(dir, "blobs"), { sync: false });
  const rendered = (await blobs.put(new TextEncoder().encode(RENDERED))).hash;
  const at = "2026-10-07T14:00:00.000Z";
  const fetch = (kind: string, payload: Record<string, unknown>): CaptureRecord =>
    makeRecord({
      source: "fetch",
      kind,
      payload: { schema: 2, recipe: "page", mode: "page", fetched_at: at, ...payload },
      received_at: at,
      occurred_at: at,
      external_id: payload["url"] as string,
    });
  const app = fetch("capture", {
    url: `${SITE}/app`,
    rendered: true,
    final_url: `${SITE}/app`,
    status: 200,
    outcome: "ok",
    content_type: "text/html; charset=utf-8",
    blob: rendered,
  });
  const lost = fetch("capture", {
    url: `${SITE}/lost`,
    status: 200,
    outcome: "ok",
    content_type: "text/html",
    blob: "0".repeat(64),
  });
  const override = makeRecord({
    source: "fetch",
    kind: "override",
    payload: { doc: "url:x", url: null, action: "read", reason: "test", at },
    received_at: at,
  });
  const other = makeRecord({
    source: "app",
    kind: "note",
    payload: { url: `${SITE}/note` },
    received_at: at,
  });
  for (const record of [app, lost, override, other]) await log.append(record);
  await log.close();
  ids["app"] = app.id;
  ids["lost"] = lost.id;
  return { dir, ids, middle };
};

let work: string;
let built: Built;
let warc: WarcResult;
let warcAll: WarcResult;
let wacz: WaczResult;
let records: Record_[];
let recordsAll: Record_[];

beforeAll(async () => {
  work = await tempDir("archive");
  built = await buildStore(join(work, "store"));
  warc = await exportWarc(built.dir, { out: join(work, "store.warc.gz") });
  warcAll = await exportWarc(built.dir, {
    out: join(work, "store-all.warc.gz"),
    includeRefusals: true,
  });
  wacz = await exportWacz(built.dir, { out: join(work, "store.wacz") });
  records = await recordsOf(warc.out);
  recordsAll = await recordsOf(warcAll.out);
  if (SAMPLES !== undefined) {
    await mkdir(SAMPLES, { recursive: true });
    for (const path of [warc.out, warcAll.out, wacz.out])
      await copyFile(path, join(SAMPLES, path.slice(work.length + 1)));
    await writeZip(
      join(SAMPLES, "zip64.zip"),
      [
        memberOf("deflated.txt", Buffer.from("Zip64 records on a small file. ".repeat(100))),
        memberOf("stored.bin", Buffer.from([0, 1, 2, 3, 255]), 0),
      ],
      { date: new Date("2026-10-17T12:00:00Z"), zip64: "always" },
    );
  }
}, SLOW);

afterAll(async () => {
  await removeDir(work);
});

const byType = (list: readonly Record_[], type: string): Record_[] =>
  list.filter((record) => field(record, "WARC-Type") === type);

const byUrl = (list: readonly Record_[], type: string, url: string): Record_ => {
  const found = byType(list, type).filter((record) => field(record, "WARC-Target-URI") === url);
  assert.equal(found.length, 1, `one ${type} record of ${url}`);
  return found[0]!;
};

describe("the WARC export", () => {
  it("writes a warcinfo record first, then the records of each capture with a body", () => {
    expect(field(records[0]!, "WARC-Type")).toBe("warcinfo");
    expect(field(records[0]!, "Content-Type")).toBe("application/warc-fields");
    expect(field(records[0]!, "WARC-Filename")).toBe("store.warc.gz");
    const info = records[0]!.block.toString("utf8");
    expect(info).toContain(
      `software: polite-crawler/${VERSION} (+https://mark1russell7.github.io/crawler/)`,
    );
    expect(info).toContain("format: WARC File Format 1.1");
    expect(byType(records, "warcinfo")).toHaveLength(1);
    expect(byType(records, "response").map((record) => field(record, "WARC-Target-URI"))).toEqual([
      `${SITE}/robots.txt`,
      `${SITE}/`,
      `${SITE}/paper.pdf`,
      `${SITE}/data.json`,
      `${SITE}/big`,
    ]);
    expect(byType(records, "revisit")).toHaveLength(1);
    expect(byType(records, "conversion")).toHaveLength(1);
    expect(byType(records, "metadata")).toHaveLength(7);
    expect(byType(records, "request")).toHaveLength(0);
    expect(records).toHaveLength(1 + 5 + 1 + 1 + 7);
    expect(warc).toMatchObject({
      format: "warc",
      captures: 9,
      responses: 5,
      revisits: 1,
      conversions: 1,
      metadata: 7,
      bodiless: 1,
      missing: 1,
      damaged: 0,
    });
    // the members cover the whole file, one record in each
    expect(records.reduce((sum, record) => sum + record.member.length, 0)).toBe(warc.bytes);
  });

  it("gives each record a WARC-Record-ID, a date, the warcinfo id and a block digest that verifies", () => {
    const info = field(records[0]!, "WARC-Record-ID");
    const ids = new Set<string>();
    for (const record of records) {
      const id = field(record, "WARC-Record-ID");
      expect(id).toMatch(
        /^<urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}>$/,
      );
      ids.add(id);
      expect(field(record, "WARC-Date")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    expect(ids.size).toBe(records.length);
    for (const record of records.slice(1)) {
      expect(field(record, "WARC-Warcinfo-ID")).toBe(info);
      expect(digests(field(record, "WARC-Block-Digest"), record.block)).toBe(true);
    }
  });

  it("holds the stored body in each response, with a payload digest that verifies", async () => {
    const blobs = new FileBlobStore(join(built.dir, "blobs"));
    const bodies: Readonly<Record<string, Uint8Array>> = {
      "/": new TextEncoder().encode(HOME_PAGE),
      "/paper.pdf": PDF,
      "/data.json": new TextEncoder().encode(JSON_BODY),
      "/big": new TextEncoder().encode("x".repeat(100)),
    };
    for (const [path, body] of Object.entries(bodies)) {
      const record = byUrl(records, "response", `${SITE}${path}`);
      const payload = payloadOf(record.block);
      expect(payload.equals(Buffer.from(body)), path).toBe(true);
      expect(digests(field(record, "WARC-Payload-Digest"), payload), path).toBe(true);
      const hash = createHash("sha256").update(body).digest("hex");
      expect(Buffer.from((await blobs.get(hash))!).equals(payload), path).toBe(true);
    }
  });

  it("rebuilds the HTTP header block from the headers that the capture kept, and says so", () => {
    const home = byUrl(records, "response", `${SITE}/`);
    expect(field(home, "Content-Type")).toBe("application/http; msgtype=response");
    expect(field(home, "WARC-Polite-Crawler-Headers")).toBe("rebuilt");
    expect(field(home, "WARC-Polite-Crawler-Capture")).toBe(built.ids["home"]);
    const head = home.block.subarray(0, home.block.indexOf("\r\n\r\n")).toString("latin1");
    expect(head.split("\r\n")).toEqual([
      "HTTP/1.1 200 OK",
      "Content-Type: text/html; charset=utf-8",
      `Content-Length: ${String(Buffer.byteLength(HOME_PAGE))}`,
      'ETag: "v1"',
      `Last-Modified: ${LAST_MODIFIED}`,
      "Cache-Control: max-age=60",
    ]);
    expect(home.fields.has("warc-truncated")).toBe(false);
    expect(home.fields.has("warc-ip-address")).toBe(false);
    // the crawler kept only the first 100 bytes of this body
    expect(field(byUrl(records, "response", `${SITE}/big`), "WARC-Truncated")).toBe("length");
  });

  it("writes the 304 as a revisit that names its original", () => {
    const home = byUrl(records, "response", `${SITE}/`);
    const revisit = byUrl(records, "revisit", `${SITE}/`);
    expect(field(revisit, "WARC-Profile")).toBe(
      "http://netpreserve.org/warc/1.1/revisit/server-not-modified",
    );
    expect(field(revisit, "WARC-Refers-To")).toBe(field(home, "WARC-Record-ID"));
    expect(field(revisit, "WARC-Refers-To-Date")).toBe(field(home, "WARC-Date"));
    expect(field(revisit, "WARC-Refers-To-Target-URI")).toBe(`${SITE}/`);
    expect(field(revisit, "WARC-Payload-Digest")).toBe(field(home, "WARC-Payload-Digest"));
    expect(field(revisit, "WARC-Polite-Crawler-Capture")).toBe(built.ids["revisit"]);
    expect(field(revisit, "WARC-Date") > field(home, "WARC-Date")).toBe(true);
    const head = revisit.block.toString("latin1");
    expect(head.startsWith("HTTP/1.1 304 Not Modified\r\n")).toBe(true);
    expect(head.endsWith("\r\n\r\n")).toBe(true);
    expect(head).toContain('ETag: "v1"');
  });

  it("writes a rendered page as a conversion record with the page after JavaScript", () => {
    const app = byUrl(records, "conversion", `${SITE}/app`);
    expect(app.block.toString("utf8")).toBe(RENDERED);
    expect(field(app, "Content-Type")).toBe("text/html; charset=utf-8");
    expect(digests(field(app, "WARC-Payload-Digest"), app.block)).toBe(true);
    expect(field(app, "WARC-Polite-Crawler-Capture")).toBe(built.ids["app"]);
  });

  it("keeps the facts of each capture in a metadata record, and its id checks against its hash", () => {
    const mains = new Map(
      records
        .filter((record) =>
          ["response", "revisit", "conversion"].includes(field(record, "WARC-Type")),
        )
        .map((record) => [field(record, "WARC-Record-ID"), record]),
    );
    const metadata = byType(records, "metadata");
    for (const record of metadata) {
      expect(field(record, "Content-Type")).toBe("application/json");
      const main = mains.get(field(record, "WARC-Concurrent-To"));
      expect(main).toBeDefined();
      expect(field(record, "WARC-Target-URI")).toBe(field(main!, "WARC-Target-URI"));
      const json = JSON.parse(record.block.toString("utf8")) as {
        capture: CaptureRecord;
        export: Record<string, string>;
      };
      const { capture } = json;
      const hash = sha256(
        stableStringify({
          source: capture.source,
          kind: capture.kind,
          external_id: capture.external_id ?? null,
          payload: capture.payload,
        }),
      );
      expect(capture.content_hash).toBe(hash);
      expect(capture.id).toBe(`${capture.source}.${hash.slice(0, 12)}`);
      expect(capture.id).toBe(field(record, "WARC-Polite-Crawler-Capture"));
      expect(json.export["record"]).toBe(field(main!, "WARC-Type"));
      expect(capture).not.toHaveProperty("labels");
      expect(capture).not.toHaveProperty("scope");
    }
    const home = metadata.find(
      (record) => field(record, "WARC-Polite-Crawler-Capture") === built.ids["home"],
    )!;
    const payload = (
      JSON.parse(home.block.toString("utf8")) as { capture: { payload: Record<string, unknown> } }
    ).capture.payload;
    expect(payload).toMatchObject({ outcome: "ok", robots: "allowed", status: 200 });
    expect(payload["robots_check"]).toMatchObject({ tokens: ["PoliteCrawler"] });
    expect(payload["signals"]).toMatchObject({ ai_input: "unset" });
  });

  it("leaves out the labels and the scope of the application", async () => {
    const text = zlib.gunzipSync(await readFile(warcAll.out)).toString("latin1");
    expect(text).not.toContain("secret-lineage");
    expect(text).not.toContain("private-scope");
  });

  it("writes the captures with no body only as metadata, and only with includeRefusals", () => {
    const urls = (list: readonly Record_[]): string[] =>
      list.map((record) => field(record, "WARC-Target-URI"));
    expect(urls(records.slice(1))).not.toContain(`${SITE}/private/secret`);
    expect(urls(records.slice(1))).not.toContain(`${SITE}/lost`);
    expect(warcAll).toMatchObject({ captures: 9, metadata: 9, bodiless: 1, missing: 1 });
    const refused = byUrl(recordsAll, "metadata", `${SITE}/private/secret`);
    expect(refused.fields.has("warc-concurrent-to")).toBe(false);
    const json = JSON.parse(refused.block.toString("utf8")) as {
      capture: CaptureRecord & { payload: Record<string, unknown> };
      export: Record<string, string>;
    };
    expect(json.capture.id).toMatch(/^fetch\.[0-9a-f]{12}$/);
    expect(json.capture.kind).toBe("skipped");
    expect(json.capture.payload["note"]).toMatch(/robots\.txt/);
    expect(json.export).toEqual({ record: "none", reason: "no body" });
    const lost = JSON.parse(
      byUrl(recordsAll, "metadata", `${SITE}/lost`).block.toString("utf8"),
    ) as {
      export: Record<string, string>;
    };
    expect(lost.export).toEqual({ record: "none", reason: "body missing" });
    // the records of the other kinds and the other sources are not part of an export
    expect(urls(recordsAll.slice(1))).not.toContain(`${SITE}/note`);
  });

  it("gives the same record ids at each export, except the warcinfo record", () => {
    const ids = (list: readonly Record_[]): string[] =>
      list.slice(1).map((record) => field(record, "WARC-Record-ID"));
    const shared = new Set(ids(recordsAll));
    expect(ids(records).every((id) => shared.has(id))).toBe(true);
    expect(field(records[0]!, "WARC-Record-ID")).not.toBe(field(recordsAll[0]!, "WARC-Record-ID"));
  });

  it("selects the captures by time, host, URL prefix and id", async () => {
    const run = async (name: string, filter: Omit<ArchiveOptions, "out">): Promise<WarcResult> =>
      exportWarc(built.dir, { ...filter, out: join(work, `${name}.warc.gz`) });
    const before = await run("until", { until: built.middle });
    expect(before).toMatchObject({ captures: 6, responses: 5, revisits: 0 });
    const after = await run("since", { since: new Date(built.middle) });
    expect(after).toMatchObject({ captures: 3, responses: 0, revisits: 1, conversions: 1 });
    expect(await run("host", { host: "SITE.example." })).toMatchObject({ captures: 9 });
    expect(await run("subdomain", { host: "example" })).toMatchObject({ captures: 9 });
    expect(await run("other", { host: "other.example" })).toMatchObject({
      captures: 0,
      metadata: 0,
    });
    expect(await run("prefix", { urlPrefix: `${SITE}/paper` })).toMatchObject({
      captures: 1,
      responses: 1,
    });
    const one = await run("ids", { ids: [built.ids["json"]!, built.ids["revisit"]!] });
    expect(one).toMatchObject({ captures: 2, responses: 1, revisits: 1 });
    // a revisit whose original is not in the export still names the URL of the original
    const revisit = byUrl(await recordsOf(one.out), "revisit", `${SITE}/`);
    expect(revisit.fields.has("warc-refers-to")).toBe(false);
    expect(field(revisit, "WARC-Refers-To-Target-URI")).toBe(`${SITE}/`);
    await expect(run("bad-time", { since: "yesterday" })).rejects.toThrow(
      'since is not a time: "yesterday"',
    );
    await expect(run("bad-host", { host: "https://site.example" })).rejects.toThrow(
      /host is a host name/,
    );
    expect(existsSync(join(work, "bad-time.warc.gz"))).toBe(false);
  });

  it("does not replace a file unless told, and leaves no file after an error", async () => {
    await expect(exportWarc(built.dir, { out: warc.out })).rejects.toThrow(/exists/);
    const again = await exportWarc(built.dir, { out: warc.out, overwrite: true });
    expect(again.responses).toBe(5);
    const empty = join(work, "empty-store");
    await mkdir(empty);
    await expect(exportWacz(empty, { out: join(empty, "x.wacz") })).rejects.toThrow(
      /has no capture log/,
    );
    expect(await readdir(empty)).toEqual([]);
    // the temporary files of the exports above are gone
    expect((await readdir(work)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("exports from the runtime of an open crawler too", async () => {
    const crawler = openCrawler({ dir: built.dir, renderer: false });
    try {
      const result = await exportWarc(crawler.runtime, { out: join(work, "runtime.warc.gz") });
      expect(result).toMatchObject({ captures: 9, responses: 5, revisits: 1, metadata: 7 });
    } finally {
      await crawler.close();
    }
  });
});

describe("the WACZ export", () => {
  let entries: Map<string, Entry>;
  beforeAll(async () => {
    entries = readZip(await readFile(wacz.out));
  });

  it("holds the five parts, with the WARC file stored and the others deflated", () => {
    expect([...entries.keys()]).toEqual([
      "archive/data.warc.gz",
      "indexes/index.cdxj",
      "pages/pages.jsonl",
      "datapackage.json",
      "datapackage-digest.json",
    ]);
    expect([...entries.values()].map((entry) => entry.method)).toEqual([0, 8, 8, 8, 8]);
    expect([...entries.values()].some((entry) => entry.zip64)).toBe(false);
    expect(wacz).toMatchObject({ format: "wacz", responses: 5, revisits: 1, pages: 4 });
  });

  it("lists each part in datapackage.json with its SHA-256, and the digest file names the package", () => {
    const hex = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
    const datapackage = JSON.parse(entries.get("datapackage.json")!.data.toString("utf8")) as {
      profile: string;
      wacz_version: string;
      software: string;
      created: string;
      resources: Array<{ name: string; path: string; hash: string; bytes: number }>;
    };
    expect(datapackage).toMatchObject({
      profile: "data-package",
      wacz_version: "1.1.1",
      software: `polite-crawler ${VERSION}`,
    });
    expect(datapackage.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(datapackage.resources.map((resource) => resource.path)).toEqual([
      "archive/data.warc.gz",
      "indexes/index.cdxj",
      "pages/pages.jsonl",
    ]);
    for (const resource of datapackage.resources) {
      const data = entries.get(resource.path)!.data;
      expect(resource.hash).toBe(`sha256:${hex(data)}`);
      expect(resource.bytes).toBe(data.length);
      expect(resource.name).toBe(resource.path.split("/")[1]);
    }
    expect(JSON.parse(entries.get("datapackage-digest.json")!.data.toString("utf8"))).toEqual({
      path: "datapackage.json",
      hash: `sha256:${hex(entries.get("datapackage.json")!.data)}`,
    });
  });

  it("holds the same WARC records as the WARC export", () => {
    const inner = membersOf(entries.get("archive/data.warc.gz")!.data).map(recordOf);
    const types = (list: readonly Record_[]): string[] =>
      list.map((record) => field(record, "WARC-Type"));
    expect(types(inner)).toEqual(types(records));
    expect(field(inner[0]!, "WARC-Filename")).toBe("data.warc.gz");
    expect(inner.slice(1).map((record) => field(record, "WARC-Record-ID"))).toEqual(
      records.slice(1).map((record) => field(record, "WARC-Record-ID")),
    );
  });

  it("writes a sorted CDXJ index whose offsets point at the gzip member of each record", () => {
    const archive = entries.get("archive/data.warc.gz")!.data;
    const lines = entries.get("indexes/index.cdxj")!.data.toString("utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(6);
    const sorted = [...lines].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    expect(lines).toEqual(sorted);
    for (const line of lines) {
      const [key, timestamp, ...rest] = line.split(" ");
      const json = JSON.parse(rest.join(" ")) as Record<string, string>;
      expect(key).toBe(surt(json["url"]!));
      expect(json["filename"]).toBe("data.warc.gz");
      const offset = Number(json["offset"]);
      const length = Number(json["length"]);
      const members = membersOf(archive.subarray(offset, offset + length));
      expect(members).toHaveLength(1);
      const record = recordOf(members[0]!);
      expect(field(record, "WARC-Target-URI")).toBe(json["url"]);
      expect(field(record, "WARC-Date").slice(0, 19).replace(/\D/g, "")).toBe(timestamp);
      expect(field(record, "WARC-Payload-Digest")).toBe(json["digest"]);
      const type = field(record, "WARC-Type");
      expect(json["mime"]).toMatch(
        type === "revisit" ? /^warc\/revisit$/ : /^(text|application)\/[a-z]+$/,
      );
      expect(json["status"]).toBe(type === "revisit" ? "304" : "200");
    }
    expect(lines.map((line) => line.split(" ")[0])).toContain("example,site)/paper.pdf");
  });

  it("lists one page for each document, at its latest capture", () => {
    const [header, ...pages] = entries
      .get("pages/pages.jsonl")!
      .data.toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, string>);
    expect(header).toEqual({ format: "json-pages-1.0", id: "pages", title: "All Pages" });
    expect(pages.map((page) => page["url"]).sort()).toEqual(
      [`${SITE}/`, `${SITE}/big`, `${SITE}/data.json`, `${SITE}/paper.pdf`].sort(),
    );
    for (const page of pages) {
      expect(page["id"]).toMatch(/^fetch\.[0-9a-f]{12}$/);
      expect(page["ts"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

describe("the parts of the export", () => {
  it("writes base 32 as RFC 4648 gives it", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["", ""],
      ["f", "MY======"],
      ["fo", "MZXQ===="],
      ["foo", "MZXW6==="],
      ["foob", "MZXW6YQ="],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI======"],
    ];
    for (const [plain, encoded] of cases) expect(base32(Buffer.from(plain))).toBe(encoded);
    const digest = createHash("sha256").update("abc").digest();
    expect(base32(digest)).toHaveLength(56);
    expect(fromBase32(base32(digest)).equals(digest)).toBe(true);
  });

  it("makes the SURT keys of pywb", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["https://www.Example.com/", "com,example)/"],
      ["http://example.com/A/B/?b=2&a=1#top", "com,example)/a/b?a=1&b=2"],
      ["https://www2.example.co.uk:8443/x", "uk,co,example:8443)/x"],
      ["http://127.0.0.1:4820/p?", "1,0,0,127:4820)/p"],
      ["https://[::1]/", "[::1])/"],
    ];
    for (const [url, key] of cases) expect(surt(url), url).toBe(key);
  });

  it("calculates the same CRC-32 with the table as zlib does", () => {
    const bytes = createHash("sha512").update("crc").digest();
    expect(tableCrc32(bytes)).toBe(zlib.crc32(bytes));
    expect(tableCrc32(bytes.subarray(10), tableCrc32(bytes.subarray(0, 10)))).toBe(
      zlib.crc32(bytes),
    );
    expect(crc32(bytes)).toBe(zlib.crc32(bytes));
    expect(tableCrc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("writes the Zip64 records when told, and a reader finds the same members", async () => {
    const dir = await tempDir("zip64");
    try {
      const text = Buffer.from("Zip64 records on a small file. ".repeat(100));
      const members = [
        memberOf("deflated.txt", text),
        memberOf("stored.bin", Buffer.from([0, 1, 2]), 0),
      ];
      const date = new Date("2026-10-17T12:00:00Z");
      const plainSize = await writeZip(join(dir, "plain.zip"), members, { date });
      const bigSize = await writeZip(join(dir, "zip64.zip"), members, { date, zip64: "always" });
      expect(bigSize).toBeGreaterThan(plainSize);
      for (const [name, wide] of [
        ["plain.zip", false],
        ["zip64.zip", true],
      ] as const) {
        const read = readZip(await readFile(join(dir, name)));
        expect([...read.keys()], name).toEqual(["deflated.txt", "stored.bin"]);
        expect(read.get("deflated.txt")!.data.equals(text), name).toBe(true);
        expect(
          [...read.values()].map((entry) => entry.zip64),
          name,
        ).toEqual([wide, wide]);
      }
      await expect(writeZip(join(dir, "plain.zip"), members, { date })).rejects.toThrow(/EEXIST/);
      await expect(
        writeZip(join(dir, "short.zip"), [{ ...members[0]!, compressedSize: 1 }], { date }),
      ).rejects.toThrow(/has \d+ bytes, not 1/);
    } finally {
      await removeDir(dir);
    }
  });

  it("sorts more lines than its memory limit through files on the disk", async () => {
    const dir = await tempDir("sorter");
    try {
      const sorter = new LineSorter(join(dir, "runs"), 4096);
      const lines = Array.from({ length: 3000 }, (_, at) =>
        createHash("sha1")
          .update(String(at))
          .digest("hex")
          .slice(0, 8 + (at % 7)),
      );
      for (const line of lines) await sorter.add(line);
      const out: string[] = [];
      for await (const line of sorter.sorted()) out.push(line.toString("utf8"));
      expect(sorter.files).toBeGreaterThan(10);
      expect(out).toEqual([...lines].sort());
      await expect(sorter.add("two\nlines")).rejects.toThrow(/line break/);
    } finally {
      await removeDir(dir);
    }
  });
});

describe("the command line: export", () => {
  it(
    "writes a WARC or a WACZ file, and checks its command line before it reads the store",
    async () => {
      const out = join(work, "cli");
      await mkdir(out);
      const [warcRun, waczRun, json] = await Promise.all([
        runCli(["export", "--dir", built.dir, "--out", join(out, "a.warc.gz")]),
        runCli(["export", "--dir", built.dir, "--out", join(out, "b.wacz"), "--include-refusals"]),
        runCli([
          "export",
          "--dir",
          built.dir,
          "--format",
          "warc",
          "--out",
          join(out, "c.archive"),
          "--prefix",
          `${SITE}/paper`,
          "--json",
        ]),
      ]);
      expect(warcRun.code, warcRun.stderr).toBe(0);
      expect(warcRun.stdout).toContain(`wrote ${join(out, "a.warc.gz")}`);
      expect(warcRun.stdout).toContain("9 captures: 5 responses, 1 revisits, 1 rendered pages");
      expect(warcRun.stdout).toContain("1 captures with no body (add --include-refusals");
      expect(waczRun.code, waczRun.stderr).toBe(0);
      expect(waczRun.stdout).toContain("9 metadata records, 4 pages");
      expect(json.code, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({ format: "warc", captures: 1, responses: 1 });
      expect(readZip(await readFile(join(out, "b.wacz"))).size).toBe(5);

      const exists = await runCli(["export", "--dir", built.dir, "--out", join(out, "a.warc.gz")]);
      expect(exists.code).toBe(1);
      expect(exists.stderr).toContain("exists");

      const never = join(work, "never");
      const cases: ReadonlyArray<readonly [readonly string[], string]> = [
        [["export"], "export wants --out <file>"],
        [["export", "--out", "x.zip"], "export wants --format warc or wacz"],
        [["export", "--out", "x.wacz", "--format", "arc"], '--format is warc or wacz, not "arc"'],
        [
          ["export", "--out", "x.wacz", "--since", "soon"],
          '--since wants a time, such as 2026-10-01, not "soon"',
        ],
        [["export", "--out", "x.wacz", "--host", "http://x"], "--host wants a host name"],
        [["export", "now", "--out", "x.wacz"], "export takes no argument"],
        [["find", "x", "--out", "x.wacz"], "--out is an option of export"],
      ];
      const results = await Promise.all(
        cases.map(([args]) => runCli([...args, "--dir", never], { cwd: work, env: childEnv() })),
      );
      results.forEach((result, at) => {
        const [args, message] = cases[at]!;
        expect(result.code, args.join(" ")).toBe(2);
        expect(result.stderr, args.join(" ")).toContain(message);
      });
      expect(existsSync(never)).toBe(false);
      expect(existsSync(join(work, "x.wacz"))).toBe(false);
      const missing = await runCli(["export", "--dir", never, "--out", join(out, "d.wacz")]);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("has no capture log");
      expect(existsSync(never)).toBe(false);
    },
    SLOW,
  );
});

// This test exports 2,000 captures and measures the memory of the process. Other processes change
// the numbers on a shared computer, so it runs only in CI.
describe.runIf(process.env["CI"] !== undefined)("the memory of an export", () => {
  it("stays flat for 2,000 captures of 512 KiB, far below the size of the bodies", async () => {
    const dir = await tempDir("archive-memory");
    try {
      const log = new CaptureLog(join(dir, "captures"), { sync: false });
      const blobs = new FileBlobStore(join(dir, "blobs"), { sync: false });
      const BODY = 512 * 1024;
      const hashes: string[] = [];
      for (let at = 0; at < 16; at += 1) {
        const text = `<p>Body ${String(at)} of the memory test.</p>\n`;
        hashes.push(
          (await blobs.put(Buffer.from(text.repeat(Math.ceil(BODY / text.length)).slice(0, BODY))))
            .hash,
        );
      }
      const start = Date.parse("2026-10-01T00:00:00Z");
      const COUNT = 2000;
      for (let at = 0; at < COUNT; at += 1) {
        const time = new Date(start + at * 1000).toISOString();
        void log.append(
          makeRecord({
            source: "fetch",
            kind: "capture",
            payload: {
              schema: 2,
              url: `https://h${String(at % 50)}.example/page/${String(at)}`,
              recipe: "page",
              mode: "page",
              fetched_at: time,
              status: 200,
              outcome: "ok",
              content_type: "text/html",
              blob: hashes[at % hashes.length],
            },
            received_at: time,
            external_id: `https://h${String(at % 50)}.example/page/${String(at)}`,
          }),
        );
      }
      await log.close();
      const gc = (globalThis as { gc?: () => void }).gc;
      gc?.();
      const sample = (): number => {
        const usage = process.memoryUsage();
        return usage.heapUsed + usage.arrayBuffers;
      };
      const before = sample();
      let peak = before;
      const timer = setInterval(() => {
        peak = Math.max(peak, sample());
      }, 5);
      let result: WaczResult;
      try {
        result = await exportWacz(dir, { out: join(dir, "memory.wacz") });
      } finally {
        clearInterval(timer);
      }
      peak = Math.max(peak, sample());
      expect(result).toMatchObject({ captures: COUNT, responses: COUNT, pages: COUNT });
      const grown = peak - before;
      // the bodies are 1000 MiB together: an export that kept them would pass the bound at once
      expect(grown).toBeLessThan(256 * 1024 * 1024);
      expect(grown).toBeLessThan((COUNT * BODY) / 4);
    } finally {
      await removeDir(dir);
    }
  }, 180_000);
});

// beforeAll copies the archives for the CI step: this test shows which files the step gets
it.runIf(SAMPLES !== undefined)("copies the archives for the validators of CI", async () => {
  const names = await readdir(SAMPLES!);
  expect(names.sort()).toEqual(["store-all.warc.gz", "store.wacz", "store.warc.gz", "zip64.zip"]);
});
