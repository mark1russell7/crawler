import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { FileBlobStore } from "./blobs.ts";
import type { CrawlEvent, CrawlerOptions } from "./crawler.ts";
import { Crawler, RENDERED_TYPE } from "./crawler.ts";
import { DocIndex } from "./docs.ts";
import { CaptureLog } from "./log.ts";
import type { CaptureRecord } from "./record.ts";
import type { RenderOptions, Renderer } from "./render.ts";
import { RenderRefused } from "./render.ts";
import { HTML_ROBOTS } from "./robots.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";

// Each test here talks to a real HTTP server on 127.0.0.1 with the default dispatcher of the
// crawler: no mock agent. The clock of the test moves when the crawler sleeps.

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const servers: Server[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

const serve = async (handler: Handler) => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, port, paths };
};

const make = async (options: Partial<CrawlerOptions> = {}) => {
  const dir = await tempDir("socket");
  const log = new CaptureLog(join(dir, "crawl"));
  const index = new DocIndex(":memory:");
  const events: CrawlEvent[] = [];
  const crawler = new Crawler({
    token: "PoliteCrawler",
    userAgent: "PoliteCrawler/0.1 (test)",
    from: "ops@example.com",
    log,
    blobs: new FileBlobStore(join(dir, "blobs")),
    index,
    clock: fakeClock(),
    random: () => 0.5,
    egress: { allowPrivate: true },
    onEvent: (event) => events.push(event),
    ...options,
  });
  cleanups.push(async () => {
    await crawler.close();
    index.close();
    await removeDir(dir);
  });
  const captures = async (): Promise<CaptureRecord[]> => {
    const rows: CaptureRecord[] = [];
    for await (const row of new CaptureLog(join(dir, "crawl")).scan({ source: "fetch" }))
      rows.push(row);
    return rows;
  };
  return { crawler, events, captures, index };
};

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

describe("bodies on a real socket", () => {
  it("reads aws-chunked as the body itself, and keeps the first part of a gzip body that the server cut", async () => {
    const page = "<p>the whole page</p>".repeat(200);
    const zipped = gzipSync(page);
    const site = await serve((request, response) => {
      if (request.url === "/aws") {
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-encoding": "aws-chunked",
        });
        response.end("plain words");
        return;
      }
      // the server closes the stream before the end of the gzip data
      response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      response.end(zipped.subarray(0, Math.floor(zipped.length * 0.6)));
    });
    const { crawler } = await make();
    const aws = await crawler.fetch({
      url: `${site.origin}/aws`,
      mode: "api",
      recipe: "t",
      minIntervalMs: 0,
    });
    expect(aws).toMatchObject({ outcome: "ok" });
    expect(text(aws.body)).toBe("plain words");
    const cut = await crawler.fetch({
      url: `${site.origin}/cut`,
      mode: "api",
      recipe: "t",
      minIntervalMs: 0,
    });
    expect(cut).toMatchObject({ outcome: "ok", truncated: true });
    expect(cut.note).toMatch(/^the compressed body ended early/);
    expect(page.startsWith(text(cut.body))).toBe(true);
    expect(cut.body!.length).toBeGreaterThan(0);
  });

  it("reads a cut robots.txt as unreadable, and fetches no page of the site", async () => {
    const rules = gzipSync("User-agent: *\nDisallow: /private\n".repeat(400));
    const site = await serve((request, response) => {
      if (request.url === "/robots.txt") {
        response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        response.end(rules.subarray(0, Math.floor(rules.length / 2)));
        return;
      }
      response.end("page");
    });
    const { crawler } = await make();
    const page = await crawler.fetch({ url: `${site.origin}/open`, mode: "page", recipe: "page" });
    expect(page.outcome).toBe("skipped");
    expect(page.note).toMatch(/^robots\.txt could not be read \(the compressed body ended early/);
    expect(site.paths).toEqual(["/robots.txt"]);
  });

  it("reads a robots.txt that is a challenge page as unreadable", async () => {
    const site = await serve((request, response) => {
      if (request.url === "/robots.txt") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<!DOCTYPE html><html><head><title>Security Verification</title><script src="https://www.google.com/recaptcha/api.js"></script></head><body><div class="g-recaptcha"></div></body></html>`,
        );
        return;
      }
      response.end("page");
    });
    const { crawler } = await make();
    const page = await crawler.fetch({ url: `${site.origin}/jobs`, mode: "page", recipe: "page" });
    expect(page).toMatchObject({
      outcome: "skipped",
      note: `robots.txt could not be read (${HTML_ROBOTS}), so nothing on the site is fetched`,
    });
    expect((await crawler.readRobots(`${site.origin}/jobs`)).robots.unreachable).toBe(HTML_ROBOTS);
  });
});

describe("failures on a real socket", () => {
  it("stops a host after five connections that fail, and says so in an event", async () => {
    const site = await serve((_request, response) => response.end("x"));
    const port = site.port;
    servers.pop()!.close();
    const { crawler, events } = await make();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await crawler.fetch({
        url: `http://127.0.0.1:${String(port)}/a`,
        mode: "api",
        recipe: "t",
      });
      expect(failed).toMatchObject({ outcome: "error", status: 0 });
    }
    const stopped = await crawler.fetch({
      url: `http://127.0.0.1:${String(port)}/a`,
      mode: "api",
      recipe: "t",
    });
    expect(stopped.outcome).toBe("skipped");
    expect(stopped.note).toMatch(/^host stopped until .*: 5 failures in a row$/);
    expect(events.filter((event) => event.type === "stop")).toEqual([
      expect.objectContaining({
        type: "stop",
        host: `127.0.0.1:${String(port)}`,
        reason: "5 failures in a row",
      }),
    ]);
    expect(events.some((event) => event.type === "wait" && event.reason === "backoff")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "skip" });
  });

  it("gives a request, a response and a skip event, and a listener that throws changes nothing", async () => {
    const site = await serve((request, response) => {
      if (request.url === "/robots.txt") response.end("User-agent: *\nDisallow: /no\n");
      else response.end("<p>yes</p>");
    });
    const seen: string[] = [];
    const { crawler } = await make({
      onEvent: (event) => {
        seen.push(`${event.type} ${"url" in event ? new URL(event.url).pathname : ""}`);
        throw new Error("a listener that fails");
      },
    });
    expect(
      (await crawler.fetch({ url: `${site.origin}/yes`, mode: "page", recipe: "page" })).outcome,
    ).toBe("ok");
    expect(
      (await crawler.fetch({ url: `${site.origin}/no`, mode: "page", recipe: "page" })).outcome,
    ).toBe("skipped");
    expect(seen).toEqual([
      "request /robots.txt",
      "response /robots.txt",
      "request /yes",
      "response /yes",
      "skip /no",
    ]);
  });
});

describe("a render through the crawler", () => {
  const renderer = (
    behave: (url: string, options: RenderOptions) => Promise<string>,
  ): Renderer & { seen: RenderOptions[] } => {
    const seen: RenderOptions[] = [];
    return {
      seen,
      render: async (url, options) => {
        seen.push(options);
        return { html: await behave(url, options), finalUrl: url, status: 200, headers: {} };
      },
      close: () => Promise.resolve(),
    };
  };

  it("passes the rules, the From header and the signal, and stores the page as UTF-8 HTML", async () => {
    const site = await serve((request, response) => {
      response.end(request.url === "/robots.txt" ? "User-agent: *\nDisallow: /secret\n" : "x");
    });
    const browser = renderer(() => Promise.resolve("<p>shown</p>"));
    const { crawler, captures } = await make({ renderer: browser });
    const done = await crawler.render({ url: `${site.origin}/page`, recipe: "page" });
    expect(done).toMatchObject({ outcome: "ok", contentType: RENDERED_TYPE });
    const options = browser.seen[0]!;
    expect(options.headers).toEqual({ from: "ops@example.com" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(await options.allowRequest!(`${site.origin}/secret`)).toBe(false);
    expect(await options.allowRequest!(`${site.origin}/app.js`)).toBe(true);
    expect(await options.allowRequest!("http://10.0.0.1/x")).toBe(true);
    const row = (await captures()).find(
      (capture) => (capture.payload as { rendered?: boolean }).rendered === true,
    )!;
    expect(row.payload).toMatchObject({ content_type: RENDERED_TYPE, outcome: "ok" });
  });

  it("skips a refused render and calls a download not-html, and neither counts against the host", async () => {
    const site = await serve((request, response) => {
      response.end(request.url === "/robots.txt" ? "User-agent: *\nAllow: /\n" : "x");
    });
    const browser = renderer((url) => {
      if (url.endsWith("/file"))
        throw new RenderRefused("download", `${url} gives a file, not a page`);
      throw new RenderRefused("refused", `the request for ${url} was refused`);
    });
    const { crawler } = await make({ renderer: browser });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const refused = await crawler.render({
        url: `${site.origin}/page${String(attempt)}`,
        recipe: "page",
      });
      expect(refused).toMatchObject({ outcome: "skipped" });
      expect(refused.note).toMatch(/was refused$/);
    }
    const file = await crawler.render({ url: `${site.origin}/file`, recipe: "page" });
    expect(file).toMatchObject({ outcome: "not-html", body: undefined });
    // six refusals and a file are no failure of the host: it is not stopped
    const after = await crawler.render({ url: `${site.origin}/again`, recipe: "page" });
    expect(after.note).not.toMatch(/host stopped/);
  });
});
