import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { FileBlobStore } from "./blobs.ts";
import type { CrawlerOptions } from "./crawler.ts";
import { Crawler } from "./crawler.ts";
import { DocIndex } from "./docs.ts";
import { CaptureLog } from "./log.ts";
import type { Clock } from "./politeness.ts";
import type { CaptureRecord } from "./record.ts";
import { removeDir, tempDir } from "./test-helpers.ts";

// Each test here talks to a real HTTP server on 127.0.0.1, so the sockets, the streams and the
// timeouts are the real ones. The clock is real for durations, and a sleep moves it at once.

type Handler = (request: IncomingMessage, response: ServerResponse, count: number) => void;

const servers: Server[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

const serve = async (handler: Handler) => {
  const hits: Array<{ readonly path: string; readonly headers: IncomingHttpHeaders }> = [];
  const server = createServer((request, response) => {
    hits.push({ path: request.url ?? "", headers: request.headers });
    handler(request, response, hits.length);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    port,
    hits,
    paths: () => hits.map((hit) => hit.path),
  };
};

/** time that passes for real during a request, and jumps ahead when the crawler sleeps */
const jumpClock = (): Clock & { slept: number[]; advance: (ms: number) => void } => {
  let offset = 0;
  const slept: number[] = [];
  return {
    slept,
    advance: (ms) => {
      offset += ms;
    },
    now: () => Date.now() + offset,
    sleep: (ms) => {
      slept.push(ms);
      offset += ms;
      return Promise.resolve();
    },
  };
};

const make = async (options: Partial<CrawlerOptions> = {}) => {
  const dir = await tempDir("hazards");
  const log = new CaptureLog(join(dir, "crawl"));
  const blobs = new FileBlobStore(join(dir, "blobs"));
  const index = new DocIndex(":memory:");
  const clock = jumpClock();
  let crawler: Crawler | undefined;
  cleanups.push(async () => {
    await crawler?.close();
    await log.close();
    index.close();
    await removeDir(dir);
  });
  crawler = new Crawler({
    token: "PoliteCrawler",
    userAgent: "PoliteCrawler/0.1 (test)",
    log,
    blobs,
    index,
    clock,
    random: () => 0.5,
    egress: { allowPrivate: true },
    ...options,
  });
  const captures = async (): Promise<CaptureRecord[]> => {
    const rows: CaptureRecord[] = [];
    for await (const row of new CaptureLog(join(dir, "crawl")).scan({ source: "fetch" }))
      rows.push(row);
    return rows;
  };
  return { crawler, clock, index, blobs, dir, captures };
};

const payloadOf = (row: CaptureRecord): Record<string, unknown> =>
  row.payload as Record<string, unknown>;
const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

describe("bodies that fail, stop early or arrive slowly", () => {
  it("records a body that resets mid-stream, counts it and rests the host", async () => {
    const site = await serve((request, response) => {
      if (request.url === "/reset") {
        response.writeHead(200, { "content-type": "text/plain", "content-length": "1000" });
        response.write("partial body");
        setTimeout(() => request.socket.destroy(), 30);
        return;
      }
      response.end("fine");
    });
    const { crawler, clock, captures } = await make();
    const reset = await crawler.fetch({
      url: `${site.origin}/reset`,
      mode: "api",
      recipe: "t",
      minIntervalMs: 2000,
    });
    expect(reset).toMatchObject({
      outcome: "error",
      status: 200,
      body: undefined,
      blob: undefined,
    });
    expect(reset.note).toMatch(/^body failed: /);
    const ok = await crawler.fetch({
      url: `${site.origin}/ok`,
      mode: "api",
      recipe: "t",
      minIntervalMs: 2000,
    });
    expect(ok.outcome).toBe("ok");
    // the host rested after the failure: the floor, or the backoff when longer
    expect(clock.slept[0]).toBeGreaterThanOrEqual(2000);
    const rows = (await captures()).map(
      (row) => `${row.kind} ${String(payloadOf(row)["outcome"])}`,
    );
    expect(rows).toEqual(["capture error", "capture ok"]);
  });

  it("does not cache a robots.txt whose body failed: it asks again after a short wait", async () => {
    let robots = 0;
    const site = await serve((request, response) => {
      if (request.url === "/robots.txt") {
        robots += 1;
        if (robots === 1) {
          response.writeHead(200, { "content-type": "text/plain", "content-length": "1000" });
          response.write("User-agent: *\n");
          setTimeout(() => request.socket.destroy(), 30);
          return;
        }
        response.end("User-agent: *\nAllow: /\n");
        return;
      }
      response.end("<h1>hi</h1>");
    });
    const { crawler, clock } = await make();
    const first = await crawler.fetch({ url: `${site.origin}/one`, mode: "page", recipe: "page" });
    expect(first.outcome).toBe("skipped");
    expect(first.note).toMatch(/^robots\.txt could not be read \(body failed: /);
    // minutes later, not a day later, the crawler reads robots.txt again
    clock.advance(10 * 60 * 1000);
    const second = await crawler.fetch({ url: `${site.origin}/two`, mode: "page", recipe: "page" });
    expect(second.outcome).toBe("ok");
    expect(robots).toBe(2);
  });

  it("keeps the first part of a body that crosses the maximum, and keeps no validators for it", async () => {
    const site = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain", etag: '"v1"' });
      response.end("x".repeat(100));
    });
    const { crawler, index } = await make();
    const cut = await crawler.fetch({
      url: `${site.origin}/big`,
      mode: "api",
      recipe: "t",
      maxBytes: 40,
    });
    expect(cut).toMatchObject({ outcome: "ok", truncated: true, note: "truncated at 40 bytes" });
    expect(cut.body).toHaveLength(40);
    expect(index.latest(cut.url)).toMatchObject({ etag: null, blob: cut.blob });
    const whole = await crawler.fetch({ url: `${site.origin}/big`, mode: "api", recipe: "t" });
    expect(whole).toMatchObject({ outcome: "ok", fromCache: false });
    expect(whole.body).toHaveLength(100);
    // no If-None-Match went with the second request, so the server could not answer 304
    expect(site.hits[1]!.headers["if-none-match"]).toBeUndefined();
  });

  it("decodes gzip, deflate, raw deflate, brotli and stacked codings, and keeps the first part of a bomb", async () => {
    const page = "hello, compressed ".repeat(20);
    const bomb = gzipSync(Buffer.alloc(3 * 1024 * 1024, "a"));
    const site = await serve((request, response) => {
      const encoded: Record<string, [string, Buffer]> = {
        "/gzip": ["gzip", gzipSync(page)],
        "/deflate": ["deflate", deflateSync(page)],
        "/raw": ["deflate", deflateRawSync(page)],
        "/br": ["br", brotliCompressSync(page)],
        "/stacked": ["gzip, br", brotliCompressSync(gzipSync(page))],
        "/bomb": ["gzip", bomb],
        "/zstd": ["zstd", Buffer.from("not really zstd")],
        "/corrupt": ["gzip", Buffer.from("this is not gzip at all")],
      };
      const [coding, body] = encoded[request.url ?? ""]!;
      response.writeHead(200, { "content-encoding": coding });
      response.end(body);
    });
    const { crawler } = await make();
    const get = (path: string, maxBytes?: number) =>
      crawler.fetch({
        url: `${site.origin}${path}`,
        mode: "api",
        recipe: "t",
        minIntervalMs: 0,
        ...(maxBytes ? { maxBytes } : {}),
      });
    for (const path of ["/gzip", "/deflate", "/raw", "/br", "/stacked"]) {
      expect(text((await get(path)).body), path).toBe(page);
    }
    const capped = await get("/bomb", 1024 * 1024);
    expect(capped).toMatchObject({ outcome: "ok", truncated: true });
    expect(capped.body).toHaveLength(1024 * 1024);
    expect(await get("/zstd")).toMatchObject({
      outcome: "error",
      note: 'undecodable body: unsupported content-encoding "zstd"',
    });
    const corrupt = await get("/corrupt");
    expect(corrupt.outcome).toBe("error");
    expect(corrupt.note).toMatch(/^undecodable body: /);
  });

  it("measures a slow body to its end, and paces a page on the whole time", async () => {
    const site = await serve((request, response) => {
      if (request.url === "/robots.txt") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      if (request.url !== "/slow") {
        response.end("<p>quick</p>");
        return;
      }
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        if (sent < 9) response.write("<p>part</p>");
        else {
          clearInterval(timer);
          response.end();
        }
      }, 120);
    });
    const { crawler, clock, captures } = await make();
    await crawler.fetch({ url: `${site.origin}/slow`, mode: "page", recipe: "page" });
    await crawler.fetch({ url: `${site.origin}/next`, mode: "page", recipe: "page" });
    const slow = (await captures()).find((row) => payloadOf(row)["url"] === `${site.origin}/slow`)!;
    expect(payloadOf(slow)["elapsed_ms"]).toBeGreaterThanOrEqual(900);
    expect(payloadOf(slow)["ttfb_ms"]).toBeLessThan(200);
    // the rest is five times the whole request (more than the 3 s floor), not five times the time to the headers
    expect(Math.max(...clock.slept)).toBeGreaterThanOrEqual(4500);
  });
});

describe("a store that fails", () => {
  it("records a blob store failure as an error of the store, which does not count against the host", async () => {
    const site = await serve((_request, response) => response.end("x"));
    const full = new FileBlobStore(join(tmpdir(), "never-written"));
    full.put = () =>
      Promise.reject(
        Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }),
      );
    const { crawler } = await make({ blobs: full, politeness: { maxFailures: 1 } });
    const fetched = await crawler.fetch({ url: `${site.origin}/a`, mode: "api", recipe: "t" });
    expect(fetched).toMatchObject({
      outcome: "error",
      note: "blob store: ENOSPC: no space left on device",
      blob: undefined,
    });
    // with one failure as the limit, a failure of the host would stop it here
    expect(
      (await crawler.fetch({ url: `${site.origin}/b`, mode: "api", recipe: "t" })).note,
    ).not.toMatch(/^host stopped/);
  });
});

describe("robots.txt that the crawler cannot read in full", () => {
  it("parses the first 500 KiB of a gzip robots.txt that decodes past the maximum", async () => {
    const filler = `# ${"x".repeat(98)}\n`.repeat(6500);
    const robots = gzipSync(`User-agent: *\nDisallow: /\n${filler}`);
    const site = await serve((request, response) => {
      if (request.url === "/robots.txt") {
        response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        response.end(robots);
        return;
      }
      response.end("secret page");
    });
    const { crawler } = await make();
    const page = await crawler.fetch({
      url: `${site.origin}/private`,
      mode: "page",
      recipe: "page",
    });
    expect(page).toMatchObject({
      outcome: "skipped",
      note: "robots.txt disallows it for PoliteCrawler",
    });
    expect(site.paths()).toEqual(["/robots.txt"]);
  });

  it("fetches nothing when the robots.txt body does not decode", async () => {
    const site = await serve((request, response) => {
      if (request.url === "/robots.txt") {
        response.writeHead(200, { "content-encoding": "gzip" });
        response.end("not gzip");
        return;
      }
      response.end("page");
    });
    const { crawler } = await make();
    const page = await crawler.fetch({ url: `${site.origin}/a`, mode: "page", recipe: "page" });
    expect(page.outcome).toBe("skipped");
    expect(page.note).toMatch(/^robots\.txt could not be read \(undecodable body: /);
    expect(site.paths()).toEqual(["/robots.txt"]);
  });

  it("reads a 401 or 403 on robots.txt as no robots.txt, and does not stop the host", async () => {
    const site = await serve((request, response) => {
      response.writeHead(request.url === "/robots.txt" ? 403 : 200);
      response.end("x");
    });
    const { crawler } = await make();
    const page = await crawler.fetch({ url: `${site.origin}/a`, mode: "page", recipe: "page" });
    expect(page.outcome).toBe("ok");
  });
});

describe("redirects", () => {
  it("drops credentials at a different origin, redacts the Location and still follows it", async () => {
    const other = await serve((_request, response) => response.end("moved here"));
    const api = await serve((request, response) => {
      if (request.url?.startsWith("/same")) {
        response.writeHead(302, { location: "/v2/same?api_key=SECRET123" });
        response.end();
        return;
      }
      if (request.url?.startsWith("/v2/")) {
        response.end("same origin");
        return;
      }
      response.writeHead(302, { location: `${other.origin}/v2/works?q=x&api_key=SECRET123` });
      response.end();
    });
    const { crawler, captures } = await make();
    const headers = { authorization: "Bearer TOKEN", "x-trace": "1" };
    const moved = await crawler.fetch({
      url: `${api.origin}/v1/works`,
      mode: "api",
      recipe: "t",
      headers,
      minIntervalMs: 0,
    });
    expect(text(moved.body)).toBe("moved here");
    expect(other.hits[0]!.headers["authorization"]).toBeUndefined();
    expect(other.hits[0]!.headers["x-trace"]).toBe("1");
    expect(other.paths()).toEqual(["/v2/works?q=x&api_key=SECRET123"]);
    const same = await crawler.fetch({
      url: `${api.origin}/same`,
      mode: "api",
      recipe: "t",
      headers,
      minIntervalMs: 0,
    });
    expect(text(same.body)).toBe("same origin");
    expect(api.hits.at(-1)!.headers["authorization"]).toBe("Bearer TOKEN");
    const log = JSON.stringify(await captures());
    expect(log).not.toContain("SECRET123");
    expect(log).toContain("api_key=REDACTED");
  });

  it("records a bad or non-http Location as an outcome, and never throws", async () => {
    const site = await serve((request, response) => {
      const targets: Record<string, string> = {
        "/bad-host": "http://exa mple.com/",
        "/mailto": "mailto:someone@example.com",
        "/file": "file:///etc/passwd",
      };
      const location = targets[request.url ?? ""];
      if (location === undefined) {
        response.end("good");
        return;
      }
      response.writeHead(302, { location });
      response.end();
    });
    const { crawler } = await make();
    const get = (path: string) =>
      crawler.fetch({ url: `${site.origin}${path}`, mode: "page", recipe: "page" });
    const [bad, mail, file, good] = await Promise.all([
      get("/bad-host"),
      get("/mailto"),
      get("/file"),
      get("/good"),
    ]);
    expect(bad).toMatchObject({ outcome: "error", note: "bad redirect target" });
    expect(mail).toMatchObject({ outcome: "skipped", note: "not an http(s) URL" });
    expect(file).toMatchObject({ outcome: "skipped", note: "not an http(s) URL" });
    expect(good.outcome).toBe("ok");
    expect(
      await crawler.fetch({ url: "file:///C:/Windows/win.ini", mode: "page", recipe: "page" }),
    ).toMatchObject({
      outcome: "skipped",
      note: "not an http(s) URL",
    });
    expect(await crawler.fetch({ url: "http://[::1", mode: "page", recipe: "page" })).toMatchObject(
      {
        outcome: "skipped",
        note: "not a valid URL",
      },
    );
  });

  it("stops an endless chain with an error after five redirects", async () => {
    const site = await serve((request, response) => {
      const step = Number((request.url ?? "/0").slice(1));
      response.writeHead(302, { location: `/${String(step + 1)}` });
      response.end();
    });
    const { crawler } = await make();
    const chain = await crawler.fetch({
      url: `${site.origin}/0`,
      mode: "api",
      recipe: "t",
      minIntervalMs: 0,
    });
    expect(chain).toMatchObject({ outcome: "error", note: "more than 5 redirects", status: 302 });
    expect(site.hits).toHaveLength(6);
  });

  it("answers a permanent redirect from the cache, and asks again for a temporary one", async () => {
    const site = await serve((request, response) => {
      if (request.url === "/old") {
        response.writeHead(301, { location: "/new" });
        response.end();
      } else if (request.url === "/temp") {
        response.writeHead(302, { location: "/new" });
        response.end();
      } else response.end("the new page");
    });
    const { crawler } = await make();
    const day = 24 * 60 * 60 * 1000;
    for (let round = 0; round < 3; round += 1) {
      const fetched = await crawler.fetch({
        url: `${site.origin}/old`,
        mode: "api",
        recipe: "t",
        maxAgeMs: day,
      });
      expect(text(fetched.body)).toBe("the new page");
    }
    expect(site.paths()).toEqual(["/old", "/new"]);
    await crawler.fetch({ url: `${site.origin}/temp`, mode: "api", recipe: "t", maxAgeMs: day });
    await crawler.fetch({ url: `${site.origin}/temp`, mode: "api", recipe: "t", maxAgeMs: day });
    expect(site.paths().filter((path) => path === "/temp")).toHaveLength(2);
  });
});

describe("the cache", () => {
  it("drops the fragment from the key, and joins equal requests that run at the same time", async () => {
    const site = await serve((_request, response) => {
      setTimeout(() => response.end("one page"), 50);
    });
    const { crawler } = await make();
    const day = 24 * 60 * 60 * 1000;
    const intro = await crawler.fetch({
      url: `${site.origin}/page#intro`,
      mode: "api",
      recipe: "t",
      maxAgeMs: day,
    });
    const pricing = await crawler.fetch({
      url: `${site.origin}/page#pricing`,
      mode: "api",
      recipe: "t",
      maxAgeMs: day,
    });
    expect(intro.url).toBe(`${site.origin}/page`);
    expect(pricing).toMatchObject({ fromCache: true, url: `${site.origin}/page` });
    const same = await Promise.all(
      [1, 2, 3].map(() => crawler.fetch({ url: `${site.origin}/same`, mode: "api", recipe: "t" })),
    );
    expect(new Set(same.map((fetched) => fetched.capture)).size).toBe(1);
    expect(site.paths()).toEqual(["/page", "/same"]);
  });

  it("sends no validators when the stored body is gone, so a 304 never comes back empty", async () => {
    const site = await serve((request, response) => {
      if (request.headers["if-none-match"] === '"v1"') {
        response.writeHead(304, { etag: '"v1"' });
        response.end();
        return;
      }
      response.writeHead(200, { etag: '"v1"', "content-type": "text/plain" });
      response.end("the body");
    });
    const { crawler, dir } = await make();
    const first = await crawler.fetch({
      url: `${site.origin}/r`,
      mode: "api",
      recipe: "t",
      minIntervalMs: 0,
    });
    const blob = first.blob!;
    await rm(join(dir, "blobs", blob.slice(0, 2), blob.slice(2, 4), blob), { force: true });
    const second = await crawler.fetch({
      url: `${site.origin}/r`,
      mode: "api",
      recipe: "t",
      minIntervalMs: 0,
    });
    expect(site.hits[1]!.headers["if-none-match"]).toBeUndefined();
    expect(second).toMatchObject({ outcome: "ok" });
    expect(text(second.body)).toBe("the body");
  });

  it("keeps the stored usage signal and content type through a 304", async () => {
    const site = await serve((request, response) => {
      if (request.headers["if-none-match"] === '"v1"') {
        response.writeHead(304, { etag: '"v1"' });
        response.end();
        return;
      }
      response.writeHead(200, {
        etag: '"v1"',
        "content-type": "text/html",
        "content-signal": "ai-input=no",
      });
      response.end("<p>no AI</p>");
    });
    const { crawler, captures } = await make();
    await crawler.fetch({ url: `${site.origin}/p`, mode: "api", recipe: "t", minIntervalMs: 0 });
    const again = await crawler.fetch({
      url: `${site.origin}/p`,
      mode: "api",
      recipe: "t",
      minIntervalMs: 0,
    });
    expect(again).toMatchObject({ outcome: "not-modified", contentType: "text/html" });
    expect(again.signals.ai_input).toBe("no");
    const revisit = (await captures()).find((row) => row.kind === "revisit")!;
    expect(payloadOf(revisit)).toMatchObject({ content_type: "text/html", etag: '"v1"' });
  });

  it("uses the freshness of the server with maxAgeMs auto, and keeps variants apart", async () => {
    const site = await serve((request, response) => {
      const headers: Record<string, string> = { "content-type": "text/plain" };
      if (request.url === "/fresh") headers["cache-control"] = "max-age=60";
      if (request.url === "/no-cache") headers["cache-control"] = "no-cache, max-age=600";
      if (request.url === "/vary") headers["vary"] = "Accept";
      response.writeHead(200, headers);
      response.end(`${request.url ?? ""} ${request.headers["accept"] ?? ""}`);
    });
    const { crawler, clock } = await make();
    const get = (path: string, maxAgeMs: number | "auto", accept?: string) =>
      crawler.fetch({
        url: `${site.origin}${path}`,
        mode: "api",
        recipe: "t",
        maxAgeMs,
        minIntervalMs: 0,
        ...(accept ? { accept } : {}),
      });
    await get("/fresh", "auto");
    expect((await get("/fresh", "auto")).fromCache).toBe(true);
    clock.advance(61_000);
    expect((await get("/fresh", "auto")).fromCache).toBe(false);
    await get("/no-cache", "auto");
    expect((await get("/no-cache", "auto")).fromCache).toBe(false);
    // an explicit age wins over the server
    expect((await get("/no-cache", 60_000)).fromCache).toBe(true);
    await get("/vary", 60_000, "application/json");
    expect((await get("/vary", 60_000, "application/json")).fromCache).toBe(true);
    const other = await get("/vary", 60_000, "text/html");
    expect(other.fromCache).toBe(false);
    expect(text(other.body)).toBe("/vary text/html");
  });

  it("reads Expires, Age and Last-Modified for freshness, and keeps a no-store response", async () => {
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;
    const site = await serve((request, response) => {
      // the dates of the server are whole seconds, as an HTTP date is
      const now = Math.floor(Date.now() / 1000) * 1000;
      const headers: Record<string, string> = {
        "content-type": "text/plain",
        date: new Date(now).toUTCString(),
      };
      if (request.url === "/expires") headers["expires"] = new Date(now + 120_000).toUTCString();
      if (request.url === "/age") {
        headers["cache-control"] = "max-age=100";
        headers["age"] = "90";
      }
      // 10 percent of the age of Last-Modified: 2.4 hours, and 24 hours at most
      if (request.url === "/modified") headers["last-modified"] = new Date(now - day).toUTCString();
      if (request.url === "/old")
        headers["last-modified"] = new Date(now - 100 * day).toUTCString();
      if (request.url === "/no-store") headers["cache-control"] = "no-store, max-age=600";
      if (request.url === "/vary-star") headers["vary"] = "*";
      if (request.url === "/vary-agent") headers["vary"] = "User-Agent";
      response.writeHead(200, headers);
      response.end(request.url ?? "");
    });
    const { crawler, clock } = await make();
    const get = (path: string, maxAgeMs: number | "auto") =>
      crawler.fetch({
        url: `${site.origin}${path}`,
        mode: "api",
        recipe: "t",
        maxAgeMs,
        minIntervalMs: 0,
      });
    for (const path of ["/expires", "/age", "/modified", "/old"]) await get(path, "auto");
    expect((await get("/expires", "auto")).fromCache).toBe(true);
    expect((await get("/age", "auto")).fromCache).toBe(true);
    clock.advance(11_000);
    // max-age=100 less an Age of 90 s is 10 s of freshness
    expect((await get("/age", "auto")).fromCache).toBe(false);
    clock.advance(110_000);
    expect((await get("/expires", "auto")).fromCache).toBe(false);
    clock.advance(2 * hour);
    expect((await get("/modified", "auto")).fromCache).toBe(true);
    clock.advance(hour);
    expect((await get("/modified", "auto")).fromCache).toBe(false);
    clock.advance(19 * hour);
    expect((await get("/old", "auto")).fromCache).toBe(true);
    clock.advance(2 * hour);
    expect((await get("/old", "auto")).fromCache).toBe(false);

    // no-store makes the copy stale at once: auto asks again, and an explicit age uses the copy
    await get("/no-store", "auto");
    expect((await get("/no-store", "auto")).fromCache).toBe(false);
    const kept = await get("/no-store", 60_000);
    expect(kept.fromCache).toBe(true);
    expect(text(kept.body)).toBe("/no-store");

    // Vary: * matches no request, and a Vary on a header that the crawler always sends changes nothing
    await get("/vary-star", 60_000);
    expect((await get("/vary-star", 60_000)).fromCache).toBe(false);
    await get("/vary-agent", 60_000);
    expect((await get("/vary-agent", 60_000)).fromCache).toBe(true);
  });
});

describe("the fetch of robots.txt", () => {
  it("follows five redirects for robots.txt, and reads a sixth as unreachable", async () => {
    const chain = (hops: number) =>
      serve((request, response) => {
        const path = request.url ?? "";
        const at = path === "/robots.txt" ? 0 : Number(/^\/r(\d+)$/.exec(path)?.[1] ?? -1);
        if (at >= 0 && at < hops) {
          response.writeHead(301, { location: `/r${String(at + 1)}` });
          response.end();
          return;
        }
        response.end(at === hops ? "User-agent: *\nDisallow: /private\n" : "page");
      });
    const five = await chain(5);
    const six = await chain(6);
    const { crawler } = await make();
    const get = (origin: string, path: string) =>
      crawler.fetch({ url: `${origin}${path}`, mode: "page", recipe: "page" });
    expect((await get(five.origin, "/public")).outcome).toBe("ok");
    expect((await get(five.origin, "/private")).note).toBe(
      "robots.txt disallows it for PoliteCrawler",
    );
    const refused = await get(six.origin, "/public");
    expect(refused.outcome).toBe("skipped");
    expect(refused.note).toBe(
      "robots.txt could not be read (more than 5 redirects), so nothing on the site is fetched",
    );
    expect(six.paths()).not.toContain("/public");
  });

  it("keeps a robots.txt for 24 hours, then asks again", async () => {
    const site = await serve((request, response) => {
      response.end(request.url === "/robots.txt" ? "User-agent: *\nAllow: /\n" : "page");
    });
    const { crawler, clock } = await make();
    const get = (path: string) =>
      crawler.fetch({ url: `${site.origin}${path}`, mode: "page", recipe: "page" });
    const robotsAsked = () => site.paths().filter((path) => path === "/robots.txt").length;
    await get("/a");
    clock.advance(23 * 60 * 60 * 1000);
    await get("/b");
    expect(robotsAsked()).toBe(1);
    clock.advance(2 * 60 * 60 * 1000);
    await get("/c");
    expect(robotsAsked()).toBe(2);
  });
});

describe("waits, errors and stops", () => {
  it("stops a host that asks for a wait past the budget, and backs off on a Retry-After it cannot read", async () => {
    const site = await serve((request, response) => {
      if (request.url === "/long") response.writeHead(429, { "retry-after": "3000000" });
      else if (request.url === "/odd") response.writeHead(503, { "retry-after": "1.5" });
      else response.writeHead(200);
      response.end("x");
    });
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning.name);
    };
    process.on("warning", onWarning);
    try {
      const { crawler, clock } = await make();
      const get = (path: string) =>
        crawler.fetch({ url: `${site.origin}${path}`, mode: "api", recipe: "t" });
      await get("/odd");
      // the backoff applies: half of the 5 s step, and half of the rest at random 0.5
      expect(clock.slept).toEqual([]);
      await get("/ok");
      expect(clock.slept).toHaveLength(1);
      expect(clock.slept[0]).toBeGreaterThan(3600);
      expect(clock.slept[0]).toBeLessThanOrEqual(3750);
      expect((await get("/long")).outcome).toBe("rate-limited");
      const after = await get("/ok");
      expect(after.outcome).toBe("skipped");
      expect(after.note).toMatch(/^host stopped until .*: asked to wait 3000000 s$/);
      // the server asked for 34.7 days, and a stop lasts 30 days at most
      const until = Date.parse(/^host stopped until (\S+):/.exec(after.note ?? "")?.[1] ?? "");
      const month = 30 * 24 * 60 * 60 * 1000;
      expect(until - clock.now()).toBeLessThanOrEqual(month);
      expect(until - clock.now()).toBeGreaterThan(month - 60_000);
      expect(warnings).not.toContain("TimeoutOverflowWarning");
    } finally {
      process.off("warning", onWarning);
    }
  });

  it("keeps client errors and requests to wait out of the stop count", async () => {
    const site = await serve((request, response) => {
      const status = request.url?.startsWith("/bad")
        ? 400
        : request.url?.startsWith("/busy")
          ? 503
          : request.url === "/broken"
            ? 500
            : 200;
      response.writeHead(status);
      response.end("x");
    });
    const { crawler } = await make();
    const get = (path: string) =>
      crawler.fetch({ url: `${site.origin}${path}`, mode: "api", recipe: "t" });
    for (let index = 0; index < 5; index += 1)
      expect((await get(`/bad${String(index)}`)).outcome).toBe("error");
    expect((await get("/good")).outcome).toBe("ok");
    for (let index = 0; index < 4; index += 1)
      expect((await get(`/busy${String(index)}`)).outcome).toBe("unavailable");
    expect((await get("/broken")).outcome).toBe("error");
    expect((await get("/good")).outcome).toBe("ok");
  });

  it("ends a stop after its time, and resetHosts ends it at once", async () => {
    const site = await serve((request, response) => {
      response.writeHead(request.url === "/wp-admin/" ? 403 : 200);
      response.end("x");
    });
    const { crawler, clock } = await make();
    const get = (path: string) =>
      crawler.fetch({ url: `${site.origin}${path}`, mode: "api", recipe: "t" });
    expect((await get("/wp-admin/")).outcome).toBe("blocked");
    expect((await get("/blog/post")).note).toMatch(/^host stopped until .*: blocked$/);
    clock.advance(61 * 60 * 1000);
    expect((await get("/blog/post")).outcome).toBe("ok");
    expect((await get("/wp-admin/")).outcome).toBe("blocked");
    expect((await get("/blog/post")).outcome).toBe("skipped");
    crawler.resetHosts();
    expect((await get("/blog/post")).outcome).toBe("ok");
  });

  it("uses the last good robots.txt while robots.txt answers 503, and asks again minutes later", async () => {
    let robotsDown = false;
    const site = await serve((request, response) => {
      if (request.url === "/robots.txt") {
        if (robotsDown) {
          response.writeHead(503);
          response.end();
          return;
        }
        response.end("User-agent: *\nDisallow: /private\n");
        return;
      }
      response.end("page");
    });
    const { crawler, clock } = await make();
    const get = (path: string) =>
      crawler.fetch({ url: `${site.origin}${path}`, mode: "page", recipe: "page" });
    const robotsAsked = () => site.paths().filter((path) => path === "/robots.txt").length;
    expect((await get("/public")).outcome).toBe("ok");
    robotsDown = true;
    clock.advance(25 * 60 * 60 * 1000);
    // the robots.txt answers 503, and the copy of yesterday still applies
    expect((await get("/public")).outcome).toBe("ok");
    expect((await get("/private")).note).toBe("robots.txt disallows it for PoliteCrawler");
    expect(robotsAsked()).toBe(2);
    // the first wait is half to all of 5 minutes: 3.75 minutes at random 0.5
    clock.advance(2 * 60 * 1000);
    await get("/public");
    expect(robotsAsked()).toBe(2);
    clock.advance(2 * 60 * 1000);
    await get("/public");
    expect(robotsAsked()).toBe(3);
  });

  it("honors the Retry-After of an unreachable robots.txt before it asks again", async () => {
    let robotsDown = true;
    const site = await serve((request, response) => {
      if (request.url === "/robots.txt" && robotsDown) {
        response.writeHead(503, { "retry-after": "900" });
        response.end();
        return;
      }
      response.end(request.url === "/robots.txt" ? "User-agent: *\nAllow: /\n" : "page");
    });
    const { crawler, clock } = await make();
    const get = (path: string) =>
      crawler.fetch({ url: `${site.origin}${path}`, mode: "page", recipe: "page" });
    expect((await get("/a")).note).toBe(
      "robots.txt could not be read (status 503), so nothing on the site is fetched",
    );
    robotsDown = false;
    clock.advance(10 * 60 * 1000);
    expect((await get("/a")).outcome).toBe("skipped");
    expect(site.paths()).toEqual(["/robots.txt"]);
    clock.advance(6 * 60 * 1000);
    expect((await get("/a")).outcome).toBe("ok");
    expect(site.paths()).toEqual(["/robots.txt", "/robots.txt", "/a"]);
  });

  it("applies the rules for an agent before a stored copy answers it", async () => {
    const site = await serve((request, response) => {
      if (request.url === "/robots.txt") {
        response.end("User-agent: Claude-User\nDisallow: /members\n\nUser-agent: *\nAllow: /\n");
        return;
      }
      response.end("members only");
    });
    const { crawler } = await make();
    const url = `${site.origin}/members`;
    expect((await crawler.fetch({ url, mode: "page", recipe: "page" })).outcome).toBe("ok");
    const asked = await crawler.fetch({
      url,
      mode: "page",
      recipe: "page",
      onBehalfOf: ["Claude-User"],
      maxAgeMs: 86_400_000,
    });
    expect(asked).toMatchObject({
      outcome: "skipped",
      note: "robots.txt disallows it for Claude-User",
    });
  });

  it("records why a page was permitted: the robots.txt capture, the tokens and the rule", async () => {
    const site = await serve((request, response) => {
      if (request.url === "/robots.txt") {
        response.end("User-agent: *\nDisallow: /private\nAllow: /private/open\n");
        return;
      }
      response.end("page");
    });
    const { crawler, captures } = await make();
    await crawler.fetch({ url: `${site.origin}/private/open/a`, mode: "page", recipe: "page" });
    await crawler.fetch({ url: `${site.origin}/private/x`, mode: "page", recipe: "page" });
    const [robots, page, skipped] = await captures();
    expect(payloadOf(page!)).toMatchObject({
      schema: 2,
      robots: "allowed",
      robots_check: {
        capture: robots!.id,
        tokens: ["PoliteCrawler"],
        rule: { line: 3, pattern: "/private/open", allow: true },
        group_line: 1,
      },
    });
    expect(payloadOf(skipped!)).toMatchObject({
      robots_check: { rule: { line: 2, pattern: "/private", allow: false } },
    });
  });
});

describe("the identity and the secrets of a request", () => {
  it("never lets a caller header replace the User-Agent, the From header or the codings", async () => {
    const site = await serve((_request, response) => response.end("x"));
    const { crawler } = await make({ from: "ops@example.com" });
    await crawler.fetch({
      url: `${site.origin}/x`,
      mode: "api",
      recipe: "t",
      headers: {
        "User-Agent": "Mozilla/5.0 Chrome/130",
        from: "someone@else.example",
        "Accept-Encoding": "zstd",
        "If-None-Match": '"forged"',
        "X-Api-Version": "2",
      },
    });
    const headers = site.hits[0]!.headers;
    expect(headers["user-agent"]).toBe("PoliteCrawler/0.1 (test)");
    expect(headers["from"]).toBe("ops@example.com");
    expect(headers["accept-encoding"]).toBe("gzip, deflate, br");
    expect(headers["if-none-match"]).toBeUndefined();
    expect(headers["x-api-version"]).toBe("2");
  });

  it("writes no user name, password or default secret into a capture, and keeps the query as written", async () => {
    const site = await serve((_request, response) => response.end("x"));
    const { crawler, captures } = await make();
    const url = `http://alice:hunter2@127.0.0.1:${String(site.port)}/x?q=a%20b/c,d~e*f&token=TOK456`;
    const fetched = await crawler.fetch({ url, mode: "api", recipe: "t" });
    expect(fetched.url).toBe(`${site.origin}/x?q=a%20b/c,d~e*f&token=REDACTED`);
    const log = JSON.stringify(await captures());
    expect(log).not.toContain("hunter2");
    expect(log).not.toContain("TOK456");
  });
});

describe("closing and cancelling", () => {
  it("ends queued work at close with no capture, and fast", async () => {
    const site = await serve((_request, response) => response.end("x"));
    const { crawler, captures } = await make({
      clock: undefined,
      politeness: { apiIntervalMs: 2000 },
    });
    const get = (path: string) =>
      crawler.fetch({ url: `${site.origin}${path}`, mode: "api", recipe: "t" });
    const first = get("/1");
    const queued = [get("/2"), get("/3")];
    await first;
    const started = Date.now();
    await crawler.close();
    const results = await Promise.all(queued);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(results.map((result) => [result.outcome, result.note, result.capture])).toEqual([
      ["skipped", "crawler closed", undefined],
      ["skipped", "crawler closed", undefined],
    ]);
    expect(site.paths()).toEqual(["/1"]);
    expect(await captures()).toHaveLength(1);
    expect((await get("/4")).note).toBe("crawler closed");
  });

  it("stops a request when the caller aborts it", async () => {
    const site = await serve((_request, response) => response.end("x"));
    const { crawler } = await make({ clock: undefined, politeness: { apiIntervalMs: 5000 } });
    await crawler.fetch({ url: `${site.origin}/1`, mode: "api", recipe: "t" });
    const controller = new AbortController();
    const waiting = crawler.fetch({
      url: `${site.origin}/2`,
      mode: "api",
      recipe: "t",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    expect(await waiting).toMatchObject({ outcome: "skipped", note: "cancelled by the caller" });
    expect(site.paths()).toEqual(["/1"]);
  });
});

describe("the politeness policy", () => {
  it("gives one host its own pace", async () => {
    const site = await serve((_request, response) => response.end("x"));
    const { crawler, clock } = await make({
      politeness: { hosts: { "127.0.0.1": { apiIntervalMs: 7000 } } },
    });
    await crawler.fetch({ url: `${site.origin}/a`, mode: "api", recipe: "t" });
    await crawler.fetch({ url: `${site.origin}/b`, mode: "api", recipe: "t" });
    expect(clock.slept).toHaveLength(1);
    expect(clock.slept[0]).toBeGreaterThan(6800);
    expect(clock.slept[0]).toBeLessThanOrEqual(7000);
  });

  it("refuses options that are not numbers, and a token that robots.txt cannot match", async () => {
    await expect(make({ politeness: { pageIntervalMs: Number.NaN } })).rejects.toThrow(RangeError);
    await expect(make({ maxActive: 0 })).rejects.toThrow(RangeError);
    await expect(make({ token: "Crawler9" })).rejects.toThrow(/not a product token/);
    await expect(make({ from: "ops@exämple.com" })).rejects.toThrow(/printable ASCII/);
    const site = await serve((_request, response) => response.end("x"));
    const { crawler } = await make();
    expect(
      await crawler.fetch({ url: `${site.origin}/a`, mode: "api", recipe: "t", maxBytes: -1 }),
    ).toMatchObject({
      outcome: "skipped",
      note: "invalid option: maxBytes is -1",
    });
  });
});
