import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlaywrightRenderer } from "./render.ts";
import { playwrightRenderer } from "./render.ts";
import { extractPage } from "./html.ts";

/**
 * The real browser, against a local site: an app shell whose script draws
 * the hours after 300 ms, and an image the browser must never ask for. If
 * Playwright's browser is not installed on this machine, the test says so and
 * skips; the stand-in renderer in page.test.ts covers the decision either way.
 */

const SHELL = `<!doctype html><html><head><title>Late</title></head><body>
<div id="root"></div><img src="/logo.png">
<script>setTimeout(function () {
  document.getElementById("root").innerHTML =
    "<h1>Hours</h1><p>Wed-Sun 17:00-23:00</p><p>The kitchen closes an hour before the bar. 12 Main St, Springfield, MA.</p>";
}, 300);</script></body></html>`;

const asked: string[] = [];
const server = createServer((request, response) => {
  asked.push(request.url ?? "");
  if (request.url === "/logo.png") {
    response.writeHead(200, { "content-type": "image/png" }).end(Buffer.alloc(16));
    return;
  }
  response.writeHead(200, { "content-type": "text/html" }).end(SHELL);
});

let base = "";
let renderer: PlaywrightRenderer | undefined;
let unavailable: string | undefined;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  renderer = playwrightRenderer();
  try {
    await renderer.render(`${base}/warmup`, {
      userAgent: "PoliteCrawler/0.1 (test)",
      timeoutMs: 15_000,
    });
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

describe("the headless browser", () => {
  it("shows what a script draws, and never fetches the images", async (context) => {
    if (unavailable !== undefined)
      context.skip(`Playwright's browser could not start: ${unavailable}`);
    const shown = await renderer!.render(`${base}/late`, {
      userAgent: "PoliteCrawler/0.1 (test)",
      timeoutMs: 15_000,
    });
    expect(extractPage(SHELL, `${base}/late`).needsRender).toBe(true);
    const page = extractPage(shown.html, shown.finalUrl);
    expect(page.text).toContain("Wed-Sun 17:00-23:00");
    expect(page.needsRender).toBe(false);
    expect(shown.status).toBe(200);
    expect(asked).toEqual(["/late"]);
  }, 60_000);

  it("closes the browser once it has been idle", async (context) => {
    if (unavailable !== undefined)
      context.skip(`Playwright's browser could not start: ${unavailable}`);
    const brief = playwrightRenderer({ idleMs: 200 });
    await brief.render(`${base}/late`, {
      userAgent: "PoliteCrawler/0.1 (test)",
      timeoutMs: 15_000,
    });
    expect(brief.open()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(brief.open()).toBe(false);
    await brief.close();
  }, 60_000);
});
