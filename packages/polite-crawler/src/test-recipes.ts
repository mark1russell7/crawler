/*
 * The tests of the recipes use these helpers. The sites are mock hosts of an undici mock agent, on
 * the reserved top-level domain `.example`. The venues, the shops and the products are made up. No
 * test uses the network: the mock agent refuses each host that it does not know.
 */
import { MockAgent } from "undici";
import type { HybridCrawler, OpenOptions } from "./open.ts";
import { openCrawler } from "./open.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";

/** The answer of a mock host to one path. */
export interface Reply {
  readonly status?: number | undefined;
  readonly body?: string | Uint8Array | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** This function gives the reply for a path of a host, or undefined for a 404. */
export type Route = (path: string) => Reply | undefined;

export const HTML: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
};
export const JSON_TYPE: Readonly<Record<string, string>> = { "content-type": "application/json" };
const TEXT = { "content-type": "text/plain" };
const ALLOW = "User-agent: *\nAllow: /\n";

/** The mock hosts and each request that they got, as the origin and the path. */
export interface World {
  readonly agent: MockAgent;
  readonly hits: string[];
}

/** This function makes the mock hosts. A host gives `robots` for `/robots.txt`, unless its route answers it. */
export const world = (
  sites: Readonly<Record<string, Route>>,
  robots: Readonly<Record<string, string>> = {},
): World => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const hits: string[] = [];
  for (const [origin, route] of Object.entries(sites)) {
    agent
      .get(origin)
      .intercept({ path: () => true, method: "GET" })
      .reply((request) => {
        hits.push(`${origin}${request.path}`);
        const reply: Reply =
          route(request.path) ??
          (request.path === "/robots.txt"
            ? { body: robots[origin] ?? ALLOW, headers: TEXT }
            : { status: 404, body: "no such page", headers: TEXT });
        return {
          statusCode: reply.status ?? 200,
          data: reply.body ?? "",
          responseOptions: { headers: reply.headers ?? {} },
        };
      })
      .persist();
  }
  return { agent, hits };
};

/** This function gives the requests of the hits, with no robots.txt. */
export const pagesOf = (hosts: World): string[] =>
  hosts.hits.filter((hit) => !hit.endsWith("/robots.txt"));

/** A crawler of a test, on a store of its own. */
export interface Opened {
  readonly crawler: HybridCrawler;
  readonly dir: string;
  readonly clock: ReturnType<typeof fakeClock>;
}

/** This function opens a crawler on the mock hosts, with a fake clock and no browser. */
export const openWith = async (
  hosts: World,
  cleanups: Array<() => Promise<void> | void>,
  options: Partial<OpenOptions> & { readonly clock?: ReturnType<typeof fakeClock> } = {},
  dir?: string,
): Promise<Opened> => {
  const store = dir ?? (await tempDir("recipes"));
  // the folder goes last, after the crawler closes, and also when the open throws
  if (dir === undefined) cleanups.push(() => removeDir(store));
  const clock = options.clock ?? fakeClock();
  const crawler = openCrawler({
    renderer: false,
    random: () => 0.5,
    dispatcher: hosts.agent,
    ...options,
    clock,
    dir: store,
  });
  cleanups.push(() => crawler.close());
  return { crawler, dir: store, clock };
};

/** This function gives an HTML page with a title, a body and an optional head. */
export const htmlPage = (title: string, body: string, head = ""): string =>
  `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;

/** This function gives a JSON-LD script with the value. */
export const jsonLd = (value: unknown): string =>
  `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

/** These words fill a page, so the reader does not think that the page needs JavaScript. */
export const FILLER: string = `<p>${"Bread from a wood oven, every morning of the week. ".repeat(8)}</p>`;
