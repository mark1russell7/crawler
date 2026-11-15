import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import * as api from "./api.ts";
import {
  ApiError,
  fetchTransport,
  isApiError,
  isQuotaError,
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
  type QuotaGate,
  type QuotaRecord,
  type QuotaStore,
  type Reply,
  type Transport,
} from "./api.ts";
import { HOST_STATE_SCHEMA, SqliteHostStateStore } from "./hoststate.ts";
import { HostScheduler } from "./politeness.ts";
import { MILLISECONDS_SINCE_EPOCH_FROM, resetTimeOf, SECONDS_SINCE_EPOCH_FROM } from "./quota.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";

const HOST = "api.example.com";
const at = (iso: string): number => Date.parse(iso);

/** A clock that moves only when the test moves it. */
const clockAt = (
  iso: string,
): { now: () => number; set: (iso: string) => void; add: (ms: number) => void } => {
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
const fakeFetch = (headers: Record<string, string> = {}): { fetch: FetchLike; calls: string[] } => {
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

/** This function gives the record of a quota and a key in a store, and changes nothing. */
const recordIn = (store: QuotaStore, quota: string, key: string): QuotaRecord | undefined => {
  let seen: QuotaRecord | undefined;
  store.changeQuota(quota, key, (record) => {
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
    const clock = clockAt("2026-11-14T12:59:00Z");
    const gate = quotaGate(rolling(100, 3_600_000), { key: "example:account", now: clock.now });
    const reset = String(at("2026-11-14T13:00:00Z") / 1000);
    const { fetch, calls } = fakeFetch({
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": reset,
    });
    const transport: Transport = withQuota(gate, fetchTransport({ userAgent: "app/1.0", fetch }), {
      read: (reply: Reply) =>
        readQuotaHeaders(
          (name) => reply.headers[name],
          { remaining: "X-RateLimit-Remaining", resetAt: "X-RateLimit-Reset" },
          clock.now(),
        ),
    });
    await transport(get, undefined);
    expect(gate.state()).toMatchObject({
      used: 100,
      left: 0,
      blockedUntil: at("2026-11-14T13:00:00Z"),
    });
    // the 100 units of the reading are in the bucket of 12:59, which counts until 14:00
    const error = await failure(transport(get, undefined));
    expect(error).toBeInstanceOf(QuotaError);
    expect((error as QuotaError).resetAt).toBe(at("2026-11-14T14:00:00Z"));
    expect(error.message).toContain("The provider refused the quota Example requests");
    expect(error.message).toContain("units of the call at 2026-11-14T14:00:00.000Z");
    // the refusal of the provider ended, and the window gives the units at the same time as before
    clock.set("2026-11-14T13:00:00Z");
    const later = await failure(transport(get, undefined));
    expect((later as QuotaError).resetAt).toBe(at("2026-11-14T14:00:00Z"));
    clock.set("2026-11-14T14:00:00Z");
    expect((await transport(get, undefined)).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("gives the result of a call that went out when the store or the reading fails", async () => {
    // a store that fails after the take, so the call went out before the note
    const memory = memoryQuotaStore();
    let changes = 0;
    const failing: QuotaStore = {
      changeQuota(quota, key, step) {
        changes += 1;
        if (changes > 1) throw new Error("database is locked");
        return memory.changeQuota(quota, key, step);
      },
    };
    const gate = quotaGate(rolling(10, 60_000), { key: "k", store: failing, now: () => 0 });
    const errors: unknown[] = [];
    let sent = 0;
    const call = withQuota(
      gate,
      () => {
        sent += 1;
        return Promise.resolve("sent");
      },
      { read: () => ({ remaining: 0 }), onError: (error) => errors.push(error) },
    );
    expect(await call()).toBe("sent");
    expect(sent).toBe(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("database is locked");
    // a read that throws goes to the same function, and with no function the result still comes back
    const reading = new Error("bad header");
    const other = quotaGate(rolling(10, 60_000), { key: "k", now: () => 0 });
    const read = (): undefined => {
      throw reading;
    };
    const seen: unknown[] = [];
    const reads = withQuota(other, () => Promise.resolve(1), {
      read,
      onError: (e) => seen.push(e),
    });
    expect(await reads()).toBe(1);
    expect(seen).toEqual([reading]);
    expect(await withQuota(other, () => Promise.resolve(2), { read })()).toBe(2);
  });
});

describe("two quotas on one key", () => {
  it("counts each quota apart in one store", async () => {
    // 10 calls in each 60 s and 20 in each UTC day: 50 tries in 20 minutes send 20 calls
    const store = memoryQuotaStore();
    let t = at("2026-11-14T12:00:00Z");
    const now = (): number => t;
    const minute = quotaGate(
      { name: "Example per minute", limit: 10, window: { kind: "rolling", ms: 60_000 } },
      { key: "example:account", store, now },
    );
    const day = quotaGate(
      {
        name: "Example per day",
        limit: 20,
        window: { kind: "calendar", unit: "day", timeZone: "UTC" },
      },
      { key: "example:account", store, now },
    );
    let sent = 0;
    const call = withQuota([minute, day], () => {
      sent += 1;
      return Promise.resolve();
    });
    let refused = 0;
    for (let round = 0; round < 50; round += 1) {
      try {
        await call();
      } catch (error) {
        if (!(error instanceof QuotaError)) throw error;
        refused += 1;
      }
      t += 24_000;
    }
    expect(sent).toBe(20);
    expect(refused).toBe(30);
    expect(day.state()).toMatchObject({ used: 20, left: 0, resetAt: at("2026-11-15T00:00:00Z") });
    expect(recordIn(store, "Example per day", "example:account")?.spent).toEqual([
      [at("2026-11-14T00:00:00Z"), 20],
    ]);
    // the day refused the last calls, so the minute gave back their units
    expect(minute.state()).toMatchObject({ used: 0, left: 10 });
  });
});

describe("a list of gates", () => {
  /** This function gives a gate of a minute (limit 10) and a gate of a UTC day (limit `perDay`) on one store. */
  const pair = (perDay: number, store: QuotaStore = memoryQuotaStore()) => {
    const clock = clockAt("2026-11-14T12:00:00Z");
    const minute = quotaGate(
      { name: "Example per minute", limit: 10, window: { kind: "rolling", ms: 60_000 } },
      { key: "k", store, now: clock.now },
    );
    const day = quotaGate(
      {
        name: "Example per day",
        limit: perDay,
        window: { kind: "calendar", unit: "day", timeZone: "UTC" },
      },
      { key: "k", store, now: clock.now },
    );
    return { clock, minute, day, store };
  };

  it("counts a call in each gate or in none, and the call does not start", async () => {
    const { minute, day } = pair(2);
    let sent = 0;
    const call = withQuota([minute, day], () => {
      sent += 1;
      return Promise.resolve("sent");
    });
    expect(await call()).toBe("sent");
    expect(await call()).toBe("sent");
    const error = await failure(call());
    expect(error).toBeInstanceOf(QuotaError);
    expect(error.message).toContain("Example per day");
    expect(sent).toBe(2);
    expect(minute.state()).toMatchObject({ used: 2, left: 8 });
    expect(day.state()).toMatchObject({ used: 2, left: 0 });
  });

  it("gives the refusal with the latest reset, and keeps no units of the refused call", async () => {
    const { minute, day } = pair(1);
    const call = withQuota([minute, day], () => Promise.resolve());
    await call();
    // the day refuses until midnight, and the minute still gives units
    const first = await failure(call());
    expect((first as QuotaError).resetAt).toBe(at("2026-11-15T00:00:00Z"));
    // the minute refuses too, until 12:01:01: the error still has the reset of the day
    minute.take(9);
    const second = await failure(call());
    expect((second as QuotaError).resetAt).toBe(at("2026-11-15T00:00:00Z"));
    expect(minute.state()).toMatchObject({ used: 10 });
    expect(day.state()).toMatchObject({ used: 1 });
  });

  it("gives back the units when a later gate throws a fault of the caller", async () => {
    const { minute, day } = pair(2);
    // a cost of 5 is more than the day gives in one window: a fault of the caller, not a wait
    const call = withQuota([minute, day], () => Promise.resolve(), { cost: 5 });
    const error = await failure(call());
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(QuotaError);
    expect(minute.state()).toMatchObject({ used: 0, left: 10 });
  });

  it("reads the count of the provider for each gate apart", async () => {
    const { minute, day } = pair(100);
    const call = withQuota([minute, day], () => Promise.resolve(), {
      // the provider tells the count of its minute only
      read: (_result, gate) => (gate === minute ? { remaining: 7 } : undefined),
    });
    await call();
    expect(minute.state()).toMatchObject({ used: 3, left: 7 });
    expect(day.state()).toMatchObject({ used: 1, left: 99 });
  });

  it("gives an error of a give-back to onError, and still throws the refusal", async () => {
    const memory = memoryQuotaStore();
    let minuteChanges = 0;
    // a store that fails at the second change of the minute: the give-back
    const failing: QuotaStore = {
      changeQuota(quota, key, step) {
        if (quota === "Example per minute") {
          minuteChanges += 1;
          if (minuteChanges === 2) throw new Error("database is locked");
        }
        return memory.changeQuota(quota, key, step);
      },
    };
    const { minute, day } = pair(1, failing);
    day.take();
    const errors: unknown[] = [];
    const call = withQuota([minute, day], () => Promise.resolve(), {
      onError: (error) => errors.push(error),
    });
    expect(await failure(call())).toBeInstanceOf(QuotaError);
    expect(errors.map((error) => (error as Error).message)).toEqual(["database is locked"]);
  });

  it("refuses an empty list, a gate with no giveBack and two gates of one quota and key", () => {
    const { minute, day } = pair(1);
    expect(() => withQuota([], () => Promise.resolve())).toThrow(ApiError);
    // a gate of a different program, with no giveBack
    const noGiveBack: QuotaGate = {
      quota: minute.quota,
      key: minute.key,
      take: (cost) => minute.take(cost),
      note: (reading) => minute.note(reading),
      state: () => minute.state(),
    };
    expect(() => withQuota([noGiveBack, day], () => Promise.resolve())).toThrow(
      "cannot give back units",
    );
    // a gate with no giveBack can still be alone
    expect(() => withQuota([noGiveBack], () => Promise.resolve())).not.toThrow();
    const again = quotaGate(minute.quota, { key: "k" });
    expect(() => withQuota([minute, again], () => Promise.resolve())).toThrow(
      "Two gates of the list have the quota Example per minute of k.",
    );
  });
});

describe("giveBack", () => {
  it("gives back the units of the bucket of their time", () => {
    const clock = clockAt("1970-01-01T00:00:00Z");
    const store = memoryQuotaStore();
    const gate = quotaGate(rolling(10, 10_000, 10), { key: "k", store, now: clock.now });
    gate.take(2);
    clock.add(1_000);
    const taken = gate.take(3);
    expect(taken.at).toBe(1_000);
    clock.add(500);
    // the units of 1,000 are in the bucket of 1,000, not in the bucket of 0 or of the time now
    expect(gate.giveBack?.(3, 1_000)).toMatchObject({ used: 2, left: 8 });
    expect(recordIn(store, "Example requests", "k")?.spent).toEqual([[0, 2]]);
    // a give-back of more units than the bucket has removes the bucket, and the count is not negative
    expect(gate.giveBack?.(5, 0)).toMatchObject({ used: 0, left: 10 });
    expect(gate.giveBack?.(0, 0)).toMatchObject({ used: 0 });
  });

  it("changes nothing after a reading of the provider at the time of the units or later", () => {
    const clock = clockAt("2026-11-14T12:00:00Z");
    const store = memoryQuotaStore();
    const gate = quotaGate(rolling(10, 60_000), { key: "k", store, now: clock.now });
    const taken = gate.take();
    // the provider tells 9 left: its count can include the unit of this call
    gate.note({ remaining: 9 });
    expect(recordIn(store, "Example requests", "k")?.readAt).toBe(clock.now());
    expect(gate.giveBack?.(1, taken.at ?? Number.NaN)).toMatchObject({ used: 1, left: 9 });
    // a call after the reading can give back its units
    clock.add(1);
    const later = gate.take();
    expect(gate.giveBack?.(1, later.at ?? Number.NaN)).toMatchObject({ used: 1, left: 9 });
  });

  it("keeps the latest time of a reading after a step back of the clock", () => {
    const clock = clockAt("1970-01-01T00:00:08Z");
    const gate = quotaGate(rolling(10, 60_000), { key: "k", now: clock.now });
    const taken = gate.take();
    clock.set("1970-01-01T00:00:10Z");
    gate.note({ remaining: 9 });
    // the clock goes back to before the units: the reading of 10 s still includes them
    clock.set("1970-01-01T00:00:05Z");
    gate.note({ remaining: 9 });
    expect(gate.giveBack?.(1, taken.at ?? Number.NaN)).toMatchObject({ used: 1, left: 9 });
  });

  it("keeps nothing of a bucket that is out of the window", () => {
    const clock = clockAt("1970-01-01T00:00:00Z");
    const gate = quotaGate(rolling(10, 10_000, 10), { key: "k", now: clock.now });
    gate.take(4);
    clock.add(20_000);
    gate.take(1);
    expect(gate.giveBack?.(4, 0)).toMatchObject({ used: 1, left: 9 });
  });

  it("refuses a cost or a time that is not valid", () => {
    const gate = quotaGate(rolling(10, 60_000), { key: "k", now: () => 0 });
    for (const [cost, time] of [
      [-1, 0],
      [Number.NaN, 0],
      [1, Number.NaN],
      [1, 9e15],
    ] as const) {
      const error = thrown(() => gate.giveBack?.(cost, time));
      expect(error).toBeInstanceOf(ApiError);
      expect(error).not.toBeInstanceOf(QuotaError);
    }
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
      at: at("2026-11-14T15:00:00Z"),
    });
    expect(gate.take()).toMatchObject({ used: 10_000, left: 0 });
    const error = thrown(() => gate.take());
    expect(error).toBeInstanceOf(QuotaError);
    expect((error as QuotaError).resetAt).toBe(at("2026-12-01T06:00:00Z"));
    // 23:59 on November 30 in Chicago is still November
    clock.set("2026-12-01T05:59:59Z");
    expect(() => gate.take()).toThrow(QuotaError);
    clock.set("2026-12-01T06:00:00Z");
    expect(gate.take()).toEqual({
      used: 1,
      left: 9_999,
      resetAt: at("2027-01-01T06:00:00Z"),
      at: at("2026-12-01T06:00:00Z"),
    });
  });

  it("gives a day of 25 hours when the clocks go back", () => {
    // in 2026, Chicago leaves daylight time at 02:00 on November 1
    const clock = clockAt("2026-11-01T12:00:00Z");
    const store = memoryQuotaStore();
    const gate = quotaGate(
      {
        name: "Example",
        limit: 5,
        window: { kind: "calendar", unit: "day", timeZone: "America/Chicago" },
      },
      { key: "k", store, now: clock.now },
    );
    expect(gate.take().resetAt).toBe(at("2026-11-02T06:00:00Z"));
    expect(recordIn(store, "Example", "k")?.spent).toEqual([[at("2026-11-01T05:00:00Z"), 1]]);
  });

  /** This function gives a gate of a day in a zone, from the hour `hour`, and its clock. */
  const dayIn = (timeZone: string, hour: number, iso: string) => {
    const clock = clockAt(iso);
    const store = memoryQuotaStore();
    const gate = quotaGate(
      { name: "Example", limit: 5, window: { kind: "calendar", unit: "day", timeZone, hour } },
      { key: "k", store, now: clock.now },
    );
    return { clock, gate, store };
  };

  it("starts a day at the end of the gap when the clock jumps over its hour", () => {
    // in 2026, Santiago leaves 00:00 on September 6 for 01:00, at 04:00 UTC
    const santiago = dayIn("America/Santiago", 0, "2026-09-06T03:30:00Z");
    // 23:30 on September 5: the reset is in the future, so a loop that waits for it does not spin
    expect(santiago.gate.take().resetAt).toBe(at("2026-09-06T04:00:00Z"));
    santiago.clock.set("2026-09-06T04:00:00Z");
    expect(santiago.gate.state()).toEqual({ used: 0, left: 5, at: at("2026-09-06T04:00:00Z") });
    expect(santiago.gate.take().resetAt).toBe(at("2026-09-07T03:00:00Z"));
    // in 2026, Chicago leaves 02:00 on March 8 for 03:00, at 08:00 UTC
    const chicago = dayIn("America/Chicago", 2, "2026-03-08T07:30:00Z");
    // 01:30 on March 8 is in the day that started at 02:00 on March 7
    expect(chicago.gate.take().resetAt).toBe(at("2026-03-08T08:00:00Z"));
    expect(recordIn(chicago.store, "Example", "k")?.spent).toEqual([
      [at("2026-03-07T08:00:00Z"), 1],
    ]);
    // the day of March 8 has 23 hours
    chicago.clock.set("2026-03-08T08:00:00Z");
    expect(chicago.gate.take()).toEqual({
      used: 1,
      left: 4,
      resetAt: at("2026-03-09T07:00:00Z"),
      at: at("2026-03-08T08:00:00Z"),
    });
  });

  it("gives a day of 25 hours when the clocks go back, from the first of two times with its hour", () => {
    // in 2026, Berlin goes back from 03:00 to 02:00 on October 25, at 01:00 UTC
    const berlin = dayIn("Europe/Berlin", 1, "2026-10-24T23:30:00Z");
    // 01:30 summer time on October 25: the day started at 01:00, and it has 25 hours
    expect(berlin.gate.take().resetAt).toBe(at("2026-10-26T00:00:00Z"));
    expect(recordIn(berlin.store, "Example", "k")?.spent).toEqual([
      [at("2026-10-24T23:00:00Z"), 1],
    ]);
    // 02:30 winter time is in the same day
    berlin.clock.set("2026-10-25T01:30:00Z");
    expect(berlin.gate.take()).toMatchObject({ used: 2, resetAt: at("2026-10-26T00:00:00Z") });
    // the clock shows 02:00 twice on October 25: the day of the hour 2 starts at the first time
    const twice = dayIn("Europe/Berlin", 2, "2026-10-25T01:30:00Z");
    expect(twice.gate.take().resetAt).toBe(at("2026-10-26T01:00:00Z"));
    expect(recordIn(twice.store, "Example", "k")?.spent).toEqual([[at("2026-10-25T00:00:00Z"), 1]]);
  });

  it("keeps the count of a later window after a step back of the clock", () => {
    const clock = clockAt("2026-11-15T00:30:00Z");
    const gate = quotaGate(
      {
        name: "Example",
        limit: 3,
        window: { kind: "calendar", unit: "day", timeZone: "UTC" },
      },
      { key: "k", now: clock.now },
    );
    gate.take(3);
    // the clock goes back into November 14: the 3 calls of November 15 still count
    clock.set("2026-11-14T23:30:00Z");
    expect(gate.state()).toMatchObject({ used: 3, left: 0 });
    const error = thrown(() => gate.take());
    expect((error as QuotaError).resetAt).toBe(at("2026-11-16T00:00:00Z"));
    // the clock comes back: still 3 calls in November 15, not 6
    clock.set("2026-11-15T00:40:00Z");
    expect(() => gate.take()).toThrow(QuotaError);
    expect(gate.state()).toMatchObject({ used: 3, left: 0 });
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
    expect(gate.state()).toEqual({ used: 0, left: 5, at: at("2026-11-14T00:30:00Z") });
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
    expect(gate.take()).toEqual({ used: 3, left: 0, resetAt: 11_000, at: 5_000 });
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
    // a call larger than the limit less the reserve can never pass, so it is a fault of the caller
    const other = quotaGate({ ...rolling(10, 60_000), reserve: 2 }, { key: "k", now: () => 0 });
    const large = thrown(() => other.take(9));
    expect(large).toBeInstanceOf(ApiError);
    expect(large).not.toBeInstanceOf(QuotaError);
    expect(large.message).toContain("in one window: 8");
    expect(other.state()).toEqual({ used: 0, left: 8, at: 0 });
  });

  it("gives 0 units left while the provider refuses the key, and a call of cost 0 still passes", () => {
    const clock = clockAt("2026-11-14T12:00:00Z");
    const gate = quotaGate(rolling(10, 60_000), { key: "k", now: clock.now });
    const until = at("2026-11-14T12:00:30Z");
    const noon = at("2026-11-14T12:00:00Z");
    expect(gate.note({ resetAt: until })).toEqual({
      used: 0,
      left: 0,
      blockedUntil: until,
      at: noon,
    });
    expect(gate.take(0)).toEqual({ used: 0, left: 0, blockedUntil: until, at: noon });
    expect((thrown(() => gate.take()) as QuotaError).resetAt).toBe(until);
    clock.set("2026-11-14T12:00:30Z");
    expect(gate.state()).toEqual({ used: 0, left: 10, at: until });
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
      at: at("2026-11-14T12:00:00Z"),
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
    store.changeQuota("Example requests", "k", () => ({ spent: "no" }) as unknown as QuotaRecord);
    const gate = quotaGate(rolling(2, 60_000), { key: "k", store, now: () => 0 });
    expect(gate.state()).toEqual({ used: 0, left: 2, at: 0 });
    expect(gate.take()).toMatchObject({ used: 1 });
  });

  it("removes only the items of a record that are not valid", () => {
    const store = memoryQuotaStore();
    const items = [[0, 2], [1000, -5], ["x", 1], [2000], [3000, Number.NaN], [9e15, 1]];
    store.changeQuota("Example requests", "k", () => ({ spent: items }) as unknown as QuotaRecord);
    const gate = quotaGate(rolling(3, 60_000), { key: "k", store, now: () => 0 });
    expect(gate.state()).toEqual({ used: 2, left: 1, resetAt: 61_000, at: 0 });
    expect(gate.take()).toMatchObject({ used: 3, left: 0 });
    expect(() => gate.take()).toThrow(QuotaError);
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
    expect(
      readQuotaHeaders(headersOf({ "x-reset-after": "1.5" }), { resetAfter: "X-Reset-After" }, now),
    ).toEqual({ resetAt: now + 1500 });
  });

  it("reads the HTTP date of Retry-After", () => {
    const names = { resetAfter: "Retry-After" };
    expect(
      readQuotaHeaders(headersOf({ "retry-after": "Sat, 14 Nov 2026 12:01:00 GMT" }), names, now),
    ).toEqual({ resetAt: at("2026-11-14T12:01:00Z") });
  });

  it("takes the seconds until the reset over the time of the reset", () => {
    const names = { resetAt: "x-reset", resetAfter: "retry-after" };
    expect(
      readQuotaHeaders(headersOf({ "x-reset": "1795000000", "retry-after": "30" }), names, now),
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

  it("reads the time of the reset when the seconds until the reset cannot be read", () => {
    const names = { resetAt: "x-reset", resetAfter: "retry-after" };
    expect(
      readQuotaHeaders(headersOf({ "x-reset": "1795000000", "retry-after": "soon" }), names, now),
    ).toEqual({ resetAt: 1_795_000_000_000 });
  });

  it("tells the three forms of a reset apart at the bounds 10^9 and 10^11", () => {
    expect(SECONDS_SINCE_EPOCH_FROM).toBe(1e9);
    expect(MILLISECONDS_SINCE_EPOCH_FROM).toBe(1e11);
    // under 10^9: seconds until the reset
    expect(resetTimeOf(999_999_999, now)).toBe(now + 999_999_999_000);
    // from 10^9: seconds since the epoch, 2001-09-09T01:46:40Z
    expect(resetTimeOf(1_000_000_000, now)).toBe(at("2001-09-09T01:46:40Z"));
    expect(resetTimeOf(99_999_999_999, now)).toBe(99_999_999_999_000);
    // from 10^11: milliseconds since the epoch, 1973-03-03T09:46:40Z
    expect(resetTimeOf(100_000_000_000, now)).toBe(at("1973-03-03T09:46:40Z"));
  });

  it("reads a reset in seconds until the reset, in seconds and in milliseconds since the epoch", () => {
    const names = { remaining: "ratelimit-remaining", resetAt: "ratelimit-reset" };
    const read = (reset: string) =>
      readQuotaHeaders(
        headersOf({ "ratelimit-remaining": "3", "ratelimit-reset": reset }),
        names,
        now,
      );
    // RateLimit-Reset of the IETF draft: not a time in 1970
    expect(read("30")).toEqual({ remaining: 3, resetAt: now + 30_000 });
    expect(read("1795000000.25")).toEqual({ remaining: 3, resetAt: 1_795_000_000_250 });
    // milliseconds: not a time in the year 58851
    expect(read("1795000000123")).toEqual({ remaining: 3, resetAt: 1_795_000_000_123 });
    // more than 15 digits is not read
    expect(read("1795000000123000")).toEqual({ remaining: 3 });
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

/**
 * The classes of a second copy of the package: the same names and the same fields, and no relation to
 * the classes of this copy. A program has two copies when two of its packages depend on two versions.
 */
class OtherApiError extends Error {
  override readonly name: string = "ApiError";
}
class OtherQuotaError extends OtherApiError {
  override readonly name: string = "QuotaError";
  constructor(
    message: string,
    readonly key: string,
    readonly resetAt: number,
  ) {
    super(message);
  }
}

describe("the guards isApiError and isQuotaError", () => {
  it("accept the errors of this copy", () => {
    const quota = new QuotaError("refused", "k", 1);
    expect([isApiError(quota), isQuotaError(quota)]).toEqual([true, true]);
    const other = new ApiError("no answer");
    expect([isApiError(other), isQuotaError(other)]).toEqual([true, false]);
  });

  it("accept the errors of another copy, where instanceof is false", () => {
    const quota = new OtherQuotaError("refused", "k", 1);
    expect(quota).not.toBeInstanceOf(QuotaError);
    expect([isApiError(quota), isQuotaError(quota)]).toEqual([true, true]);
    const other = new OtherApiError("no answer");
    expect(other).not.toBeInstanceOf(ApiError);
    expect([isApiError(other), isQuotaError(other)]).toEqual([true, false]);
  });

  it("refuse each other value", () => {
    const named = (name: string, fields: object = {}): Error =>
      Object.assign(new Error("x"), { name, ...fields });
    const values: unknown[] = [
      new Error("x"),
      new TypeError("x"),
      named("QuotaError"),
      named("QuotaError", { key: "k", resetAt: Number.NaN }),
      named("QuotaError", { key: "k", resetAt: "1" }),
      named("QuotaError", { key: 1, resetAt: 1 }),
      { name: "QuotaError", message: "x", key: "k", resetAt: 1 },
      "QuotaError",
      undefined,
      null,
    ];
    expect(values.map((value) => isQuotaError(value))).toEqual(values.map(() => false));
    expect(isApiError(named("QuotaError", { key: "k", resetAt: Number.NaN }))).toBe(true);
    expect(
      [new Error("x"), named("Other"), { name: "ApiError" }].map((value) => isApiError(value)),
    ).toEqual([false, false, false]);
  });

  it("know the name of each class of error that polite-crawler/api exports", () => {
    type ErrorClass = new (...args: unknown[]) => Error;
    const classes = (Object.values(api) as unknown[]).filter(
      (value): value is ErrorClass =>
        typeof value === "function" &&
        (value === ApiError ||
          (value as { readonly prototype?: unknown }).prototype instanceof ApiError),
    );
    expect(classes.length).toBeGreaterThanOrEqual(2);
    for (const Class of classes) {
      const instance = new Class("x", "k", 1);
      // the error of another copy has the same name and fields, and another class
      const copy = Object.assign(new Error("x"), { name: instance.name, key: "k", resetAt: 1 });
      expect({ name: instance.name, known: isApiError(copy) }).toEqual({
        name: instance.name,
        known: true,
      });
    }
  });

  it("let send give a refusal of another copy as it is, and the host keeps its state", async () => {
    const clock = fakeClock("2026-11-14T12:00:00Z");
    const scheduler = new HostScheduler(clock, 4);
    const pace: Pace = { scheduler, now: clock.now, random: () => 0.5 };
    const refusal = new OtherQuotaError("refused", "k", clock.now() + 60_000);
    const transport: Transport = () => Promise.reject(refusal);
    const input = { source: "Example", host: HOST, what: "the thing", exchange: get };
    for (let round = 0; round < 8; round += 1) {
      expect(await failure(send(pace, transport, input))).toBe(refusal);
    }
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

  it("keeps the time of the last reading, so a give-back after a restart still changes nothing", async () => {
    const path = await pathIn();
    const quota = rolling(10, 3_600_000);
    const now = (): number => 5_000;
    const one = quotaGate(quota, { key: "k", store: open(path), now });
    const taken = one.take();
    one.note({ remaining: 9 });
    const two = quotaGate(quota, { key: "k", store: open(path), now });
    expect(recordIn(open(path), "Example requests", "k")?.readAt).toBe(5_000);
    expect(two.giveBack?.(1, taken.at ?? Number.NaN)).toMatchObject({ used: 1, left: 9 });
  });

  it("changes a record in one transaction, so a different process waits", async () => {
    const path = await pathIn();
    const one = open(path);
    const two = new SqliteHostStateStore(path, { busyTimeoutMs: 0 });
    cleanups.push(() => two.close());
    let inner: Error | undefined;
    one.changeQuota("q", "k", (record) => {
      // the first store holds the lock of the file, so the second store cannot change the record
      inner = thrown(() => two.changeQuota("q", "k", (other) => other ?? { spent: [[0, 9]] }));
      return record ?? { spent: [[0, 1]] };
    });
    expect(inner?.message).toMatch(/database is locked/);
    expect(recordIn(two, "q", "k")).toEqual({ spent: [[0, 1]] });
  });

  it("reads a row that is not JSON as no record", async () => {
    const path = await pathIn();
    open(path).close();
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO quotas (quota, key, record) VALUES (?, ?, ?)").run(
      "Example requests",
      "k",
      "{not json",
    );
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
