import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PlaywrightRenderer } from "./render.ts";
import { RenderRefused, playwrightRenderer } from "./render.ts";
import { extractPage } from "./html.ts";

/**
 * The real browser, against a local site: an app shell whose script draws
 * the hours after 300 ms, and images the browser must never ask for. If
 * Playwright's browser is not installed on this machine, the test says so and
 * skips; the stand-in renderer in page.test.ts covers the decision either way.
 */

const SHELL = `<!doctype html><html><head><title>Late</title></head><body>
<div id="root"></div><img src="/logo.png"><img src="/cdn/image/upload/abc"><img src="/b.PNG">
<script>setTimeout(function () {
  document.getElementById("root").innerHTML =
    "<h1>Hours</h1><p>Wed-Sun 17:00-23:00</p><p>The kitchen closes an hour before the bar. 12 Main St, Springfield, MA.</p>";
}, 300);</script></body></html>`;

const FILLER = "<p>The kitchen closes an hour before the bar. 12 Main St, Springfield, MA.</p>";
const PAGES: Record<string, string> = {
  "/late": SHELL,
  "/fetches": `<html><body>${FILLER}<div id="root"></div><script>
fetch("/api/hours").then(function (r) { return r.text(); }).then(function (t) { document.getElementById("root").textContent = t; });
</script></body></html>`,
  "/shadow": `<html><body><div id="host"></div><script>
var root = document.getElementById("host").attachShadow({ mode: "open" });
root.innerHTML = "<h2>Hours</h2><p>Tue-Sun 11am-9pm</p>";
</script></body></html>`,
  "/frame": `<html><body>${FILLER}<iframe src="/inner"></iframe></body></html>`,
  "/inner": "<html><body><p>Brunch Sat-Sun 10am-2pm</p></body></html>",
  "/blank": '<html><body><div id="root"></div></body></html>',
  "/hang": `<html><body>${FILLER}<script>setTimeout(function () { for (;;) {} }, 50);</script></body></html>`,
  "/alert": `<html><body>${FILLER}<script>alert("hi"); confirm("sure?"); window.open("/inner");</script></body></html>`,
};

const asked: Array<{ readonly path: string; readonly from: string | undefined }> = [];
const server = createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0]!;
  const from = request.headers["from"];
  asked.push({ path, from: typeof from === "string" ? from : undefined });
  if (/\.(png|PNG)$/.test(path) || path.startsWith("/cdn/")) {
    response.writeHead(200, { "content-type": "image/png" }).end(Buffer.alloc(16));
    return;
  }
  if (path === "/api/hours") {
    response.writeHead(200, { "content-type": "text/plain" }).end("Secret hours from the API");
    return;
  }
  if (path === "/download") {
    response
      .writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": "attachment; filename=menu.pdf",
      })
      .end("%PDF-1.4\n");
    return;
  }
  const page = PAGES[path];
  response
    .writeHead(page === undefined ? 404 : 200, { "content-type": "text/html" })
    .end(page ?? "no");
});

const OPTIONS = { userAgent: "PoliteCrawler/0.1 (test)", timeoutMs: 15_000 } as const;
let base = "";
let renderer: PlaywrightRenderer | undefined;
let unavailable: string | undefined;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  renderer = playwrightRenderer();
  try {
    await renderer.render(`${base}/warmup`, OPTIONS);
  } catch (error) {
    unavailable = error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error);
  }
  asked.length = 0;
}, 60_000);

afterAll(async () => {
  await renderer?.close();
  // close() waits out keep-alive connections the browser left open, which
  // under a loaded full suite outran the default hook timeout
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}, 60_000);

const paths = (): string[] => asked.map(({ path }) => path);

describe("the headless browser", () => {
  it("shows what a script draws, and never fetches the images", async (context) => {
    if (unavailable !== undefined)
      context.skip(`Playwright's browser could not start: ${unavailable}`);
    asked.length = 0;
    const shown = await renderer!.render(`${base}/late`, OPTIONS);
    expect(extractPage(SHELL, `${base}/late`).needsRender).toBe(true);
    const page = extractPage(shown.html, shown.finalUrl);
    expect(page.text).toContain("Wed-Sun 17:00-23:00");
    expect(page.needsRender).toBe(false);
    expect(shown.status).toBe(200);
    // an image with no extension or in capitals is still an image
    expect(paths()).toEqual(["/late"]);
  }, 60_000);

  it("asks allowRequest about each request, and sends the headers with each one", async (context) => {
    if (unavailable !== undefined)
      context.skip(`Playwright's browser could not start: ${unavailable}`);
    asked.length = 0;
    const decided: string[] = [];
    const shown = await renderer!.render(`${base}/fetches`, {
      ...OPTIONS,
      headers: { From: "bot-admin@example.org" },
      allowRequest: (url) => {
        decided.push(new URL(url).pathname);
        return !url.includes("/api/");
      },
    });
    expect(decided).toEqual(["/fetches", "/api/hours"]);
    expect(paths()).toEqual(["/fetches"]);
    expect(asked[0]!.from).toBe("bot-admin@example.org");
    expect(extractPage(shown.html, shown.finalUrl).text).not.toContain("Secret hours");
    // a refused first navigation is no render, and no failure of the site
    asked.length = 0;
    const refused = renderer!.render(`${base}/api/hours`, { ...OPTIONS, allowRequest: () => false });
    await expect(refused).rejects.toBeInstanceOf(RenderRefused);
    await expect(refused).rejects.toMatchObject({ reason: "refused" });
    expect(paths()).toEqual([]);
  }, 60_000);

  it("reads open shadow roots and frames of the same origin, and stops waiting on an empty page", async (context) => {
    if (unavailable !== undefined)
      context.skip(`Playwright's browser could not start: ${unavailable}`);
    const shadow = await renderer!.render(`${base}/shadow`, OPTIONS);
    expect(extractPage(shadow.html, shadow.finalUrl).text).toContain("Tue-Sun 11am-9pm");
    const framed = await renderer!.render(`${base}/frame`, OPTIONS);
    expect(extractPage(framed.html, framed.finalUrl).text).toContain("Brunch Sat-Sun 10am-2pm");
    expect(framed.html).toContain(`data-polite-frame="${base}/inner"`);
    const started = Date.now();
    await renderer!.render(`${base}/blank`, OPTIONS);
    // the wait used to run to its 12-second limit
    expect(Date.now() - started).toBeLessThan(8000);
  }, 60_000);

  it("dismisses dialogs and closes popups", async (context) => {
    if (unavailable !== undefined)
      context.skip(`Playwright's browser could not start: ${unavailable}`);
    const shown = await renderer!.render(`${base}/alert`, OPTIONS);
    expect(extractPage(shown.html, shown.finalUrl).text).toContain("The kitchen closes");
    expect(shown.finalUrl).toBe(`${base}/alert`);
  }, 60_000);

  it("stops a page that never yields at the deadline, and renders the next page", async (context) => {
    if (unavailable !== undefined)
      context.skip(`Playwright's browser could not start: ${unavailable}`);
    const started = Date.now();
    await expect(
      renderer!.render(`${base}/hang`, { ...OPTIONS, timeoutMs: 4000 }),
    ).rejects.toThrow(/timed out after 4000 ms/);
    expect(Date.now() - started).toBeLessThan(12_000);
    const next = await renderer!.render(`${base}/late`, OPTIONS);
    expect(extractPage(next.html, next.finalUrl).text).toContain("Wed-Sun 17:00-23:00");
  }, 60_000);

  it("refuses a download and a URL that is not http, as no failure of the host", async (context) => {
    if (unavailable !== undefined)
      context.skip(`Playwright's browser could not start: ${unavailable}`);
    await expect(renderer!.render(`${base}/download`, OPTIONS)).rejects.toMatchObject({
      name: "RenderRefused",
      reason: "download",
    });
    await expect(
      renderer!.render("data:text/html,<p>hello</p>", OPTIONS),
    ).rejects.toMatchObject({ reason: "scheme" });
  }, 60_000);

  it("launches a new browser when the old one disconnects", async (context) => {
    if (unavailable !== undefined)
      context.skip(`Playwright's browser could not start: ${unavailable}`);
    const { chromium } = await import("playwright-core");
    const launched: Browser[] = [];
    const own = playwrightRenderer({
      launch: async () => {
        const browser = await chromium.launch({ headless: true });
        launched.push(browser);
        return browser;
      },
    });
    try {
      await own.render(`${base}/late`, OPTIONS);
      await launched[0]!.close();
      const again = await own.render(`${base}/late`, OPTIONS);
      expect(extractPage(again.html, again.finalUrl).text).toContain("Wed-Sun 17:00-23:00");
      expect(launched).toHaveLength(2);
    } finally {
      await own.close();
    }
  }, 60_000);

  it("closes the browser once it has been idle", async (context) => {
    if (unavailable !== undefined)
      context.skip(`Playwright's browser could not start: ${unavailable}`);
    const brief = playwrightRenderer({ idleMs: 200 });
    await brief.render(`${base}/late`, OPTIONS);
    expect(brief.open()).toBe(true);
    // a busy computer can fire the idle timer late: the test waits for it, with a limit
    await vi.waitFor(() => expect(brief.open()).toBe(false), { timeout: 10_000, interval: 50 });
    await brief.close();
  }, 60_000);
});
