import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCrawler } from "./open.ts";
import type { HybridCrawler } from "./open.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";
import type { Reply, TestSite } from "./test-site.ts";
import { htmlPage, pagesOf, testSite } from "./test-site.ts";
import type { WatchEvent, WatchRunOptions, WatchRunnerOptions, WatchSummary } from "./watch.ts";
import { WATCH_LIMITS, WatchStore, runWatch } from "./watch.ts";

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
): HybridCrawler => {
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
  crawler: HybridCrawler,
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

  it("drains for a shutdown: the check in progress ends with its state, and no new check starts", async () => {
    const clock = fakeClock();
    const crawler = crawlerOn(await store(), clock);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const made = await siteWith(clock, (path) =>
      path === "/a" || path === "/b"
        ? { type: "text/html", body: htmlPage(path), ...(path === "/a" ? { after: held } : {}) }
        : undefined,
    );
    cleanups.push(() => release());
    // the two entries are on one host, so the second check waits for the first
    await crawler.watch.add(`${made.origin}/a`, { every: "1h" });
    await crawler.watch.add(`${made.origin}/b`, { every: "1h" });
    const drain = new AbortController();
    const run = crawler.watch.run({ drain: drain.signal });
    const events: WatchEvent[] = [];
    const loop = (async () => {
      for await (const event of run) events.push(event);
    })();
    const end = Date.now() + 10_000;
    while (!made.hits.some((hit) => hit.path === "/a") && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 10));
    drain.abort();
    release();
    await loop;
    expect(events.map((event) => [event.url, event.kind])).toEqual([[`${made.origin}/a`, "new"]]);
    expect(await run.summary).toMatchObject({
      checked: 1,
      due: 1,
      stopped: "cancelled",
      reason: "the run stopped for a shutdown: the checks in progress ended first",
    });
    expect(pagesOf(made)).toEqual(["/a"]);
  });

  it("rejects after the close of the crawler", async () => {
    const clock = fakeClock();
    const crawler = crawlerOn(await store(), clock);
    await crawler.close();
    await expect(crawler.watch.list()).rejects.toThrow(/closed/);
    await expect(runOnce(crawler)).rejects.toThrow(/closed/);
    await expect(
      crawler.watch.reschedule("https://example.com/", { at: new Date(clock.now()) }),
    ).rejects.toThrow(/closed/);
  });

  it("names the captures of its checks with the job of runWatch, and a run with no job names none", async () => {
    const clock = fakeClock();
    const crawler = crawlerOn(await store(), clock);
    const { url } = await changing(clock);
    const watches = new WatchStore(":memory:");
    cleanups.push(() => watches.close());
    watches.add(url, { every: "1h" }, clock.now());
    const check = async (options: WatchRunnerOptions): Promise<WatchEvent> => {
      const events: WatchEvent[] = [];
      for await (const event of runWatch(crawler.runtime, watches, options)) events.push(event);
      expect(events).toHaveLength(1);
      return events[0]!;
    };
    const named = await check({ job: "place.recheck" });
    clock.advance(HOUR);
    const plain = await check({});
    expect([named.kind, plain.kind]).toEqual(["new", "unchanged"]);
    const jobs = new Map<string, unknown>();
    for await (const record of crawler.runtime.captures.scan({ source: "fetch" })) {
      jobs.set(record.id, (record.payload as { readonly job?: unknown }).job);
    }
    expect(jobs.get(named.capture!)).toBe("place.recheck");
    expect(jobs.has(plain.capture!)).toBe(true);
    expect(jobs.get(plain.capture!)).toBeUndefined();
  });
});

describe("the schedule of an entry", () => {
  it("reschedules one entry: an earlier time comes sooner, a later time waits, and the check after it uses every again", async () => {
    const clock = fakeClock();
    const crawler = crawlerOn(await store(), clock);
    const one = await changing(clock);
    const two = await changing(clock);
    await crawler.watch.add(one.url, { every: "20h" });
    await crawler.watch.add(two.url, { every: "20h" });
    expect(
      await crawler.watch.reschedule("https://example.com/", { at: new Date(clock.now()) }),
    ).toBeUndefined();
    expect((await runOnce(crawler)).summary).toMatchObject({ checked: 2, due: 0 });
    const checkedAt = async (url: string): Promise<number> =>
      Date.parse((await crawler.watch.list()).find((entry) => entry.url === url)!.checked_at!);
    const first = await checkedAt(one.url);

    // a time before one floor (1 hour) after the last check, or no time, is refused
    await expect(
      crawler.watch.reschedule(one.url, { at: new Date(first + HOUR / 2) }),
    ).rejects.toThrow(/60 minutes after the last check, so a watch cannot hammer a site/);
    await expect(crawler.watch.reschedule(one.url, { at: "soon" })).rejects.toThrow(
      /at must be a time/,
    );

    // the second page is due again after 1 hour, and the first waits 30 hours, not its 20
    const soon = new Date((await checkedAt(two.url)) + HOUR).toISOString();
    expect(await crawler.watch.reschedule(two.url, { at: soon })).toMatchObject({
      url: two.url,
      every_ms: 20 * HOUR,
      checks: 1,
      next_at: soon,
    });
    const late = new Date(first + 30 * HOUR).toISOString();
    expect((await crawler.watch.reschedule(one.url, { at: late }))?.next_at).toBe(late);
    clock.advance(HOUR);
    expect((await runOnce(crawler)).events.map((event) => event.url)).toEqual([two.url]);
    expect(
      Date.parse((await crawler.watch.list()).find((entry) => entry.url === two.url)!.next_at),
    ).toBe((await checkedAt(two.url)) + 20 * HOUR);
    clock.advance(20 * HOUR);
    expect((await runOnce(crawler)).events.map((event) => event.url)).toEqual([two.url]);
    clock.advance(10 * HOUR);
    expect((await runOnce(crawler)).events.map((event) => event.url)).toEqual([one.url]);
    expect(pagesOf(one.made)).toEqual(["/", "/"]);
  });

  it("checks the due entries in the sequence of their times, so an earlier time comes first", () => {
    const watches = new WatchStore(":memory:");
    cleanups.push(() => watches.close());
    const now = Date.parse("2026-10-07T12:00:00Z");
    watches.add("https://one.example/", {}, now);
    watches.add("https://two.example/", {}, now);
    // an entry with no check has no floor: an earlier time puts it first
    const earlier = new Date(now - HOUR).toISOString();
    expect(watches.reschedule("https://two.example/", { at: earlier }, now)).toMatchObject({
      url: "https://two.example/",
      next_at: earlier,
      checks: 0,
    });
    expect(watches.list(now).map((entry) => entry.url)).toEqual([
      "https://two.example/",
      "https://one.example/",
    ]);
    const claimed = watches.claim(now, "runner", now + 60_000, []);
    expect(claimed?.target).toBe("https://two.example/");
    // a check in progress sets the time again when it ends
    watches.reschedule("https://two.example/", { at: new Date(now + 5 * HOUR) }, now);
    watches.settle(claimed!.url, "runner", {
      next_at: now + HOUR,
      last_at: now,
      last_kind: "unchanged",
      last_note: null,
      changed: false,
      doc: null,
    });
    expect(watches.get("https://two.example/", now)?.next_at).toBe(
      new Date(now + HOUR).toISOString(),
    );
    watches.close();
    expect(() => watches.reschedule("https://two.example/", { at: earlier }, now)).toThrow(
      /closed/,
    );
  });

  it("keeps the time of the next check at an add with keepSchedule, and sets it from every by default", async () => {
    const clock = fakeClock();
    const crawler = crawlerOn(await store(), clock);
    const { url } = await changing(clock);
    await crawler.watch.add(url, { every: "20h" });
    await runOnce(crawler);
    const checked = Date.parse((await crawler.watch.list())[0]!.checked_at!);
    const at = new Date(checked + HOUR).toISOString();
    await crawler.watch.reschedule(url, { at });
    // an add with keepSchedule changes the options, and keeps the time
    const kept = await crawler.watch.add(url, {
      every: "24h",
      labels: { place: "p-1" },
      keepSchedule: true,
    });
    expect(kept).toMatchObject({ next_at: at, every_ms: 24 * HOUR, labels: { place: "p-1" } });
    // the default sets the time one every after the last check, as before
    const reset = await crawler.watch.add(url, { every: "24h", keepSchedule: false });
    expect(reset.next_at).toBe(new Date(checked + 24 * HOUR).toISOString());
    expect((await crawler.watch.add(url, { every: "20h" })).next_at).toBe(
      new Date(checked + 20 * HOUR).toISOString(),
    );
    // a new entry is due at once, also with keepSchedule
    const fresh = await crawler.watch.add("https://example.com/new", { keepSchedule: true });
    expect(fresh.next_at).toBe(new Date(clock.now()).toISOString());
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
    expect(a.get("https://two.example/", now)).toMatchObject({ checks: 0, pending: null });
    expect(a.get("https://three.example/", now)).toBeUndefined();
    // a closed store writes nothing, and a run that ends during a close does not throw
    a.close();
    expect(a.settle(taken!.url, "runner-b", update)).toBe(false);
    expect(() => a.release(taken!.url, "runner-b")).not.toThrow();
    expect(() => a.list(now)).toThrow(/closed/);
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
