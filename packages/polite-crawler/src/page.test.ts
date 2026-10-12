import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { FileBlobStore } from "./blobs.ts";
import { Crawler } from "./crawler.ts";
import { DocIndex } from "./docs.ts";
import { CaptureLog } from "./log.ts";
import type { Renderer } from "./render.ts";
import type { CrawlRuntime } from "./runtime.ts";
import { Extractors, fetchPage, reindex } from "./runtime.ts";

let dir: string | undefined;
// a capture log keeps its file open: one left open is closed by the garbage
// collector, which Node treats as an uncaught error
const logs: CaptureLog[] = [];
const opened = (log: CaptureLog): CaptureLog => {
  logs.push(log);
  return log;
};
afterEach(async () => {
  for (const log of logs.splice(0)) await log.close();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const SHELL =
  '<html><head><title>Bistro</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
const SHOWN = `<html><head><title>Bistro</title>
<script type="application/ld+json">{"@type":"Restaurant","name":"Bistro","openingHours":"Mo-Fr 17:00-22:00"}</script>
</head><body><div id="root"><h1>Bistro</h1><p>Dinner Monday to Friday, 5 to 10.</p><a href="/menu">Menu</a></div></body></html>`;
const PLAIN = `<html><head><title>Cafe</title></head><body><h1>Cafe</h1><p>${"Coffee and pastries every morning. ".repeat(12)}</p></body></html>`;

/** a stand-in browser: says what it was asked to render */
const fakeRenderer = (html: string): Renderer & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    render: (url) => {
      asked.push(url);
      return Promise.resolve({ html, finalUrl: url, status: 200, headers: {} });
    },
    close: () => Promise.resolve(),
  };
};

const setup = async (renderer: Renderer) => {
  dir = await mkdtemp(join(tmpdir(), "polite-crawler-pages-"));
  const agent = new MockAgent();
  agent.disableNetConnect();
  const blobs = new FileBlobStore(join(dir, "blobs"));
  const log = opened(new CaptureLog(join(dir, "crawl")));
  const index = new DocIndex(":memory:");
  const runtime: CrawlRuntime = {
    crawler: new Crawler({
      token: "PoliteCrawler",
      userAgent: "PoliteCrawler/0.1 (test)",
      log,
      blobs,
      index,
      renderer,
      dispatcher: agent,
      clock: { now: () => Date.parse("2026-10-07T12:00:00Z"), sleep: () => Promise.resolve() },
    }),
    index,
    blobs,
    captures: log,
    log,
    extractors: new Extractors(),
    now: () => "2026-10-07T12:00:00.000Z",
  };
  return { agent, runtime };
};

const site = (agent: MockAgent, origin: string, robots: string, pages: Record<string, string>) => {
  const pool = agent.get(origin);
  pool.intercept({ path: "/robots.txt", method: "GET" }).reply(200, robots);
  for (const [path, html] of Object.entries(pages)) {
    pool
      .intercept({ path, method: "GET" })
      .reply(200, html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
};

describe("reading pages, rendering only on evidence", () => {
  it("renders a page that shows nothing without JavaScript, and keeps both captures", async () => {
    const browser = fakeRenderer(SHOWN);
    const { agent, runtime } = await setup(browser);
    site(agent, "https://bistro.example", "User-agent: *\nAllow: /\n", { "/": SHELL });
    const page = await fetchPage(runtime, "https://bistro.example/", { render: "auto" });
    expect(browser.asked).toEqual(["https://bistro.example/"]);
    expect(page).toMatchObject({
      doc: "url:https://bistro.example/",
      rendered: true,
      structured: ["Restaurant"],
      links: 1,
    });
    expect(page.captures).toHaveLength(2);
    expect(runtime.index.get(page.doc!)!.text).toContain("Dinner Monday to Friday, 5 to 10.");
  });

  it("does not open the browser for a page that already shows its content", async () => {
    const browser = fakeRenderer(SHOWN);
    const { agent, runtime } = await setup(browser);
    site(agent, "https://cafe.example", "User-agent: *\nAllow: /\n", { "/": PLAIN });
    const page = await fetchPage(runtime, "https://cafe.example/", { render: "auto" });
    expect(browser.asked).toEqual([]);
    expect(page).toMatchObject({ rendered: false, title: "Cafe" });
  });

  it("never renders when told not to, and never renders a page robots.txt declines", async () => {
    const browser = fakeRenderer(SHOWN);
    const { agent, runtime } = await setup(browser);
    site(agent, "https://bistro.example", "User-agent: *\nDisallow: /private\n", { "/": SHELL });
    expect(
      (await fetchPage(runtime, "https://bistro.example/", { render: "never" })).rendered,
    ).toBe(false);
    const declined = await fetchPage(runtime, "https://bistro.example/private", {
      render: "always",
    });
    expect(declined).toMatchObject({ outcome: "skipped", doc: null, rendered: false });
    expect(browser.asked).toEqual([]);
  });

  it("rebuilds rendered pages from the capture log like any other", async () => {
    const { agent, runtime } = await setup(fakeRenderer(SHOWN));
    site(agent, "https://bistro.example", "User-agent: *\nAllow: /\n", { "/": SHELL });
    await fetchPage(runtime, "https://bistro.example/", { render: "auto" });
    await runtime.log.close();
    const rebuilt = { ...runtime, index: new DocIndex(":memory:") };
    expect(await reindex(rebuilt)).toEqual({ captures: 3, docs: 1, urls: 3 });
    expect(rebuilt.index.get("url:https://bistro.example/")!.text).toContain(
      "Dinner Monday to Friday",
    );
  });
});
