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
 * The civil time of a calendar window comes from `@mark1russell7/algebra/clock`. The module imports
 * no Node.js module, so a browser can use it. Each export is beta.
 */
import { instantsOf, localTime, offsetChanges } from "@mark1russell7/algebra/clock";
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

const MAX_BUCKETS = 1000;
const DEFAULT_BUCKETS = 60;
const HOUR_MS = 3_600_000;
/** The largest time of a `Date`, in milliseconds from the epoch. */
const MAX_TIME = 8.64e15;

const iso = (t: number): string => new Date(t).toISOString();

/** The checked form of a window: the time bucket of a time, and the test of a bucket. */
interface Span {
  /** This function gives the start and the end of the bucket of the time `t`. */
  bucket(t: number): readonly [start: number, end: number];
  /**
   * This function gives the test of the buckets that count at the time `t`. A bucket of a later
   * window counts too: after a step back of the clock, the calls of that window still count.
   */
  counting(t: number): (start: number) => boolean;
  /** This function gives the time when the bucket that starts at `start` stops counting. */
  freeAt(start: number): number;
}

/** This function gives the clock time of `t` in a zone, as the milliseconds of that clock time in UTC. */
const wallOf = (t: number, timeZone: string): number => {
  const local = localTime(t, timeZone);
  if (local === undefined) throw new ApiError(`The time ${String(t)} is not a date.`);
  const { year, month, day, hour, minute, second } = local;
  return Date.UTC(year, month - 1, day, hour, minute, second);
};

/**
 * This function gives the first time at which the clock of the zone shows the clock time `wall`.
 * In the gap of a change forward, the clock does not show `wall`. The function then gives the time
 * of the change: the end of the gap.
 */
const firstAt = (wall: number, timeZone: string): number => {
  const [first] = instantsOf(wall, timeZone) ?? [];
  if (first !== undefined) return first;
  // a time with the clock time `wall` is from 14 hours before `wall` to 12 hours after it
  const changes = offsetChanges(wall - 15 * HOUR_MS, wall + 13 * HOUR_MS, timeZone) ?? [];
  const change = changes.find(
    (at) => wallOf(at - 1, timeZone) < wall && wallOf(at, timeZone) >= wall,
  );
  if (change === undefined) {
    throw new ApiError(`The clock of ${timeZone} does not show or jump over ${iso(wall)}.`);
  }
  return change;
};

/** This function gives the calendar window of the time `t`: its start, and the start of the next window. */
const calendarOf = (
  unit: "day" | "month",
  timeZone: string,
  hour: number,
  t: number,
): readonly [number, number] => {
  const wall = new Date(wallOf(t, timeZone));
  const year = wall.getUTCFullYear();
  const month = wall.getUTCMonth();
  const day = wall.getUTCDate();
  // the start of the window that is `back` windows before the window of the date of `t`
  const startOf = (back: number): number =>
    firstAt(
      unit === "day"
        ? Date.UTC(year, month, day - back, hour)
        : Date.UTC(year, month - back, 1, hour),
      timeZone,
    );
  const start = startOf(0);
  return start <= t ? [start, startOf(-1)] : [startOf(1), start];
};

const spanOf = (window: QuotaWindow): Span => {
  if (window.kind === "rolling") {
    const buckets = window.buckets ?? DEFAULT_BUCKETS;
    if (!Number.isFinite(window.ms) || window.ms <= 0) {
      throw new ApiError(`The rolling window is not a positive number: ${String(window.ms)}.`);
    }
    if (!Number.isInteger(buckets) || buckets < 1 || buckets > MAX_BUCKETS) {
      throw new ApiError(
        `The count of buckets is not a whole number from 1 to ${String(MAX_BUCKETS)}: ${String(buckets)}.`,
      );
    }
    const { ms } = window;
    const size = Math.ceil(ms / buckets);
    return {
      bucket: (t) => {
        const start = Math.floor(t / size) * size;
        return [start, start + size];
      },
      counting: (t) => (start) => start + size + ms > t,
      freeAt: (start) => start + size + ms,
    };
  }
  const hour = window.hour ?? 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ApiError(
      `The hour of the window is not a whole number from 0 to 23: ${String(hour)}.`,
    );
  }
  if (localTime(0, window.timeZone) === undefined) {
    throw new ApiError(`The time zone of the window is not an IANA time zone: ${window.timeZone}.`);
  }
  const { unit, timeZone } = window;
  return {
    bucket: (t) => calendarOf(unit, timeZone, hour, t),
    // only the windows before the window of `t` stop counting
    counting: (t) => {
      const [first] = calendarOf(unit, timeZone, hour, t);
      return (start) => start >= first;
    },
    freeAt: (start) => calendarOf(unit, timeZone, hour, start)[1],
  };
};

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_TIME;

/**
 * This function gives the record of a store, or undefined for a value that is not a record. It
 * removes each item that is not valid and keeps the other items, so the count stays as high as the
 * record lets it.
 */
const recordOf = (value: unknown): QuotaRecord | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { spent, blockedUntil, readAt } = value as {
    spent?: unknown;
    blockedUntil?: unknown;
    readAt?: unknown;
  };
  if (!Array.isArray(spent)) return undefined;
  const items: (readonly [number, number])[] = [];
  for (const item of spent as unknown[]) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const [start, units] = item as unknown[];
    if (isTime(start) && isTime(units) && units >= 0) items.push([start, units]);
  }
  items.sort((a, b) => a[0] - b[0]);
  return {
    spent: items,
    ...(isTime(blockedUntil) ? { blockedUntil } : {}),
    ...(isTime(readAt) ? { readAt } : {}),
  };
};

/** This function removes the buckets that do not count at the time `t`, and an ended refusal. */
const prune = (span: Span, record: QuotaRecord | undefined, t: number): QuotaRecord => {
  const counts = span.counting(t);
  const spent = (record?.spent ?? []).filter(([start]) => counts(start));
  const blockedUntil = record?.blockedUntil;
  const readAt = record?.readAt;
  return {
    spent,
    ...(blockedUntil !== undefined && blockedUntil > t ? { blockedUntil } : {}),
    ...(readAt === undefined ? {} : { readAt }),
  };
};

const usedOf = (record: QuotaRecord): number =>
  record.spent.reduce((sum, [, units]) => sum + units, 0);

/** This function adds units to the bucket of the time `t`. */
const add = (span: Span, record: QuotaRecord, t: number, units: number): QuotaRecord => {
  const [start] = span.bucket(t);
  const spent = record.spent.map(([at, count]): readonly [number, number] =>
    at === start ? [at, count + units] : [at, count],
  );
  if (!spent.some(([at]) => at === start)) spent.push([start, units]);
  spent.sort((a, b) => a[0] - b[0]);
  return { ...record, spent };
};

/** This function gives the time when `need` units of the oldest buckets stop counting. */
const freeTime = (span: Span, record: QuotaRecord, need: number): number | undefined => {
  let freed = 0;
  for (const [start, units] of record.spent) {
    freed += units;
    if (freed >= need) return span.freeAt(start);
  }
  return undefined;
};

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
 * @throws ApiError when the quota or its window is not valid.
 * @beta
 */
export function quotaGate(quota: Quota, options: QuotaGateOptions): QuotaGate {
  const span = spanOf(quota.window);
  const { limit, name } = quota;
  const reserve = quota.reserve ?? 0;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new ApiError(
      `The limit of the quota ${name} is not a positive number: ${String(limit)}.`,
    );
  }
  if (!Number.isFinite(reserve) || reserve < 0 || reserve >= limit) {
    throw new ApiError(
      `The reserve of the quota ${name} is not from 0 to less than the limit: ${String(reserve)}.`,
    );
  }
  const { key, maxBlockMs } = options;
  if (maxBlockMs !== undefined && (!Number.isFinite(maxBlockMs) || maxBlockMs <= 0)) {
    throw new ApiError(
      `The longest block of the quota ${name} is not a positive number: ${String(maxBlockMs)}.`,
    );
  }
  // the latest end of a block that a reading at the time `t` can set
  const blockBound = (t: number): number =>
    maxBlockMs === undefined ? span.freeAt(span.bucket(t)[0]) : t + maxBlockMs;
  const store = options.store ?? memoryQuotaStore();
  const now = options.now ?? Date.now;
  const allowed = limit - reserve;
  const stateOf = (record: QuotaRecord, t: number): QuotaState => {
    const used = usedOf(record);
    const resetAt = record.spent.length === 0 ? undefined : span.freeAt(record.spent[0]![0]);
    return {
      used,
      left: record.blockedUntil === undefined ? Math.max(0, allowed - used) : 0,
      ...(resetAt === undefined ? {} : { resetAt }),
      ...(record.blockedUntil === undefined ? {} : { blockedUntil: record.blockedUntil }),
      at: t,
    };
  };
  // a block ends at the latest at the bound: also a block that a record of an earlier version keeps
  const bounded = (record: QuotaRecord, t: number): QuotaRecord => {
    const { blockedUntil } = record;
    const bound = blockBound(t);
    return blockedUntil !== undefined && blockedUntil > bound
      ? { ...record, blockedUntil: bound }
      : record;
  };
  // the record of the quota and the key, so two quotas of one key in one store count apart
  const change = (step: (record: QuotaRecord, t: number) => QuotaRecord): QuotaState => {
    const t = now();
    // the step sees a bounded record, and its new block is bounded too
    const record = store.changeQuota(name, key, (stored) =>
      bounded(step(bounded(prune(span, recordOf(stored), t), t), t), t),
    );
    return stateOf(prune(span, recordOf(record), t), t);
  };
  // a read that writes the record back as it is, so a store needs only one method
  const state = (): QuotaState => change((record) => record);
  return {
    quota,
    key,
    take(cost = 1) {
      if (!Number.isFinite(cost) || cost < 0) {
        throw new ApiError(`The cost of a call is not a number of 0 or more: ${String(cost)}.`);
      }
      // a call that the provider does not count, for example a read of a receipt
      if (cost === 0) return state();
      if (cost > allowed) {
        throw new ApiError(
          `A call of ${String(cost)} units is more than the quota ${name} gives in one window: ${String(allowed)}.`,
        );
      }
      let refused: QuotaError | undefined;
      const taken = change((record, t) => {
        const used = usedOf(record);
        // the need is never more than the units of the window, because cost <= allowed
        const free =
          used + cost > allowed
            ? (freeTime(span, record, used + cost - allowed) ?? span.bucket(t)[1])
            : undefined;
        const { blockedUntil } = record;
        if (blockedUntil !== undefined) {
          const resetAt = Math.max(blockedUntil, free ?? blockedUntil);
          refused = new QuotaError(
            `The provider refused the quota ${name} of ${key} until ${iso(blockedUntil)}.` +
              (resetAt > blockedUntil
                ? ` The window has the units of the call at ${iso(resetAt)}.`
                : ""),
            key,
            resetAt,
          );
          return record;
        }
        if (free !== undefined) {
          refused = new QuotaError(
            `The quota ${name} of ${key} refused a call of ${String(cost)} units: ` +
              `${String(used)} of ${String(limit)} are used, and ${String(reserve)} stay in reserve. ` +
              `It gives units again at ${iso(free)}.`,
            key,
            free,
          );
          return record;
        }
        return add(span, record, t, cost);
      });
      if (refused !== undefined) throw refused;
      return taken;
    },
    note(reading) {
      return change((record, t) => {
        let next = record;
        const { remaining, resetAt } = reading;
        if (remaining !== undefined && Number.isFinite(remaining) && remaining >= 0) {
          const more = limit - remaining - usedOf(next);
          if (more > 0) next = add(span, next, t, more);
          // a later give-back cannot know if this count includes its units, so it changes nothing
          next = { ...next, readAt: Math.max(next.readAt ?? t, t) };
        }
        const exhausted = remaining === undefined || remaining <= 0;
        if (exhausted && resetAt !== undefined && Number.isFinite(resetAt) && resetAt > t) {
          next = { ...next, blockedUntil: Math.max(next.blockedUntil ?? 0, resetAt) };
        }
        return next;
      });
    },
    state,
    giveBack(cost, at) {
      if (!Number.isFinite(cost) || cost < 0) {
        throw new ApiError(
          `The cost of a give-back is not a number of 0 or more: ${String(cost)}.`,
        );
      }
      if (!isTime(at)) throw new ApiError(`The time of a give-back is not a time: ${String(at)}.`);
      if (cost === 0) return state();
      return change((record) => {
        if (record.readAt !== undefined && record.readAt >= at) return record;
        // the units are in the bucket of their time, and a bucket out of the window is gone
        const [start] = span.bucket(at);
        const spent = record.spent.flatMap(([from, units]): (readonly [number, number])[] =>
          from !== start ? [[from, units]] : units > cost ? [[from, units - cost]] : [],
        );
        return { ...record, spent };
      });
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

/** This function gives back the units of each gate that counted them, and gives each error to `onError`. */
const giveBackAll = (
  taken: readonly (readonly [QuotaGate, number | undefined])[],
  cost: number,
  onError: ((error: unknown) => void) | undefined,
): void => {
  for (const [gate, at] of taken) {
    try {
      if (at === undefined) {
        throw new ApiError(
          `The gate of the quota ${gate.quota.name} of ${gate.key} gave no time for its units, so it cannot give them back.`,
        );
      }
      gate.giveBack?.(cost, at);
    } catch (error) {
      report(onError, error);
    }
  }
};

/**
 * This function counts `cost` units in each gate, or in none. When a gate refuses, the gates that
 * counted give back the units: the call did not start. The next gates still answer, so the
 * `QuotaError` has the latest time of a reset.
 */
const takeAll = (
  gates: readonly QuotaGate[],
  cost: number,
  onError: ((error: unknown) => void) | undefined,
): void => {
  const taken: (readonly [QuotaGate, number | undefined])[] = [];
  let refusal: QuotaError | undefined;
  try {
    for (const gate of gates) {
      try {
        taken.push([gate, gate.take(cost).at]);
      } catch (error) {
        if (!isQuotaError(error) || gates.length === 1) throw error;
        if (refusal === undefined || error.resetAt > refusal.resetAt) refusal = error;
      }
    }
    if (refusal !== undefined) throw refusal;
  } catch (error) {
    giveBackAll(taken, cost, onError);
    throw error;
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
