import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { FileBlobStore } from "./blobs.ts";
import type { CrawlerOptions } from "./crawler.ts";
import { Crawler } from "./crawler.ts";
import { DocIndex } from "./docs.ts";
import { CaptureLog } from "./log.ts";
import type { Clock } from "./politeness.ts";
import type { CaptureRecord } from "./record.ts";
import { removeDir, tempDir } from "./test-helpers.ts";

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
  if (dir !== undefined) await removeDir(dir);
  dir = undefined;
});

/** time that only moves when the crawler sleeps, so pacing is measured, not waited */
const fakeClock = (): Clock & { slept: number[] } => {
  let now = Date.parse("2026-10-07T12:00:00Z");
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
};

const setup = async (options: Partial<CrawlerOptions> = {}) => {
  dir = await tempDir("crawler");
  const agent = new MockAgent();
  agent.disableNetConnect();
  const clock = fakeClock();
  const log = opened(new CaptureLog(join(dir, "crawl")));
  const blobs = new FileBlobStore(join(dir, "blobs"));
  const index = new DocIndex(":memory:");
  const crawler = new Crawler({
    token: "PoliteCrawler",
    userAgent: "PoliteCrawler/0.1 (test)",
    log,
    blobs,
    index,
    clock,
    random: () => 0.5,
    dispatcher: agent,
    ...options,
  });
  const captures = async (): Promise<CaptureRecord[]> => {
    await log.close();
    const rows: CaptureRecord[] = [];
    for await (const row of new CaptureLog(join(dir!, "crawl")).scan({
      source: "fetch",
    })) {
      rows.push(row);
    }
    return rows;
  };
  return { agent, clock, crawler, index, blobs, captures };
};

describe("the polite fetcher", () => {
  it("captures an API response, stores the body by hash, and never writes the key", async () => {
    const { agent, crawler, index, blobs, captures } = await setup();
    agent
      .get("https://api.example.org")
      .intercept({ path: "/works?query=creatine&api_key=SECRET", method: "GET" })
      .reply(200, '{"items":[1,2]}', {
        headers: { "content-type": "application/json", etag: '"v1"' },
      });
    const fetched = await crawler.fetch({
      url: "https://api.example.org/works?query=creatine&api_key=SECRET",
      mode: "api",
      recipe: "test.works",
      secretParams: ["api_key"],
    });
    expect(fetched).toMatchObject({ status: 200, outcome: "ok", fromCache: false });
    expect(fetched.url).toBe("https://api.example.org/works?query=creatine&api_key=REDACTED");
    expect(new TextDecoder().decode(await blobs.get(fetched.blob!))).toBe('{"items":[1,2]}');
    expect(index.latest(fetched.url)).toMatchObject({ etag: '"v1"', capture: fetched.capture });
    const rows = await captures();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(fetched.capture);
    expect(JSON.stringify(rows)).not.toContain("SECRET");
    expect(rows[0]!.payload).toMatchObject({
      recipe: "test.works",
      outcome: "ok",
      robots: "not-checked",
    });
  });

  it("reads robots.txt for pages, and records the pages it declines", async () => {
    const { agent, crawler, captures } = await setup();
    const site = agent.get("https://venue.example");
    site
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(200, "User-agent: *\nDisallow: /private\n", {
        headers: { "content-type": "text/plain" },
      });
    site.intercept({ path: "/menu", method: "GET" }).reply(200, "<h1>Menu</h1>", {
      headers: { "content-type": "text/html" },
    });
    const declined = await crawler.fetch({
      url: "https://venue.example/private/x",
      mode: "page",
      recipe: "page",
    });
    expect(declined).toMatchObject({ outcome: "skipped", status: 0 });
    expect(declined.note).toContain("robots.txt disallows");
    const menu = await crawler.fetch({
      url: "https://venue.example/menu",
      mode: "page",
      recipe: "page",
    });
    expect(menu.outcome).toBe("ok");
    const kinds = (await captures()).map((row) => [
      row.kind,
      (row.payload as { recipe: string }).recipe,
    ]);
    expect(kinds).toEqual([
      ["capture", "robots.txt"],
      ["skipped", "page"],
      ["capture", "page"],
    ]);
  });

  it("fetches nothing from a site whose robots.txt cannot be read, and says why", async () => {
    const { agent, crawler } = await setup();
    agent
      .get("https://gone.example")
      .intercept({ path: "/robots.txt", method: "GET" })
      .replyWithError(new Error("getaddrinfo ENOTFOUND gone.example"));
    agent
      .get("https://busy.example")
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(522, "origin timed out");
    const gone = await crawler.fetch({
      url: "https://gone.example/",
      mode: "page",
      recipe: "page",
    });
    expect(gone.outcome).toBe("skipped");
    expect(gone.note).toMatch(/^robots\.txt could not be read \(no response: .*ENOTFOUND/);
    const busy = await crawler.fetch({
      url: "https://busy.example/",
      mode: "page",
      recipe: "page",
    });
    expect(busy.note).toBe(
      "robots.txt could not be read (status 522), so nothing on the site is fetched",
    );
  });

  it("applies rules a site wrote for Claude-User when Claude asked for the page", async () => {
    const { agent, crawler } = await setup();
    const site = agent.get("https://shop.example");
    site
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(200, "User-agent: Claude-User\nDisallow: /\n\nUser-agent: *\nAllow: /\n");
    const asked = await crawler.fetch({
      url: "https://shop.example/item",
      mode: "page",
      recipe: "page",
      onBehalfOf: ["Claude-User"],
    });
    expect(asked.note).toContain("Claude-User");
  });

  it("decodes gzip", async () => {
    const { agent, crawler } = await setup();
    agent
      .get("https://api.example.org")
      .intercept({ path: "/z", method: "GET" })
      .reply(200, gzipSync(Buffer.from("hello, compressed")), {
        headers: { "content-encoding": "gzip" },
      });
    const fetched = await crawler.fetch({
      url: "https://api.example.org/z",
      mode: "api",
      recipe: "t",
    });
    expect(new TextDecoder().decode(fetched.body)).toBe("hello, compressed");
  });

  it("revalidates with the stored ETag, and a 304 reuses the stored body", async () => {
    const { agent, crawler, captures } = await setup();
    const api = agent.get("https://api.example.org");
    api.intercept({ path: "/r", method: "GET" }).reply(200, "first body", {
      headers: { etag: '"abc"', "last-modified": "Mon, 05 Oct 2026 10:00:00 GMT" },
    });
    api
      .intercept({ path: "/r", method: "GET", headers: { "if-none-match": '"abc"' } })
      .reply(304, "", { headers: { etag: '"abc"' } });
    const first = await crawler.fetch({
      url: "https://api.example.org/r",
      mode: "api",
      recipe: "t",
    });
    const second = await crawler.fetch({
      url: "https://api.example.org/r",
      mode: "api",
      recipe: "t",
    });
    expect(second).toMatchObject({ outcome: "not-modified", blob: first.blob });
    expect(new TextDecoder().decode(second.body)).toBe("first body");
    const rows = await captures();
    expect(rows.map((row) => row.kind)).toEqual(["capture", "revisit"]);
    expect(rows[1]!.payload).toMatchObject({ revisit_of: first.capture });
  });

  it("serves a young enough capture without a request", async () => {
    const { agent, crawler } = await setup();
    agent
      .get("https://api.example.org")
      .intercept({ path: "/c", method: "GET" })
      .reply(200, "cached");
    await crawler.fetch({ url: "https://api.example.org/c", mode: "api", recipe: "t" });
    // no second interceptor: a request now would fail the test
    const again = await crawler.fetch({
      url: "https://api.example.org/c",
      mode: "api",
      recipe: "t",
      maxAgeMs: 60_000,
    });
    expect(again).toMatchObject({ fromCache: true, outcome: "ok" });
    expect(new TextDecoder().decode(again.body)).toBe("cached");
  });

  it("paces one host and honors Retry-After", async () => {
    const { agent, crawler, clock } = await setup();
    const api = agent.get("https://api.example.org");
    api
      .intercept({ path: "/a", method: "GET" })
      .reply(429, "slow down", { headers: { "retry-after": "120" } });
    api.intercept({ path: "/b", method: "GET" }).reply(200, "ok");
    api.intercept({ path: "/c", method: "GET" }).reply(200, "ok");
    const limited = await crawler.fetch({
      url: "https://api.example.org/a",
      mode: "api",
      recipe: "t",
    });
    expect(limited.outcome).toBe("rate-limited");
    await crawler.fetch({
      url: "https://api.example.org/b",
      mode: "api",
      recipe: "t",
      minIntervalMs: 1000,
    });
    await crawler.fetch({
      url: "https://api.example.org/c",
      mode: "api",
      recipe: "t",
      minIntervalMs: 1000,
    });
    // the host rested 120 s after the 429, then 1 s between the next two
    expect(clock.slept).toEqual([120_000, 1000]);
  });

  it("stops asking a host that answers with a challenge", async () => {
    const { agent, crawler } = await setup();
    agent
      .get("https://guarded.example")
      .intercept({ path: "/x", method: "GET" })
      .reply(403, "<html>challenge</html>", { headers: { "cf-mitigated": "challenge" } });
    const first = await crawler.fetch({
      url: "https://guarded.example/x",
      mode: "api",
      recipe: "t",
    });
    expect(first).toMatchObject({ outcome: "challenge", body: undefined, blob: undefined });
    const second = await crawler.fetch({
      url: "https://guarded.example/y",
      mode: "api",
      recipe: "t",
    });
    expect(second).toMatchObject({ outcome: "skipped" });
    expect(second.note).toContain("challenge");
  });

  it("keeps the rules of a robots.txt that a revalidation says has not changed", async () => {
    const { agent, crawler, index, blobs, clock } = await setup();
    const site = agent.get("https://venue.example");
    site
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(200, "User-agent: *\nDisallow: /private\n", {
        headers: { "content-type": "text/plain", etag: '"r1"' },
      });
    site
      .intercept({ path: "/menu", method: "GET" })
      .reply(200, "<h1>Menu</h1>", { headers: { "content-type": "text/html" } })
      .times(2);
    const page = { url: "https://venue.example/menu", mode: "page", recipe: "page" } as const;
    expect((await crawler.fetch(page)).outcome).toBe("ok");
    await crawler.close();
    // a restarted crawler asks again with the stored ETag, and hears 304
    site
      .intercept({ path: "/robots.txt", method: "GET", headers: { "if-none-match": '"r1"' } })
      .reply(304, "");
    const restarted = new Crawler({
      token: "PoliteCrawler",
      userAgent: "PoliteCrawler/0.1 (test)",
      log: opened(new CaptureLog(join(dir!, "crawl-restarted"))),
      blobs,
      index,
      clock,
      random: () => 0.5,
      dispatcher: agent,
    });
    expect((await restarted.fetch(page)).outcome).toBe("ok");
    const declined = await restarted.fetch({ ...page, url: "https://venue.example/private/x" });
    expect(declined.note).toBe("robots.txt disallows it for PoliteCrawler");
    await restarted.close();
  });

  it("skips, never throws, a request whose host was stopped while it waited", async () => {
    const { agent, crawler } = await setup();
    // a challenge on robots.txt stops the host before the page is asked for
    agent
      .get("https://guarded.example")
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(403, "<html>Just a moment...</html>", { headers: { "cf-mitigated": "challenge" } });
    const page = await crawler.fetch({
      url: "https://guarded.example/",
      mode: "page",
      recipe: "page",
    });
    expect(page.outcome).toBe("skipped");
    // a challenge stops the host for a day, not for the life of the process
    expect(page.note).toBe("host stopped until 2026-10-08T12:00:00.000Z: challenge");
    // a request queued behind the one that met the challenge
    agent
      .get("https://busy.example")
      .intercept({ path: "/a", method: "GET" })
      .reply(403, "", { headers: { "cf-mitigated": "challenge" } });
    const [first, second] = await Promise.all([
      crawler.fetch({ url: "https://busy.example/a", mode: "api", recipe: "t" }),
      crawler.fetch({ url: "https://busy.example/b", mode: "api", recipe: "t" }),
    ]);
    expect([first.outcome, second.outcome]).toEqual(["challenge", "skipped"]);
  });

  it("reads an AI-input opt-out from the response", async () => {
    const { agent, crawler } = await setup();
    agent
      .get("https://news.example")
      .intercept({ path: "/story", method: "GET" })
      .reply(200, "text", { headers: { "content-signal": "search=yes, ai-input=no" } });
    const fetched = await crawler.fetch({
      url: "https://news.example/story",
      mode: "api",
      recipe: "t",
    });
    expect(fetched.signals.ai_input).toBe("no");
  });

  it("records the TDMRep header and tags of a page with its signals, and keeps AI input unset", async () => {
    const { agent, crawler } = await setup();
    agent
      .get("https://news.example")
      .intercept({ path: "/tdm", method: "GET" })
      .reply(
        200,
        '<html><head><meta name="tdm-reservation" content="1"></head><body><p>text</p></body></html>',
        {
          headers: { "content-type": "text/html", "tdm-policy": "https://news.example/tdm.json" },
        },
      );
    const fetched = await crawler.fetch({
      url: "https://news.example/tdm",
      mode: "api",
      recipe: "t",
    });
    expect(fetched.signals).toMatchObject({
      ai_input: "unset",
      raw: expect.arrayContaining([
        "tdm-policy: https://news.example/tdm.json",
        "meta tdm-reservation: 1",
      ]) as unknown,
    });
  });

  it("keeps no stored copy of a web page that answers a JSON request, and asks again the next time", async () => {
    const { agent, crawler, index, captures } = await setup();
    let calls = 0;
    agent
      .get("https://api.example")
      .intercept({ path: "/data", method: "GET" })
      .reply(() => {
        calls += 1;
        return calls === 1
          ? {
              statusCode: 200,
              data: "<html><body>Please sign in</body></html>",
              responseOptions: { headers: { "content-type": "text/html; charset=utf-8" } },
            }
          : {
              statusCode: 200,
              data: '{"ok":true}',
              responseOptions: { headers: { "content-type": "application/json" } },
            };
      })
      .persist();
    const request = {
      url: "https://api.example/data",
      mode: "api",
      recipe: "t",
      accept: "application/json",
      maxAgeMs: 3_600_000,
    } as const;
    const first = await crawler.fetch(request);
    expect(first.outcome).toBe("ok");
    expect(first.note).toContain(
      "the server sent text/html; charset=utf-8, and the request accepts application/json",
    );
    expect(index.latest("https://api.example/data")).toBeUndefined();
    const second = await crawler.fetch(request);
    expect(second).toMatchObject({ outcome: "ok", fromCache: false });
    expect(calls).toBe(2);
    // the JSON answer is the stored copy, so a third request sends nothing
    expect(await crawler.fetch(request)).toMatchObject({ fromCache: true });
    expect(calls).toBe(2);
    const records = await captures();
    expect(records[0]!.payload).toMatchObject({ unasked: true });
    expect(records[1]!.payload).not.toHaveProperty("unasked");
  });

  it("keeps an HTML answer that the request admits, and refuses one with q=0", async () => {
    const { agent, crawler, index } = await setup();
    agent
      .get("https://api.example")
      .intercept({ path: (path) => path.startsWith("/page"), method: "GET" })
      .reply(200, "<html><body>page</body></html>", { headers: { "content-type": "text/html" } })
      .persist();
    const ask = async (path: string, accept: string): Promise<boolean> => {
      await crawler.fetch({ url: `https://api.example${path}`, mode: "api", recipe: "t", accept });
      return index.latest(`https://api.example${path}`) !== undefined;
    };
    expect(await ask("/page1", "text/html,*/*;q=0.5")).toBe(true);
    expect(await ask("/page2", "application/json, text/*")).toBe(true);
    expect(await ask("/page3", "application/json, text/html;q=0")).toBe(false);
  });
});

describe("the records of a robots.txt fetch", () => {
  const RANK = ["public", "private", "intimate"];

  it("take the most private scope of the requests that wait for the fetch, and their labels", async () => {
    const { agent, crawler, captures } = await setup({
      scope: "public",
      scopeRank: (scope) => RANK.indexOf(scope),
    });
    const site = agent.get("https://shop.example");
    // the robots.txt answers late, so both pages wait for the one fetch
    site
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(200, "User-agent: *\nAllow: /\n")
      .delay(100);
    site.intercept({ path: "/a", method: "GET" }).reply(200, "a").persist();
    site.intercept({ path: "/b", method: "GET" }).reply(200, "b").persist();
    await Promise.all([
      crawler.fetch({
        url: "https://shop.example/a",
        mode: "page",
        recipe: "page",
        scope: "private",
        labels: { from: "a" },
      }),
      crawler.fetch({
        url: "https://shop.example/b",
        mode: "page",
        recipe: "page",
        scope: "intimate",
        labels: { gift: "b" },
      }),
    ]);
    const robots = (await captures()).filter(
      (row) => (row.payload as { recipe?: string }).recipe === "robots.txt",
    );
    expect(robots).toHaveLength(1);
    expect(robots[0]).toMatchObject({ scope: "intimate", labels: { from: "a", gift: "b" } });
  });

  it("take the scope of the one request that starts the fetch, not the scope of the crawler", async () => {
    const { agent, crawler, captures } = await setup({ scope: "public" });
    const site = agent.get("https://quiet.example");
    site.intercept({ path: "/robots.txt", method: "GET" }).reply(200, "User-agent: *\nAllow: /\n");
    site.intercept({ path: "/a", method: "GET" }).reply(200, "a");
    await crawler.fetch({
      url: "https://quiet.example/a",
      mode: "page",
      recipe: "page",
      scope: "intimate",
      labels: { gift: "17" },
    });
    const rows = await captures();
    expect(
      rows.map((row) => [(row.payload as { recipe?: string }).recipe, row.scope, row.labels]),
    ).toEqual([
      ["robots.txt", "intimate", { gift: "17" }],
      ["page", "intimate", { gift: "17" }],
    ]);
  });
});

describe("an application that links the bot page of polite-crawler", () => {
  const ask = async (options: Partial<CrawlerOptions>): Promise<Record<string, string>> => {
    const { agent, crawler } = await setup(options);
    const site = agent.get("https://shop.example");
    site
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(200, "User-agent: PoliteCrawler\nDisallow: /private\n")
      .persist();
    site
      .intercept({ path: (path) => path !== "/robots.txt", method: "GET" })
      .reply(200, "page")
      .persist();
    const out: Record<string, string> = {};
    for (const path of ["/private", "/open"]) {
      out[path] = (
        await crawler.fetch({ url: `https://shop.example${path}`, mode: "page", recipe: "page" })
      ).outcome;
    }
    return out;
  };

  it("obeys the rules for PoliteCrawler too, unless it turns that off or does not link the page", async () => {
    const linked = {
      token: "MyApp",
      userAgent: "MyApp/1.0 (+https://mark1russell7.github.io/crawler/bot/)",
    };
    expect(await ask(linked)).toEqual({ "/private": "skipped", "/open": "ok" });
    expect(await ask({ ...linked, obeyDefaultToken: false })).toEqual({
      "/private": "ok",
      "/open": "ok",
    });
    expect(
      await ask({ token: "MyApp", userAgent: "MyApp/1.0 (+https://myapp.example/bot)" }),
    ).toEqual({ "/private": "ok", "/open": "ok" });
  });
});
