/**
 * Kept answers. A client keeps the last full answer of a GET with its validators. The next GET of
 * the same key is then a conditional request (RFC 9110 §13.1). An answer 304 then gives the kept
 * answer with the fields of the 304 (RFC 9111 §4.3.4). Some APIs with a rate limit do not count a
 * 304, for example the REST API of GitHub. The store is data, so a client can keep it between two
 * runs. The server examines each validator, so a kept answer goes to the client only after the
 * server tells that it is current. The module imports no Node.js module.
 */

/**
 * The kept answer of one key.
 *
 * @beta
 */
export interface Kept {
  /** This value is the `ETag` header of the answer, when it had one. */
  readonly etag?: string | undefined;
  /** This value is the `Last-Modified` header of the answer, when it had one. */
  readonly lastModified?: string | undefined;
  /** This value is the status of the answer: 200, 203 or 204 (`KEPT_STATUSES`). */
  readonly status: number;
  /** These values are the headers that the store keeps, by name in lowercase. */
  readonly headers: Readonly<Record<string, string>>;
  /** This value is the body of the answer, as text. */
  readonly body: string;
}

/**
 * A store of kept answers, by key. A `Map` is a store in memory. `keptStore` also records the
 * entries that a run uses.
 *
 * @beta
 */
export interface KeptStore {
  /** This function gives the kept answer of the key, or undefined when the store has none. */
  get(key: string): Kept | undefined;
  /** This function keeps the answer under the key, in place of an earlier one. */
  set(key: string, kept: Kept): void;
}

/**
 * An answer as a client reads it: its status, its headers by name in lowercase, and its body.
 *
 * @beta
 */
export interface KeptAnswer {
  /** The status of the answer. After a 304, it is the status of the kept answer. */
  readonly status: number;
  /** The headers of the answer, by name in lowercase. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body of the answer as text. After a 304, it is the kept body. */
  readonly body: string;
  /** This value is true when the server answered 304 and the answer is the kept answer. */
  readonly notModified: boolean;
}

/**
 * The options of `keepAnswer`.
 *
 * @beta
 */
export interface KeepOptions {
  /** These names are the headers that a kept answer keeps. The default is `KEPT_HEADERS`. */
  readonly headers?: readonly string[] | undefined;
  /**
   * This value is the largest body that the store keeps, in UTF-16 code units. The default is
   * `KEPT_BODY_MAX`.
   */
  readonly maxBody?: number | undefined;
}

/**
 * The headers that a kept answer keeps when the options give no list. `link` keeps the next page
 * of a list.
 *
 * @beta
 */
export const KEPT_HEADERS: readonly string[] = ["content-type", "etag", "last-modified", "link"];

/**
 * The largest body that a store keeps when the options give no limit: 1,048,576 UTF-16 code units.
 *
 * @beta
 */
export const KEPT_BODY_MAX: number = 1_048_576;

/**
 * The statuses that a store keeps. The body of each is the full answer. A 206 has only a part of
 * the body, so a store does not keep it.
 *
 * @beta
 */
export const KEPT_STATUSES: readonly number[] = [200, 203, 204];

/** These fields of a 304 tell of its empty body, so they do not go into the kept answer. */
const BODY_FIELDS: ReadonlySet<string> = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);

/** A body of one of these media types is text, so a store can keep it as text. */
const TEXT_TYPE = /^\s*(?:text\/[\w.+-]+|application\/(?:[\w.-]+\+)?(?:json|xml))\s*(?:;|$)/i;

/** This pattern finds the charset parameter of a media type. */
const CHARSET = /;\s*charset\s*=\s*"?([^";\s]+)"?/i;

/** This function gives the headers with each name in lowercase. */
const lower = (headers: Readonly<Record<string, string>>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
};

/**
 * This function tells if the headers of a request make it conditional or partial on their own:
 * `If-None-Match`, `If-Modified-Since`, `If-Match`, `If-Unmodified-Since`, `If-Range` or
 * `Range`. The client of such a request reads the answer itself, so a store does not answer for
 * it.
 *
 * @beta
 */
export function hasValidator(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some((name) => {
    const n = name.toLowerCase();
    return n === "range" || n.startsWith("if-");
  });
}

/**
 * This function tells if a body of a media type is text in UTF-8. That is a text, JSON or XML type
 * with no charset or with the charset UTF-8. A store keeps only such a body, because `text()` of
 * `fetch` reads a body as UTF-8.
 *
 * @beta
 */
export function isTextType(contentType: string | undefined): boolean {
  const type = contentType ?? "";
  if (!TEXT_TYPE.test(type)) return false;
  const charset = CHARSET.exec(type)?.[1];
  return charset === undefined || /^utf-?8$/i.test(charset);
}

/**
 * This function gives the key of a request in a store: its `accept` header and its URL. A
 * different `accept` header can give a different body, so it gets a different key.
 *
 * @beta
 */
export function keptKey(url: string, headers: Readonly<Record<string, string>>): string {
  return `${lower(headers)["accept"] ?? ""} ${url}`;
}

/**
 * This function gives the headers of a conditional request: the headers of the request, and the
 * validators of the kept answer. `If-None-Match` sends its ETag, and `If-Modified-Since` sends its
 * date. The function adds no header to a request that has a validator of its own.
 *
 * @beta
 */
export function keptRequestHeaders(
  kept: Kept | undefined,
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = { ...headers };
  if (kept === undefined || hasValidator(headers)) return out;
  if (kept.etag !== undefined) out["if-none-match"] = kept.etag;
  if (kept.lastModified !== undefined) out["if-modified-since"] = kept.lastModified;
  return out;
}

/**
 * This function gives the answer that a client reads, and changes the store.
 *
 * - A 304 for a key with a kept answer gives the kept answer. Its headers get the fields of the
 *   304, as RFC 9111 §4.3.4 tells, and the store keeps the new values of its kept headers.
 * - An answer with a status of `KEPT_STATUSES` and an ETag or a date goes into the store. It needs
 *   a text type in UTF-8 and a body in the limit.
 * - Each other answer is as it is, and the store does not change.
 *
 * @beta
 */
export function keepAnswer(
  store: KeptStore,
  key: string,
  answer: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
  options: KeepOptions = {},
): KeptAnswer {
  const names = new Set((options.headers ?? KEPT_HEADERS).map((name) => name.toLowerCase()));
  const headers = lower(answer.headers);
  const kept = store.get(key);
  if (answer.status === 304 && kept !== undefined) {
    const read: Record<string, string> = { ...kept.headers };
    const keep: Record<string, string> = { ...kept.headers };
    for (const [name, value] of Object.entries(headers)) {
      if (BODY_FIELDS.has(name)) continue;
      read[name] = value;
      if (names.has(name)) keep[name] = value;
    }
    store.set(key, {
      ...kept,
      etag: headers["etag"] ?? kept.etag,
      lastModified: headers["last-modified"] ?? kept.lastModified,
      headers: keep,
    });
    return { status: kept.status, headers: read, body: kept.body, notModified: true };
  }
  const etag = headers["etag"];
  const lastModified = headers["last-modified"];
  if (
    KEPT_STATUSES.includes(answer.status) &&
    (etag !== undefined || lastModified !== undefined) &&
    isTextType(headers["content-type"]) &&
    answer.body.length <= (options.maxBody ?? KEPT_BODY_MAX)
  ) {
    const keep: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) if (names.has(name)) keep[name] = value;
    store.set(key, { etag, lastModified, status: answer.status, headers: keep, body: answer.body });
  }
  return { status: answer.status, headers, body: answer.body, notModified: false };
}

/**
 * A store of kept answers in memory that records which entries a run uses.
 *
 * @beta
 */
export interface KeptMemory extends KeptStore {
  /**
   * This function gives each entry that a `get` found or a `set` wrote, in the order of the first
   * use. A client that saves only these entries keeps no answer that it does not ask for again.
   */
  used(): [string, Kept][];
}

/**
 * This function makes a store of kept answers in memory, with the entries of an earlier run.
 *
 * @beta
 */
export function keptStore(entries: Iterable<readonly [string, Kept]> = []): KeptMemory {
  const all = new Map<string, Kept>(entries);
  const used = new Set<string>();
  return {
    get(key) {
      const kept = all.get(key);
      if (kept !== undefined) used.add(key);
      return kept;
    },
    set(key, kept) {
      all.set(key, kept);
      used.add(key);
    },
    used: () =>
      [...used].flatMap((key): [string, Kept][] => {
        const kept = all.get(key);
        return kept === undefined ? [] : [[key, kept]];
      }),
  };
}

/** This function gives a kept answer from data, or null when the data does not have its shape. */
const keptOf = (value: unknown): Kept | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { etag, lastModified, status, headers, body } = value as Record<string, unknown>;
  if (typeof status !== "number" || !KEPT_STATUSES.includes(status)) return null;
  if (typeof body !== "string") return null;
  if (etag !== undefined && typeof etag !== "string") return null;
  if (lastModified !== undefined && typeof lastModified !== "string") return null;
  if (etag === undefined && lastModified === undefined) return null;
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return null;
  const read: Record<string, string> = {};
  for (const [name, field] of Object.entries(headers)) {
    if (typeof field !== "string") return null;
    read[name.toLowerCase()] = field;
  }
  return {
    etag: typeof etag === "string" ? etag : undefined,
    lastModified: typeof lastModified === "string" ? lastModified : undefined,
    status,
    headers: read,
    body,
  };
};

/**
 * This function reads the entries of a store from data, for example from the JSON of the `used`
 * entries of an earlier run. It keeps each entry with a correct shape and drops each other entry.
 * Thus damaged data gives fewer kept answers and no error.
 *
 * @beta
 */
export function readKept(data: unknown): [string, Kept][] {
  if (!Array.isArray(data)) return [];
  const out: [string, Kept][] = [];
  for (const entry of data) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") continue;
    const kept = keptOf(entry[1]);
    if (kept !== null) out.push([entry[0], kept]);
  }
  return out;
}
