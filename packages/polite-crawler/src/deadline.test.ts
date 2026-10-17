import { afterEach, describe, expect, it } from "vitest";
import { fakeClock } from "./test-helpers.ts";
import { htmlPage, testCrawler, testSite } from "./test-site.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("the deadline of a request", () => {
  it("starts a request before the deadline, and none at or after it", async () => {
    const clock = fakeClock();
    const site = await testSite(
      (path) => (path === "/robots.txt" ? undefined : { type: "text/html", body: htmlPage(path) }),
      clock,
    );
    const { crawler, close } = await testCrawler({ clock });
    cleanups.push(async () => {
      await close();
      await site.close();
    });
    const start = clock.now();
    const fetch = (path: string, deadline?: number) =>
      crawler.runtime.crawler.fetch({
        url: `${site.origin}${path}`,
        mode: "page",
        recipe: "page",
        ...(deadline === undefined ? {} : { deadline }),
      });
    // robots.txt at 0 s, then the pages at 1 s and 4 s: each starts before the deadline at 5 s
    expect((await fetch("/a", start + 5000)).outcome).toBe("ok");
    expect((await fetch("/b", start + 5000)).outcome).toBe("ok");
    // the host is free at 7 s: the request does not wait, and it does not start
    const late = await fetch("/c", start + 5000);
    expect(late.outcome).toBe("skipped");
    expect(late.note).toBe(
      `deadline reached: the host is free at ${new Date(start + 7000).toISOString()}, and the request must start before ${new Date(start + 5000).toISOString()}`,
    );
    expect(clock.now() - start).toBe(4000);
    // a host that is free after its deadline: the request does not start either
    clock.advance(60_000);
    const after = await fetch("/d", start + 10_000);
    expect(after.outcome).toBe("skipped");
    expect(after.note).toMatch(/^deadline reached: the host is free at /);
    // with no deadline, the request waits for its slot as before
    expect((await fetch("/e")).outcome).toBe("ok");
    expect(site.hits.map((hit) => [hit.path, hit.at - start])).toEqual([
      ["/robots.txt", 0],
      ["/a", 1000],
      ["/b", 4000],
      ["/e", 65_000],
    ]);
  });

  it("gives the robots.txt decision for a URL, and refuses what it cannot decide", async () => {
    const clock = fakeClock();
    const site = await testSite(
      (path) => (path === "/robots.txt" ? undefined : { type: "text/html", body: htmlPage(path) }),
      clock,
      "User-agent: *\nDisallow: /closed\n\nUser-agent: Claude-User\nDisallow: /assistant\n",
    );
    const { crawler, close } = await testCrawler({ clock });
    cleanups.push(async () => {
      await close();
      await site.close();
    });
    const allow = (url: string, onBehalfOf?: readonly string[]) =>
      crawler.runtime.crawler.robotsAllow(url, { onBehalfOf });
    expect(await allow(`${site.origin}/open`)).toEqual({ allowed: true, note: undefined });
    expect(await allow(`${site.origin}/closed/x`)).toEqual({
      allowed: false,
      note: "robots.txt disallows it for PoliteCrawler",
    });
    expect((await allow(`${site.origin}/assistant`)).allowed).toBe(true);
    expect(await allow(`${site.origin}/assistant`, ["Claude-User"])).toEqual({
      allowed: false,
      note: "robots.txt disallows it for Claude-User",
    });
    expect(await allow("not a URL")).toEqual({ allowed: false, note: "not a valid URL" });
    expect(await allow("ftp://site.example/")).toEqual({
      allowed: false,
      note: "not an http(s) URL",
    });
    expect((await allow(`${site.origin}/open`, ["Bad Token"])).note).toBe(
      'not a valid product token: "Bad Token"',
    );
    const aborted = new AbortController();
    aborted.abort(new Error("stop"));
    await expect(
      crawler.runtime.crawler.robotsAllow(`${site.origin}/open`, { signal: aborted.signal }),
    ).rejects.toThrow("stop");
    // robots.txt is read one time for the origin
    expect(site.hits.filter((hit) => hit.path === "/robots.txt")).toHaveLength(1);
    await crawler.close();
    expect(await allow(`${site.origin}/open`)).toEqual({ allowed: false, note: "crawler closed" });
  });
});
