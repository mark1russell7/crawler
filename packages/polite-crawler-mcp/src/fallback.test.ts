import { gzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { archivedDocId } from "../../polite-crawler/src/fallback.ts";
import { createMcpServer } from "./server.ts";
import type { OpenOptions, PoliteCrawler } from "../../polite-crawler/src/open.ts";
import { openCrawler } from "../../polite-crawler/src/open.ts";
import { fakeClock, removeDir, tempDir } from "../../polite-crawler/src/test-helpers.ts";

/*
 * The archived fallback, on mock hosts only: the live sites, the Wayback Machine (archive.org and
 * web.archive.org) and Common Crawl (index.commoncrawl.org and data.commoncrawl.org). No test sends a
 * request to a real archive: the mock agent refuses each host that it does not know.
 */

interface Reply {
  readonly status?: number;
  readonly body?: string | Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
}

type Route = (path: string, headers: Readonly<Record<string, string>>) => Reply | undefined;

const HTML = { "content-type": "text/html; charset=utf-8" };
const TEXT = { "content-type": "text/plain" };
const JSON_TYPE = { "content-type": "application/json" };
const ALLOW = "User-agent: *\nAllow: /\n";

/** The text of the archived page of a URL. Each test quotes it. */
const archivedText = (url: string): string =>
  `This archived page of ${url} says that the bakery opens at seven in the morning.`;
const archivedHtml = (url: string, title = "The archived page"): string =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${archivedText(url)}</p><p>${"More words of the archived page. ".repeat(10)}</p></main></body></html>`;

const WAYBACK_TIME = "20240115093000";
const CC_TIME = "2025-03-02T10:20:30Z";
const CC_FILE =
  "crawl-data/CC-MAIN-2026-40/segments/1700000000.1/warc/CC-MAIN-20261001-00001.warc.gz";

/** This function makes one gzip member with a WARC response record, as Common Crawl stores it. */
const warcRecord = (
  target: string,
  body: string,
  httpHeaders: Readonly<Record<string, string>> = HTML,
): Buffer => {
  const http = Buffer.from(
    `HTTP/1.1 200 OK\r\n${Object.entries(httpHeaders)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("")}X-Crawler-Content-Encoding: gzip\r\n\r\n${body}`,
  );
  const head = Buffer.from(
    `WARC/1.0\r\nWARC-Type: response\r\nWARC-Date: ${CC_TIME}\r\nWARC-Record-ID: <urn:uuid:3f6b6f9e-0000-4000-8000-000000000001>\r\nWARC-Target-URI: ${target}\r\nContent-Type: application/http; msgtype=response\r\nContent-Length: ${String(http.length)}\r\n\r\n`,
  );
  return gzipSync(Buffer.concat([head, http, Buffer.from("\r\n\r\n")]));
};

interface Archives {
  /** The URLs that the Wayback Machine has, and the headers of each copy. */
  readonly wayback?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The URLs that Common Crawl has, and the HTTP headers of each record. */
  readonly commoncrawl?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The robots.txt of each archive host. */
  readonly robots?: Readonly<Record<string, string>>;
}

interface World {
  readonly agent: MockAgent;
  /** Each request, as `origin + path`. */
  readonly hits: string[];
  readonly headersOf: (url: string) => Readonly<Record<string, string>> | undefined;
}

/** This function makes the mock hosts: the live sites and the four hosts of the two archives. */
const world = (sites: Readonly<Record<string, Route>>, archives: Archives = {}): World => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const hits: string[] = [];
  const headers = new Map<string, Record<string, string>>();
  const host = (origin: string, route: Route, robots = ALLOW): void => {
    agent
      .get(origin)
      .intercept({ path: () => true, method: "GET" })
      .reply((request) => {
        const sent = Object.fromEntries(
          Object.entries((request.headers ?? {}) as Record<string, string>).map(([name, value]) => [
            name.toLowerCase(),
            String(value),
          ]),
        );
        hits.push(`${origin}${request.path}`);
        headers.set(`${origin}${request.path}`, sent);
        const reply: Reply =
          route(request.path, sent) ??
          (request.path === "/robots.txt"
            ? { status: 200, body: robots, headers: TEXT }
            : { status: 404, body: "no such page", headers: TEXT });
        return {
          statusCode: reply.status ?? 200,
          data: reply.body ?? "",
          responseOptions: { headers: reply.headers ?? {} },
        };
      })
      .persist();
  };
  for (const [origin, route] of Object.entries(sites)) host(origin, route);
  const wayback = archives.wayback ?? {};
  host(
    "https://archive.org",
    (path) => {
      const asked = new URL(path, "https://archive.org");
      if (asked.pathname !== "/wayback/available") return undefined;
      const url = asked.searchParams.get("url") ?? "";
      const known = wayback[url] !== undefined;
      return {
        body: JSON.stringify({
          url,
          archived_snapshots: known
            ? {
                closest: {
                  status: "200",
                  available: true,
                  url: `http://web.archive.org/web/${WAYBACK_TIME}/${url}`,
                  timestamp: WAYBACK_TIME,
                },
              }
            : {},
        }),
        headers: JSON_TYPE,
      };
    },
    archives.robots?.["https://archive.org"],
  );
  host(
    "https://web.archive.org",
    (path) => {
      const match = /^\/web\/(\d{14})id_\/(.+)$/.exec(path);
      if (match === null) return undefined;
      const original = match[2]!;
      const extra = wayback[original];
      if (extra === undefined) return { status: 404, body: "not archived", headers: TEXT };
      return { body: archivedHtml(original), headers: { ...HTML, ...extra } };
    },
    archives.robots?.["https://web.archive.org"],
  );
  const commoncrawl = archives.commoncrawl ?? {};
  // one WARC file: a first record of another page, then one record for each archived URL
  const records = Object.entries(commoncrawl).map(([url, httpHeaders]) =>
    warcRecord(url, archivedHtml(url, "The crawled page"), httpHeaders),
  );
  const first = warcRecord("https://other.test/", "<p>another page</p>");
  const file = Buffer.concat([first, ...records]);
  const offsets = new Map<string, { offset: number; length: number }>();
  let at = first.length;
  for (const [index, url] of Object.keys(commoncrawl).entries()) {
    offsets.set(url, { offset: at, length: records[index]!.length });
    at += records[index]!.length;
  }
  host(
    "https://index.commoncrawl.org",
    (path) => {
      if (path === "/collinfo.json")
        return {
          body: JSON.stringify(
            ["CC-MAIN-2026-40", "CC-MAIN-2026-33", "CC-MAIN-2026-26", "CC-MAIN-2026-21"].map(
              (id) => ({ id, "cdx-api": `https://index.commoncrawl.org/${id}-index` }),
            ),
          ),
          headers: JSON_TYPE,
        };
      const asked = new URL(path, "https://index.commoncrawl.org");
      const url = asked.searchParams.get("url") ?? "";
      const place = offsets.get(url);
      if (asked.pathname !== "/CC-MAIN-2026-40-index" || place === undefined)
        return { status: 404, body: '{"message": "No Captures found"}', headers: JSON_TYPE };
      return {
        body: `${JSON.stringify({ urlkey: "x", timestamp: "20250302102030", url, status: "301", filename: CC_FILE, offset: "0", length: "10" })}\n${JSON.stringify({ urlkey: "x", timestamp: "20250302102030", url, mime: "text/html", status: "200", filename: CC_FILE, offset: String(place.offset), length: String(place.length) })}\n`,
        headers: { "content-type": "text/x-ndjson" },
      };
    },
    archives.robots?.["https://index.commoncrawl.org"],
  );
  host(
    "https://data.commoncrawl.org",
    (path, sent) => {
      if (path !== `/${CC_FILE}`) return undefined;
      const range = /^bytes=(\d+)-(\d+)$/.exec(sent["range"] ?? "");
      if (range === null)
        return { body: file, headers: { "content-type": "application/octet-stream" } };
      const start = Number(range[1]);
      const end = Number(range[2]);
      return {
        status: 206,
        body: file.subarray(start, end + 1),
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes ${String(start)}-${String(end)}/${String(file.length)}`,
        },
      };
    },
    archives.robots?.["https://data.commoncrawl.org"],
  );
  return { agent, hits, headersOf: (url) => headers.get(url) };
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** This function opens a crawler on a new store, with the mock hosts and a fake clock. */
const open = async (
  hosts: World,
  options: Partial<OpenOptions> = {},
  dir?: string,
): Promise<{ readonly crawler: PoliteCrawler; readonly dir: string }> => {
  const store = dir ?? (await tempDir("fallback"));
  const crawler = openCrawler({
    renderer: false,
    random: () => 0.5,
    clock: fakeClock(),
    dispatcher: hosts.agent,
    ...options,
    dir: store,
  });
  cleanups.push(async () => {
    await crawler.close();
  });
  if (dir === undefined) cleanups.unshift(() => removeDir(store));
  return { crawler, dir: store };
};

const archiveHits = (hosts: World): string[] =>
  hosts.hits.filter((hit) => /archive\.org|commoncrawl\.org/.test(hit));

describe("the archived fallback over MCP", () => {
  it("gives archived copies only with archive_fallback, and marks them in the envelope", async () => {
    const page = "https://site.test/p";
    const hosts = world(
      { "https://site.test": (path) => (path === "/p" ? { status: 403 } : undefined) },
      { wayback: { [page]: {} } },
    );
    const { crawler } = await open(hosts);
    const server = createMcpServer(crawler);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ text: string }>;
      return {
        structured: result.structuredContent as Record<string, unknown>,
        web: content[1]?.text ?? "",
      };
    };
    const plain = await call("crawl_fetch", { urls: [page] });
    expect((plain.structured["pages"] as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      "archived",
    );
    expect(archiveHits(hosts)).toEqual([]);

    const fetched = await call("crawl_fetch", { urls: [page], archive_fallback: true });
    const shown = (fetched.structured["pages"] as Array<Record<string, unknown>>)[0]!;
    // the 403 of the first call stopped the host: the second call is a stop, with a copy
    expect(shown).toMatchObject({
      outcome: "skipped",
      doc: archivedDocId(page),
      archived: { source: "wayback", timestamp: "2024-01-15T09:30:00Z" },
    });
    expect(fetched.web).toContain('archived="wayback%202024-01-15T09:30:00Z"');
    const verified = await call("crawl_verify", {
      doc: archivedDocId(page),
      quote: "the bakery opens at seven",
    });
    expect(verified.structured).toMatchObject({
      found: true,
      archived: { source: "wayback", timestamp: "2024-01-15T09:30:00Z" },
    });
    expect(String(verified.structured["note"])).toContain("not a fresh fetch");
    const read = await call("crawl_read", { doc: archivedDocId(page) });
    expect(read.structured).toMatchObject({ kind: "archived", archived: { source: "wayback" } });
    // a value from an archived copy says so, as a quote does
    const extracted = await call("crawl_extract", {
      doc: archivedDocId(page),
      fields: { hours: { value: "the bakery opens at seven" } },
    });
    expect(extracted.structured).toMatchObject({
      summary: { verified: 1 },
      archived: { source: "wayback", timestamp: "2024-01-15T09:30:00Z" },
    });
    expect(String(extracted.structured["note"])).toContain("not a fresh fetch");
    expect(extracted.web).toContain('archived="wayback%202024-01-15T09:30:00Z"');
  });
});
