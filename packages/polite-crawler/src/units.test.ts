import { afterEach, describe, expect, it, vi } from "vitest";
import { classify, isClientError, parseHttpDate, parseRetryAfter } from "./classify.ts";
import { DEFAULT_SECRET_PARAMS, redact } from "./crawler.ts";
import {
  DEFAULT_POLICY,
  HostScheduler,
  HostStopped,
  MemoryHostStateStore,
  backoffMs,
  checkPolicy,
  equalJitterMs,
  policyFor,
  realClock,
} from "./politeness.ts";
import { readSignals } from "./signals.ts";

const headers =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name];

describe("classifying responses", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  it("reads Retry-After as seconds or as a date", () => {
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter("Wed, 07 Oct 2026 12:02:00 GMT", now)).toBe(120_000);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
  });
  it("reads only the two forms of Retry-After, so garbage gets the backoff and not a zero", () => {
    for (const value of ["1.5", "-5", "120, 120", "0x10", "", "Wed, 07 Oct 2026", "2026-10-07T12:02:00Z"]) {
      expect(parseRetryAfter(value, now), value).toBeUndefined();
    }
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("Tue, 06 Oct 2026 12:00:00 GMT", now)).toBe(0);
  });
  it("reads the three forms of an HTTP date, and nothing else", () => {
    const at = Date.UTC(1994, 10, 6, 8, 49, 37);
    expect(parseHttpDate("Sun, 06 Nov 1994 08:49:37 GMT")).toBe(at);
    expect(parseHttpDate("Sunday, 06-Nov-94 08:49:37 GMT")).toBe(at);
    expect(parseHttpDate("Sun Nov  6 08:49:37 1994")).toBe(at);
    expect(parseHttpDate("6 Nov 1994")).toBeUndefined();
    expect(parseHttpDate("1.5")).toBeUndefined();
  });
  it("keeps a client error apart from a failure of the host", () => {
    for (const status of [400, 405, 406, 409, 413, 414, 422, 451]) expect(isClientError(status), String(status)).toBe(true);
    for (const status of [401, 402, 403, 404, 408, 410, 429, 500, 503, 200]) expect(isClientError(status), String(status)).toBe(false);
  });
  it("recognizes challenges, licence demands and refusals", () => {
    expect(classify(202, headers({ "x-amzn-waf-action": "challenge" }), now).outcome).toBe(
      "challenge",
    );
    expect(classify(405, headers({ "x-amzn-waf-action": "captcha" }), now).outcome).toBe(
      "challenge",
    );
    expect(classify(402, headers({ "crawler-price": "USD 0.01" }), now)).toMatchObject({
      outcome: "payment-required",
      note: "price USD 0.01",
    });
    expect(classify(403, headers({}), now).outcome).toBe("blocked");
    // a busy gateway is a reason to wait, not a failure
    expect(classify(504, headers({}), now).outcome).toBe("unavailable");
    expect(classify(503, headers({ "retry-after": "60" }), now)).toMatchObject({
      outcome: "unavailable",
      retryAfterMs: 60_000,
    });
  });
});

describe("usage signals", () => {
  it("lets a no anywhere win, and ignores training opt-outs", () => {
    expect(readSignals(["content-signal: search=yes, ai-train=no"], headers({})).ai_input).toBe(
      "unset",
    );
    expect(readSignals([], headers({ "content-usage": "ai-use=n" })).ai_input).toBe("no");
    expect(
      readSignals(["content-signal: ai-input=yes"], headers({ "content-signal": "ai-input=no" }))
        .ai_input,
    ).toBe("no");
  });
  it("reads quoted and structured values, names the deciding line, and records a training opt-out", () => {
    expect(readSignals([], headers({ "content-signal": 'ai-input="no"' })).ai_input).toBe("no");
    expect(readSignals([], headers({ "content-usage": "ai-use=?0" })).ai_input).toBe("no");
    const tagged = readSignals([], headers({ "x-robots-tag": "noai, noimageai" }));
    expect(tagged).toMatchObject({ ai_input: "unset", ai_train: "no" });
    const decided = readSignals(
      ["content-signal: search=yes, ai-train=no"],
      headers({ "content-signal": "ai-input=no" }),
    );
    expect(decided).toMatchObject({ ai_input: "no", ai_train: "no", deciding: "content-signal: ai-input=no" });
  });
});

describe("redaction", () => {
  it("removes userinfo and default secrets, and keeps the rest of the query as written", () => {
    const url = new URL("http://alice:hunter2@h.example/x?q=a%20b/c,d~e*f&api_key=X&Token=Y&page=2#top");
    expect(redact(url)).toBe("http://h.example/x?q=a%20b/c,d~e*f&api_key=REDACTED&Token=REDACTED&page=2#top");
    expect(redact(new URL("http://h.example/?mailto=me%40x.example"), ["mailto"])).toBe(
      "http://h.example/?mailto=REDACTED",
    );
    expect(DEFAULT_SECRET_PARAMS).toContain("access_token");
  });
});

describe("pacing across hosts", () => {
  it("runs different hosts at once and one host at a time", async () => {
    const scheduler = new HostScheduler({ now: () => 0, sleep: () => Promise.resolve() }, 8);
    let inFlight = 0;
    let peak = 0;
    const perHost = new Map<string, number>();
    const task = (host: string) => async () => {
      inFlight += 1;
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      peak = Math.max(peak, inFlight);
      expect(perHost.get(host)).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      perHost.set(host, perHost.get(host)! - 1);
      inFlight -= 1;
      return { value: host, delayMs: 0 };
    };
    const hosts = ["a", "b", "c", "a", "b", "c"];
    await Promise.all(hosts.map((host) => scheduler.run(host, task(host))));
    expect(peak).toBe(3);
  });
  it("backs off with full jitter, capped", () => {
    expect(backoffMs(1, 1000, 60_000, () => 0.5)).toBe(500);
    expect(backoffMs(4, 1000, 60_000, () => 0.999)).toBe(7992);
    expect(backoffMs(20, 1000, 60_000, () => 1)).toBe(60_000);
  });
  it("backs off with equal jitter, so a backoff is never less than half its step", () => {
    expect(equalJitterMs(1, 5000, 300_000, () => 0)).toBe(2500);
    expect(equalJitterMs(1, 5000, 300_000, () => 0.999)).toBe(4997);
    expect(equalJitterMs(3, 5000, 300_000, () => 0)).toBe(10_000);
    expect(equalJitterMs(30, 5000, 300_000, () => 0)).toBe(150_000);
  });
  it("never has more requests in progress than maxActive, under load", async () => {
    for (const maxActive of [1, 4]) {
      const scheduler = new HostScheduler({ now: () => 0, sleep: () => Promise.resolve() }, maxActive);
      let inFlight = 0;
      let peak = 0;
      const tasks = Array.from({ length: 60 }, (_, index) =>
        scheduler.run(`host${String(index % 20)}`, async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, (index * 7) % 5));
          inFlight -= 1;
          return { value: index, delayMs: 0 };
        }),
      );
      await Promise.all(tasks);
      expect(peak, `maxActive ${String(maxActive)}`).toBe(maxActive);
    }
  });
  it("refuses a maxActive that is not a whole number of 1 or more", () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(() => new HostScheduler(realClock, value)).toThrow(RangeError);
    }
  });
  it("rests a host after a task that throws or gives a delay that is not a number", async () => {
    const slept: number[] = [];
    let now = 0;
    const scheduler = new HostScheduler(
      {
        now: () => now,
        sleep: (ms) => {
          slept.push(ms);
          now += ms;
          return Promise.resolve();
        },
      },
      2,
    );
    await expect(scheduler.run("a", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await scheduler.run("a", () => Promise.resolve({ value: 1, delayMs: Number.NaN }));
    await scheduler.run("a", () => Promise.resolve({ value: 2, delayMs: 0 }));
    expect(slept).toEqual([1000, 1000]);
  });
  it("ends the wait of a request when its signal aborts", async () => {
    const scheduler = new HostScheduler(realClock, 2);
    await scheduler.run("a", () => Promise.resolve({ value: 1, delayMs: 60_000 }));
    const controller = new AbortController();
    const waiting = scheduler.run("a", () => Promise.resolve({ value: 2, delayMs: 0 }), controller.signal);
    setTimeout(() => controller.abort(new Error("stop")), 20);
    const started = Date.now();
    await expect(waiting).rejects.toThrow("stop");
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("stops a host until a time, and throws HostStopped with that time", async () => {
    let now = 1000;
    const scheduler = new HostScheduler({ now: () => now, sleep: () => Promise.resolve() }, 1);
    scheduler.stop("a", "blocked", 5000);
    await expect(scheduler.run("a", () => Promise.resolve({ value: 1, delayMs: 0 }))).rejects.toMatchObject({
      reason: "blocked",
      until: 5000,
    });
    now = 5000;
    expect(scheduler.stoppedReason("a")).toBeUndefined();
    await expect(scheduler.run("a", () => Promise.resolve({ value: 1, delayMs: 0 }))).resolves.toBe(1);
    scheduler.stop("b", "challenge");
    expect(scheduler.stopOf("b")).toEqual({ until: Number.POSITIVE_INFINITY, reason: "challenge" });
    scheduler.reset("b");
    expect(scheduler.stopOf("b")).toBeUndefined();
    expect(new HostStopped("a", "blocked")).toMatchObject({ until: Number.POSITIVE_INFINITY });
  });
});

describe("the host state store", () => {
  it("gives the slot to one holder at a time, and keeps the pace through a reset", () => {
    const store = new MemoryHostStateStore();
    expect(store.reserve("a", 0, 100)).toBe(0);
    // a second holder waits for the end of the lease
    expect(store.reserve("a", 10, 100)).toBe(90);
    store.release("a", 3000);
    expect(store.reserve("a", 1000, 100)).toBe(2000);
    expect(store.record("a", "failure")).toEqual({ failures: 1, waits: 0 });
    expect(store.record("a", "wait")).toEqual({ failures: 1, waits: 1 });
    expect(store.record("a", "neutral")).toEqual({ failures: 1, waits: 1 });
    expect(store.record("a", "success")).toEqual({ failures: 0, waits: 0 });
    store.stop("a", 9000, "challenge");
    store.stop("a", 5000, "blocked");
    expect(store.stopped("a", 4000)).toEqual({ until: 9000, reason: "challenge" });
    expect(store.stopped("a", 9000)).toBeUndefined();
    store.defer("a", 4000);
    store.reset();
    expect(store.stopped("a", 4000)).toBeUndefined();
    expect(store.reserve("a", 3500, 100)).toBe(500);
  });
  it("forgets idle hosts when it holds too many", () => {
    const store = new MemoryHostStateStore(10);
    for (let index = 0; index < 100; index += 1) {
      store.reserve(`host${String(index)}`, index, 1);
      store.release(`host${String(index)}`, index);
    }
    store.stop("kept", Number.POSITIVE_INFINITY, "blocked");
    store.reserve("trigger", 1000, 1);
    expect(store.size).toBeLessThanOrEqual(12);
    expect(store.stopped("kept", 1000)).toBeDefined();
  });
});

describe("the real clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("waits longer than a timer can hold, in parts", async () => {
    vi.useFakeTimers();
    let done = false;
    void realClock.sleep(3_000_000_000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(2 ** 31);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000_000_000);
    expect(done).toBe(true);
  });
  it("ends a wait when its signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    await realClock.sleep(60_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("the politeness policy", () => {
  it("gives the defaults, then the general values, then the most specific host entry", () => {
    expect(policyFor(undefined, "a.example")).toBe(DEFAULT_POLICY);
    const options = {
      pageIntervalMs: 4000,
      hosts: { "*.example.org": { pageIntervalMs: 6000 }, "api.example.org": { apiIntervalMs: 250 } },
    };
    expect(policyFor(options, "news.example.com").pageIntervalMs).toBe(4000);
    expect(policyFor(options, "news.example.org").pageIntervalMs).toBe(6000);
    expect(policyFor(options, "API.example.org.")).toMatchObject({ pageIntervalMs: 6000, apiIntervalMs: 250 });
  });
  it("refuses a value that is not a number of 0 or more", () => {
    expect(() => checkPolicy({ maxFailures: 2.5 })).toThrow(RangeError);
    expect(() => checkPolicy({ hosts: { "a.example": { robotsTtlMs: -1 } } })).toThrow(RangeError);
    expect(() => checkPolicy({ blockedStopMs: Number.POSITIVE_INFINITY })).not.toThrow();
  });
});
