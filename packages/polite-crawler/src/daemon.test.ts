import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Daemon,
  DaemonMcpHost,
  DaemonMcpOptions,
  DaemonOptions,
  DaemonTick,
} from "./daemon.ts";
import {
  DAEMON_STATE_SCHEMA,
  changeCommand,
  nextTickAt,
  readDaemonState,
  scheduleWatches,
  startDaemon,
} from "./daemon.ts";
import type { OpenedCrawler } from "./open.ts";
import { openCrawler } from "./open.ts";
import type { Clock } from "./politeness.ts";
import { realClock } from "./politeness.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";
import type { Reply, TestSite } from "./test-site.ts";
import { htmlPage, testSite } from "./test-site.ts";
import type { WatchEntry, WatchEvent, WatchList, WatchSummary } from "./watch.ts";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const store = async (): Promise<string> => {
  const dir = await tempDir("daemon");
  cleanups.push(() => removeDir(dir));
  return dir;
};

const open = (dir: string, clock?: Clock): OpenedCrawler => {
  const crawler = openCrawler({
    dir,
    renderer: false,
    egress: { allowPrivate: true },
    random: () => 0.5,
    ...(clock === undefined ? {} : { clock }),
  });
  cleanups.push(() => crawler.close());
  return crawler;
};

const site = async (
  route: (path: string) => Reply | undefined,
  clock: Clock = realClock,
): Promise<TestSite> => {
  const made = await testSite((path) => route(path), clock);
  cleanups.push(() => made.close());
  return made;
};

/** A gate holds the answer of a page until the test opens it. The cleanup opens it, so the site can close. */
const gate = (): { readonly wait: Promise<void>; readonly open: () => void } => {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanups.push(() => release());
  return { wait, open: () => release() };
};

/** This function waits until a condition is true, on the real clock. */
const until = async (condition: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("the condition did not come true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** This function adds watches to a store, with a crawler that closes before the daemon opens the store. */
const watchOn = async (
  dir: string,
  urls: readonly string[],
  clock: Clock = realClock,
  options: { readonly confirm?: 1 | 2 } = {},
): Promise<void> => {
  const crawler = openCrawler({ dir, renderer: false, clock });
  for (const url of urls) await crawler.watch.add(url, { every: "1h", ...options });
  await crawler.close();
};

/** This function runs a schedule over a crawler until `ticks` ticks ended. */
const scheduleFor = async (
  crawler: OpenedCrawler,
  clock: Clock,
  ticks: number,
  options: Parameters<typeof scheduleWatches>[1] = {},
): Promise<{ ticks: DaemonTick[]; events: WatchEvent[] }> => {
  const seen: DaemonTick[] = [];
  const events: WatchEvent[] = [];
  const schedule = scheduleWatches(crawler.watch, {
    clock,
    ...options,
    onEvent: (event) => events.push(event),
    onTick: (tick) => {
      seen.push(tick);
      if (seen.length >= ticks) void schedule.stop();
    },
  });
  const result = await schedule.done;
  expect(result.ticks).toBe(ticks);
  return { ticks: seen, events };
};

const page = (title: string): Reply => ({ type: "text/html", body: htmlPage(title) });
/** This function gives the mode of a file for its owner, group and others. Windows has no such mode, so it gives 0o600 there. */
const modeOf = (file: string): number =>
  process.platform === "win32" ? 0o600 : statSync(file).mode & 0o777;
const at = (time: string | null): number => Date.parse(time ?? "");

describe("the schedule of the watch list", () => {
  it("waits one tick and a jitter within its bounds when nothing is due", async () => {
    const clock = fakeClock();
    const crawler = open(await store(), clock);
    const randoms = [0, 0.999, 0.5];
    const { ticks } = await scheduleFor(crawler, clock, 3, {
      tick: "1m",
      jitter: "10s",
      random: () => randoms.shift() ?? 0,
    });
    const waits = ticks.map((tick) => at(tick.next_at) - at(tick.ended_at));
    expect(waits).toEqual([MINUTE, MINUTE + 9_990, MINUTE + 5_000]);
    // the schedule sleeps on the clock of the crawler until the next tick, and the stop ends the last wait
    expect(clock.slept).toEqual([MINUTE, MINUTE + 9_990]);
    expect(ticks.every((tick) => tick.summary?.checked === 0)).toBe(true);
  });

  it("checks each entry at its time: a due entry wakes the schedule before the tick, never before its time", async () => {
    const clock = fakeClock();
    const dir = await store();
    const made = await site(
      (path) => (path === "/" || path === "/b" ? page(path) : undefined),
      clock,
    );
    await watchOn(dir, [`${made.origin}/`, `${made.origin}/b`], clock);
    const crawler = open(dir, clock);
    const { ticks, events } = await scheduleFor(crawler, clock, 2, {
      tick: "3h",
      jitter: "30s",
      random: () => 0.5,
    });
    expect(events.map((event) => event.kind)).toEqual(["new", "new", "unchanged", "unchanged"]);
    // the two entries are on one host: one request at a time
    expect(made.maxInFlight()).toBe(1);
    const due = Math.min(...events.slice(0, 2).map((event) => at(event.next_at)));
    expect(at(ticks[0]!.next_at)).toBe(due + 15_000);
    expect(at(ticks[1]!.started_at)).toBe(due + 15_000);
    // no check came before the time of its entry
    const pages = made.hits.filter((hit) => hit.path !== "/robots.txt");
    expect(pages).toHaveLength(4);
    expect(pages.slice(2).every((hit) => hit.at >= due)).toBe(true);
    expect(ticks[0]!.due.map((entry) => entry.last_kind)).toEqual(["new", "new"]);
  });

  it("keeps a budget for each tick: the entries that a tick leaves wait for the next tick", async () => {
    const clock = fakeClock();
    const dir = await store();
    const sites = await Promise.all([1, 2, 3].map(() => site(() => page("A page"), clock)));
    await watchOn(
      dir,
      sites.map((one) => `${one.origin}/`),
      clock,
    );
    const crawler = open(dir, clock);
    const { ticks } = await scheduleFor(crawler, clock, 3, { tick: "5m", jitter: 0, maxPages: 1 });
    expect(ticks.map((tick) => [tick.summary?.checked, tick.summary?.stopped])).toEqual([
      [1, "max-pages"],
      [1, "max-pages"],
      [1, "done"],
    ]);
    // a tick that the limit stopped waits one whole tick
    expect(at(ticks[0]!.next_at) - at(ticks[0]!.ended_at)).toBe(5 * MINUTE);
    const none = await scheduleFor(crawler, clock, 2, { tick: "5m", jitter: 0, budget: 0 });
    expect(none.ticks.map((tick) => tick.summary?.stopped)).toEqual(["budget", "budget"]);
    expect(none.events).toEqual([]);
  });

  it("waits for the end of the stop of a host, with no request in the stop", async () => {
    const clock = fakeClock();
    const dir = await store();
    let served = 0;
    const made = await site(
      (path) =>
        path !== "/"
          ? undefined
          : served++ === 0
            ? {
                status: 429,
                type: "text/plain",
                headers: { "retry-after": String((2 * HOUR) / 1000) },
                body: "slow down",
              }
            : page("Back"),
      clock,
    );
    await watchOn(dir, [`${made.origin}/`], clock);
    const crawler = open(dir, clock);
    const { ticks, events } = await scheduleFor(crawler, clock, 2, { tick: "1d", jitter: 0 });
    const checked = at(ticks[0]!.ended_at);
    const stopEnd = at(events[0]!.next_at);
    expect(stopEnd - checked).toBeGreaterThanOrEqual(2 * HOUR - 1000);
    // the next tick comes at the end of the stop, not at the end of the tick of 1 day
    expect(at(ticks[0]!.next_at)).toBe(stopEnd);
    expect(events[1]).toMatchObject({ kind: "new", outcome: "ok" });
    const inStop = made.hits.filter(
      (hit) => hit.path === "/" && hit.at > checked && hit.at < stopEnd,
    );
    expect(inStop).toEqual([]);
  });

  it("gives the next tick: due times, leases, a floor and a run that a limit stopped", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    const entry = (next: number, lease: number | null = null): WatchEntry =>
      ({
        url: "https://example.com/",
        next_at: new Date(next).toISOString(),
        leased_until: lease === null ? null : new Date(lease).toISOString(),
      }) as unknown as WatchEntry;
    const summary = (stopped: WatchSummary["stopped"]): WatchSummary =>
      ({ stopped }) as WatchSummary;
    const options = { tickMs: HOUR, jitterMs: 1000, random: () => 0 };
    expect(nextTickAt([], summary("done"), now, options)).toBe(now + HOUR);
    expect(nextTickAt([entry(now + MINUTE)], summary("done"), now, options)).toBe(now + MINUTE);
    // an entry that a different process holds waits for the end of its lease
    const leased = entry(now - MINUTE, now + 5 * MINUTE);
    expect(nextTickAt([leased], summary("done"), now, options)).toBe(now + 5 * MINUTE);
    // an entry that became due during the run gets the floor of 1 second
    expect(nextTickAt([entry(now - 1)], summary("done"), now, options)).toBe(now + 1000);
    // an entry that the budget left, or a run that failed, waits one tick
    expect(nextTickAt([entry(now - 1)], summary("budget"), now, options)).toBe(now + HOUR);
    expect(nextTickAt([entry(now - 1)], null, now, options)).toBe(now + HOUR);
    // the jitter stays within its bound, also for a bad random number
    expect(nextTickAt([], summary("done"), now, { ...options, random: () => 2 })).toBe(
      now + HOUR + 1000,
    );
  });

  it("checks its options", () => {
    const watch = {} as WatchList;
    expect(() => scheduleWatches(watch, { tick: "10ms" })).toThrow(/tick must be 1000 ms or more/);
    expect(() => scheduleWatches(watch, { jitter: "soon" })).toThrow(/jitter: not a duration/);
    expect(() => scheduleWatches(watch, { maxPages: 0 })).toThrow(/maxPages/);
  });
});

describe("the daemon", () => {
  const options = (dir: string, extra: Partial<DaemonOptions> = {}): DaemonOptions => ({
    dir,
    renderer: false,
    egress: { allowPrivate: true },
    random: () => 0,
    signals: false,
    events: false,
    log: () => undefined,
    ...extra,
  });

  const started = async (given: DaemonOptions): Promise<Daemon> => {
    const daemon = await startDaemon(given);
    cleanups.push(async () => {
      await daemon.stop(0);
    });
    return daemon;
  };

  it("writes each confirmed change as one JSON line, gives it to onChange, and keeps a state file", async () => {
    const clock = fakeClock();
    const dir = await store();
    let served = 0;
    const made = await site(
      (path) => (path === "/" ? page(served++ === 0 ? "First" : "Second") : undefined),
      clock,
    );
    await watchOn(dir, [`${made.origin}/`], clock, { confirm: 1 });
    const events = join(dir, "logs", "changes.jsonl");
    const changes: WatchEvent[] = [];
    let daemon: Daemon | undefined;
    daemon = await started(
      options(dir, {
        clock,
        tick: "2h",
        jitter: 0,
        events,
        onChange: (event) => {
          changes.push(event);
          void daemon?.stop();
          throw new Error("the hook failed");
        },
      }),
    );
    expect(readDaemonState(dir)?.alive).toBe(true);
    const final = await daemon.done;
    expect(final).toMatchObject({ running: false, ticks: 2, checked: 2, changes: 1 });
    const lines = readFileSync(events, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as WatchEvent;
    expect(line).toMatchObject({ kind: "changed", confirmed: true, url: `${made.origin}/` });
    expect(changes.map((event) => event.capture)).toEqual([line.capture]);
    // the error of the hook is the last error, and the daemon went on
    expect(final.last_error?.message).toBe("the on-change hook: the hook failed");
    const state = readDaemonState(dir)!;
    expect(state).toMatchObject({
      schema: DAEMON_STATE_SCHEMA,
      alive: false,
      running: false,
      ticks: 2,
      mcp: null,
      tasks: [],
    });
    expect(state.next_due.map((due) => due.url)).toEqual([`${made.origin}/`]);
    expect(state.stopped_at).not.toBeNull();
    expect(modeOf(daemon.stateFile)).toBe(0o600);
    expect(modeOf(events)).toBe(0o600);
  });

  it("refuses a second daemon on a store, and a state file of a process that ended holds nothing", async () => {
    const dir = await store();
    const lines: string[] = [];
    const first = await started(options(dir, { tick: "1h", events: (line) => lines.push(line) }));
    await until(() => first.status().ticks === 1);
    await expect(startDaemon(options(dir))).rejects.toThrow(/a daemon runs on the store/);
    expect((await first.stop()).running).toBe(false);
    expect(lines).toEqual([]);
    // after a stop, a new daemon starts on the store
    const second = await started(options(dir, { tick: "1h" }));
    await second.stop();
    const file = join(dir, "daemon", "state.json");
    const stale = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    // no system gives this id to a process: Linux stops at 2^22, Windows uses multiples of 4
    writeFileSync(file, JSON.stringify({ ...stale, running: true, pid: 2 ** 22 + 12_345 }));
    expect(readDaemonState(dir)).toMatchObject({ running: true, alive: false });
    const third = await started(options(dir, { tick: "1h" }));
    await third.stop();
    writeFileSync(file, "not json");
    expect(readDaemonState(dir)).toBeUndefined();
    await expect(startDaemon(options(dir, { tick: "10ms" }))).rejects.toThrow(/tick must be/);
  });

  it("lets the check in progress end at a stop, within the grace", async () => {
    const dir = await store();
    const held = gate();
    const made = await site((path) =>
      path === "/slow" ? { ...page("Slow"), after: held.wait } : undefined,
    );
    await watchOn(dir, [`${made.origin}/slow`]);
    const daemon = await started(options(dir, { tick: "1h", grace: "10s" }));
    await until(() => made.hits.some((hit) => hit.path === "/slow"));
    const stopping = daemon.stop();
    held.open();
    const final = await stopping;
    expect(final).toMatchObject({ running: false, ticks: 1, checked: 1 });
    const entry = (await open(dir).watch.list())[0]!;
    expect(entry).toMatchObject({ checks: 1, last_kind: "new", leased_until: null });
  });

  it("aborts a check that the grace does not cover, and releases its lease", async () => {
    const dir = await store();
    const held = gate();
    const made = await site((path) =>
      path === "/hang" ? { ...page("Hang"), after: held.wait } : undefined,
    );
    await watchOn(dir, [`${made.origin}/hang`]);
    const daemon = await started(options(dir, { tick: "1h", grace: "50ms" }));
    await until(() => made.hits.some((hit) => hit.path === "/hang"));
    const begin = Date.now();
    const final = await daemon.stop();
    expect(Date.now() - begin).toBeLessThan(5_000);
    expect(final).toMatchObject({ running: false, checked: 0 });
    await until(() => made.dropped.includes("/hang"));
    // the entry has no lease and stays due, so the next daemon checks it at once
    const entry = (await open(dir).watch.list())[0]!;
    expect(entry).toMatchObject({ checks: 0, leased_until: null });
    expect(Date.parse(entry.next_at)).toBeLessThanOrEqual(Date.now());
  });

  it("serves MCP through its seam, with a new token at each start, and lists the tasks", async () => {
    const dir = await store();
    const given: DaemonMcpOptions[] = [];
    let closed = 0;
    const host: DaemonMcpHost = {
      start: (_crawler, mcp) => {
        given.push(mcp);
        return Promise.resolve({
          url: "http://127.0.0.1:1234/mcp",
          tasks: () => [
            {
              id: "t1",
              tool: "crawl_site",
              status: "working",
              message: "1 of 3 done",
              created_at: "2026-10-07T12:00:00.000Z",
              updated_at: "2026-10-07T12:00:01.000Z",
            },
          ],
          close: () => {
            closed += 1;
            return Promise.resolve();
          },
        });
      },
    };
    const daemon = await started(options(dir, { tick: "1h", mcp: { port: 1234 }, mcpHost: host }));
    const tokenFile = join(dir, "daemon", "mcp-token");
    const token = readFileSync(tokenFile, "utf8").trim();
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(given).toMatchObject([{ port: 1234, token }]);
    expect(modeOf(tokenFile)).toBe(0o600);
    expect(daemon.status()).toMatchObject({
      mcp: { url: "http://127.0.0.1:1234/mcp", token_file: tokenFile },
      tasks: [{ id: "t1", tool: "crawl_site", message: "1 of 3 done" }],
    });
    await daemon.stop();
    expect(closed).toBe(1);
    // a new start makes a new token, and a token of the operator is not written
    const again = await started(options(dir, { tick: "1h", mcp: {}, mcpHost: host }));
    expect(readFileSync(tokenFile, "utf8").trim()).not.toBe(token);
    await again.stop();
    const own = await started(
      options(dir, { tick: "1h", mcp: { tokenFile: "/no/such/file" }, mcpHost: host }),
    );
    expect(given.at(-1)).toMatchObject({ tokenFile: "/no/such/file" });
    expect(given.at(-1)?.token).toBeUndefined();
    expect(own.status().mcp?.token_file).toBe("/no/such/file");
    await own.stop();
    // a host that fails stops the start, and closes the crawler
    await expect(
      startDaemon(
        options(dir, {
          mcp: {},
          mcpHost: { start: () => Promise.reject(new Error("the port is in use")) },
        }),
      ),
    ).rejects.toThrow(/in use/);
    expect(readDaemonState(dir)?.alive).toBe(false);
  });
});

describe("the on-change command", () => {
  it("gets the event as one JSON line on its standard input, and never in its command line", async () => {
    const dir = await store();
    const script = join(dir, "hook.mjs");
    const out = join(dir, "out.json");
    writeFileSync(
      script,
      'import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], readFileSync(0, "utf8"));\n',
    );
    const hook = changeCommand(`"${process.execPath}" "${script}" "${out}"`);
    const event = { url: "https://example.com/", kind: "changed", note: "$(touch pwned) `id`" };
    await hook(event as unknown as WatchEvent);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(event);
  });

  it("rejects for an exit code that is not 0, and stops a command that runs too long", async () => {
    const dir = await store();
    const fails = join(dir, "fails.mjs");
    writeFileSync(fails, 'process.stderr.write("the disk is full");\nprocess.exit(3);\n');
    const event = { url: "https://example.com/" } as unknown as WatchEvent;
    await expect(changeCommand(`"${process.execPath}" "${fails}"`)(event)).rejects.toThrow(
      /exited with code 3: the disk is full/,
    );
    const slow = join(dir, "slow.mjs");
    writeFileSync(slow, "setTimeout(() => undefined, 3000);\n");
    await expect(
      changeCommand(`"${process.execPath}" "${slow}"`, { timeout: "100ms" })(event),
    ).rejects.toThrow(/ran for more than 100 ms/);
    expect(() => changeCommand("  ")).toThrow(/empty/);
  });
});
