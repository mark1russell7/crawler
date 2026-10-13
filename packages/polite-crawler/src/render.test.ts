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
  "/hops": `<html><body>${FILLER}<div id="out"></div><iframe src="/frame-out"></iframe><script>
["/fetch-out", "/api-chain"].forEach(function (path) {
  fetch(path).then(function (r) { return r.text(); }).then(function (t) { document.getElementById("out").textContent += " " + t; }, function () {});
});
</script></body></html>`,
  "/end": `<html><body>${FILLER}<p>PUBLIC-END</p></body></html>`,
  "/restless": `<html><body>${FILLER}<script>setTimeout(function () { location.replace("/restless"); }, 30);</script></body></html>`,
  "/js-out": `<html><body>${FILLER}<script>setTimeout(function () { location.href = "/internal/js"; }, 300);</script></body></html>`,
};
/** These paths redirect to the path that they give. The paths under /internal/ stand for a private address. */
const HOPS: Record<string, string> = {
  "/fetch-out": "/internal/fetch",
  "/frame-out": "/internal/frame",
  "/nav-out": "/internal/nav",
  "/api-chain": "/api-chain2",
  "/api-chain2": "/api-end",
  "/chain": "/chain2",
  "/chain2": "/end",
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
  if (path.startsWith("/internal/")) {
    response.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" }).end(`INTERNAL ${path}`);
    return;
  }
  const hop = HOPS[path] ?? (/^\/loop\/\d+$/.test(path) ? `/loop/${String(Number(path.slice(6)) + 1)}` : undefined);
  if (hop !== undefined) {
    response.writeHead(302, { location: hop }).end();
    return;
  }
  if (path === "/api-end") {
    response.writeHead(200, { "content-type": "text/plain" }).end("PUBLIC-FETCH-END");
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

  it("follows each redirect in the route, so a step that allowRequest refuses is never requested", async (context) => {
    if (unavailable !== undefined)
      context.skip(`Playwright's browser could not start: ${unavailable}`);
    const decided: string[] = [];
    const options = {
      ...OPTIONS,
      headers: { From: "bot-admin@example.org" },
      allowRequest: (url: string) => {
        decided.push(new URL(url).pathname);
        return !new URL(url).pathname.startsWith("/internal/");
      },
    };
    asked.length = 0;
    const shown = await renderer!.render(`${base}/hops`, options);
    const text = extractPage(shown.html, shown.finalUrl).text;
    // a fetch and a frame that redirect to a refused address: allowRequest refuses the step, and the server never sees it
    expect(decided).toEqual(expect.arrayContaining(["/hops", "/fetch-out", "/internal/fetch", "/frame-out", "/internal/frame"]));
    expect(paths().filter((path) => path.startsWith("/internal/"))).toEqual([]);
    expect(text).not.toContain("INTERNAL");
    // an allowed chain still answers, and each step carries the headers
    expect(text).toContain("PUBLIC-FETCH-END");
    expect(asked.filter(({ path }) => path === "/api-chain2").map(({ from }) => from)).toEqual(["bot-admin@example.org"]);
    // a navigation that redirects gives the URL of its last step
    asked.length = 0;
    const moved = await renderer!.render(`${base}/chain`, options);
    expect(moved).toMatchObject({ finalUrl: `${base}/end`, status: 200 });
    expect(extractPage(moved.html, moved.finalUrl).text).toContain("PUBLIC-END");
    expect(paths()).toEqual(["/chain", "/chain2", "/end"]);
    // a navigation that redirects to a refused address is no render
    asked.length = 0;
    await expect(renderer!.render(`${base}/nav-out`, options)).rejects.toMatchObject({
      reason: "refused",
      message: `the request for ${base}/internal/nav, a redirect of ${base}/nav-out, was refused`,
    });
    expect(paths()).toEqual(["/nav-out"]);
    // the limit of a plain fetch: five redirects, and the sixth step is not requested
    asked.length = 0;
    await expect(renderer!.render(`${base}/loop/0`, options)).rejects.toMatchObject({ reason: "refused" });
    expect(paths()).toEqual(["/loop/0", "/loop/1", "/loop/2", "/loop/3", "/loop/4", "/loop/5"]);
    asked.length = 0;
    await expect(renderer!.render(`${base}/loop/0`, { ...options, maxRedirects: 1 })).rejects.toThrow(/redirects more than 1 times/);
    expect(paths()).toEqual(["/loop/0", "/loop/1"]);
    // a script that goes on to a refused URL leaves the browser on its error page: no render, and the error names the URL
    asked.length = 0;
    await expect(renderer!.render(`${base}/js-out`, options)).rejects.toMatchObject({
      reason: "refused",
      url: `${base}/internal/js`,
      message: `the page moved: the request for ${base}/internal/js was refused`,
    });
    expect(paths()).toEqual(["/js-out"]);
  }, 60_000);

  it("reads a page whose script navigates while the browser measures its text", async (context) => {
    if (unavailable !== undefined)
      context.skip(`Playwright's browser could not start: ${unavailable}`);
    const shown = await renderer!.render(`${base}/restless`, { ...OPTIONS, timeoutMs: 5000 });
    expect(extractPage(shown.html, shown.finalUrl).text).toContain("The kitchen closes");
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
