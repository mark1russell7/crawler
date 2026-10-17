import { afterEach, describe, expect, it } from "vitest";
import { DeadlineReached, HostScheduler } from "./politeness.ts";
import { fakeClock } from "./test-helpers.ts";
import { htmlPage, testCrawler, testSite } from "./test-site.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("the deadline of a request", () => {
  it("starts a request before the deadline, and none at or after it", async () => {
    const clock = fakeClock();
    const scheduler = new HostScheduler(clock, 4);
    const start = clock.now();
    const task = async () => ({ value: clock.now() - start, delayMs: 3000 });
    expect(await scheduler.run("a", task, undefined, start + 5000)).toBe(0);
    expect(await scheduler.run("a", task, undefined, start + 5000)).toBe(3000);
    // the next slot is at 6 s: the wait ends after the deadline, so the scheduler does not wait
    await expect(scheduler.run("a", task, undefined, start + 5000)).rejects.toBeInstanceOf(
      DeadlineReached,
    );
    expect(clock.now() - start).toBe(3000);
    const late = await scheduler
      .run("b", task, undefined, start + 3000)
      .catch((error: unknown) => error);
    expect(late).toMatchObject({ host: "b", readyAt: start + 3000, deadline: start + 3000 });
    // with no deadline, the scheduler waits for the slot as before
    expect(await scheduler.run("a", task)).toBe(6000);
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
