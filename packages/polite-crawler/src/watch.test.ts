import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCrawler } from "./open.ts";
import type { OpenedCrawler } from "./open.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";
import type { Reply, TestSite } from "./test-site.ts";
import { htmlPage, pagesOf, testSite } from "./test-site.ts";
import type { WatchEvent, WatchRunOptions, WatchSummary } from "./watch.ts";
import { WATCH_LIMITS, WatchStore } from "./watch.ts";

const HOUR = 3_600_000;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const store = async (): Promise<string> => {
  const dir = await tempDir("watch");
  cleanups.push(() => removeDir(dir));
  return dir;
};

type Clock = ReturnType<typeof fakeClock>;

const crawlerOn = (
  dir: string,
  clock: Clock,
  extra: { watchFloor?: string } = {},
): OpenedCrawler => {
  const crawler = openCrawler({
    dir,
    clock,
    renderer: false,
    egress: { allowPrivate: true },
    random: () => 0.5,
    ...extra,
  });
  cleanups.push(() => crawler.close());
  return crawler;
};

const siteWith = async (
  clock: Clock,
  route: (path: string) => Reply | undefined,
  robots?: string,
): Promise<TestSite> => {
  const made = await testSite((path) => route(path), clock, robots);
  cleanups.push(() => made.close());
  return made;
};

/** This function runs the watch list and gives the events and the summary. */
const runOnce = async (
  crawler: OpenedCrawler,
  options: WatchRunOptions = {},
): Promise<{ events: WatchEvent[]; summary: WatchSummary }> => {
  const run = crawler.watch.run(options);
  const events: WatchEvent[] = [];
  for await (const event of run) events.push(event);
  return { events, summary: await run.summary };
};

/** A page whose text the test changes. */
const changing = async (clock: Clock) => {
  const state = {
    text: "Hours: Tuesday to Sunday",
    status: 200,
    headers: {} as Record<string, string>,
  };
  const made = await siteWith(clock, (path) =>
    path === "/"
      ? {
          status: state.status,
          type: "text/html",
          headers: state.headers,
          body: state.status === 200 ? htmlPage(state.text) : "gone",
        }
      : undefined,
  );
  return { made, state, url: `${made.origin}/` };
};

describe("a watch", () => {
  it("is due at once, then each `every`: new, unchanged, then a change that a second check confirms", async () => {
    const clock = fakeClock();
    const crawler = crawlerOn(await store(), clock);
    const { made, state, url } = await changing(clock);
    const added = await crawler.watch.add(url, { every: "1h", labels: { lineage: "test" } });
    expect(added).toMatchObject({
      url,
      every_ms: HOUR,
      confirm: 2,
      checks: 0,
      next_at: new Date(clock.now()).toISOString(),
      labels: { lineage: "test" },
      pending: null,
    });

    const first = await runOnce(crawler);
    expect(first.events.map((event) => [event.kind, event.suspected, event.confirmed])).toEqual([
      ["new", false, false],
    ]);
    const baseline = first.events[0]!;
    expect(baseline).toMatchObject({ outcome: "ok", previous: null, diff: null, held_back: false });
    expect(baseline.capture).toMatch(/^fetch\./);
    expect(first.summary).toMatchObject({ checked: 1, new: 1, due: 0, stopped: "done" });
    const checkedAt = Date.parse((await crawler.watch.list())[0]!.checked_at!);
    expect(Date.parse(baseline.next_at)).toBe(checkedAt + HOUR);

    // nothing is due before the hour: the run sends no request
    const hits = made.hits.length;
    clock.advance(HOUR / 2);
    expect((await runOnce(crawler)).summary).toMatchObject({ checked: 0, stopped: "done" });
    expect(made.hits.length).toBe(hits);

    clock.advance(HOUR);
    const same = await runOnce(crawler);
    expect(same.events.map((event) => event.kind)).toEqual(["unchanged"]);
    expect(same.events[0]!.previous).toBe(baseline.capture);

    state.text = "Hours: Wednesday to Sunday";
    clock.advance(HOUR);
    const seen = (await runOnce(crawler)).events[0]!;
    expect(seen).toMatchObject({ kind: "changed", suspected: true, confirmed: false });
    expect(seen.previous).toBe(baseline.capture);
    expect(seen.diff).toMatchObject({ lines_changed: 1 });
    // the title changed too
    expect(seen.diff!.meta_changes).toBeGreaterThanOrEqual(1);
    expect(seen.note).toMatch(/the next check confirms it/);
    const suspected = (await crawler.watch.list())[0]!;
    expect(suspected).toMatchObject({ capture: baseline.capture, changes: 0 });
    expect(suspected.pending).toMatchObject({ kind: "changed", capture: seen.capture });

    clock.advance(HOUR);
    const confirmed = await runOnce(crawler);
    expect(confirmed.events[0]).toMatchObject({
      kind: "changed",
      suspected: false,
      confirmed: true,
      previous: baseline.capture,
    });
    expect(confirmed.summary).toMatchObject({ changed: 1, confirmed: 1, suspected: 0 });
    const after = (await crawler.watch.list())[0]!;
    expect(after).toMatchObject({
      capture: confirmed.events[0]!.capture,
      changes: 1,
      checks: 4,
      pending: null,
      last_kind: "changed",
    });
    // each check is a request: robots.txt one time, and the page at each check
    expect(pagesOf(made)).toEqual(["/", "/", "/", "/"]);
  });

  it("takes a change that does not repeat for a glitch, and confirm 1 confirms at once", async () => {
    const clock = fakeClock();
    const crawler = crawlerOn(await store(), clock);
    const { state, url } = await changing(clock);
    await crawler.watch.add(url, { every: "1h" });
    await runOnce(crawler);
    state.text = "A glitch of the site";
    clock.advance(HOUR);
    expect((await runOnce(crawler)).events[0]).toMatchObject({ kind: "changed", suspected: true });
    state.text = "Hours: Tuesday to Sunday";
    clock.advance(HOUR);
    const back = (await runOnce(crawler)).events[0]!;
    expect(back).toMatchObject({ kind: "unchanged", suspected: false });
    expect(back.note).toMatch(/did not repeat/);
    expect((await crawler.watch.list())[0]!.pending).toBeNull();

    // a second change that differs from the suspected one is suspected again
    state.text = "First change";
    clock.advance(HOUR);
    await runOnce(crawler);
    state.text = "Second change";
    clock.advance(HOUR);
    const other = (await runOnce(crawler)).events[0]!;
    expect(other).toMatchObject({ kind: "changed", suspected: true });
    expect(other.note).toMatch(/a different change than the last check/);

    await crawler.watch.add(url, { every: "1h", confirm: 1 });
    state.text = "Third change";
    clock.advance(HOUR);
    expect((await runOnce(crawler)).events[0]).toMatchObject({
      kind: "changed",
      suspected: false,
      confirmed: true,
    });
  });

  it("finds a page that is gone, confirms it, and sees it come back", async () => {
    const clock = fakeClock();
    const crawler = crawlerOn(await store(), clock);
    const { state, url } = await changing(clock);
    await crawler.watch.add(url, { every: "1h" });
    await runOnce(crawler);
    state.status = 404;
    clock.advance(HOUR);
    expect((await runOnce(crawler)).events[0]).toMatchObject({
      kind: "gone",
      suspected: true,
      outcome: "not-found",
      status: 404,
    });
    clock.advance(HOUR);
    expect((await runOnce(crawler)).events[0]).toMatchObject({ kind: "gone", confirmed: true });
    expect((await crawler.watch.list())[0]).toMatchObject({ gone: true, changes: 1 });
    clock.advance(HOUR);
    expect((await runOnce(crawler)).events[0]).toMatchObject({ kind: "unchanged" });
    state.status = 200;
    clock.advance(HOUR);
    const back = (await runOnce(crawler)).events[0]!;
    expect(back).toMatchObject({ kind: "new", suspected: true });
    expect((await crawler.watch.list())[0]!.pending).toMatchObject({ kind: "new" });
  });

  it("gives refused for robots.txt and a stopped host, and a stop moves the next check", async () => {
    const clock = fakeClock();
    const crawler = crawlerOn(await store(), clock);
    const closed = await siteWith(clock, () => undefined, "User-agent: *\nDisallow: /\n");
    await crawler.watch.add(`${closed.origin}/private`, { every: "1h" });
    const refused = await runOnce(crawler);
    expect(refused.events[0]).toMatchObject({ kind: "refused", outcome: "skipped" });
    expect(refused.events[0]!.note).toMatch(/robots.txt disallows it/);
    expect(pagesOf(closed)).toEqual([]);

    // a challenge stops the host for 24 hours: the watch waits for the end of the stop
    const { state, url } = await changing(clock);
    await crawler.watch.add(url, { every: "1h" });
    await runOnce(crawler);
    state.headers = { "cf-mitigated": "challenge" };
    state.status = 403;
    clock.advance(HOUR);
    const stopped = await runOnce(crawler);
    const event = stopped.events.find((one) => one.url === url)!;
    expect(event).toMatchObject({ kind: "refused", outcome: "challenge" });
    const entry = (await crawler.watch.list()).find((one) => one.url === url)!;
    expect(Date.parse(entry.next_at) - Date.parse(entry.checked_at!)).toBeGreaterThan(23 * HOUR);
    // a refusal is not a change: the confirmed version stays
    expect(entry.capture).not.toBeNull();
    expect(entry.pending).toBeNull();
  });

  it("keeps an entry due when the budget ends before its request, and obeys maxPages", async () => {
    const clock = fakeClock();
    const crawler = crawlerOn(await store(), clock);
    const one = await changing(clock);
    const two = await changing(clock);
    await crawler.watch.add(one.url, { every: "1h" });
    await crawler.watch.add(two.url, { every: "1h" });
    const none = await runOnce(crawler, { budgetMs: 0 });
    expect(none.summary).toMatchObject({ checked: 0, due: 2, stopped: "budget" });
    const limited = await runOnce(crawler, { maxPages: 1 });
    expect(limited.summary).toMatchObject({ checked: 1, due: 1, stopped: "max-pages" });
    expect((await runOnce(crawler)).summary).toMatchObject({ checked: 1, due: 0, stopped: "done" });
    await expect(runOnce(crawler, { maxPages: 0 })).rejects.toThrow(RangeError);
  });

  it("holds back the diff of a page that asked not to be AI input", async () => {
    const clock = fakeClock();
    const crawler = crawlerOn(await store(), clock);
    const { state, url } = await changing(clock);
    state.headers = { "content-signal": "ai-input=no" };
    await crawler.watch.add(url, { every: "1h", confirm: 1 });
    await runOnce(crawler);
    state.text = "SECRET new text";
    clock.advance(HOUR);
    const event = (await runOnce(crawler)).events[0]!;
    expect(event).toMatchObject({ kind: "changed", held_back: true, diff: null });
    expect(JSON.stringify(event)).not.toContain("SECRET");
  });

  it("checks the floor of every, the options and the URL", async () => {
    const clock = fakeClock();
    const crawler = crawlerOn(await store(), clock);
    await expect(crawler.watch.add("https://example.com/", { every: "30m" })).rejects.toThrow(
      /every must be 60 minutes or more/,
    );
    await expect(
      crawler.watch.add("https://example.com/", { confirm: 3 as unknown as 1 }),
    ).rejects.toThrow(RangeError);
    await expect(
      crawler.watch.add("https://example.com/", { render: "sometimes" as unknown as "auto" }),
    ).rejects.toThrow(RangeError);
    await expect(crawler.watch.add("ftp://example.com/")).rejects.toThrow(/http or https/);
    await expect(crawler.watch.add("not a url")).rejects.toThrow(/not a valid URL/);
    const entry = await crawler.watch.add("https://example.com/#top");
    expect(entry).toMatchObject({ url: "https://example.com/", every_ms: WATCH_LIMITS.everyMs });
    expect(await crawler.watch.remove("https://EXAMPLE.com/")).toBe(true);
    expect(await crawler.watch.remove("https://example.com/")).toBe(false);
    expect(await crawler.watch.list()).toEqual([]);
    const low = crawlerOn(await store(), clock, { watchFloor: "10m" });
    expect((await low.watch.add("https://example.com/", { every: "30m" })).every_ms).toBe(
      30 * 60_000,
    );
  });
});

describe("a run of the watch list", () => {
  it("gives error for a server error and for a page that gives no document", async () => {
    const clock = fakeClock();
    const crawler = crawlerOn(await store(), clock);
    const made = await siteWith(clock, (path) =>
      path === "/broken"
        ? { status: 500, type: "text/plain", body: "down" }
        : path === "/image"
          ? { type: "image/png", body: new Uint8Array([137, 80, 78, 71]) }
          : undefined,
    );
    await crawler.watch.add(`${made.origin}/broken`, { every: "1h" });
    await crawler.watch.add(`${made.origin}/image`, { every: "1h" });
    const first = await runOnce(crawler, { maxPages: 1 });
    const second = await runOnce(crawler);
    const events = [...first.events, ...second.events];
    expect(
      events.map((event) => [event.url.endsWith("broken") ? "broken" : "image", event.kind]),
    ).toEqual([
      ["broken", "error"],
      ["image", "error"],
    ]);
    expect(events[1]!.note).toMatch(/gave no document/);
    expect(first.summary.error + second.summary.error).toBe(2);
    expect((await crawler.watch.list()).every((entry) => entry.capture === null)).toBe(true);
  });

  it("stops at a cancel and at a break, and an entry that it did not check stays due", async () => {
    const clock = fakeClock();
    const crawler = crawlerOn(await store(), clock);
    const one = await changing(clock);
    const two = await changing(clock);
    await crawler.watch.add(one.url, { every: "1h" });
    await crawler.watch.add(two.url, { every: "1h" });
    const controller = new AbortController();
    controller.abort();
    expect((await runOnce(crawler, { signal: controller.signal })).summary).toMatchObject({
      checked: 0,
      due: 2,
      stopped: "cancelled",
    });
    const run = crawler.watch.run();
    for await (const event of run) {
      expect(event.kind).toBe("new");
      break;
    }
    const summary = await run.summary;
    expect(summary).toMatchObject({ stopped: "cancelled", reason: "the caller stopped the loop" });
    expect(() => run[Symbol.asyncIterator]()).toThrow(/operates one time/);
    // the check in progress at the break ends and writes its state; the run checked each entry once
    const entries = await crawler.watch.list();
    expect(entries.filter((entry) => entry.checks === 1).length + summary.due).toBe(2);
    expect(entries.every((entry) => entry.leased_until === null)).toBe(true);
  });

  it("rejects after the close of the crawler", async () => {
    const clock = fakeClock();
    const crawler = crawlerOn(await store(), clock);
    await crawler.close();
    await expect(crawler.watch.list()).rejects.toThrow(/closed/);
    await expect(runOnce(crawler)).rejects.toThrow(/closed/);
  });
});

describe("the watch list in the store", () => {
  it("stays after a restart, with its state, and opens only when a watch is used", async () => {
    const clock = fakeClock();
    const dir = await store();
    const { url } = await changing(clock);
    const first = crawlerOn(dir, clock);
    await first.fetch(url);
    expect(existsSync(join(dir, "watch.sqlite"))).toBe(false);
    await first.watch.add(url, { every: "2h", scope: "private" });
    const baseline = (await runOnce(first)).events[0]!;
    await first.close();

    clock.advance(2 * 60 * 60_000);
    const second = crawlerOn(dir, clock);
    const [entry] = await second.watch.list();
    expect(entry).toMatchObject({
      url,
      every_ms: 2 * HOUR,
      scope: "private",
      capture: baseline.capture,
      checks: 1,
      last_kind: "new",
    });
    expect((await runOnce(second)).events.map((event) => event.kind)).toEqual(["unchanged"]);
  });

  it("gives each due entry to one runner: a lease keeps a second process away", async () => {
    const clock = fakeClock();
    const dir = await store();
    const a = new WatchStore(join(dir, "watch.sqlite"));
    const b = new WatchStore(join(dir, "watch.sqlite"));
    cleanups.push(() => a.close());
    cleanups.push(() => b.close());
    const now = clock.now();
    a.add("https://one.example/", {}, now);
    const held = a.claim(now, "runner-a", now + 60_000, []);
    expect(held?.target).toBe("https://one.example/");
    expect(b.claim(now, "runner-b", now + 60_000, [])).toBeUndefined();
    expect(b.list(now)[0]!.leased_until).toBe(new Date(now + 60_000).toISOString());
    // a lease that ended (a runner that stopped) frees the entry, and the late runner writes nothing
    const taken = b.claim(now + 60_000, "runner-b", now + 120_000, []);
    expect(taken?.target).toBe("https://one.example/");
    const update = {
      next_at: now + HOUR,
      last_at: now,
      last_kind: "unchanged" as const,
      last_note: null,
      changed: false,
      doc: null,
    };
    expect(a.settle(held!.url, "runner-a", update)).toBe(false);
    expect(b.settle(taken!.url, "runner-b", update)).toBe(true);
    expect(b.list(now)[0]).toMatchObject({ checks: 1, leased_until: null });
    // a busy host is not claimed
    a.add("https://two.example/", {}, now);
    expect(a.claim(now, "runner-a", now + 60_000, ["two.example"])).toBeUndefined();
    expect(() => new WatchStore(":memory:", { floorMs: -1 })).toThrow(RangeError);
  });

  it("lets two runs on one store fetch each entry one time", async () => {
    const clock = fakeClock();
    const dir = await store();
    const sites = await Promise.all([changing(clock), changing(clock), changing(clock)]);
    const one = crawlerOn(dir, clock);
    const two = crawlerOn(dir, clock);
    for (const site of sites) await one.watch.add(site.url, { every: "1h" });
    await two.watch.list();
    const [left, right] = await Promise.all([runOnce(one), runOnce(two)]);
    const urls = [...left.events, ...right.events].map((event) => event.url).sort();
    expect(urls).toEqual(sites.map((site) => site.url).sort());
    for (const site of sites) expect(pagesOf(site.made)).toEqual(["/"]);
    expect(left.summary.checked + right.summary.checked).toBe(3);
  });
});
