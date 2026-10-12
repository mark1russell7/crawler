import type { Browser } from "playwright-core";

/**
 * The renderer opens the headless browser only for a page that shows almost nothing without
 * JavaScript. The settings:
 *
 * - The default `chromium-headless-shell` of Playwright, the lighter build.
 * - One browser for many pages, and a new context for each page. Thus no cookie or storage goes
 *   from one site to the next.
 * - The DevTools protocol blocks images, fonts and media. This keeps the HTTP cache, which
 *   `page.route` turns off.
 * - A wait until the visible text stops growing, with a limit. Playwright discourages
 *   `networkidle`.
 * - The browser closes after two idle minutes. An idle Chromium holds hundreds of megabytes, so
 *   it stays open only while pages need it.
 */

export interface Rendered {
  readonly html: string;
  readonly finalUrl: string;
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
}

/** These are the options of one render. */
export interface RenderOptions {
  readonly userAgent: string;
  /** This value is the deadline of the whole render, in milliseconds. */
  readonly timeoutMs: number;
  /** These headers go with each request of the page, for example the `From` header. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * This function decides each request that the page makes, the first navigation included. When
   * it gives false, the browser does not send the request. The crawler uses it to apply the
   * egress policy and robots.txt to the requests of the page.
   */
  readonly allowRequest?: ((url: string) => Promise<boolean> | boolean) | undefined;
}

export interface Renderer {
  render(url: string, options: RenderOptions): Promise<Rendered>;
  close(): Promise<void>;
}

const BLOCKED = [
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.avif",
  "*.svg",
  "*.ico",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.otf",
  "*.eot",
  "*.mp4",
  "*.webm",
  "*.mov",
  "*.mp3",
  "*.m4a",
  "*.wav",
];

/** The text is stable when it does not grow for this time. */
const SETTLED_MS = 1000;
const POLL_MS = 250;
const SETTLE_CAP_MS = 12_000;

/** The text of the error when the optional package `playwright-core` is not installed. */
export const NO_PLAYWRIGHT =
  "rendering needs the package playwright-core and a browser: npm install playwright-core, then npx playwright-core install chromium-headless-shell";

// playwright-core is an optional peer: it loads only when a page first needs a browser
const launch = async (): Promise<Browser> => {
  let chromium: typeof import("playwright-core").chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch (cause) {
    throw new Error(NO_PLAYWRIGHT, { cause });
  }
  return chromium.launch({ headless: true });
};

export interface PlaywrightRenderer extends Renderer {
  /** This function tells if a browser is open. */
  readonly open: () => boolean;
}

export const playwrightRenderer = (
  options: { readonly idleMs?: number } = {},
): PlaywrightRenderer => {
  const idleMs = options.idleMs ?? 120_000;
  let browser: Promise<Browser> | undefined;
  let inFlight = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const shutSoon = (): void => {
    idle = setTimeout(() => {
      idle = undefined;
      if (inFlight > 0 || browser === undefined) return;
      const closing = browser;
      browser = undefined;
      void closing.then((running) => running.close()).catch(() => undefined);
    }, idleMs);
    // an idle timer must not keep the process alive on its own
    idle.unref();
  };
  return {
    open: () => browser !== undefined,
    async render(url, { userAgent, timeoutMs }) {
      if (idle !== undefined) {
        clearTimeout(idle);
        idle = undefined;
      }
      inFlight += 1;
      try {
        return await renderPage(url, { userAgent, timeoutMs });
      } finally {
        inFlight -= 1;
        if (inFlight === 0) shutSoon();
      }
    },
    async close() {
      if (idle !== undefined) clearTimeout(idle);
      idle = undefined;
      const launched = browser;
      browser = undefined;
      // a launch that failed has nothing to close, and closing never throws:
      // the idle timer calls this with no one to catch it
      if (launched !== undefined)
        await launched.then(
          (open) => open.close(),
          () => undefined,
        );
    },
  };

  async function renderPage(
    url: string,
    { userAgent, timeoutMs }: RenderOptions,
  ): Promise<Rendered> {
    browser ??= launch().catch((error: unknown) => {
      // a failed launch is not kept, so the next page tries again
      browser = undefined;
      throw error;
    });
    const context = await (
      await browser
    ).newContext({
      userAgent,
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    try {
      const page = await context.newPage();
      const devtools = await context.newCDPSession(page);
      await devtools.send("Network.enable");
      await devtools.send("Network.setBlockedURLs", { urls: BLOCKED });
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      const deadline = Date.now() + Math.min(timeoutMs, SETTLE_CAP_MS);
      let last = -1;
      let since = Date.now();
      while (Date.now() < deadline) {
        const length = (await page.evaluate(
          "document.body ? document.body.innerText.length : 0",
        )) as number;
        if (length !== last) {
          last = length;
          since = Date.now();
        } else if (length > 0 && Date.now() - since >= SETTLED_MS) {
          break;
        }
        await page.waitForTimeout(POLL_MS);
      }
      return {
        html: await page.content(),
        finalUrl: page.url(),
        status: response?.status() ?? null,
        headers: response?.headers() ?? {},
      };
    } finally {
      await context.close();
    }
  }
};
