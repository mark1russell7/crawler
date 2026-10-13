import type { APIResponse, Browser, BrowserContext, Page, Request, Route } from "playwright-core";

/**
 * The renderer opens the headless browser only for a page that shows almost nothing without
 * JavaScript. The settings:
 *
 * - The default `chromium-headless-shell` of Playwright, the lighter build.
 * - One browser for many pages, and a new context for each page. Thus no cookie or storage goes
 *   from one site to the next. A context has its own HTTP cache, so routing each request costs
 *   no cache across sites.
 * - Each request of the page goes through a route, the first navigation too. The route refuses
 *   images, fonts and media by their resource type. It asks `allowRequest` about each other
 *   request, and it sends `headers` with it.
 * - Playwright routes only the first request of a redirect chain. Thus with `allowRequest`, the
 *   route sends each request itself, follows each redirect itself and asks about each step. The
 *   browser then gets each body whole, not as a stream.
 * - No download, no popup, no service worker and no dialog.
 * - A wait until the visible text stops growing, with a limit. Playwright discourages
 *   `networkidle`. The text includes open shadow roots and the frames of the same origin.
 * - One deadline for the whole render: the navigation, the wait and the reading of the page.
 * - After a crash or a disconnection, the next page launches a new browser.
 * - The browser closes after two idle minutes. An idle Chromium holds hundreds of megabytes, so
 *   it stays open only while pages need it. The open browser keeps the process alive, so a
 *   script uses `close()` when it is done.
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
  /** This value is the maximum number of redirects of one request of the page. The default is 5, as for a plain fetch. */
  readonly maxRedirects?: number | undefined;
  /** When this signal aborts, the renderer stops the page: it closes the context, and the render rejects. */
  readonly signal?: AbortSignal | undefined;
}

export interface Renderer {
  render(url: string, options: RenderOptions): Promise<Rendered>;
  close(): Promise<void>;
}

/**
 * This error tells that the renderer did not render the page, and that the page or the site is
 * not at fault. The reason is one of these:
 *
 * - `refused`: `allowRequest` refused the first navigation.
 * - `download`: the URL gives a file, not a page.
 * - `scheme`: the URL is not an http or https URL.
 *
 * A crawler does not count this error as a failure of the host.
 */
export class RenderRefused extends Error {
  readonly reason: "refused" | "download" | "scheme";
  constructor(reason: "refused" | "download" | "scheme", message: string) {
    super(message);
    this.name = "RenderRefused";
    this.reason = reason;
  }
}

/** The browser does not ask for these. The text of a page needs none of them. */
const BLOCKED_TYPES = new Set(["image", "font", "media"]);
/** These statuses send the request on to the URL in `Location` (the Fetch standard). */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** The text is stable when it does not grow for this time. */
const SETTLED_MS = 1000;
const POLL_MS = 250;
const SETTLE_CAP_MS = 12_000;
/** A page with no text after this time has nothing more to show. */
const EMPTY_SETTLE_MS = 3000;
/** The part of the deadline that is kept to read the page after the wait. */
const READ_RESERVE_MS = 2000;
/** A context that does not close in this time takes its browser with it. */
const CLOSE_MS = 5000;
/** A browser that does not open a context in this time is replaced. */
const OPEN_MS = 5000;

/** The text of the error when the optional package `playwright-core` is not installed. */
export const NO_PLAYWRIGHT =
  "rendering needs the package playwright-core and a browser: npm install playwright-core, then npx playwright-core install chromium-headless-shell. For the MCP server with npx, start it with npx -y -p polite-crawler -p playwright-core polite-crawler mcp";

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

/** This script gives the length of the text that the page shows: its body, its open shadow roots and its frames of the same origin. */
const MEASURE = `(() => {
  let total = document.body ? document.body.innerText.length : 0;
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) {
        total += (element.shadowRoot.textContent || "").length;
        visit(element.shadowRoot);
      }
    }
  };
  visit(document);
  for (const frame of document.querySelectorAll("iframe, frame")) {
    try {
      const inner = frame.contentDocument;
      if (inner && inner.body) total += inner.body.innerText.length;
    } catch (error) {}
  }
  return total;
})()`;

/** This script gives the HTML of the page with its open shadow roots, and the body of each frame of the same origin. */
const SERIALIZE = `(() => {
  const roots = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) {
        roots.push(element.shadowRoot);
        visit(element.shadowRoot);
      }
    }
  };
  visit(document);
  const root = document.documentElement;
  if (!root) return { html: "", frames: [] };
  const quote = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const open = "<html" + Array.from(root.attributes, (item) => " " + item.name + '="' + quote(item.value) + '"').join("") + ">";
  const inner =
    roots.length > 0 && typeof root.getHTML === "function"
      ? root.getHTML({ serializableShadowRoots: true, shadowRoots: roots })
      : root.innerHTML;
  const frames = [];
  for (const frame of document.querySelectorAll("iframe, frame")) {
    try {
      const doc = frame.contentDocument;
      if (doc && doc.body) frames.push({ src: frame.src || "", html: doc.body.innerHTML });
    } catch (error) {}
  }
  return { html: "<!DOCTYPE html>" + open + inner + "</html>", frames };
})()`;

interface Serialized {
  readonly html: string;
  readonly frames: ReadonlyArray<{ readonly src: string; readonly html: string }>;
}

/** This function puts the body of each frame at the end of the page, in a section that names the frame. */
const withFrames = ({ html, frames }: Serialized): string => {
  if (frames.length === 0) return html;
  const sections = frames
    .map(({ src, html: body }) => `<section data-polite-frame="${src.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">${body}</section>`)
    .join("");
  const end = html.toLowerCase().lastIndexOf("</body>");
  return end === -1 ? `${html}${sections}` : `${html.slice(0, end)}${sections}${html.slice(end)}`;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms)).unref();
  });

/** This function gives the value of a promise, or undefined when the time ends first. */
const within = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
};

export interface PlaywrightRenderer extends Renderer {
  /** This function tells if a browser is open. */
  readonly open: () => boolean;
}

export const playwrightRenderer = (
  options: {
    readonly idleMs?: number;
    /** This function starts the browser. The default is the headless shell of Playwright. */
    readonly launch?: (() => Promise<Browser>) | undefined;
  } = {},
): PlaywrightRenderer => {
  const idleMs = options.idleMs ?? 120_000;
  const start = options.launch ?? launch;
  let browser: Promise<Browser> | undefined;
  let inFlight = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const shutSoon = (): void => {
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(() => {
      idle = undefined;
      if (inFlight > 0 || browser === undefined) return;
      const closing = browser;
      browser = undefined;
      void closing.then((running) => running.close()).catch(() => undefined);
    }, idleMs);
    // the timer alone does not keep the process alive; the open browser does
    idle.unref();
  };
  const acquire = async (): Promise<Browser> => {
    for (let attempt = 0; ; attempt += 1) {
      if (browser === undefined) {
        const launching: Promise<Browser> = start().then((running) => {
          // a crash, a kill or a closed pipe: the next page launches a new browser
          running.on("disconnected", () => {
            if (browser === launching) browser = undefined;
          });
          return running;
        });
        // a failed launch is not kept, so the next page tries again; a newer
        // launch that replaced this one is not touched
        launching.catch(() => {
          if (browser === launching) browser = undefined;
        });
        browser = launching;
      }
      const held = browser;
      const running = await held;
      if (running.isConnected() || attempt > 0) return running;
      if (browser === held) browser = undefined;
    }
  };
  /** This function gives up on a browser that does not answer. The next page launches a new one. */
  const forget = (running: Browser): void => {
    const held = browser;
    if (held !== undefined) {
      void held.then(
        (current) => {
          if (current === running && browser === held) browser = undefined;
        },
        () => undefined,
      );
    }
    void running.close().catch(() => undefined);
  };

  const renderPage = async (
    url: string,
    { userAgent, timeoutMs, headers, allowRequest, maxRedirects = MAX_REDIRECTS, signal }: RenderOptions,
  ): Promise<Rendered> => {
    if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error("the render was cancelled");
    const deadline = Date.now() + timeoutMs;
    const left = (): number => Math.max(1, deadline - Date.now());
    let running: Browser | undefined;
    let context: BrowserContext | undefined;
    let shownPage: Page | undefined;
    /** This text tells why the route refused a navigation of the page, or it is undefined. */
    let refused: string | undefined;
    /** The last navigation of the page that the route answered: the URL that the browser asked for, and the URL of the answer. */
    let navigated: { readonly asked: string; readonly final: string } | undefined;
    const extra = Object.fromEntries(
      Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const contextOptions = {
      userAgent,
      serviceWorkers: "block" as const,
      acceptDownloads: false,
      viewport: { width: 1280, height: 900 },
    };
    const ask = async (url: string): Promise<boolean> =>
      allowRequest === undefined
        ? true
        : Promise.resolve()
            .then(() => allowRequest(url))
            .catch(() => false);
    /**
     * This function sends one request of the page and follows its redirects. Each step is a new
     * decision of `allowRequest`, and a step past `maxRedirects` is refused. It gives the answer,
     * or the reason of a refusal. These rules are the rules of a browser. Each step gets the cookies
     * of its own URL from the context. A credential does not go to a different origin. A 303, or a
     * 301 or 302 after a POST, changes the request to a GET.
     */
    const follow = async (
      route: Route,
      sent: Record<string, string> | undefined,
    ): Promise<{ readonly response: APIResponse; readonly url: string } | { readonly refusal: string }> => {
      const request = route.request();
      let url = request.url();
      let method = request.method();
      let headers: Record<string, string> = { ...request.headers(), ...extra };
      let response = await route.fetch({ maxRedirects: 0, timeout: left(), ...(sent === undefined ? {} : { headers: sent }) });
      for (let hop = 0; ; hop += 1) {
        const location = REDIRECTS.has(response.status()) ? response.headers()["location"] : undefined;
        if (location === undefined) return { response, url };
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return { refusal: `${url} redirects to a URL that does not parse` };
        }
        if (hop >= maxRedirects) return { refusal: `${request.url()} redirects more than ${String(maxRedirects)} times` };
        if (!(await ask(next.href))) return { refusal: `the request for ${next.href}, a redirect of ${url}, was refused` };
        const status = response.status();
        const get = status === 303 || ((status === 301 || status === 302) && method === "POST");
        const crossOrigin = next.origin !== new URL(url).origin;
        headers = Object.fromEntries(
          Object.entries(headers).filter(
            ([name]) =>
              name !== "cookie" &&
              !(crossOrigin && name === "authorization") &&
              !(get && (name === "content-type" || name === "content-length")),
          ),
        );
        if (get) method = "GET";
        const body = get ? undefined : (request.postDataBuffer() ?? undefined);
        response = await context!.request.fetch(next.href, {
          method,
          headers,
          maxRedirects: 0,
          timeout: left(),
          ...(body === undefined ? {} : { data: body }),
        });
        url = next.href;
      }
    };
    /** This function tells if a request is a navigation of the page itself, not of a frame or a popup. */
    const ofPage = (request: Request): boolean => {
      if (!request.isNavigationRequest()) return false;
      try {
        return request.frame().parentFrame() === null && request.frame().page() === shownPage;
      } catch {
        // a popup asks for its first page before it has a frame
        return false;
      }
    };
    const decide = async (route: Route): Promise<void> => {
      const request = route.request();
      const main = ofPage(request);
      try {
        if (BLOCKED_TYPES.has(request.resourceType())) {
          await route.abort("blockedbyclient");
          return;
        }
        if (!(await ask(request.url()))) {
          if (main) refused = `the request for ${request.url()} was refused`;
          await route.abort("blockedbyclient");
          return;
        }
        const sent =
          Object.keys(extra).length === 0
            ? undefined
            : {
                ...Object.fromEntries(
                  Object.entries(await request.allHeaders()).filter(([name]) => !name.startsWith(":") && name !== "host"),
                ),
                ...extra,
              };
        if (allowRequest === undefined) {
          await route.continue(sent === undefined ? undefined : { headers: sent });
          return;
        }
        const answer = await follow(route, sent);
        if ("refusal" in answer) {
          if (main) refused = answer.refusal;
          await route.abort("blockedbyclient");
          return;
        }
        if (main) navigated = { asked: request.url(), final: answer.url };
        await route.fulfill({ response: answer.response });
      } catch {
        // the page closed while the request waited: nothing to answer
      }
    };
    const work = (async (): Promise<Rendered> => {
      running = await acquire();
      // a browser that was killed can keep its pipe open and answer nothing:
      // it gets a few seconds, and then a new browser takes its place
      const opened = await within(
        running.newContext(contextOptions).catch((error: unknown) => {
          if (!/closed|disconnected/i.test(messageOf(error))) throw error;
          return undefined;
        }),
        Math.min(OPEN_MS, left()),
      );
      if (opened === undefined) {
        forget(running);
        running = await acquire();
        context = await running.newContext(contextOptions);
      } else {
        context = opened;
      }
      await context.route("**/*", decide);
      if (allowRequest !== undefined && typeof context.routeWebSocket === "function") {
        await context.routeWebSocket(/.*/, async (socket) => {
          const allowed = await Promise.resolve()
            .then(() => allowRequest(socket.url().replace(/^ws/i, "http")))
            .catch(() => false);
          if (allowed) socket.connectToServer();
          else await socket.close({ code: 1008, reason: "refused" }).catch(() => undefined);
        });
      }
      const page: Page = await context.newPage();
      shownPage = page;
      // a popup is not the page, and a dialog waits for no one
      context.on("page", (other) => {
        if (other !== page) void other.close().catch(() => undefined);
      });
      page.on("dialog", (dialog) => {
        void dialog.dismiss().catch(() => undefined);
      });
      let response;
      try {
        response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: Math.max(1, left() - READ_RESERVE_MS),
        });
      } catch (error) {
        if (refused !== undefined) throw new RenderRefused("refused", refused);
        if (/Download is starting/i.test(messageOf(error))) {
          throw new RenderRefused("download", `${url} gives a file, not a page`);
        }
        throw error;
      }
      const settleEnd = Math.min(deadline - READ_RESERVE_MS, Date.now() + SETTLE_CAP_MS);
      const settleStart = Date.now();
      let last = -1;
      let since = Date.now();
      while (Date.now() < settleEnd) {
        const length = await within(page.evaluate(MEASURE) as Promise<number>, settleEnd - Date.now());
        // a page that keeps its thread busy does not answer: the reading below decides
        if (length === undefined) break;
        if (length !== last) {
          last = length;
          since = Date.now();
        } else if (
          Date.now() - since >= SETTLED_MS &&
          (length > 0 || Date.now() - settleStart >= EMPTY_SETTLE_MS)
        ) {
          break;
        }
        await sleep(Math.min(POLL_MS, settleEnd - Date.now()));
      }
      const serialized = (await page.evaluate(SERIALIZE).catch(async (error: unknown) => {
        // a navigation can replace the document while it is read
        if (!/destroyed|navigat/i.test(messageOf(error))) throw error;
        await page.waitForLoadState("domcontentloaded", { timeout: left() }).catch(() => undefined);
        return page.evaluate(SERIALIZE);
      })) as Serialized;
      // the route followed the redirects of the navigation, so the browser shows the first URL
      const shown = page.url().replace(/#.*$/s, "");
      return {
        html: withFrames(serialized),
        finalUrl: navigated !== undefined && shown === navigated.asked ? navigated.final : page.url(),
        status: response?.status() ?? null,
        headers: response?.headers() ?? {},
      };
    })();
    // the deadline can win the race; the work then ends when its context closes
    work.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`render timed out after ${String(timeoutMs)} ms`)),
        timeoutMs,
      );
      // a cancelled render ends now; the context closes below, and that stops the page
      if (signal !== undefined) {
        cancel = () => reject(signal.reason instanceof Error ? signal.reason : new Error("the render was cancelled"));
        signal.addEventListener("abort", cancel, { once: true });
      }
    });
    const closeContext = async (): Promise<void> => {
      const open = context;
      if (open === undefined) return;
      const closed = await within(
        open.close().then(
          () => true,
          () => true,
        ),
        CLOSE_MS,
      );
      if (closed === undefined && running !== undefined) forget(running);
    };
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
      if (cancel !== undefined) signal?.removeEventListener("abort", cancel);
      if (context !== undefined) await closeContext();
      // a context made after the deadline is closed when it arrives
      else void work.then(closeContext, closeContext).catch(() => undefined);
    }
  };

  return {
    open: () => browser !== undefined,
    async render(url, renderOptions) {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        throw new RenderRefused("scheme", `${url} is not a URL`);
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new RenderRefused("scheme", `the renderer reads http and https pages, not ${target.protocol}`);
      }
      if (idle !== undefined) {
        clearTimeout(idle);
        idle = undefined;
      }
      inFlight += 1;
      try {
        return await renderPage(target.href, renderOptions);
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
};
