/**
 * The quotas of API keys. A quota gives a key at most `limit` units in each window: a calendar day
 * or month in a time zone, or a rolling window. The gate counts each call before it starts, and it
 * refuses a call over the quota before the provider does. `withQuota` puts a gate on any async
 * function: a `fetch`, a transport or a different client.
 *
 * The count is not lower than the count of the provider. A rolling window puts each call in a time
 * bucket, and a bucket counts until all of it is out of the window. The answer of the provider can
 * make the count larger, but not smaller.
 *
 * The count of a window comes from the keyed quota of `@mark1russell7/service/limiter`, and a list
 * of gates takes its units with `takeQuotas` of that module. The module imports no Node.js module,
 * so a browser can use it. Each export is beta.
 */
import type {
  QuotaChange,
  QuotaPart,
  QuotaRefused,
  QuotaSpec,
  QuotaState as LimiterState,
  QuotaStore as LimiterStore,
  QuotaVerdict,
} from "@mark1russell7/service/limiter";
import { keyedQuota, quotaProblems, takeQuotas } from "@mark1russell7/service/limiter";
import { ApiError } from "./api-error.ts";
import { parseRetryAfter } from "./classify.ts";
import type { QuotaRecord, QuotaStore } from "./politeness.ts";

/**
 * The window of a quota.
 *
 * - `rolling`: the units of the last `ms` milliseconds. Use it when the provider does not tell when
 *   its count starts again. It is stricter than each fixed window of the same length or shorter.
 * - `calendar`: the units of a day or a month in the IANA time zone `timeZone`. A window starts at
 *   the hour `hour` (default 0) of the first day, in that zone. When the clock jumps over that hour,
 *   the window starts at the jump.
 *
 * @beta
 */
export type QuotaWindow =
  | {
      readonly kind: "rolling";
      readonly ms: number;
      /** The window has this count of time buckets. The default is 60. Each call counts until all of its bucket is out of the window. */
      readonly buckets?: number | undefined;
    }
  | {
      readonly kind: "calendar";
      readonly unit: "day" | "month";
      /** This value is an IANA time zone, for example `America/Chicago` or `UTC`. */
      readonly timeZone: string;
      /** This value is the hour of the start of a window, from 0 to 23. The default is 0. */
      readonly hour?: number | undefined;
    };

/**
 * A quota of one API key: at most `limit` units in each window.
 *
 * @beta
 */
export interface Quota {
  /**
   * This value names the quota in a message, for example `Example API requests`. A store keeps a
   * record for each name and key, so give each quota of a key a different name.
   */
  readonly name: string;
  /** This value is the count of units that the provider gives in one window. */
  readonly limit: number;
  /** The gate keeps this count of units unused. The default is 0. */
  readonly reserve?: number | undefined;
  readonly window: QuotaWindow;
}

/**
 * What an answer of the provider tells of its count.
 *
 * @beta
 */
export interface QuotaReading {
  /** This value is the count of units that the provider gives before its next reset. */
  readonly remaining?: number | undefined;
  /**
   * This value is the time of the next reset of the provider, in milliseconds since the epoch. When
   * `remaining` is 0 or is not there, the gate refuses each call until this time.
   */
  readonly resetAt?: number | undefined;
}

/**
 * The state of a quota at one time.
 *
 * @beta
 */
export interface QuotaState {
  /** This value is the count of units in the window. */
  readonly used: number;
  /**
   * This value is the count of units that the gate gives: the limit, less the reserve and `used`.
   * It is 0 while the provider refuses the key.
   */
  readonly left: number;
  /** The units come back from this time, in milliseconds since the epoch. With no unit in the window, it is not there. */
  readonly resetAt?: number | undefined;
  /** The provider refused the key until this time, in milliseconds since the epoch. */
  readonly blockedUntil?: number | undefined;
  /**
   * This value is the time of the state, in milliseconds since the epoch. For the state that `take`
   * gives, it is the time of the units of the call, which `giveBack` needs.
   */
  readonly at?: number | undefined;
}

/**
 * The refusal of a call over its quota. The gate refused the call before the call started.
 *
 * @beta
 */
export class QuotaError extends ApiError {
  override readonly name: string = "QuotaError";
  /** This value is the key of the quota. */
  readonly key: string;
  /** The gate gives units again from this time, in milliseconds since the epoch. */
  readonly resetAt: number;

  constructor(message: string, key: string, resetAt: number) {
    super(message);
    this.key = key;
    this.resetAt = resetAt;
  }
}

/**
 * This function tells if a value is a `QuotaError`. The error can come from this copy of the package
 * or from another copy, of this version or of an earlier one. `instanceof` is false across two copies.
 * So the function also accepts an `Error` named `QuotaError`, with a string `key` and a finite number
 * `resetAt`. A package that gets a transport of `withQuota` uses it to tell a refusal of the quota from
 * another failure. That package needs no dependency on this package.
 *
 * @beta
 */
export const isQuotaError = (value: unknown): value is QuotaError =>
  value instanceof QuotaError ||
  (value instanceof Error &&
    value.name === "QuotaError" &&
    typeof (value as { readonly key?: unknown }).key === "string" &&
    Number.isFinite((value as { readonly resetAt?: unknown }).resetAt));

const DEFAULT_BUCKETS = 60;
/** The largest time of a `Date`, in milliseconds from the epoch. */
const MAX_TIME = 8.64e15;

const iso = (t: number): string => new Date(t).toISOString();

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_TIME;

/** This function refuses a cost that is not a finite number of 0 or more. */
const checkCost = (cost: number, of: string): void => {
  if (!Number.isFinite(cost) || cost < 0) {
    throw new ApiError(`The cost of ${of} is not a number of 0 or more: ${String(cost)}.`);
  }
};

/**
 * This function gives the spec of the limiter for a quota. Without `maxBlockMs`, a block ends at the
 * latest when the bucket of its reading stops counting: one window.
 */
const specOf = (quota: Quota, maxBlockMs: number | undefined): QuotaSpec => {
  const { window } = quota;
  return {
    limit: { value: quota.limit, unit: "count" },
    reserve: { value: quota.reserve ?? 0, unit: "count" },
    window:
      window.kind === "rolling"
        ? {
            kind: "rolling",
            span: { value: window.ms, unit: "ms" },
            buckets: { value: window.buckets ?? DEFAULT_BUCKETS, unit: "count" },
          }
        : {
            kind: "calendar",
            unit: window.unit,
            zone: window.timeZone,
            start: { value: window.hour ?? 0, unit: "h" },
          },
    maxBlock: maxBlockMs === undefined ? "window" : { value: maxBlockMs, unit: "ms" },
  };
};

/**
 * This function gives a store of the limiter over a store of this package. The two stores keep one
 * form of record, so a record of an earlier version stays valid.
 */
const limiterStore = (store: QuotaStore): LimiterStore<true> => ({
  sync: true,
  change<T>(quota: string, key: string, step: (stored: unknown) => QuotaChange<T>): T {
    let result: { readonly value: T } | undefined;
    store.changeQuota(quota, key, (stored) => {
      const next = step(stored);
      result = { value: next.result };
      return next.record;
    });
    if (result === undefined) {
      throw new ApiError(`The store did not change the record of the quota ${quota} of ${key}.`);
    }
    return result.value;
  },
});

/**
 * The gate of one key. It counts the units of the calls, and it refuses a call over the quota.
 *
 * @beta
 */
export interface QuotaGate {
  readonly quota: Quota;
  readonly key: string;
  /**
   * This method counts `cost` units (default 1) for a call that starts at this time, and gives the
   * state. A cost of 0 counts nothing and refuses nothing.
   *
   * @throws QuotaError when the units are more than `left`, or when the provider refused the key.
   * The gate then counts nothing. Its `resetAt` is the end of the refusal of the provider, or a later
   * time when the window has the units of the call.
   * @throws ApiError when the cost is negative or not finite, or when it is more than the quota
   * gives in one window.
   */
  take(cost?: number): QuotaState;
  /** This method adds what an answer of the provider tells. The count can only become larger. */
  note(reading: QuotaReading): QuotaState;
  /** This method gives the state at this time, and changes nothing. */
  state(): QuotaState;
  /**
   * This method gives back `cost` units that `take` counted at the time `at` (the `at` of its
   * state), for a call that did not start. `withQuota` uses it for a list of gates. When the gate
   * read the count of the provider at the time `at` or later, the method changes nothing. That
   * reading can include the units. So the count does not become lower than the count of the provider
   * at any time. A gate made by `quotaGate` has this method.
   *
   * @throws ApiError when the cost is negative or not finite, or when `at` is not a time.
   */
  giveBack?(cost: number, at: number): QuotaState;
}

/**
 * The options of `quotaGate`.
 *
 * @beta
 */
export interface QuotaGateOptions {
  /**
   * This value names the key, for example `example:account-1`. A store keeps it as text, so do not
   * give the secret of the key. Give one name to each account that the provider counts.
   */
  readonly key: string;
  /** This store keeps the records. The default is a new `memoryQuotaStore`. */
  readonly store?: QuotaStore | undefined;
  /** This function gives the time in milliseconds since the epoch. The default is `Date.now`. */
  readonly now?: (() => number) | undefined;
  /**
   * This value is the longest block that a reset of the provider can set, in milliseconds. A reading
   * with a later reset blocks the key until the time of the reading plus this value. The default is
   * one window. Then the block ends at the latest when the units of a call at the time of the
   * reading go free. Thus a reset header in a wrong form cannot stop a key for much longer than the
   * window of the quota.
   */
  readonly maxBlockMs?: number | undefined;
}

/**
 * This function makes the gate of one key.
 *
 * @throws ApiError when the quota, its window or `maxBlockMs` is not valid. The message gives each
 * problem.
 * @beta
 */
export function quotaGate(quota: Quota, options: QuotaGateOptions): QuotaGate {
  const { limit, name } = quota;
  const reserve = quota.reserve ?? 0;
  const { key, maxBlockMs } = options;
  const spec = specOf(quota, maxBlockMs);
  const problems = quotaProblems(name, spec);
  if (problems.length > 0) {
    throw new ApiError(`The quota ${name} is not valid: ${problems.join("; ")}.`);
  }
  // the record of the quota and the key, so two quotas of one key in one store count apart
  const limiter = keyedQuota(name, spec, limiterStore(options.store ?? memoryQuotaStore()), {
    time: "wall",
    now: options.now ?? Date.now,
  });
  /** This function gives the error of a refused call. */
  const refusal = (verdict: QuotaRefused, cost: number): ApiError => {
    if (verdict.cause === "capacity") {
      return new ApiError(
        `A call of ${String(cost)} units is more than the quota ${name} gives in one window: ${String(verdict.capacity)}.`,
      );
    }
    const { resetAt, state } = verdict;
    const { blockedUntil } = state;
    if (verdict.cause === "provider" && blockedUntil !== undefined) {
      return new QuotaError(
        `The provider refused the quota ${name} of ${key} until ${iso(blockedUntil)}.` +
          (resetAt > blockedUntil
            ? ` The window has the units of the call at ${iso(resetAt)}.`
            : ""),
        key,
        resetAt,
      );
    }
    return new QuotaError(
      `The quota ${name} of ${key} refused a call of ${String(cost)} units: ` +
        `${String(state.used)} of ${String(limit)} are used, and ${String(reserve)} stay in reserve. ` +
        `It gives units again at ${iso(resetAt)}.`,
      key,
      resetAt,
    );
  };
  return {
    quota,
    key,
    take(cost = 1) {
      checkCost(cost, "a call");
      // a call of cost 0 is a call that the provider does not count, for example a read of a receipt
      const verdict = limiter.take(key, cost);
      if (!verdict.allowed) throw refusal(verdict, cost);
      return verdict.state;
    },
    note: (reading) => limiter.note(key, reading),
    state: () => limiter.state(key),
    giveBack(cost, at) {
      checkCost(cost, "a give-back");
      if (!isTime(at)) throw new ApiError(`The time of a give-back is not a time: ${String(at)}.`);
      return limiter.giveBack(key, cost, at);
    },
  };
}

/**
 * This function makes a store of records in memory. Each gate of one process can share it.
 *
 * @beta
 */
export function memoryQuotaStore(): QuotaStore {
  const records = new Map<string, Map<string, QuotaRecord>>();
  return {
    changeQuota(quota, key, step) {
      let keys = records.get(quota);
      if (keys === undefined) {
        keys = new Map();
        records.set(quota, keys);
      }
      const next = step(keys.get(key));
      keys.set(key, next);
      return next;
    },
  };
}

/**
 * The options of `withQuota`.
 *
 * @beta
 */
export interface WithQuotaOptions<A extends readonly unknown[], R> {
  /**
   * This value is the count of units of a call, or a function of the arguments that gives it. The
   * default is 1. Give 0 for a call that the provider does not count: the gate then does not refuse it.
   */
  readonly cost?: number | ((...args: A) => number) | undefined;
  /**
   * This function reads what the result of a call tells of the count of the provider, for example
   * with `readQuotaHeaders`. With a list of gates, it reads once for each gate. A provider often
   * tells the count of one quota only: then give its reading for that gate, and undefined for the
   * other gates.
   */
  readonly read?: ((result: R, gate: QuotaGate) => QuotaReading | undefined) | undefined;
  /**
   * This function gets an error of `read` or of the store after the call. The call went out, so
   * `withQuota` gives its result. It does not throw, because a retry after a throw sends the call
   * again. It also gets an error of a give-back of a list, and the caller still gets the refusal.
   * With no function, the error is lost. An error that this function throws is lost too.
   */
  readonly onError?: ((error: unknown) => void) | undefined;
}

const isGateList = (gate: QuotaGate | readonly QuotaGate[]): gate is readonly QuotaGate[] =>
  Array.isArray(gate);

/** This function checks the gates of `withQuota`: a list has gates that can give back units. */
const gateList = (gate: QuotaGate | readonly QuotaGate[]): readonly QuotaGate[] => {
  if (!isGateList(gate)) return [gate];
  if (gate.length === 0) throw new ApiError("The list of gates of withQuota is empty.");
  const seen = new Set<string>();
  for (const each of gate) {
    const named = `the quota ${each.quota.name} of ${each.key}`;
    if (gate.length > 1 && each.giveBack === undefined) {
      throw new ApiError(`The gate of ${named} cannot give back units, so it cannot be in a list.`);
    }
    // a store keeps one record for each name and key, so two such gates count each call twice;
    // a gate does not show its store, so two gates of one name and key on two stores are refused too
    const id = JSON.stringify([each.quota.name, each.key]);
    if (seen.has(id)) {
      throw new ApiError(`Two gates of the list have ${named}. Give each quota a different name.`);
    }
    seen.add(id);
  }
  return [...gate];
};

/**
 * This function gives an error to `onError`. An error that `onError` throws is lost. Thus the other
 * give-backs still occur, and the caller gets the refusal or the result of the call.
 */
const report = (onError: ((error: unknown) => void) | undefined, error: unknown): void => {
  try {
    onError?.(error);
  } catch {
    // the refusal or the result of the call is more important than an error of the report
  }
};

/** This function gives a state of a gate in the form of the limiter. A state with no time gets the time NaN. */
const limiterState = (state: QuotaState): LimiterState => ({
  ...state,
  at: state.at ?? Number.NaN,
});

/**
 * This function gives a gate of a list as a part of `takeQuotas`. The part keeps the `QuotaError` of
 * its refusal in `refusals`, because the caller gets that error. A `QuotaError` has no state, so a
 * refused part reads the state of its gate. A give-back of units with no time fails, and `onError`
 * gets its error.
 */
const partOf = (
  gate: QuotaGate,
  units: number,
  index: number,
  refusals: Map<number, QuotaError>,
): QuotaPart<true> => ({
  key: gate.key,
  units,
  quota: {
    sync: true,
    take: (_key, cost = 1): QuotaVerdict => {
      try {
        return { allowed: true, state: limiterState(gate.take(cost)) };
      } catch (error) {
        if (!isQuotaError(error)) throw error;
        refusals.set(index, error);
        const state = limiterState(gate.state());
        const wait = Number.isNaN(state.at) ? 0 : Math.max(0, error.resetAt - state.at);
        return {
          allowed: false,
          cause: state.blockedUntil === undefined ? "limit" : "provider",
          resetAt: error.resetAt,
          retryAfter: { value: wait, unit: "ms" },
          state,
        };
      }
    },
    giveBack: (_key, cost, at) => {
      if (Number.isNaN(at)) {
        throw new ApiError(
          `The gate of the quota ${gate.quota.name} of ${gate.key} gave no time for its units, so it cannot give them back.`,
        );
      }
      return limiterState(gate.giveBack?.(cost, at) ?? gate.state());
    },
  },
});

/**
 * This function counts `cost` units in each gate, or in none. One gate gives its refusal as it is. A
 * list takes with `takeQuotas`: when a gate refuses, the gates that counted give back the units,
 * because the call did not start. The next gates still answer, so the `QuotaError` has the latest
 * time of a reset.
 */
const takeAll = (
  gates: readonly QuotaGate[],
  cost: number,
  onError: ((error: unknown) => void) | undefined,
): void => {
  const [only] = gates;
  if (gates.length === 1 && only !== undefined) {
    only.take(cost);
    return;
  }
  const refusals = new Map<number, QuotaError>();
  const verdict = takeQuotas(
    gates.map((gate, index) => partOf(gate, cost, index, refusals)),
    { onGiveBackError: (error) => report(onError, error) },
  );
  if (!verdict.allowed) {
    throw (
      refusals.get(verdict.index) ??
      new ApiError("A gate of the list refused the call, but it gave no QuotaError.")
    );
  }
};

/**
 * This function puts a gate, or a list of gates, on an async function, and keeps the type of the
 * function. Each call counts its units first. A call over the quota throws `QuotaError`, and the
 * function does not start.
 *
 * Give the result to a client that takes a function of this type. For example, `withQuota(gate,
 * fetch)` is a `fetch`, and `withQuota(gate, transport)` is a transport of `send` and `poll`.
 *
 * For two quotas of one key, give a list: `withQuota([perMinute, perDay], fetch)`. The list counts
 * the call in each gate or in none. Do not put one gate in the function of another. The outer gate
 * cannot know if a request went out before the inner gate refused (`send` retries). So it keeps
 * the units of the call.
 *
 * @throws ApiError when the list is empty, or when a gate of a list of two or more has no
 * `giveBack`. Also when two gates of the list have one quota name and key.
 * @beta
 */
export function withQuota<A extends readonly unknown[], R>(
  gate: QuotaGate | readonly QuotaGate[],
  call: (...args: A) => Promise<R>,
  options: WithQuotaOptions<A, R> = {},
): (...args: A) => Promise<R> {
  const gates = gateList(gate);
  const { cost, read, onError } = options;
  return async (...args: A): Promise<R> => {
    takeAll(gates, typeof cost === "function" ? cost(...args) : (cost ?? 1), onError);
    const result = await call(...args);
    for (const each of gates) {
      try {
        const reading = read?.(result, each);
        if (reading !== undefined) each.note(reading);
      } catch (error) {
        report(onError, error);
      }
    }
    return result;
  };
}

/**
 * The names of the headers of an answer that tell the count of a provider. Each name is optional.
 *
 * @beta
 */
export interface QuotaHeaders {
  /** This header has the count of units that the provider gives before its reset, for example `x-ratelimit-remaining`. */
  readonly remaining?: string | undefined;
  /**
   * This header has the time of the reset, for example `x-ratelimit-reset`. The function reads its
   * form from its size. A value under 10^9 is the seconds until the reset, as `RateLimit-Reset` of
   * the IETF draft gives them. A value from 10^9 to under 10^11 is seconds since the epoch. A value
   * from 10^11 is milliseconds since the epoch.
   */
  readonly resetAt?: string | undefined;
  /**
   * This header has the seconds until the reset, or the HTTP date of the reset, as `retry-after`
   * gives them. When it has a value that the function can read, the function does not read `resetAt`.
   */
  readonly resetAfter?: string | undefined;
}

const COUNT = /^\d{1,15}$/;
const SECONDS = /^\d{1,12}(?:\.\d{1,3})?$/;
const RESET = /^\d{1,15}(?:\.\d{1,3})?$/;

/**
 * A reset value under this bound is a count of seconds until the reset. As seconds since the epoch,
 * it is a time before 2001-09-09T01:46:40Z, and no reset of a provider is that early.
 */
export const SECONDS_SINCE_EPOCH_FROM = 1e9;
/**
 * A reset value from this bound is in milliseconds since the epoch. As seconds since the epoch, it
 * is a time in the year 5138, and as milliseconds it is a time in 1973.
 */
export const MILLISECONDS_SINCE_EPOCH_FROM = 1e11;

/**
 * This function gives the time of a reset, in milliseconds since the epoch, from the number of a
 * reset header. The three forms of the header do not overlap:
 *
 * - under `SECONDS_SINCE_EPOCH_FROM` (10^9): seconds until the reset, from `now`
 * - from 10^9 to under `MILLISECONDS_SINCE_EPOCH_FROM` (10^11): seconds since the epoch
 * - from 10^11: milliseconds since the epoch
 */
export const resetTimeOf = (value: number, now: number): number =>
  value < SECONDS_SINCE_EPOCH_FROM
    ? now + value * 1000
    : value < MILLISECONDS_SINCE_EPOCH_FROM
      ? value * 1000
      : value;

/**
 * This function reads the count of a provider from the headers of an answer. `get` gives the value
 * of one header, for example `(name) => response.headers.get(name)` for a `fetch` answer, or
 * `(name) => reply.headers[name]` for a `Reply`. A value that is not a number is not read. A value of
 * `resetAfter` can also be an HTTP date, as in `Retry-After`. The value of `resetAt` can be in each
 * of three forms, which the function tells apart by their size.
 *
 * A reset with no count tells that the provider refuses the key until that time. The answer can
 * have a reset header, and no `remaining` header with a number. Then the gate stops the key until
 * the reset, also after a successful answer.
 *
 * @returns the reading, or undefined when no header has a value.
 * @beta
 */
export function readQuotaHeaders(
  get: (name: string) => string | null | undefined,
  names: QuotaHeaders,
  now: number,
): QuotaReading | undefined {
  const text = (name: string | undefined): string | undefined =>
    name === undefined ? undefined : get(name.toLowerCase())?.trim();
  const value = (name: string | undefined, form: RegExp): number | undefined => {
    const found = text(name);
    return found !== undefined && form.test(found) ? Number(found) : undefined;
  };
  const remaining = value(names.remaining, COUNT);
  const at = value(names.resetAt, RESET);
  // seconds with a fraction, as some providers give, and then the two forms of Retry-After
  const afterText = text(names.resetAfter);
  const after =
    afterText === undefined
      ? undefined
      : SECONDS.test(afterText)
        ? Number(afterText) * 1000
        : parseRetryAfter(afterText, now);
  const resetAt =
    after !== undefined ? now + after : at === undefined ? undefined : resetTimeOf(at, now);
  if (remaining === undefined && resetAt === undefined) return undefined;
  return {
    ...(remaining === undefined ? {} : { remaining }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}
