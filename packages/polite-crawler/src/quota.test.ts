import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApiError,
  fetchTransport,
  memoryQuotaStore,
  QuotaError,
  quotaGate,
  readQuotaHeaders,
  send,
  withQuota,
  type Exchange,
  type FetchLike,
  type Pace,
  type Quota,
  type QuotaRecord,
  type QuotaStore,
  type Reply,
  type Transport,
} from "./api.ts";
import { HOST_STATE_SCHEMA, SqliteHostStateStore } from "./hoststate.ts";
import { HostScheduler } from "./politeness.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";

const HOST = "api.example.com";
const at = (iso: string): number => Date.parse(iso);

/** A clock that moves only when the test moves it. */
const clockAt = (iso: string): { now: () => number; set: (iso: string) => void; add: (ms: number) => void } => {
  let t = at(iso);
  return {
    now: () => t,
    set: (next) => {
      t = at(next);
    },
    add: (ms) => {
      t += ms;
    },
  };
};

/** A fetch function that records each call and gives a fixed answer. */
const fakeFetch = (
  headers: Record<string, string> = {},
): { fetch: FetchLike; calls: string[] } => {
  const calls: string[] = [];
  const fetch: FetchLike = (url) => {
    calls.push(url);
    return Promise.resolve({
      status: 200,
      statusText: "OK",
      headers: new Headers(headers),
      text: () => Promise.resolve("{}"),
    });
  };
  return { fetch, calls };
};

const get: Exchange = { method: "GET", url: `https://${HOST}/thing`, headers: {}, body: null };

const failure = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`The promise rejected with a value that is not an error: ${String(error)}`);
  }
  throw new Error("The promise did not reject.");
};

const thrown = (work: () => unknown): Error => {
  try {
    work();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`The work threw a value that is not an error: ${String(error)}`);
  }
  throw new Error("The work did not throw.");
};

/** This function gives the record of a key in a store, and changes nothing. */
const recordIn = (store: QuotaStore, key: string): QuotaRecord | undefined => {
  let seen: QuotaRecord | undefined;
  store.changeQuota(key, (record) => {
    seen = record;
    return record ?? { spent: [] };
  });
  return seen;
};

const rolling = (limit: number, ms: number, buckets?: number): Quota => ({
  name: "Example requests",
  limit,
  window: { kind: "rolling", ms, ...(buckets === undefined ? {} : { buckets }) },
});

describe("withQuota on fetchTransport", () => {
  it("refuses a call over the quota with the reset time, and the fetch does not start", async () => {
    const clock = clockAt("2026-11-14T12:00:00.500Z");
    const gate = quotaGate(rolling(2, 60_000), { key: "example:account", now: clock.now });
    const { fetch: inner, calls } = fakeFetch();
    // the result is a fetch function, so each client that takes a fetch takes it
    const fetch: FetchLike = withQuota(gate, inner);
    const transport = fetchTransport({ userAgent: "example-app/1.0", fetch });
    expect((await transport(get, undefined)).status).toBe(200);
    expect((await transport(get, undefined)).status).toBe(200);
    const error = await failure(transport(get, undefined));
    expect(error).toBeInstanceOf(QuotaError);
    expect(error).toBeInstanceOf(ApiError);
    // the bucket of 1 s that starts at 12:00:00 stops counting 60 s after its end
    expect((error as QuotaError).resetAt).toBe(at("2026-11-14T12:01:01Z"));
    expect((error as QuotaError).key).toBe("example:account");
    expect(error.message).toContain("2026-11-14T12:01:01.000Z");
    expect(calls).toHaveLength(2);
    clock.set("2026-11-14T12:01:01Z");
    expect((await transport(get, undefined)).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("reads the count of the provider from the reply, and stops before the provider refuses", async () => {
    const clock = clockAt("2026-11-14T12:00:00Z");
    const gate = quotaGate(rolling(100, 3_600_000), { key: "example:account", now: clock.now });
    const reset = String(at("2026-11-14T13:00:00Z") / 1000);
    const { fetch, calls } = fakeFetch({ "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": reset });
    const transport: Transport = withQuota(gate, fetchTransport({ userAgent: "app/1.0", fetch }), {
      read: (reply: Reply) =>
        readQuotaHeaders(
          (name) => reply.headers[name],
          { remaining: "X-RateLimit-Remaining", resetAt: "X-RateLimit-Reset" },
          clock.now(),
        ),
    });
    await transport(get, undefined);
    expect(gate.state()).toMatchObject({ used: 100, left: 0, blockedUntil: at("2026-11-14T13:00:00Z") });
    const error = await failure(transport(get, undefined));
    expect(error).toBeInstanceOf(QuotaError);
    expect((error as QuotaError).resetAt).toBe(at("2026-11-14T13:00:00Z"));
    expect(error.message).toContain("The provider refused");
    expect(calls).toHaveLength(1);
  });
});

describe("a calendar window", () => {
  it("counts a month in the zone of the provider, and starts again at its midnight", () => {
    // the Pushover limit: 10,000 messages for each month, reset at 00:00 Central Time on the 1st
    const clock = clockAt("2026-11-14T15:00:00Z");
    const gate = quotaGate(
      {
        name: "Pushover messages",
        limit: 10_000,
        window: { kind: "calendar", unit: "month", timeZone: "America/Chicago" },
      },
      { key: "pushover:account", now: clock.now },
    );
    expect(gate.take(9_999)).toEqual({
      used: 9_999,
      left: 1,
      resetAt: at("2026-12-01T06:00:00Z"),
    });
    expect(gate.take()).toMatchObject({ used: 10_000, left: 0 });
    const error = thrown(() => gate.take());
    expect(error).toBeInstanceOf(QuotaError);
    expect((error as QuotaError).resetAt).toBe(at("2026-12-01T06:00:00Z"));
    // 23:59 on November 30 in Chicago is still November
    clock.set("2026-12-01T05:59:59Z");
    expect(() => gate.take()).toThrow(QuotaError);
    clock.set("2026-12-01T06:00:00Z");
    expect(gate.take()).toEqual({ used: 1, left: 9_999, resetAt: at("2027-01-01T06:00:00Z") });
  });

  it("gives a day of 25 hours when the clocks go back", () => {
    // in 2026, Chicago leaves daylight time at 02:00 on November 1
    const clock = clockAt("2026-11-01T12:00:00Z");
    const store = memoryQuotaStore();
    const gate = quotaGate(
      { name: "Example", limit: 5, window: { kind: "calendar", unit: "day", timeZone: "America/Chicago" } },
      { key: "k", store, now: clock.now },
    );
    expect(gate.take().resetAt).toBe(at("2026-11-02T06:00:00Z"));
    expect(recordIn(store, "k")?.spent).toEqual([[at("2026-11-01T05:00:00Z"), 1]]);
  });

  it("starts a day at the hour of the window", () => {
    // 05:30 on November 14 in Kolkata is in the day that started at 06:00 on November 13
    const clock = clockAt("2026-11-14T00:00:00Z");
    const gate = quotaGate(
      {
        name: "Example",
        limit: 5,
        window: { kind: "calendar", unit: "day", timeZone: "Asia/Kolkata", hour: 6 },
      },
      { key: "k", now: clock.now },
    );
    expect(gate.take().resetAt).toBe(at("2026-11-14T00:30:00Z"));
    clock.set("2026-11-14T00:30:00Z");
    expect(gate.state()).toEqual({ used: 0, left: 5 });
  });
});

describe("a rolling window", () => {
  it("frees a unit only when all of its bucket is out of the window", () => {
    const clock = clockAt("1970-01-01T00:00:00Z");
    const gate = quotaGate(rolling(3, 10_000, 10), { key: "k", now: clock.now });
    gate.take();
    clock.add(2_500);
    gate.take();
    clock.add(2_500);
    expect(gate.take()).toEqual({ used: 3, left: 0, resetAt: 11_000 });
    clock.add(1_000);
    expect((thrown(() => gate.take()) as QuotaError).resetAt).toBe(11_000);
    // a window of the provider that started at 0 ends at 10,000, so the gate is the stricter of the two
    clock.set("1970-01-01T00:00:10.999Z");
    expect(() => gate.take()).toThrow(QuotaError);
    clock.set("1970-01-01T00:00:11Z");
    expect(gate.take()).toMatchObject({ used: 3, left: 0 });
  });

  it("frees the oldest buckets that a large call needs", () => {
    const clock = clockAt("1970-01-01T00:00:00Z");
    const gate = quotaGate(rolling(10, 10_000, 10), { key: "k", now: clock.now });
    gate.take(4);
    clock.add(3_000);
    gate.take(4);
    // a call of 6 needs 4 more units: those of the bucket that starts at 0
    expect((thrown(() => gate.take(6)) as QuotaError).resetAt).toBe(11_000);
    expect((thrown(() => gate.take(10)) as QuotaError).resetAt).toBe(14_000);
  });
});

describe("the gate", () => {
  it("keeps the reserve unused", () => {
    const gate = quotaGate({ ...rolling(10, 60_000), reserve: 2 }, { key: "k", now: () => 0 });
    expect(gate.take(8)).toMatchObject({ used: 8, left: 0 });
    expect(() => gate.take()).toThrow(QuotaError);
  });

  it("counts the cost of the arguments of a call", async () => {
    const gate = quotaGate(rolling(10, 60_000), { key: "k", now: () => 0 });
    const call = withQuota(gate, (count: number) => Promise.resolve(count * 2), {
      cost: (count) => count,
    });
    expect(await call(3)).toBe(6);
    expect(gate.state().used).toBe(3);
    expect(await failure(call(8))).toBeInstanceOf(QuotaError);
    expect(gate.state().used).toBe(3);
  });

  it("counts nothing and refuses nothing for a call of cost 0", async () => {
    // one fetch for the messages, which the provider counts, and the receipts, which it does not
    const gate = quotaGate(rolling(1, 60_000), { key: "k", now: () => 0 });
    const urls: string[] = [];
    const call = withQuota(
      gate,
      (url: string) => {
        urls.push(url);
        return Promise.resolve(url);
      },
      { cost: (url) => (url.endsWith("/messages.json") ? 1 : 0) },
    );
    await call("https://api.example.com/1/messages.json");
    expect(await failure(call("https://api.example.com/1/messages.json"))).toBeInstanceOf(
      QuotaError,
    );
    await call("https://api.example.com/1/receipts/r1.json");
    expect(urls).toEqual([
      "https://api.example.com/1/messages.json",
      "https://api.example.com/1/receipts/r1.json",
    ]);
    expect(gate.state()).toMatchObject({ used: 1, left: 0 });
  });

  it("makes the count larger after a reading, never smaller", () => {
    const clock = clockAt("2026-11-14T12:00:00Z");
    const gate = quotaGate(rolling(10, 60_000), { key: "k", now: clock.now });
    gate.take(2);
    expect(gate.note({ remaining: 5 })).toMatchObject({ used: 5, left: 5 });
    expect(gate.note({ remaining: 9 })).toMatchObject({ used: 5, left: 5 });
    // a reset time with units left does not block
    expect(gate.note({ remaining: 4, resetAt: clock.now() + 1000 })).toEqual({
      used: 6,
      left: 4,
      resetAt: at("2026-11-14T12:01:01Z"),
    });
    // a reset time with no count blocks until that time
    gate.note({ resetAt: clock.now() + 30_000 });
    const error = thrown(() => gate.take());
    expect((error as QuotaError).resetAt).toBe(clock.now() + 30_000);
    clock.add(30_000);
    expect(gate.take()).toMatchObject({ used: 7 });
  });

  it("shares the count of a key between the gates of one store", () => {
    const store = memoryQuotaStore();
    const one = quotaGate(rolling(2, 60_000), { key: "k", store, now: () => 0 });
    const two = quotaGate(rolling(2, 60_000), { key: "k", store, now: () => 0 });
    const other = quotaGate(rolling(2, 60_000), { key: "other", store, now: () => 0 });
    one.take();
    two.take();
    expect(() => one.take()).toThrow(QuotaError);
    expect(other.take()).toMatchObject({ used: 1 });
  });

  it("refuses a quota, a window or a cost that is not valid", () => {
    const options = { key: "k" };
    const bad: Quota[] = [
      rolling(0, 1000),
      rolling(Number.NaN, 1000),
      { ...rolling(10, 1000), reserve: 10 },
      { ...rolling(10, 1000), reserve: -1 },
      rolling(10, 0),
      rolling(10, 1000, 0),
      rolling(10, 1000, 1.5),
      rolling(10, 1000, 1001),
      { name: "x", limit: 1, window: { kind: "calendar", unit: "day", timeZone: "Mars/Olympus" } },
      { name: "x", limit: 1, window: { kind: "calendar", unit: "day", timeZone: "UTC", hour: 24 } },
    ];
    for (const quota of bad) expect(() => quotaGate(quota, options)).toThrow(ApiError);
    const gate = quotaGate(rolling(10, 1000), options);
    for (const cost of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = thrown(() => gate.take(cost));
      expect(error).toBeInstanceOf(ApiError);
      expect(error).not.toBeInstanceOf(QuotaError);
    }
    // a call larger than a whole window is a fault of the caller, not a wait
    const large = thrown(() => gate.take(11));
    expect(large).not.toBeInstanceOf(QuotaError);
    expect(large.message).toContain("more than the quota Example requests gives in one window: 10");
  });

  it("reads a record that is not valid as no record", () => {
    const store = memoryQuotaStore();
    store.changeQuota("k", () => ({ spent: "no" }) as unknown as QuotaRecord);
    const gate = quotaGate(rolling(2, 60_000), { key: "k", store, now: () => 0 });
    expect(gate.state()).toEqual({ used: 0, left: 2 });
    expect(gate.take()).toMatchObject({ used: 1 });
  });
});

describe("readQuotaHeaders", () => {
  const now = at("2026-11-14T12:00:00Z");
  const headersOf =
    (values: Record<string, string>) =>
    (name: string): string | undefined =>
      values[name];

  it("reads the count, the reset time and the seconds until the reset", () => {
    const names = { remaining: "X-RateLimit-Remaining", resetAt: "X-RateLimit-Reset" };
    expect(
      readQuotaHeaders(
        headersOf({ "x-ratelimit-remaining": "42", "x-ratelimit-reset": "1795000000" }),
        names,
        now,
      ),
    ).toEqual({ remaining: 42, resetAt: 1_795_000_000_000 });
    expect(
      readQuotaHeaders(headersOf({ "retry-after": "30" }), { resetAfter: "Retry-After" }, now),
    ).toEqual({ resetAt: now + 30_000 });
  });

  it("does not read a value that is not a number, and gives nothing with no value", () => {
    const names = { remaining: "x-remaining", resetAt: "x-reset", resetAfter: "retry-after" };
    expect(
      readQuotaHeaders(
        headersOf({ "x-remaining": "-1", "x-reset": "soon", "retry-after": "1e3" }),
        names,
        now,
      ),
    ).toBeUndefined();
    expect(readQuotaHeaders(() => null, names, now)).toBeUndefined();
  });
});

describe("send with a quota", () => {
  it("gives the QuotaError as it is, and the host keeps its state", async () => {
    const clock = fakeClock("2026-11-14T12:00:00Z");
    const scheduler = new HostScheduler(clock, 4);
    const pace: Pace = { scheduler, now: clock.now, random: () => 0.5 };
    const gate = quotaGate(rolling(1, 3_600_000), { key: "k", now: clock.now });
    let sent = 0;
    const transport = withQuota(gate, (): Promise<Reply> => {
      sent += 1;
      return Promise.resolve({ status: 200, statusText: "OK", headers: {}, body: "{}" });
    });
    const input = { source: "Example", host: HOST, what: "the thing", exchange: get };
    expect((await send(pace, transport, input)).reply.status).toBe(200);
    // more refusals than the failures that stop a host
    for (let round = 0; round < 8; round += 1) {
      const error = await failure(send(pace, transport, input));
      expect(error).toBeInstanceOf(QuotaError);
      expect(error.message).toContain("refused a call of 1 units");
    }
    expect(sent).toBe(1);
    expect(scheduler.store.stopped(HOST, clock.now())).toBeUndefined();
    expect(scheduler.store.record(HOST, "neutral")).toEqual({ failures: 0, waits: 0 });
  });
});

describe("the quotas of the SQLite host state store", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  const pathIn = async (): Promise<string> => {
    const dir = await tempDir("quotas");
    cleanups.push(() => removeDir(dir));
    return join(dir, "hosts.sqlite");
  };
  const open = (path: string): SqliteHostStateStore => {
    const store = new SqliteHostStateStore(path);
    cleanups.push(() => store.close());
    return store;
  };

  it("shares the count between two stores on one file, and keeps it after a restart", async () => {
    const path = await pathIn();
    const quota = rolling(2, 3_600_000);
    const now = (): number => 0;
    const one = quotaGate(quota, { key: "k", store: open(path), now });
    const two = quotaGate(quota, { key: "k", store: open(path), now });
    one.take();
    two.take();
    expect(() => one.take()).toThrow(QuotaError);
    const three = quotaGate(quota, { key: "k", store: open(path), now });
    expect(three.state()).toMatchObject({ used: 2, left: 0 });
  });

  it("reads a row that is not JSON as no record", async () => {
    const path = await pathIn();
    open(path).close();
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO quotas (key, record) VALUES (?, ?)").run("k", "{not json");
    db.close();
    const gate = quotaGate(rolling(2, 60_000), { key: "k", store: open(path), now: () => 0 });
    expect(gate.take()).toMatchObject({ used: 1 });
  });

  it("adds the table of quotas to a file of version 1, and keeps its hosts", async () => {
    const path = await pathIn();
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE hosts (
      host TEXT PRIMARY KEY,
      next_at REAL NOT NULL DEFAULT 0,
      leased_until REAL NOT NULL DEFAULT 0,
      owner TEXT,
      failures INTEGER NOT NULL DEFAULT 0,
      waits INTEGER NOT NULL DEFAULT 0,
      stop_until REAL,
      stop_reason TEXT
    );
    CREATE TABLE validators (
      host TEXT PRIMARY KEY,
      skip_etag INTEGER NOT NULL DEFAULT 0,
      etag TEXT NOT NULL DEFAULT 'unknown',
      last_modified TEXT NOT NULL DEFAULT 'unknown',
      etag_misses INTEGER NOT NULL DEFAULT 0,
      date_misses INTEGER NOT NULL DEFAULT 0,
      since_probe INTEGER NOT NULL DEFAULT 0,
      changed_at REAL NOT NULL DEFAULT 0
    );
    PRAGMA user_version = 1`);
    old
      .prepare("INSERT INTO hosts (host, stop_until, stop_reason) VALUES (?, ?, ?)")
      .run("old.example", 9000, "challenge");
    old.close();
    const store = open(path);
    expect(store.stopped("old.example", 1000)).toEqual({ until: 9000, reason: "challenge" });
    expect(quotaGate(rolling(2, 60_000), { key: "k", store, now: () => 0 }).take()).toMatchObject({
      used: 1,
    });
    store.close();
    const check = new DatabaseSync(path);
    expect(HOST_STATE_SCHEMA).toBe(2);
    expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    check.close();
  });
});
