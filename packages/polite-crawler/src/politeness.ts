/**
 * The scheduler controls the pace of each host. The speed of a polite crawler is the number of
 * hosts in progress divided by the delay for each host. Thus the scheduler keeps one request in
 * progress for each host, and it waits the delay of the host between two requests. It uses its
 * concurrency across many hosts, as the back queues of the Mercator crawler do.
 *
 * The caller decides the delay after each request, and `run` gets it from the task. Only the caller
 * knows the documented rate of the source, the crawl delay of the site and the duration of the
 * request. A wait holds no global slot, so a host that waits does not block a different host.
 *
 * The state of each host (its next time, its counts and its stop) is in a `HostStateStore`. The
 * default store is in memory. A store that processes share keeps one pace for each host across them.
 */

export interface Clock {
  readonly now: () => number;
  /** This function waits `ms` milliseconds. When the signal aborts, the wait ends early. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** A timer of Node.js holds a maximum of 2^31 − 1 milliseconds. A longer timer fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      // a long wait goes in parts, because a timer longer than the maximum fires at once
      let left = Number.isFinite(ms) ? Math.max(0, ms) : 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const step = (): void => {
        if (left <= 0) {
          done();
          return;
        }
        const part = Math.min(left, MAX_TIMER_MS);
        left -= part;
        timer = setTimeout(step, part);
      };
      signal?.addEventListener("abort", done, { once: true });
      step();
    }),
};

/** The crawler does not ask a host again until the stop ends, after a refusal (a challenge, 403 or 402). */
export class HostStopped extends Error {
  constructor(
    readonly host: string,
    readonly reason: string,
    /** This value is the end of the stop, in milliseconds since the epoch. `Infinity` is a stop with no end. */
    readonly until: number = Number.POSITIVE_INFINITY,
  ) {
    super(`${host} stopped: ${reason}`);
  }
}

export interface Paced<T> {
  readonly value: T;
  /** This value is the time that the host rests before its next request. */
  readonly delayMs: number;
}

/** A stop keeps the crawler away from a host until a time. */
export interface HostStop {
  /** This value is the end of the stop, in milliseconds since the epoch. `Infinity` is a stop with no end. */
  readonly until: number;
  readonly reason: string;
}

/** These are the counts of a host. Each count gives the results of one kind in sequence. */
export interface HostCounts {
  /** This value counts errors and requests with no answer. At the limit of the policy, the host stops. */
  readonly failures: number;
  /** This value counts the requests to wait (429, 502, 503, 504). It sets the backoff and does not stop the host. */
  readonly waits: number;
}

/**
 * This value tells how one result changes the counts of a host:
 *
 * - `success` sets the two counts to zero.
 * - `failure` adds one to `failures`.
 * - `wait` adds one to `waits`.
 * - `neutral` changes nothing. A client error (a 400) is neutral, because a different request can succeed.
 */
export type HostResult = "success" | "failure" | "wait" | "neutral";

/**
 * A host state store keeps the state of each host for the scheduler. Its methods are synchronous,
 * and each method is one atomic step on the state of one host. Thus a store can be a table of
 * SQLite that processes share. Times are milliseconds since the epoch.
 *
 * The state of a host has five parts:
 *
 * - the next time: the earliest time of the next request
 * - the lease: the end of the slot of the request in progress, when there is one
 * - the counts (`HostCounts`)
 * - the stop: an end time and a reason, when there is one
 */
export interface HostStateStore {
  /**
   * This method asks for the slot of a host at the time `now`. When the host has no rest left
   * and no lease, the store gives the slot to the caller until `now + leaseMs` and gives 0.
   * Otherwise it changes nothing and gives the time to wait in milliseconds: the time to the next
   * time, or to the end of the lease. A store that processes share gives a short wait (one second
   * or less) during a lease, because the holder usually releases it early. The caller asks again after the wait.
   */
  reserve(host: string, now: number, leaseMs: number): number;
  /** This method changes the counts of a host for one result, and it gives the new counts. */
  record(host: string, result: HostResult): HostCounts;
  /**
   * This method ends the lease of the caller. It sets the next time to `nextAt` when `nextAt` is
   * later than the stored next time. Only the holder of the lease uses it.
   */
  release(host: string, nextAt: number): void;
  /** This method sets the next time to `until` when `until` is later. It does not touch the lease. */
  defer(host: string, until: number): void;
  /** This method stops a host until a time. When the host has a stop that ends later, that stop stays. */
  stop(host: string, until: number, reason: string): void;
  /** This method gives the stop of a host at the time `now`. A stop that ended gives no value. */
  stopped(host: string, now: number): HostStop | undefined;
  /**
   * This method removes the stops and the counts of one host, or of each host when there is no
   * host. It keeps the next times and the leases, so a reset cannot make a host go faster than its pace.
   */
  reset(host?: string): void;
  /**
   * This method gives the validator memo of a host, when the store has one. A store without this
   * method and `noteValidators` has no memo. The crawler then sends each validator of a stored copy.
   */
  validators?(host: string): ValidatorMemo | undefined;
  /**
   * This method adds one conditional request to the memo of a host, with the rules of
   * `nextValidatorMemo`, in one atomic step. It gives the new memo.
   */
  noteValidators?(host: string, report: ValidatorReport, now: number): ValidatorMemo;
}

/** This value tells the result that the crawler learned for one validator of a host. */
export type ValidatorVerdict = "unknown" | "works" | "fails";

/**
 * This value tells what one conditional request got:
 *
 * - `not-modified`: a 304.
 * - `same`: a 200 with the body that the store has. Thus the validator did not match.
 * - `changed`: a 200 with a different body. This answer tells nothing about the validator.
 */
export type ValidatorAnswer = "not-modified" | "same" | "changed";

/** This report tells the validators that one conditional request sent, and the answer that it got. */
export interface ValidatorReport {
  /** This value is true when the request sent `If-None-Match`. */
  readonly etag: boolean;
  /** This value is true when the request sent `If-Modified-Since`. */
  readonly lastModified: boolean;
  readonly answer: ValidatorAnswer;
}

/**
 * A validator memo holds what the crawler learned about the validators of one host. A server
 * examines `If-None-Match` first, and it ignores `If-Modified-Since` when the request has the two
 * (RFC 9110, section 13.1.3). Thus a host with unstable ETags does not answer 304 to a request with
 * the two validators at any time. Its stable `Last-Modified` date does not help. `nextValidatorMemo`
 * gives the rules.
 */
export interface ValidatorMemo {
  /** This value is true when the crawler leaves out `If-None-Match` for the host and sends only `If-Modified-Since`. */
  readonly skipEtag: boolean;
  /** This value tells if a request with `If-None-Match` got a 304 (`works`) or the stored body again (`fails`). */
  readonly etag: ValidatorVerdict;
  /** This value tells the same for a request with only `If-Modified-Since`. */
  readonly lastModified: ValidatorVerdict;
  /** This value counts the stored bodies in sequence that came back to a request with `If-None-Match`. */
  readonly etagMisses: number;
  /** This value counts the stored bodies in sequence that came back to a request with only `If-Modified-Since`. */
  readonly dateMisses: number;
  /** This value counts the requests with only `If-Modified-Since` since the crawler stopped the ETag, or since the last probe. */
  readonly sinceProbe: number;
  /** This time (milliseconds since the epoch) is the last time that the crawler stopped or started the ETag, or probed it. */
  readonly changedAt: number;
}

/** These are the limits of the validator memo. */
export interface ValidatorLimits {
  /** After this number of stored bodies in sequence, a validator fails. The value is 3. */
  readonly misses: number;
  /** After this number of requests with only `If-Modified-Since`, the next request sends the ETag again (a probe). The value is 20. */
  readonly probeEvery: number;
  /** After this time with no probe, the next request is a probe. The value is 7 days. */
  readonly probeAgeMs: number;
}

/** These are the limits of the validator memo of the crawler. */
export const VALIDATOR_MEMO: ValidatorLimits = {
  misses: 3,
  probeEvery: 20,
  probeAgeMs: 7 * 24 * 60 * 60 * 1000,
};

const EMPTY_MEMO: ValidatorMemo = {
  skipEtag: false,
  etag: "unknown",
  lastModified: "unknown",
  etagMisses: 0,
  dateMisses: 0,
  sinceProbe: 0,
  changedAt: 0,
};

/**
 * This function tells which validators the next conditional request to a host sends. It sends
 * each validator of the stored copy, except when the memo stopped the ETag and the copy has a
 * `Last-Modified` date. Then it sends only `If-Modified-Since`, and the ETag too for a probe.
 * A probe comes after `probeEvery` requests or after `probeAgeMs`.
 */
export const validatorsToSend = (
  memo: ValidatorMemo | undefined,
  stored: { readonly etag: boolean; readonly lastModified: boolean },
  now: number,
): { readonly etag: boolean; readonly lastModified: boolean } => {
  if (memo?.skipEtag !== true || !stored.etag || !stored.lastModified) return stored;
  const probe =
    memo.sinceProbe >= VALIDATOR_MEMO.probeEvery ||
    now - memo.changedAt >= VALIDATOR_MEMO.probeAgeMs;
  return { etag: probe, lastModified: true };
};

/**
 * This function adds one conditional request to the memo of a host, and gives the new memo.
 * These are the rules, with the limits of `VALIDATOR_MEMO`:
 *
 * 1. A 304 to a request with `If-None-Match` marks the ETag `works`. After a probe, the crawler sends the ETag again.
 * 2. After `misses` stored bodies in sequence with `If-None-Match`, the ETag fails. When the request also sent
 *    `If-Modified-Since`, the crawler stops the ETag for the host.
 * 3. A probe that gets a 200 keeps the ETag stopped, and the count to the next probe starts again.
 * 4. After `misses` stored bodies in sequence with only `If-Modified-Since`, that validator fails too. Then the
 *    crawler sends the two validators again, because they cost nothing. It tries the date alone again after `probeAgeMs`.
 * 5. A changed body tells nothing about a validator.
 */
export const nextValidatorMemo = (
  memo: ValidatorMemo | undefined,
  report: ValidatorReport,
  now: number,
): ValidatorMemo => {
  const next: { -readonly [K in keyof ValidatorMemo]: ValidatorMemo[K] } = {
    ...(memo ?? EMPTY_MEMO),
  };
  if (report.etag) {
    const probe = next.skipEtag;
    if (report.answer === "not-modified") {
      next.etag = "works";
      next.etagMisses = 0;
      if (probe) {
        next.skipEtag = false;
        next.sinceProbe = 0;
        next.changedAt = now;
      }
    } else if (probe) {
      if (report.answer === "same") next.etagMisses += 1;
      next.sinceProbe = 0;
      next.changedAt = now;
    } else if (report.answer === "same") {
      next.etagMisses += 1;
      if (next.etagMisses >= VALIDATOR_MEMO.misses) {
        next.etag = "fails";
        // a date that failed gets a new try only after probeAgeMs, so the memo does not swing at each request
        const dateLeft =
          next.lastModified !== "fails" || now - next.changedAt >= VALIDATOR_MEMO.probeAgeMs;
        if (report.lastModified && dateLeft) {
          next.skipEtag = true;
          next.dateMisses = 0;
          next.sinceProbe = 0;
          next.changedAt = now;
        }
      }
    }
  } else if (report.lastModified) {
    if (next.skipEtag) next.sinceProbe += 1;
    if (report.answer === "not-modified") {
      next.lastModified = "works";
      next.dateMisses = 0;
    } else if (report.answer === "same") {
      next.dateMisses += 1;
      if (next.dateMisses >= VALIDATOR_MEMO.misses) {
        next.lastModified = "fails";
        if (next.skipEtag) {
          next.skipEtag = false;
          next.sinceProbe = 0;
          next.changedAt = now;
        }
      }
    }
  }
  return next;
};

interface MemoryState {
  nextAt: number;
  leasedUntil: number;
  failures: number;
  waits: number;
  stop: HostStop | undefined;
}

/**
 * This store keeps the state of each host in memory, for one process. It removes the state of an
 * idle host (no rest left, no lease, no counts and no stop) when it holds more than `maxHosts` hosts.
 * It keeps the validator memos of the `maxHosts` hosts that it used last.
 */
export class MemoryHostStateStore implements HostStateStore {
  private readonly states = new Map<string, MemoryState>();
  /** The validator memos, the memo used last at the end. */
  private readonly memos = new Map<string, ValidatorMemo>();
  private sweepAt: number;

  constructor(private readonly maxHosts: number = 10_000) {
    this.sweepAt = maxHosts;
  }

  /** This value is the number of hosts that the store holds. */
  get size(): number {
    return this.states.size;
  }

  private state(host: string): MemoryState {
    let state = this.states.get(host);
    if (state === undefined) {
      state = { nextAt: 0, leasedUntil: 0, failures: 0, waits: 0, stop: undefined };
      this.states.set(host, state);
    }
    return state;
  }

  private sweep(now: number): void {
    for (const [host, state] of this.states) {
      const idle =
        state.nextAt <= now &&
        state.leasedUntil <= now &&
        state.failures === 0 &&
        state.waits === 0 &&
        (state.stop === undefined || state.stop.until <= now);
      if (idle) this.states.delete(host);
    }
    // the next sweep comes after a tenth more hosts, so a store of busy hosts does not sweep at each request
    this.sweepAt = Math.max(this.maxHosts, Math.ceil(this.states.size * 1.1));
  }

  reserve(host: string, now: number, leaseMs: number): number {
    if (this.states.size > this.sweepAt) this.sweep(now);
    const state = this.state(host);
    if (state.leasedUntil > now) return state.leasedUntil - now;
    if (state.nextAt > now) return state.nextAt - now;
    state.leasedUntil = now + leaseMs;
    return 0;
  }

  record(host: string, result: HostResult): HostCounts {
    const state = this.state(host);
    if (result === "success") {
      state.failures = 0;
      state.waits = 0;
    } else if (result === "failure") state.failures += 1;
    else if (result === "wait") state.waits += 1;
    return { failures: state.failures, waits: state.waits };
  }

  release(host: string, nextAt: number): void {
    const state = this.state(host);
    state.leasedUntil = 0;
    if (nextAt > state.nextAt) state.nextAt = nextAt;
  }

  defer(host: string, until: number): void {
    const state = this.state(host);
    if (until > state.nextAt) state.nextAt = until;
  }

  stop(host: string, until: number, reason: string): void {
    const state = this.state(host);
    if (state.stop === undefined || state.stop.until < until) state.stop = { until, reason };
  }

  stopped(host: string, now: number): HostStop | undefined {
    const stop = this.states.get(host)?.stop;
    return stop !== undefined && stop.until > now ? stop : undefined;
  }

  reset(host?: string): void {
    const clear = (state: MemoryState): void => {
      state.failures = 0;
      state.waits = 0;
      state.stop = undefined;
    };
    if (host === undefined) for (const state of this.states.values()) clear(state);
    else {
      const state = this.states.get(host);
      if (state !== undefined) clear(state);
    }
  }

  validators(host: string): ValidatorMemo | undefined {
    return this.memos.get(host);
  }

  noteValidators(host: string, report: ValidatorReport, now: number): ValidatorMemo {
    const memo = nextValidatorMemo(this.memos.get(host), report, now);
    // the memo of each change goes to the end, so the first memo is the memo used longest ago
    this.memos.delete(host);
    this.memos.set(host, memo);
    if (this.memos.size > this.maxHosts) this.memos.delete(this.memos.keys().next().value!);
    return memo;
  }
}

/** These options change the scheduler. */
export interface SchedulerOptions {
  /** This store keeps the state of each host. The default is a `MemoryHostStateStore`. */
  readonly store?: HostStateStore | undefined;
  /** This value is the longest slot of one request. A slot that a crashed process holds ends after it. The default is 5 minutes. */
  readonly leaseMs?: number | undefined;
  /** A host rests this long after a task that throws an error, or a task that gives no valid delay. The default is 1 second. */
  readonly fallbackDelayMs?: number | undefined;
}

const aborted = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The wait was aborted", "AbortError");

export class HostScheduler {
  /** This store keeps the state of each host. */
  readonly store: HostStateStore;
  private readonly chains = new Map<string, Promise<unknown>>();
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly leaseMs: number;
  private readonly fallbackDelayMs: number;

  constructor(
    private readonly clock: Clock,
    private readonly maxActive: number,
    options: SchedulerOptions = {},
  ) {
    if (!Number.isInteger(maxActive) || maxActive < 1) {
      throw new RangeError(`maxActive must be an integer of 1 or more, not ${String(maxActive)}`);
    }
    this.store = options.store ?? new MemoryHostStateStore();
    this.leaseMs = options.leaseMs ?? 300_000;
    this.fallbackDelayMs = options.fallbackDelayMs ?? 1000;
  }

  private acquire(signal: AbortSignal | undefined): Promise<void> {
    if (this.active < this.maxActive) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = (): void => {
        const at = this.queue.indexOf(grant);
        if (at !== -1) this.queue.splice(at, 1);
        reject(aborted(signal!));
      };
      this.queue.push(grant);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  private release(): void {
    // the slot goes to the next waiter directly, so a new request cannot take it in between
    const next = this.queue.shift();
    if (next !== undefined) next();
    else this.active -= 1;
  }

  private async sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined) {
      await this.clock.sleep(ms);
      return;
    }
    if (signal.aborted) throw aborted(signal);
    await new Promise<void>((resolve, reject) => {
      const cancel = (): void => reject(aborted(signal));
      signal.addEventListener("abort", cancel, { once: true });
      this.clock.sleep(ms, signal).then(
        () => {
          signal.removeEventListener("abort", cancel);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener("abort", cancel);
          reject(error);
        },
      );
    });
  }

  /**
   * This method starts one request on a host, in sequence, after the rest of the host. When the
   * signal aborts during the wait, the promise rejects with the reason of the signal.
   */
  run<T>(host: string, task: () => Promise<Paced<T>>, signal?: AbortSignal): Promise<T> {
    const previous = this.chains.get(host) ?? Promise.resolve();
    const result = previous.then(async () => {
      // after a wait, the time is at least the end of the wait, also on a clock that a test holds still
      let waited = Number.NEGATIVE_INFINITY;
      for (;;) {
        if (signal?.aborted === true) throw aborted(signal);
        const now = Math.max(this.clock.now(), waited);
        const stop = this.store.stopped(host, now);
        if (stop !== undefined) throw new HostStopped(host, stop.reason, stop.until);
        const wait = this.store.reserve(host, now, this.leaseMs);
        if (!(wait > 0)) break;
        await this.sleep(wait, signal);
        waited = now + wait;
      }
      try {
        await this.acquire(signal);
      } catch (error) {
        this.store.release(host, this.clock.now());
        throw error;
      }
      let nextAt = this.clock.now() + this.fallbackDelayMs;
      try {
        const { value, delayMs } = await task();
        const rest = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : this.fallbackDelayMs;
        nextAt = this.clock.now() + rest;
        return value;
      } catch (error) {
        nextAt = this.clock.now() + this.fallbackDelayMs;
        throw error;
      } finally {
        this.store.release(host, nextAt);
        this.release();
      }
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(host, tail);
    // a host with no queued request keeps no chain
    void tail.then(() => {
      if (this.chains.get(host) === tail) this.chains.delete(host);
    });
    return result;
  }

  /** The server asked for a pause (Retry-After), or a backoff chose one. */
  park(host: string, untilMs: number): void {
    this.store.defer(host, untilMs);
  }

  /** This method stops a host until `untilMs`. With no time, the stop has no end. */
  stop(host: string, reason: string, untilMs: number = Number.POSITIVE_INFINITY): void {
    this.store.stop(host, untilMs, reason);
  }

  stoppedReason(host: string): string | undefined {
    return this.store.stopped(host, this.clock.now())?.reason;
  }

  /** This method gives the stop of a host, with its end, when the host is stopped. */
  stopOf(host: string): HostStop | undefined {
    return this.store.stopped(host, this.clock.now());
  }

  /** This value counts the failures of a host in sequence, for the backoff. A success sets it to zero. */
  failed(host: string): number {
    return this.store.record(host, "failure").failures;
  }

  /** This value counts the requests to wait (429, 503) of a host in sequence. They do not stop the host. */
  waited(host: string): number {
    return this.store.record(host, "wait").waits;
  }

  succeeded(host: string): void {
    this.store.record(host, "success");
  }

  /** This method removes the stops and the counts of one host, or of each host. The pace stays. */
  reset(host?: string): void {
    this.store.reset(host);
  }
}

/**
 * This function gives an exponential backoff with full jitter, from the analysis of AWS. The wait
 * is random, up to base × 2^(try − 1), with a maximum. The jitter keeps retries apart.
 */
export const backoffMs = (
  attempt: number,
  baseMs: number,
  capMs: number,
  random: () => number,
): number => Math.floor(random() * Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1)));

/**
 * This function gives an exponential backoff with equal jitter. The wait is half of
 * base × 2^(try − 1), with a maximum, and a random part up to the other half. Thus each backoff
 * is at least half of its step, and it is not lost under the rest of the host.
 */
export const equalJitterMs = (
  attempt: number,
  baseMs: number,
  capMs: number,
  random: () => number,
): number => {
  const step = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(step / 2 + random() * (step / 2));
};

/** These are the facts of one request that set the rest of its host. */
export interface RestInput {
  /** This value is the kind of the request: a web page, a documented API, or a render in the browser. */
  readonly kind: "page" | "api" | "render";
  /** This value is the duration of the request, in milliseconds. */
  readonly elapsedMs: number;
  /** This value is the `crawl-delay` of robots.txt, in seconds. */
  readonly crawlDelaySeconds?: number | undefined;
  /** This value is the documented pace of the source. It replaces the interval of the policy for the kind. */
  readonly minIntervalMs?: number | undefined;
  /** This value is the wait that the server asked for (`Retry-After`). */
  readonly retryAfterMs?: number | undefined;
}

/** The rest of a host after a request, and the reason for its length. */
export interface Rest {
  readonly ms: number;
  readonly reason: "pace" | "slow" | "retry-after" | "crawl-delay";
}

/**
 * This function gives the rest of a host after one request, as the crawler calculates it. These
 * are the parts:
 *
 * - The interval of the kind (3 seconds for a page), or the documented pace of the source.
 * - The `crawl-delay` of robots.txt, up to `crawlDelayCapMs`, when it is longer.
 * - After a page or a render, `elapsedFactor` times the duration of the request, up to `elapsedCapMs`.
 * - The `Retry-After` of the server, when it is longer.
 *
 * The backoff after an error or a request to wait comes on top, with jitter. The function is
 * pure, so a simulation and a study can use the pace of the crawler.
 */
export const restAfter = (policy: PolitenessPolicy, input: RestInput): Rest => {
  const interval =
    input.minIntervalMs ??
    (input.kind === "page"
      ? policy.pageIntervalMs
      : input.kind === "api"
        ? policy.apiIntervalMs
        : policy.renderIntervalMs);
  const crawlDelay = Math.min(
    policy.crawlDelayCapMs,
    Math.max(0, (input.crawlDelaySeconds ?? 0) * 1000),
  );
  let ms = Math.max(interval, crawlDelay);
  let reason: Rest["reason"] = crawlDelay > interval ? "crawl-delay" : "pace";
  if (input.kind !== "api") {
    const slow = Math.min(policy.elapsedCapMs, policy.elapsedFactor * Math.max(0, input.elapsedMs));
    if (slow > ms) {
      ms = slow;
      reason = "slow";
    }
  }
  if (input.retryAfterMs !== undefined && input.retryAfterMs > ms) {
    ms = input.retryAfterMs;
    reason = "retry-after";
  }
  return { ms, reason };
};

/**
 * The politeness policy holds each limit of the crawler. Each value has a default, and a host can
 * have values of its own. The times are in milliseconds.
 */
export interface PolitenessPolicy {
  /** This value is the shortest rest of a host between two page requests. The default is 3 seconds. */
  readonly pageIntervalMs: number;
  /** This value is the shortest rest of a host between two API requests. The default is 1 second. */
  readonly apiIntervalMs: number;
  /** This value is the shortest rest of a host after a render. The default is 5 seconds. */
  readonly renderIntervalMs: number;
  /** After a page, the host rests this number of times the duration of the request. The default is 5. */
  readonly elapsedFactor: number;
  /** This value is the maximum of the rest that comes from the duration. The default is 30 seconds. */
  readonly elapsedCapMs: number;
  /** This value is the maximum `crawl-delay` that the crawler obeys. The default is 60 seconds. */
  readonly crawlDelayCapMs: number;
  /** This value is the maximum number of redirects for one fetch. The default is 5. */
  readonly maxRedirects: number;
  /** This value is the maximum size of a body after decompression. The default is 5 MiB. */
  readonly maxBytes: number;
  /** This value is the deadline of one request, the body included. The default is 90 seconds. */
  readonly requestTimeoutMs: number;
  /** This value is the deadline of one render. The default is 20 seconds. */
  readonly renderTimeoutMs: number;
  /** After this number of failures in sequence, the host stops. The default is 5. */
  readonly maxFailures: number;
  /** This value is the stop after too many failures. The default is 1 hour. */
  readonly failureStopMs: number;
  /** This value is the stop after a 401 or a 403. The default is 1 hour. */
  readonly blockedStopMs: number;
  /** This value is the stop after a bot challenge. The default is 24 hours. */
  readonly challengeStopMs: number;
  /** This value is the stop after a 402. The default is 24 hours. */
  readonly paymentStopMs: number;
  /** The crawler obeys a `Retry-After` up to this value. A longer wait stops the host for that time. The default is 1 hour. */
  readonly maxRetryAfterMs: number;
  /** This value is the first step of the backoff after an error or a request to wait. The default is 5 seconds. */
  readonly backoffBaseMs: number;
  /** This value is the maximum step of the backoff. The default is 300 seconds. */
  readonly backoffCapMs: number;
  /** The crawler keeps a robots.txt for this time. The default is 24 hours. */
  readonly robotsTtlMs: number;
  /** The crawler keeps an unreachable robots.txt verdict for this time first, with a backoff. The default is 5 minutes. */
  readonly robotsRetryMs: number;
  /** This value is the maximum time for an unreachable robots.txt verdict. The default is 1 hour. */
  readonly robotsRetryCapMs: number;
  /** A stored robots.txt younger than this age replaces a robots.txt that the crawler cannot read. The default is 30 days. */
  readonly robotsStaleMs: number;
  /** This value is the maximum freshness that the crawler gives a response with no freshness of its own. The default is 24 hours. */
  readonly heuristicFreshnessCapMs: number;
}

/**
 * This value is the longest stop that a `Retry-After` can give: 30 days. A wait longer than
 * `maxRetryAfterMs` stops the host for the time that the server asks, up to this value.
 */
export const MAX_STOP_MS: number = 30 * 24 * 60 * 60 * 1000;

export const DEFAULT_POLICY: PolitenessPolicy = {
  pageIntervalMs: 3000,
  apiIntervalMs: 1000,
  renderIntervalMs: 5000,
  elapsedFactor: 5,
  elapsedCapMs: 30_000,
  crawlDelayCapMs: 60_000,
  maxRedirects: 5,
  maxBytes: 5 * 1024 * 1024,
  requestTimeoutMs: 90_000,
  renderTimeoutMs: 20_000,
  maxFailures: 5,
  failureStopMs: 60 * 60 * 1000,
  blockedStopMs: 60 * 60 * 1000,
  challengeStopMs: 24 * 60 * 60 * 1000,
  paymentStopMs: 24 * 60 * 60 * 1000,
  maxRetryAfterMs: 60 * 60 * 1000,
  backoffBaseMs: 5000,
  backoffCapMs: 300_000,
  robotsTtlMs: 24 * 60 * 60 * 1000,
  robotsRetryMs: 5 * 60 * 1000,
  robotsRetryCapMs: 60 * 60 * 1000,
  robotsStaleMs: 30 * 24 * 60 * 60 * 1000,
  heuristicFreshnessCapMs: 24 * 60 * 60 * 1000,
};

/**
 * These options change the politeness policy. The values at the top apply to each host. The
 * `hosts` map gives values for one host (`api.example.org`) or for the hosts under a name
 * (`*.example.org`). The most specific entry wins.
 */
export interface PolicyOptions extends Partial<PolitenessPolicy> {
  readonly hosts?: Readonly<Record<string, Partial<PolitenessPolicy>>> | undefined;
}

const INTEGER_KEYS: ReadonlySet<string> = new Set(["maxRedirects", "maxFailures"]);

const checked = (values: Partial<PolitenessPolicy>, where: string): Partial<PolitenessPolicy> => {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in DEFAULT_POLICY))
      throw new RangeError(`${where}: ${key} is not a politeness setting`);
    const good =
      typeof value === "number" &&
      value >= 0 &&
      (Number.isFinite(value) || key.endsWith("StopMs")) &&
      (!INTEGER_KEYS.has(key) || Number.isInteger(value));
    if (!good)
      throw new RangeError(`${where}: ${key} must be a number of 0 or more, not ${String(value)}`);
  }
  return values;
};

/** This function examines the options of a policy. It throws a `RangeError` for a value that is not a valid number. */
export const checkPolicy = (options: PolicyOptions | undefined): void => {
  if (options === undefined) return;
  const { hosts, ...base } = options;
  checked(base, "politeness");
  for (const [host, values] of Object.entries(hosts ?? {}))
    checked(values, `politeness.hosts["${host}"]`);
};

/** This function gives the policy of one host: the defaults, then the general options, then the entries for the host. */
export const policyFor = (options: PolicyOptions | undefined, host: string): PolitenessPolicy => {
  if (options === undefined) return DEFAULT_POLICY;
  const { hosts, ...base } = options;
  const name = host.toLowerCase().replace(/\.$/, "");
  const matching = Object.entries(hosts ?? {})
    .map(([key, values]) => ({ key: key.toLowerCase(), values }))
    .filter(({ key }) => key === name || (key.startsWith("*.") && name.endsWith(key.slice(1))))
    // an exact name wins, and a longer pattern wins over a shorter one
    .sort(
      (a, b) => (a.key === name ? 1 : 0) - (b.key === name ? 1 : 0) || a.key.length - b.key.length,
    );
  return Object.assign(
    {},
    DEFAULT_POLICY,
    base,
    ...matching.map(({ values }) => values),
  ) as PolitenessPolicy;
};
