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
 * The module imports no Node.js module, so a browser can use it. Each export is beta.
 */
import { ApiError } from "./api-error.ts";

/**
 * The window of a quota.
 *
 * - `rolling`: the units of the last `ms` milliseconds. Use it when the provider does not tell when
 *   its count starts again. It is stricter than each fixed window of the same length.
 * - `calendar`: the units of a day or a month in the IANA time zone `timeZone`. A window starts at
 *   the hour `hour` (default 0) of the first day, in that zone.
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
  /** This value names the quota in a message, for example `Example API requests`. */
  readonly name: string;
  /** This value is the count of units that the provider gives in one window. */
  readonly limit: number;
  /** The gate keeps this count of units unused. The default is 0. */
  readonly reserve?: number | undefined;
  readonly window: QuotaWindow;
}

/**
 * The record of one key in a store: the units of each time bucket, and the end of a refusal of the
 * provider. A record has only numbers, so a store can keep it as JSON.
 *
 * @beta
 */
export interface QuotaRecord {
  /** Each item is the start of a bucket in milliseconds since the epoch, and its units. The items are in the order of their start. */
  readonly spent: readonly (readonly [start: number, units: number])[];
  /** The provider refused the key until this time, in milliseconds since the epoch. */
  readonly blockedUntil?: number | undefined;
}

/**
 * A store of the records of the keys. `memoryQuotaStore` keeps them in memory, and
 * `SqliteHostStateStore` keeps them in its file.
 *
 * @beta
 */
export interface QuotaStore {
  /**
   * This method gives the record of `key` to `step`, keeps the record that `step` gives, and gives
   * it. It is one step: a different call cannot change the record between the read and the write.
   */
  changeQuota(key: string, step: (record: QuotaRecord | undefined) => QuotaRecord): QuotaRecord;
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
  /** This value is the count of units that the gate gives: the limit, less the reserve and `used`. */
  readonly left: number;
  /** The units come back from this time, in milliseconds since the epoch. With no unit in the window, it is not there. */
  readonly resetAt?: number | undefined;
  /** The provider refused the key until this time, in milliseconds since the epoch. */
  readonly blockedUntil?: number | undefined;
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

const MAX_BUCKETS = 1000;
const DEFAULT_BUCKETS = 60;

/** The checked form of a window: the time bucket of a time, and the test of a bucket. */
interface Span {
  /** This function gives the start and the end of the bucket of the time `t`. */
  bucket(t: number): readonly [start: number, end: number];
  /** This function tells if the bucket that starts at `start` counts at the time `t`. */
  counts(start: number, t: number): boolean;
  /** This function gives the time when the bucket that starts at `start` stops counting. */
  freeAt(start: number): number;
}

const formats = new Map<string, Intl.DateTimeFormat>();

const formatOf = (timeZone: string): Intl.DateTimeFormat => {
  let format = formats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(timeZone, format);
  }
  return format;
};

/** This function gives the clock time of `t` in a zone, as the milliseconds of that clock time in UTC. */
const wallOf = (t: number, timeZone: string): number => {
  const part: Record<string, number> = {};
  for (const { type, value } of formatOf(timeZone).formatToParts(t)) part[type] = Number(value);
  return Date.UTC(
    part["year"] ?? 0,
    (part["month"] ?? 1) - 1,
    part["day"] ?? 1,
    part["hour"] ?? 0,
    part["minute"] ?? 0,
    part["second"] ?? 0,
  );
};

/**
 * This function gives the time of a clock time of a zone. The arguments are those of `Date.UTC`, so
 * a day 0 is the last day of the month before. Two passes find the offset after a clock change.
 */
const instantOf = (
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
): number => {
  const wall = Date.UTC(year, month, day, hour);
  const offsetAt = (t: number): number => wallOf(t, timeZone) - Math.floor(t / 1000) * 1000;
  const first = wall - offsetAt(wall);
  return wall - offsetAt(first);
};

/** This function gives the calendar window of the time `t`. */
const calendarOf = (
  unit: "day" | "month",
  timeZone: string,
  hour: number,
  t: number,
): readonly [number, number] => {
  const wall = new Date(wallOf(t, timeZone));
  const year = wall.getUTCFullYear();
  const month = wall.getUTCMonth();
  const day = unit === "day" ? wall.getUTCDate() : 1;
  const step = (back: number): readonly [number, number] =>
    unit === "day"
      ? [
          instantOf(timeZone, year, month, day - back, hour),
          instantOf(timeZone, year, month, day - back + 1, hour),
        ]
      : [
          instantOf(timeZone, year, month - back, 1, hour),
          instantOf(timeZone, year, month - back + 1, 1, hour),
        ];
  const window = step(0);
  return window[0] <= t ? window : step(1);
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
      counts: (start, t) => start + size + ms > t,
      freeAt: (start) => start + size + ms,
    };
  }
  const hour = window.hour ?? 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ApiError(
      `The hour of the window is not a whole number from 0 to 23: ${String(hour)}.`,
    );
  }
  try {
    formatOf(window.timeZone);
  } catch {
    throw new ApiError(`The time zone of the window is not an IANA time zone: ${window.timeZone}.`);
  }
  const { unit, timeZone } = window;
  return {
    bucket: (t) => calendarOf(unit, timeZone, hour, t),
    counts: (start, t) => calendarOf(unit, timeZone, hour, t)[0] === start,
    freeAt: (start) => calendarOf(unit, timeZone, hour, start)[1],
  };
};

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** This function gives the record of a store, or undefined for a value that is not a record. */
const recordOf = (value: unknown): QuotaRecord | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { spent, blockedUntil } = value as { spent?: unknown; blockedUntil?: unknown };
  if (!Array.isArray(spent)) return undefined;
  const items: (readonly [number, number])[] = [];
  for (const item of spent as unknown[]) {
    if (!Array.isArray(item) || item.length !== 2) return undefined;
    const [start, units] = item as unknown[];
    if (!isTime(start) || !isTime(units) || units < 0) return undefined;
    items.push([start, units]);
  }
  items.sort((a, b) => a[0] - b[0]);
  return isTime(blockedUntil) ? { spent: items, blockedUntil } : { spent: items };
};

/** This function removes the buckets that do not count at the time `t`, and an ended refusal. */
const prune = (span: Span, record: QuotaRecord | undefined, t: number): QuotaRecord => {
  const spent = (record?.spent ?? []).filter(([start]) => span.counts(start, t));
  const blockedUntil = record?.blockedUntil;
  return blockedUntil !== undefined && blockedUntil > t ? { spent, blockedUntil } : { spent };
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
   * The gate then counts nothing.
   * @throws ApiError when the cost is negative or not finite, or when it is more than the quota
   * gives in one window.
   */
  take(cost?: number): QuotaState;
  /** This method adds what an answer of the provider tells. The count can only become larger. */
  note(reading: QuotaReading): QuotaState;
  /** This method gives the state at this time, and changes nothing. */
  state(): QuotaState;
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
}

const iso = (t: number): string => new Date(t).toISOString();

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
  const { key } = options;
  const store = options.store ?? memoryQuotaStore();
  const now = options.now ?? Date.now;
  const allowed = limit - reserve;
  const stateOf = (record: QuotaRecord): QuotaState => {
    const used = usedOf(record);
    const resetAt = record.spent.length === 0 ? undefined : span.freeAt(record.spent[0]![0]);
    return {
      used,
      left: Math.max(0, allowed - used),
      ...(resetAt === undefined ? {} : { resetAt }),
      ...(record.blockedUntil === undefined ? {} : { blockedUntil: record.blockedUntil }),
    };
  };
  const change = (step: (record: QuotaRecord, t: number) => QuotaRecord): QuotaState => {
    const t = now();
    const record = store.changeQuota(key, (stored) => step(prune(span, recordOf(stored), t), t));
    return stateOf(prune(span, recordOf(record), t));
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
        if (record.blockedUntil !== undefined) {
          refused = new QuotaError(
            `The provider refused the quota ${name} of ${key} until ${iso(record.blockedUntil)}.`,
            key,
            record.blockedUntil,
          );
          return record;
        }
        const used = usedOf(record);
        if (used + cost > allowed) {
          // the need is never more than the units of the window, because cost <= allowed
          const resetAt = freeTime(span, record, used + cost - allowed) ?? span.bucket(t)[1];
          refused = new QuotaError(
            `The quota ${name} of ${key} refused a call of ${String(cost)} units: ` +
              `${String(used)} of ${String(limit)} are used, and ${String(reserve)} stay in reserve. ` +
              `It gives units again at ${iso(resetAt)}.`,
            key,
            resetAt,
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
        }
        const exhausted = remaining === undefined || remaining <= 0;
        if (exhausted && resetAt !== undefined && Number.isFinite(resetAt) && resetAt > t) {
          next = { ...next, blockedUntil: Math.max(next.blockedUntil ?? 0, resetAt) };
        }
        return next;
      });
    },
    state,
  };
}

/**
 * This function makes a store of records in memory. Each gate of one process can share it.
 *
 * @beta
 */
export function memoryQuotaStore(): QuotaStore {
  const records = new Map<string, QuotaRecord>();
  return {
    changeQuota(key, step) {
      const next = step(records.get(key));
      records.set(key, next);
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
  /** This function reads what the result of a call tells of the count of the provider, for example with `readQuotaHeaders`. */
  readonly read?: ((result: R) => QuotaReading | undefined) | undefined;
}

/**
 * This function puts a gate on an async function, and keeps the type of the function. Each call
 * counts its units first. A call over the quota throws `QuotaError`, and the function does not start.
 *
 * Give the result to a client that takes a function of this type. For example, `withQuota(gate,
 * fetch)` is a `fetch`, and `withQuota(gate, transport)` is a transport of `send` and `poll`. Put two gates on
 * one function for two quotas of one key.
 *
 * @beta
 */
export function withQuota<A extends readonly unknown[], R>(
  gate: QuotaGate,
  call: (...args: A) => Promise<R>,
  options: WithQuotaOptions<A, R> = {},
): (...args: A) => Promise<R> {
  const { cost, read } = options;
  return async (...args: A): Promise<R> => {
    gate.take(typeof cost === "function" ? cost(...args) : (cost ?? 1));
    const result = await call(...args);
    const reading = read?.(result);
    if (reading !== undefined) gate.note(reading);
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
  /** This header has the time of the reset in seconds since the epoch, for example `x-ratelimit-reset`. */
  readonly resetAt?: string | undefined;
  /** This header has the seconds until the reset, for example `retry-after`. */
  readonly resetAfter?: string | undefined;
}

const COUNT = /^\d{1,15}$/;
const SECONDS = /^\d{1,12}(?:\.\d{1,3})?$/;

/**
 * This function reads the count of a provider from the headers of an answer. `get` gives the value
 * of one header, for example `(name) => response.headers.get(name)` for a `fetch` answer, or
 * `(name) => reply.headers[name]` for a `Reply`. A value that is not a number is not read.
 *
 * @returns the reading, or undefined when no header has a value.
 * @beta
 */
export function readQuotaHeaders(
  get: (name: string) => string | null | undefined,
  names: QuotaHeaders,
  now: number,
): QuotaReading | undefined {
  const value = (name: string | undefined, form: RegExp): number | undefined => {
    if (name === undefined) return undefined;
    const text = get(name.toLowerCase())?.trim();
    return text !== undefined && form.test(text) ? Number(text) : undefined;
  };
  const remaining = value(names.remaining, COUNT);
  const at = value(names.resetAt, SECONDS);
  const after = value(names.resetAfter, SECONDS);
  const resetAt =
    after !== undefined ? now + after * 1000 : at === undefined ? undefined : at * 1000;
  if (remaining === undefined && resetAt === undefined) return undefined;
  return {
    ...(remaining === undefined ? {} : { remaining }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}
