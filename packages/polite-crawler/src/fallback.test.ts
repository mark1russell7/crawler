import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { archivedDocId, fallbackReason, readWarcResponse } from "./fallback.ts";
import { createMcpServer } from "./mcp.ts";
import type { OpenOptions, PoliteCrawler } from "./open.ts";
import { openCrawler } from "./open.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";

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

describe("the archived fallback", () => {
  it("gives a Wayback Machine copy after a 403, marked archived, never as a fresh fetch", async () => {
    const page = "https://site.test/hours";
    const hosts = world(
      {
        "https://site.test": (path) =>
          path === "/hours" ? { status: 403, body: "no" } : undefined,
      },
      { wayback: { [page]: {} } },
    );
    const { crawler } = await open(hosts);
    const result = await crawler.fetch(page, { fallback: "archive" });
    expect(result).toMatchObject({
      url: page,
      doc: archivedDocId(page),
      outcome: "blocked",
      status: 403,
      title: "The archived page",
      from_cache: false,
      held_back: false,
      archived: {
        source: "wayback",
        timestamp: "2024-01-15T09:30:00Z",
        url: `https://web.archive.org/web/${WAYBACK_TIME}/${page}`,
        original: page,
      },
    });
    expect(result.note).toContain(
      "an archived copy from the Wayback Machine, captured 2024-01-15T09:30:00Z, not a fresh fetch",
    );
    expect(result.doc).toBe("archive:https://site.test/hours");
    // the archives are fetches of the same crawler: robots.txt first, the same identity
    expect(archiveHits(hosts)).toEqual([
      "https://archive.org/robots.txt",
      `https://archive.org/wayback/available?url=${encodeURIComponent(page)}`,
      "https://web.archive.org/robots.txt",
      `https://web.archive.org/web/${WAYBACK_TIME}id_/${page}`,
    ]);
    expect(
      hosts.headersOf(`https://web.archive.org/web/${WAYBACK_TIME}id_/${page}`)?.["user-agent"],
    ).toMatch(/^PoliteCrawler\//);

    // read, verify and find say archived, with the date of the copy
    const read = await crawler.read(result.doc!);
    expect(read.kind).toBe("archived");
    expect(read.archived).toEqual(result.archived);
    expect(read.note).toContain("not a fresh fetch");
    expect(read.text).toContain(archivedText(page));
    const verified = await crawler.verify(result.doc!, "the bakery opens at seven in the morning");
    expect(verified).toMatchObject({ found: true, archived: result.archived });
    expect(verified.note).toContain("captured 2024-01-15T09:30:00Z");
    const found = await crawler.find("bakery seven morning");
    expect(found[0]).toMatchObject({
      doc: result.doc,
      kind: "archived",
      archived: result.archived,
    });
    // a search for pages leaves the archived copies out
    expect(await crawler.find("bakery seven morning", { kind: "page" })).toEqual([]);

    // the store answers the second time, with no request
    const before = hosts.hits.length;
    const again = await crawler.fetch(page, { fallback: "archive" });
    expect(again).toMatchObject({ doc: result.doc, from_cache: true, archived: result.archived });
    expect(hosts.hits.length - before).toBeLessThanOrEqual(1);
    expect(archiveHits(hosts)).toHaveLength(4);

    // the copy is a projection of the log: a rebuild keeps it, with its label
    await crawler.reindex();
    expect((await crawler.read(result.doc!)).archived).toEqual(result.archived);
  });

  it("gives a copy after each kind of refusal: 401, 402, a challenge, 503, 500, a bot check, a stop and a dead host", async () => {
    const urls = {
      unauthorized: "https://a401.test/p",
      payment: "https://a402.test/p",
      challenge: "https://challenge.test/p",
      unavailable: "https://a503.test/p",
      error: "https://a500.test/p",
      botCheck: "https://botcheck.test/p",
      stopped: "https://a401.test/q",
      robotsDown: "https://robotsdown.test/p",
      dead: "https://dead.test/p",
    };
    const only =
      (status: number, headers: Record<string, string> = TEXT, body = "refused"): Route =>
      (path) =>
        path === "/robots.txt" ? undefined : { status, body, headers };
    const hosts = world(
      {
        "https://a401.test": only(401),
        "https://a402.test": only(402, { ...TEXT, "crawler-price": "USD 0.01" }),
        "https://challenge.test": only(403, { ...HTML, "cf-mitigated": "challenge" }),
        "https://a503.test": only(503, { ...TEXT, "retry-after": "60" }),
        "https://a500.test": only(500),
        "https://botcheck.test": only(
          200,
          HTML,
          "<html><head><title>Just a moment...</title></head><body><p>Checking your browser.</p></body></html>",
        ),
        "https://robotsdown.test": (path) =>
          path === "/robots.txt" ? { status: 500, body: "down" } : { body: "never asked" },
      },
      { wayback: Object.fromEntries(Object.values(urls).map((url) => [url, {}])) },
    );
    hosts.agent
      .get("https://dead.test")
      .intercept({ path: () => true, method: "GET" })
      .replyWithError(new Error("getaddrinfo ENOTFOUND dead.test"))
      .persist();
    const { crawler } = await open(hosts);
    const results: Record<string, { outcome: string; archived: string | undefined }> = {};
    for (const [name, url] of Object.entries(urls)) {
      const page = await crawler.fetch(url, { fallback: "archive" });
      results[name] = { outcome: page.outcome, archived: page.archived?.source };
    }
    expect(results).toEqual({
      unauthorized: { outcome: "blocked", archived: "wayback" },
      payment: { outcome: "payment-required", archived: "wayback" },
      challenge: { outcome: "challenge", archived: "wayback" },
      unavailable: { outcome: "unavailable", archived: "wayback" },
      error: { outcome: "error", archived: "wayback" },
      botCheck: { outcome: "ok", archived: "wayback" },
      // the 401 stopped the host: the next page of the host is a skip with a copy
      stopped: { outcome: "skipped", archived: "wayback" },
      robotsDown: { outcome: "skipped", archived: "wayback" },
      dead: { outcome: "skipped", archived: "wayback" },
    });
  });

  it("gives no copy for a 404, a 429 or a fetch that worked", async () => {
    const hosts = world(
      {
        "https://site.test": (path) =>
          path === "/gone"
            ? { status: 404, body: "gone" }
            : path === "/busy"
              ? { status: 429, body: "slow down", headers: { ...TEXT, "retry-after": "5" } }
              : path === "/fine"
                ? { body: archivedHtml("live"), headers: HTML }
                : undefined,
      },
      {
        wayback: {
          "https://site.test/gone": {},
          "https://site.test/busy": {},
          "https://site.test/fine": {},
        },
      },
    );
    const { crawler } = await open(hosts);
    for (const path of ["/gone", "/busy", "/fine"]) {
      const page = await crawler.fetch(`https://site.test${path}`, { fallback: "archive" });
      expect(page.archived).toBeUndefined();
    }
    expect(archiveHits(hosts)).toEqual([]);
  });

  it("is off by default: a refusal sends no request to an archive", async () => {
    const hosts = world(
      { "https://site.test": (path) => (path === "/p" ? { status: 403 } : undefined) },
      { wayback: { "https://site.test/p": {} } },
    );
    const { crawler } = await open(hosts);
    const page = await crawler.fetch("https://site.test/p");
    expect(page).toMatchObject({ outcome: "blocked", doc: null });
    expect(page.archived).toBeUndefined();
    expect(archiveHits(hosts)).toEqual([]);
  });

  it("gives no copy of a page that robots.txt disallows, unless archiveDespiteRobots", async () => {
    const page = "https://site.test/private/notes";
    const hosts = world(
      {
        "https://site.test": (path) =>
          path === "/robots.txt"
            ? { body: "User-agent: *\nDisallow: /private/\n", headers: TEXT }
            : undefined,
      },
      { wayback: { [page]: {} } },
    );
    const { crawler } = await open(hosts);
    const refused = await crawler.fetch(page, { fallback: "archive" });
    expect(refused).toMatchObject({ outcome: "skipped", doc: null });
    expect(refused.archived).toBeUndefined();
    expect(refused.note).toContain("robots.txt disallows it");
    expect(refused.note).toContain(
      "the current robots.txt of the site disallows the page for this agent, so the crawler gives no archived copy",
    );
    expect(archiveHits(hosts)).toEqual([]);

    const despite = await crawler.fetch(page, { fallback: "archive", archiveDespiteRobots: true });
    expect(despite).toMatchObject({ outcome: "skipped", archived: { source: "wayback" } });
  });

  it("reads the current robots.txt for a stopped host: a disallowed page gets no copy", async () => {
    const hosts = world(
      {
        "https://site.test": (path) =>
          path === "/robots.txt"
            ? { body: "User-agent: *\nDisallow: /private/\n", headers: TEXT }
            : { status: 403, body: "no" },
      },
      { wayback: { "https://site.test/open": {}, "https://site.test/private/x": {} } },
    );
    const first = await open(hosts);
    expect((await first.crawler.fetch("https://site.test/a")).outcome).toBe("blocked");
    await first.crawler.close();
    // a new process on the same store: the stop is in hosts.sqlite, the robots.txt only on the disk
    const second = await open(hosts, {}, first.dir);
    const before = hosts.hits.filter((hit) => hit.startsWith("https://site.test")).length;
    const disallowed = await second.crawler.fetch("https://site.test/private/x", {
      fallback: "archive",
    });
    expect(disallowed.note).toContain("host stopped");
    expect(disallowed.archived).toBeUndefined();
    expect(disallowed.note).toContain("the current robots.txt of the site disallows the page");
    const allowed = await second.crawler.fetch("https://site.test/open", { fallback: "archive" });
    expect(allowed).toMatchObject({ outcome: "skipped", archived: { source: "wayback" } });
    // the stop holds: the site got no request
    expect(hosts.hits.filter((hit) => hit.startsWith("https://site.test")).length).toBe(before);
  });

  it("asks Common Crawl when the Wayback Machine has no copy, with a range request for the record", async () => {
    const page = "https://site.test/menu";
    const hosts = world(
      { "https://site.test": (path) => (path === "/menu" ? { status: 401 } : undefined) },
      { commoncrawl: { [page]: HTML } },
    );
    const { crawler } = await open(hosts);
    const result = await crawler.fetch(page, { fallback: "archive" });
    expect(result).toMatchObject({
      outcome: "blocked",
      doc: archivedDocId(page),
      title: "The crawled page",
      archived: {
        source: "commoncrawl",
        timestamp: CC_TIME,
        url: `https://data.commoncrawl.org/${CC_FILE}`,
        original: page,
        record: "urn:uuid:3f6b6f9e-0000-4000-8000-000000000001",
      },
    });
    expect(result.note).toContain("the Wayback Machine: no copy");
    expect(result.note).toContain(
      "an archived copy from Common Crawl, captured 2025-03-02T10:20:30Z",
    );
    const range = hosts.headersOf(`https://data.commoncrawl.org/${CC_FILE}`)?.["range"];
    expect(range).toMatch(/^bytes=\d+-\d+$/);
    expect((await crawler.read(result.doc!)).text).toContain(archivedText(page));
    // a part of a file is not the stored copy of the file, and a rebuild still reads the record
    await crawler.reindex();
    expect(
      (await crawler.verify(result.doc!, "opens at seven in the morning")).archived?.source,
    ).toBe("commoncrawl");
  });

  it("tells why no archive has a copy", async () => {
    const page = "https://site.test/new";
    const hosts = world({
      "https://site.test": (path) => (path === "/new" ? { status: 403 } : undefined),
    });
    const { crawler } = await open(hosts);
    const result = await crawler.fetch(page, { fallback: "archive" });
    expect(result).toMatchObject({ outcome: "blocked", doc: null });
    expect(result.archived).toBeUndefined();
    expect(result.note).toContain(
      "no archived copy: the Wayback Machine: no copy; Common Crawl: no copy in the 3 newest indexes",
    );
    // three indexes at most, the newest first
    expect(hosts.hits.filter((hit) => hit.includes("-index?"))).toHaveLength(3);
  });

  it("obeys the robots.txt of an archive", async () => {
    const page = "https://site.test/p";
    const hosts = world(
      { "https://site.test": (path) => (path === "/p" ? { status: 403 } : undefined) },
      {
        wayback: { [page]: {} },
        commoncrawl: { [page]: HTML },
        robots: { "https://web.archive.org": "User-agent: *\nDisallow: /web/\n" },
      },
    );
    const { crawler } = await open(hosts);
    const result = await crawler.fetch(page, { fallback: "archive" });
    expect(result.archived?.source).toBe("commoncrawl");
    expect(result.note).toContain(
      "the Wayback Machine: the copy did not come (skipped: robots.txt disallows it",
    );
    expect(hosts.hits.some((hit) => hit.startsWith("https://web.archive.org/web/"))).toBe(false);
  });

  it("sends no URL with a secret to an archive", async () => {
    const page = "https://site.test/p?token=abc123";
    const hosts = world(
      { "https://site.test": (path) => (path.startsWith("/p") ? { status: 403 } : undefined) },
      { wayback: { [page]: {} } },
    );
    const { crawler } = await open(hosts);
    const result = await crawler.fetch(page, { fallback: "archive" });
    expect(result.archived).toBeUndefined();
    expect(result.note).toContain(
      "the URL holds a secret, so the crawler does not send it to a web archive",
    );
    expect(archiveHits(hosts)).toEqual([]);
  });

  it("applies the AI-input signals of the copy as for a live page", async () => {
    const urls = {
      waybackHeader: "https://site.test/a",
      siteRobots: "https://quiet.test/b",
      warcHeader: "https://site.test/c",
    };
    const hosts = world(
      {
        "https://site.test": (path) => (path === "/robots.txt" ? undefined : { status: 403 }),
        "https://quiet.test": (path) =>
          path === "/robots.txt"
            ? { body: "User-agent: *\nContent-Signal: ai-input=no\nAllow: /\n", headers: TEXT }
            : { status: 403 },
      },
      {
        wayback: {
          [urls.waybackHeader]: { "x-archive-orig-content-signal": "ai-input=no" },
          [urls.siteRobots]: {},
        },
        commoncrawl: { [urls.warcHeader]: { ...HTML, "Content-Signal": "ai-input=no" } },
      },
    );
    const { crawler } = await open(hosts);
    for (const url of Object.values(urls)) {
      const page = await crawler.fetch(url, { fallback: "archive" });
      expect(page.archived).toBeDefined();
      expect(page.held_back).toBe(true);
      expect(page.title).toBeNull();
      const read = await crawler.read(page.doc!);
      expect(read).toMatchObject({ held_back: true, text: "", archived: page.archived });
      expect(await crawler.find("bakery seven")).toEqual([]);
    }
  });

  it("records each request to an archive in the capture log", async () => {
    const page = "https://site.test/p";
    const hosts = world(
      { "https://site.test": (path) => (path === "/p" ? { status: 403 } : undefined) },
      { commoncrawl: { [page]: HTML } },
    );
    const { crawler, dir } = await open(hosts);
    await crawler.fetch(page, { fallback: "archive" });
    await crawler.close();
    const lines = (await readFile(join(dir, "captures", "fetch", "2026", "10.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { payload: Record<string, unknown> });
    const recipes = lines.map(
      (line) => `${String(line.payload["recipe"])} ${String(line.payload["url"])}`,
    );
    expect(recipes).toContain(
      `archive-index https://archive.org/wayback/available?url=${encodeURIComponent(page)}`,
    );
    expect(recipes).toContain("archive-index https://index.commoncrawl.org/collinfo.json");
    expect(recipes).toContain(`archive-copy https://data.commoncrawl.org/${CC_FILE}`);
    const copy = lines.find((line) => line.payload["recipe"] === "archive-copy")!;
    expect(copy.payload).toMatchObject({ status: 206, outcome: "ok" });
    expect(copy.payload["range"]).toMatch(/^bytes=\d+-\d+$/);
  });
});

describe("the parts of the fallback", () => {
  it("reads a WARC record, and refuses bytes that are not one", () => {
    const record = readWarcResponse(warcRecord("https://site.test/x", "<p>hello</p>"));
    expect(record).toMatchObject({ target: "https://site.test/x", date: CC_TIME, status: 200 });
    expect(new TextDecoder().decode(record!.body)).toBe("<p>hello</p>");
    expect(readWarcResponse(new TextEncoder().encode("WARC/1.0\r\n"))).toBeUndefined();
    expect(readWarcResponse(gzipSync("not a record"))).toBeUndefined();
  });

  it("knows the notes of the crawler for each refusal", () => {
    const indexed = (outcome: string, note: string | undefined, status = 0) => ({
      fetched: {
        url: "https://site.test/",
        status,
        outcome: outcome as "skipped",
        fromCache: false,
        capture: undefined,
        blob: undefined,
        body: undefined,
        contentType: undefined,
        signals: { ai_input: "unset" as const, raw: [] },
        note,
      },
      docs: [],
    });
    expect(fallbackReason(indexed("skipped", "robots.txt disallows it for PoliteCrawler"))).toBe(
      "robots",
    );
    expect(
      fallbackReason(
        indexed(
          "skipped",
          "robots.txt could not be read (status 500), so nothing on the site is fetched",
        ),
      ),
    ).toBe("unreachable");
    expect(
      fallbackReason(indexed("skipped", "host stopped until 2026-10-07T13:00:00.000Z: blocked")),
    ).toBe("stopped");
    expect(
      fallbackReason(
        indexed(
          "skipped",
          "egress policy: 10.0.0.1 is a private address; set allowPrivate to fetch it",
        ),
      ),
    ).toBeUndefined();
    expect(fallbackReason(indexed("error", "cancelled by the caller"))).toBeUndefined();
    expect(fallbackReason(indexed("error", "no response: connect ECONNREFUSED"))).toBe(
      "unreachable",
    );
    expect(fallbackReason(indexed("error", "status 502", 500))).toBe("error");
    expect(fallbackReason(indexed("error", "status 418", 418))).toBeUndefined();
  });
});

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
  });
});
