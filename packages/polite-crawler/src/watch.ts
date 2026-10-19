import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StatementSync } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import type { DiffSummary } from "./diff.ts";
import { diffTexts } from "./diff.ts";
import { pastDeadline } from "./discover.ts";
import type { VersionText } from "./docs.ts";
import type { Duration } from "./duration.ts";
import { durationMs } from "./duration.ts";
import { sha256, stableStringify } from "./record.ts";
import type { CrawlRuntime, PageResult } from "./runtime.ts";
import { fetchPage, isHeldBack } from "./runtime.ts";
import { cacheKeyOf } from "./urls.ts";

/**
 * A watch list keeps the pages that the crawler checks again on a schedule. `watch.run` fetches the
 * pages that are due through the normal fetch, so each polite rule applies. It gives an event for
 * each page: new, changed, unchanged, gone, refused or error.
 *
 * These are the rules of a watch:
 *
 * - A watch compares the title, the text and the JSON-LD of the page with the last confirmed version.
 * - With `confirm: 2` (the default), a change is suspected when a check first sees it. The next
 *   check confirms it when it sees the same new version. A check that sees the earlier version
 *   again clears the suspicion, because one read can be a glitch. With `confirm: 1`, each check confirms.
 * - `every` has a floor of 1 hour by default. A check that a stop of the host refused is due again
 *   at the end of the stop, or later.
 * - The list is in `watch.sqlite` in the store, so it stays after a restart. A run claims each entry
 *   with a lease in that file, so two processes do not check one entry two times.
 *
 * A scheduler of the operator starts `watch.run`, or the daemon (`startDaemon`) starts it on a schedule.
 */

/** This value is the version of the schema of `watch.sqlite`. */
export const WATCH_SCHEMA = 1;

/** These are the defaults and the limits of the watch list. */
export const WATCH_LIMITS = {
  /** The shortest `every` of a watch by default: 1 hour, so a watch cannot hammer a site. */
  floorMs: 3_600_000,
  /** The default `every`: 24 hours. */
  everyMs: 86_400_000,
  /** The default time of one run: 10 minutes. No request starts after it. */
  budgetMs: 600_000,
  /** The default number of entries that one run checks. */
  maxPages: 100,
  /** The most hosts that get a check of one run at one time. */
  hostsAtOnce: 8,
  /** A run holds the lease of an entry until the end of its budget and this time more: 2 minutes. */
  leaseMs: 120_000,
} as const;

/** The kind of a check: the page is new, changed, unchanged or gone, or the check got no version. */
export type WatchKind = "new" | "changed" | "unchanged" | "gone" | "refused" | "error";

/** These options add a page to the watch list, or change its watch. */
export interface WatchOptions {
  /** This value is the time between two checks. The default is `24h`, and the floor is `1h` (`watchFloor`). */
  readonly every?: Duration | undefined;
  /** The value `auto` renders a page only when it shows almost nothing without JavaScript. */
  readonly render?: "auto" | "never" | "always" | undefined;
  /** These labels go into the capture records of each check. */
  readonly labels?: Readonly<Record<string, string>> | undefined;
  /** This label goes into the capture records of each check. */
  readonly scope?: string | undefined;
  /** These agents get their robots.txt rules applied to each check. */
  readonly onBehalfOf?: readonly string[] | undefined;
  /** This value is the number of checks that must see a change before it is confirmed. The default is 2. */
  readonly confirm?: 1 | 2 | undefined;
}

/** A change that one check saw, and that the next check can confirm. */
export interface WatchPending {
  /** This value is `changed`, `gone` or `new` (a page that came back). */
  readonly kind: "changed" | "gone" | "new";
  /** This id is the capture of the suspected version, or null for a page that is gone. */
  readonly capture: string | null;
  /** This time (ISO 8601) is the time of the check that first saw the change. */
  readonly since: string;
}

/** This is one entry of the watch list. */
export interface WatchEntry {
  /** This URL is the page that the watch fetches. */
  readonly url: string;
  /** This value is the time between two checks in milliseconds. */
  readonly every_ms: number;
  readonly render: "auto" | "never" | "always";
  readonly confirm: 1 | 2;
  readonly scope: string | null;
  readonly labels: Readonly<Record<string, string>> | null;
  readonly on_behalf_of: readonly string[];
  /** This time (ISO 8601) is the time of the first add. */
  readonly added_at: string;
  /** This time (ISO 8601) is the time when the entry is due. */
  readonly next_at: string;
  /** This time (ISO 8601) is the time of the last check, or null before the first check. */
  readonly checked_at: string | null;
  readonly last_kind: WatchKind | null;
  readonly last_note: string | null;
  /** This value counts the checks. */
  readonly checks: number;
  /** This value counts the confirmed changes. */
  readonly changes: number;
  /** This id is the document of the page. */
  readonly doc: string | null;
  /** This id is the capture of the last confirmed version, or null. */
  readonly capture: string | null;
  /** This time (ISO 8601) is the fetch time of the last confirmed version, or null. */
  readonly fetched_at: string | null;
  /** This value is true when the last confirmed state is that the page is gone. */
  readonly gone: boolean;
  /** This value is the change that the last check suspected, or null. */
  readonly pending: WatchPending | null;
  /** This time (ISO 8601) is the end of the lease of a run that checks the entry, or null. */
  readonly leased_until: string | null;
}

/** These options control a run of the watch list. */
export interface WatchRunOptions {
  /** This value is the longest time of the run in milliseconds. No request starts after it. The default is 10 minutes. */
  readonly budgetMs?: number | undefined;
  /** This value is the most entries that the run checks. The default is 100. */
  readonly maxPages?: number | undefined;
  /** When this signal aborts, the run stops the checks in progress and ends. */
  readonly signal?: AbortSignal | undefined;
  /**
   * When this signal aborts, the run starts no new check. The checks in progress end and write
   * their state, and the run stops with `cancelled`. The daemon uses it for a clean stop.
   */
  readonly drain?: AbortSignal | undefined;
}

/**
 * These options control `runWatch`: the options of a run, and the parts of `openCrawler`.
 *
 * @beta
 */
export interface WatchRunnerOptions extends WatchRunOptions {
  /** These agents get their robots.txt rules applied to each check, before the agents of the entry. */
  readonly onBehalfOf?: readonly string[] | undefined;
  /** This function operates before the first check. `openCrawler` waits there for the open of the store. */
  readonly ready?: (() => Promise<void>) | undefined;
}

/** This is the event of one check of a run. */
export interface WatchEvent {
  /** This URL is the page of the watch. */
  readonly url: string;
  readonly doc: string | null;
  readonly kind: WatchKind;
  /** This value is true when the check saw a change for the first time, and the next check must confirm it. */
  readonly suspected: boolean;
  /** This value is true when the check confirmed a change. Its version is then the last confirmed version. */
  readonly confirmed: boolean;
  /** This id is the capture that the check got, or null. */
  readonly capture: string | null;
  /** This time (ISO 8601) is the fetch time of that capture, or null. */
  readonly fetched_at: string | null;
  /** This id is the capture of the last confirmed version before the check, or null. */
  readonly previous: string | null;
  /** This time (ISO 8601) is the fetch time of that version, or null. */
  readonly previous_fetched_at: string | null;
  readonly outcome: string;
  readonly status: number;
  /** These are the counts of the diff from the last confirmed version, for a change. A held-back page gives null. */
  readonly diff: DiffSummary | null;
  /** This value is true when the page asked not to be AI input. */
  readonly held_back: boolean;
  /** This time (ISO 8601) is the time when the entry is due again. */
  readonly next_at: string;
  readonly note: string | null;
}

/** The reason that a run stopped. */
export type WatchStop = "done" | "max-pages" | "budget" | "cancelled" | "closed" | "error";

/** The summary of a run. */
export interface WatchSummary {
  /** This value counts the checks that gave an event. */
  readonly checked: number;
  readonly new: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly gone: number;
  readonly refused: number;
  readonly error: number;
  /** This value counts the changes that wait for the next check. */
  readonly suspected: number;
  /** This value counts the changes that the run confirmed. */
  readonly confirmed: number;
  /** This value counts the entries that are due at the end of the run. */
  readonly due: number;
  readonly stopped: WatchStop;
  /** This text tells why the run stopped. */
  readonly reason: string;
  /** This value is the time of the run in milliseconds, on the clock of the crawler. */
  readonly elapsed_ms: number;
}

/** A run in progress. A `for await` loop gets each event. `summary` resolves when the loop ends. */
export interface WatchRun extends AsyncIterable<WatchEvent> {
  readonly summary: Promise<WatchSummary>;
}

/** This is the watch list of `openCrawler`. Each method gives a promise, except `run`. */
export interface WatchList {
  /** This method adds a page, or changes the options of its watch. A new entry is due at once. */
  add(url: string, options?: WatchOptions): Promise<WatchEntry>;
  /** This method removes a page from the list. It gives false when the list does not have the page. */
  remove(url: string): Promise<boolean>;
  /** This method gives the entries, the first due first. */
  list(): Promise<WatchEntry[]>;
  /** This method checks the entries that are due, to a budget. A `for await` loop gets each event. */
  run(options?: WatchRunOptions): WatchRun;
}

/**
 * These options open a watch store.
 *
 * @beta
 */
export interface WatchStoreOptions {
  /** This value is the time in milliseconds that a step waits for the lock of a different process. The default is 10 seconds. */
  readonly busyTimeoutMs?: number | undefined;
  /** This value is the shortest `every` in milliseconds. The default is 1 hour. */
  readonly floorMs?: number | undefined;
}

/**
 * This is a row of the table of the watch list, as `WatchStore` reads it.
 *
 * @beta
 */
export interface WatchRow {
  url: string;
  target: string;
  host: string;
  every_ms: number;
  render: string;
  confirm: number;
  scope: string | null;
  labels: string | null;
  on_behalf_of: string | null;
  added_at: number;
  next_at: number;
  lease_until: number;
  lease_owner: string | null;
  checks: number;
  changes: number;
  last_at: number | null;
  last_kind: string | null;
  last_note: string | null;
  doc: string | null;
  base_state: string | null;
  base_sha: string | null;
  base_capture: string | null;
  base_fetched_at: string | null;
  pend_state: string | null;
  pend_sha: string | null;
  pend_capture: string | null;
  pend_fetched_at: string | null;
  pend_since: number | null;
}

/**
 * The state of a page after a check: what a later check compares.
 *
 * @beta
 */
export interface WatchState {
  readonly state: "present" | "gone";
  readonly sha: string | null;
  readonly capture: string | null;
  readonly fetched_at: string | null;
}

/**
 * This is the change of an entry after a check.
 *
 * @beta
 */
export interface WatchUpdate {
  readonly next_at: number;
  readonly last_at: number;
  readonly last_kind: WatchKind;
  readonly last_note: string | null;
  readonly changed: boolean;
  readonly doc: string | null;
  /** The new confirmed state, or undefined when it stays. */
  readonly base?: WatchState | undefined;
  /** The new suspected state, null to clear it, or undefined when it stays. */
  readonly pending?: (WatchState & { readonly since: number }) | null | undefined;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const parseJson = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const RENDERS: ReadonlySet<string> = new Set(["auto", "never", "always"]);

const entryOf = (row: WatchRow, now: number): WatchEntry => ({
  url: row.target,
  every_ms: row.every_ms,
  render: row.render as WatchEntry["render"],
  confirm: row.confirm === 1 ? 1 : 2,
  scope: row.scope,
  labels: parseJson<Record<string, string> | null>(row.labels, null),
  on_behalf_of: parseJson<string[]>(row.on_behalf_of, []),
  added_at: iso(row.added_at),
  next_at: iso(row.next_at),
  checked_at: row.last_at === null ? null : iso(row.last_at),
  last_kind: row.last_kind as WatchKind | null,
  last_note: row.last_note,
  checks: row.checks,
  changes: row.changes,
  doc: row.doc,
  capture: row.base_capture,
  fetched_at: row.base_fetched_at,
  gone: row.base_state === "gone",
  pending:
    row.pend_state === null
      ? null
      : {
          kind: row.pend_state === "gone" ? "gone" : row.base_state === "gone" ? "new" : "changed",
          capture: row.pend_capture,
          since: iso(row.pend_since ?? row.last_at ?? row.added_at),
        },
  leased_until: row.lease_until > now ? iso(row.lease_until) : null,
});

/** This function gives the canonical key, the URL and the host of a page to watch. A URL that is not http(s) throws a `RangeError`. */
const targetOf = (
  url: string,
): { readonly key: string; readonly target: string; readonly host: string } => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RangeError(`not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new RangeError(`a watch needs an http or https URL, not ${url}`);
  parsed.hash = "";
  return { key: cacheKeyOf(parsed.href), target: parsed.href, host: parsed.host.toLowerCase() };
};

/**
 * This store keeps the watch list in a SQLite file (`watch.sqlite`). Two or more processes on one
 * store share it. Each step is one transaction (`BEGIN IMMEDIATE`), and it waits for the lock of a
 * different process (`busy_timeout`).
 *
 * The list is the decision of the operator, not a projection of the capture log. Thus it has its
 * own file: a deletion of `hosts.sqlite` or of the index does not lose it.
 *
 * @beta
 */
export class WatchStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;
  /** This value is the shortest `every` in milliseconds. */
  readonly floorMs: number;

  constructor(
    readonly path: string,
    options: WatchStoreOptions = {},
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const floor = options.floorMs ?? WATCH_LIMITS.floorMs;
    if (!Number.isFinite(floor) || floor < 0)
      throw new RangeError(
        `the floor of every must be 0 or more milliseconds, not ${String(floor)}`,
      );
    this.floorMs = floor;
    this.db = new DatabaseSync(path);
    const wait = Math.max(0, Math.floor(options.busyTimeoutMs ?? 10_000));
    this.db.exec(`PRAGMA busy_timeout = ${String(wait)};`);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.step(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS watches (
        url TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        host TEXT NOT NULL,
        every_ms REAL NOT NULL,
        render TEXT NOT NULL,
        confirm INTEGER NOT NULL,
        scope TEXT,
        labels TEXT,
        on_behalf_of TEXT,
        added_at REAL NOT NULL,
        next_at REAL NOT NULL,
        lease_until REAL NOT NULL DEFAULT 0,
        lease_owner TEXT,
        checks INTEGER NOT NULL DEFAULT 0,
        changes INTEGER NOT NULL DEFAULT 0,
        last_at REAL,
        last_kind TEXT,
        last_note TEXT,
        doc TEXT,
        base_state TEXT,
        base_sha TEXT,
        base_capture TEXT,
        base_fetched_at TEXT,
        pend_state TEXT,
        pend_sha TEXT,
        pend_capture TEXT,
        pend_fetched_at TEXT,
        pend_since REAL
      )`);
      this.db.exec("CREATE INDEX IF NOT EXISTS watches_due ON watches (next_at)");
      const { user_version: version } = this.db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (version < WATCH_SCHEMA) this.db.exec(`PRAGMA user_version = ${String(WATCH_SCHEMA)}`);
    });
  }

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** This method does one step in one transaction. */
  private step<T>(work: () => T): T {
    if (this.closed) throw new Error("the watch store is closed");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private row(key: string): WatchRow | undefined {
    return this.stmt("SELECT * FROM watches WHERE url = ?").get(key) as WatchRow | undefined;
  }

  /**
   * This method adds a page, or changes the options of its watch and keeps its state. A new entry
   * is due at once. A changed entry is due one `every` after its last check. A bad option throws
   * a `RangeError`.
   */
  add(url: string, options: WatchOptions, now: number): WatchEntry {
    const { key, target, host } = targetOf(url);
    const every = options.every === undefined ? WATCH_LIMITS.everyMs : durationMs(options.every);
    if (every < this.floorMs) {
      throw new RangeError(
        `every must be ${String(this.floorMs / 60_000)} minutes or more, so a watch cannot hammer a site, not ${String(every / 60_000)} minutes`,
      );
    }
    const render = options.render ?? "auto";
    if (!RENDERS.has(render))
      throw new RangeError(`render is auto, never or always, not ${JSON.stringify(render)}`);
    const confirm = options.confirm ?? 2;
    if (confirm !== 1 && confirm !== 2)
      throw new RangeError(`confirm is 1 or 2, not ${JSON.stringify(confirm)}`);
    const labels =
      options.labels === undefined || Object.keys(options.labels).length === 0
        ? null
        : JSON.stringify(options.labels);
    const agents =
      options.onBehalfOf === undefined || options.onBehalfOf.length === 0
        ? null
        : JSON.stringify([...options.onBehalfOf]);
    return this.step(() => {
      this.stmt(
        `INSERT INTO watches (url, target, host, every_ms, render, confirm, scope, labels, on_behalf_of, added_at, next_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET target = excluded.target, host = excluded.host,
           every_ms = excluded.every_ms, render = excluded.render, confirm = excluded.confirm,
           scope = excluded.scope, labels = excluded.labels, on_behalf_of = excluded.on_behalf_of,
           next_at = CASE WHEN watches.last_at IS NULL THEN watches.next_at
                          ELSE watches.last_at + excluded.every_ms END`,
      ).run(
        key,
        target,
        host,
        every,
        render,
        confirm,
        options.scope ?? null,
        labels,
        agents,
        now,
        now,
      );
      return entryOf(this.row(key)!, now);
    });
  }

  /** This method removes a page. It gives false when the list does not have the page. */
  remove(url: string): boolean {
    const { key } = targetOf(url);
    return this.step(
      () => Number(this.stmt("DELETE FROM watches WHERE url = ?").run(key).changes) > 0,
    );
  }

  /** This method gives the entry of a page, or undefined. */
  get(url: string, now: number): WatchEntry | undefined {
    if (this.closed) throw new Error("the watch store is closed");
    const row = this.row(targetOf(url).key);
    return row === undefined ? undefined : entryOf(row, now);
  }

  /** This method gives the entries, the first due first. */
  list(now: number): WatchEntry[] {
    if (this.closed) throw new Error("the watch store is closed");
    return (
      this.stmt("SELECT * FROM watches ORDER BY next_at, url").all() as unknown as WatchRow[]
    ).map((row) => entryOf(row, now));
  }

  /** This method counts the entries that are due at a time. */
  due(now: number): number {
    if (this.closed) throw new Error("the watch store is closed");
    return (
      this.stmt("SELECT count(*) AS n FROM watches WHERE next_at <= ?").get(now) as { n: number }
    ).n;
  }

  /**
   * This method claims the first due entry with no lease, on a host that is not in `busy`. The
   * lease of `owner` holds until `until`. Thus two processes do not get one entry at one time.
   */
  claim(now: number, owner: string, until: number, busy: readonly string[]): WatchRow | undefined {
    return this.step(() => {
      const row = this.stmt(
        `SELECT * FROM watches WHERE next_at <= ? AND lease_until <= ?
           AND host NOT IN (SELECT value FROM json_each(?)) ORDER BY next_at, url LIMIT 1`,
      ).get(now, now, JSON.stringify(busy)) as WatchRow | undefined;
      if (row === undefined) return undefined;
      this.stmt("UPDATE watches SET lease_until = ?, lease_owner = ? WHERE url = ?").run(
        until,
        owner,
        row.url,
      );
      return { ...row, lease_until: until, lease_owner: owner };
    });
  }

  /** This method ends the lease of `owner` and changes nothing else, so the entry stays due. A closed store does nothing. */
  release(key: string, owner: string): void {
    if (this.closed) return;
    this.step(() => {
      this.stmt(
        "UPDATE watches SET lease_until = 0, lease_owner = NULL WHERE url = ? AND lease_owner = ?",
      ).run(key, owner);
    });
  }

  /**
   * This method writes the result of a check and ends the lease. It gives false when `owner` does
   * not hold the lease, or when the store is closed.
   */
  settle(key: string, owner: string, update: WatchUpdate): boolean {
    if (this.closed) return false;
    return this.step(() => {
      const row = this.row(key);
      if (row === undefined || row.lease_owner !== owner) return false;
      const base = update.base;
      const pending = update.pending;
      this.stmt(
        `UPDATE watches SET lease_until = 0, lease_owner = NULL, next_at = ?, last_at = ?, last_kind = ?,
           last_note = ?, checks = checks + 1, changes = changes + ?, doc = ?,
           base_state = ?, base_sha = ?, base_capture = ?, base_fetched_at = ?,
           pend_state = ?, pend_sha = ?, pend_capture = ?, pend_fetched_at = ?, pend_since = ?
         WHERE url = ?`,
      ).run(
        update.next_at,
        update.last_at,
        update.last_kind,
        update.last_note,
        update.changed ? 1 : 0,
        update.doc ?? row.doc,
        base === undefined ? row.base_state : base.state,
        base === undefined ? row.base_sha : base.sha,
        base === undefined ? row.base_capture : base.capture,
        base === undefined ? row.base_fetched_at : base.fetched_at,
        pending === undefined ? row.pend_state : (pending?.state ?? null),
        pending === undefined ? row.pend_sha : (pending?.sha ?? null),
        pending === undefined ? row.pend_capture : (pending?.capture ?? null),
        pending === undefined ? row.pend_fetched_at : (pending?.fetched_at ?? null),
        pending === undefined ? row.pend_since : (pending?.since ?? null),
        key,
      );
      return true;
    });
  }

  /** This method closes the file. A second close does nothing. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }
}

/** The outcomes of a check that the site or the crawler refused. */
const REFUSALS: ReadonlySet<string> = new Set([
  "skipped",
  "blocked",
  "challenge",
  "payment-required",
]);

/** This function gives the fingerprint of a version: a hash of its title, its text and its JSON-LD. */
export const watchFingerprint = (version: VersionText): string =>
  sha256(stableStringify([version.title, version.text, version.meta["jsonld"] ?? null]));

const sameState = (a: WatchState | undefined, b: WatchState): boolean =>
  a !== undefined && a.state === b.state && (a.state === "gone" || a.sha === b.sha);

/** One check that ended: an event, or an entry that stays due because the run stopped first. */
type Done =
  | { readonly kind: "event"; readonly host: string; readonly event: WatchEvent }
  | { readonly kind: "deferred"; readonly host: string; readonly stop: WatchStop | undefined };

/**
 * This function checks the entries of a watch store that are due. `PoliteCrawler.watch.run` uses
 * it. Each check is a fetch of the page with `fetchPage`, with no stored copy (`maxAgeMs: 0`), so
 * each polite rule applies. A check that the budget stops before its request stays due. The store
 * can be a function that opens it: the run uses it before the first check.
 *
 * @beta
 */
export const runWatch = (
  runtime: CrawlRuntime,
  source: WatchStore | (() => Promise<WatchStore>),
  options: WatchRunnerOptions = {},
): WatchRun => {
  let resolveSummary: (summary: WatchSummary) => void = () => undefined;
  const summary = new Promise<WatchSummary>((resolve) => {
    resolveSummary = resolve;
  });
  let used = false;

  async function* events(): AsyncGenerator<WatchEvent, void, undefined> {
    const now = (): number => Date.parse(runtime.now());
    const startedAt = now();
    const owner = randomUUID();
    const abort = new AbortController();
    const outer = options.signal;
    const cancel = (): void => abort.abort(outer?.reason);
    if (outer?.aborted === true) cancel();
    outer?.addEventListener("abort", cancel, { once: true });
    const inflight = new Map<string, Promise<Done>>();
    const counts = {
      checked: 0,
      new: 0,
      changed: 0,
      unchanged: 0,
      gone: 0,
      refused: 0,
      error: 0,
      suspected: 0,
      confirmed: 0,
    };
    let started = 0;
    let stopping: WatchStop | undefined;
    let reason: string | undefined;
    let finished = false;
    let budgetMs: number = WATCH_LIMITS.budgetMs;
    let maxPages: number = WATCH_LIMITS.maxPages;
    let opened: WatchStore | undefined;

    /** This function fetches one entry, compares it with its state, and writes the new state. */
    const check = async (store: WatchStore, row: WatchRow, deadline: number): Promise<Done> => {
      const agents = [...(options.onBehalfOf ?? []), ...parseJson<string[]>(row.on_behalf_of, [])];
      const labels = parseJson<Record<string, string> | undefined>(row.labels, undefined);
      let page: PageResult | undefined;
      let failure: string | undefined;
      try {
        page = await fetchPage(runtime, row.target, {
          render: row.render as "auto" | "never" | "always",
          maxAgeMs: 0,
          onBehalfOf: agents,
          signal: abort.signal,
          scope: row.scope ?? undefined,
          labels,
          deadline,
        });
      } catch (error) {
        failure = `watch error: ${error instanceof Error ? error.message : String(error)}`;
      }
      const deferred = (stop: WatchStop | undefined): Done => {
        store.release(row.url, owner);
        return { kind: "deferred", host: row.host, stop };
      };
      if (abort.signal.aborted) return deferred("cancelled");
      if (page !== undefined && pastDeadline(page.note)) return deferred("budget");
      if (page?.outcome === "skipped" && page.note === "crawler closed") return deferred("closed");
      const at = now();
      const base: WatchState | undefined =
        row.base_state === null
          ? undefined
          : {
              state: row.base_state as WatchState["state"],
              sha: row.base_sha,
              capture: row.base_capture,
              fetched_at: row.base_fetched_at,
            };
      const pending: WatchState | undefined =
        row.pend_state === null
          ? undefined
          : {
              state: row.pend_state as WatchState["state"],
              sha: row.pend_sha,
              capture: row.pend_capture,
              fetched_at: row.pend_fetched_at,
            };
      let seen: WatchState | undefined;
      let version: VersionText | undefined;
      let held = false;
      let kind: WatchKind;
      let note: string | null = page?.note ?? failure ?? null;
      const ok = page !== undefined && (page.outcome === "ok" || page.outcome === "not-modified");
      if (page !== undefined && ok && page.doc !== null && page.capture !== null) {
        version = runtime.index.versionText(page.doc, page.capture);
        const doc = runtime.index.get(page.doc);
        held =
          (doc !== undefined && isHeldBack(doc)) || (version !== undefined && isHeldBack(version));
        if (version !== undefined) {
          seen = {
            state: "present",
            sha: watchFingerprint(version),
            capture: version.capture,
            fetched_at: version.fetched_at,
          };
        }
      } else if (page?.outcome === "not-found") {
        seen = { state: "gone", sha: null, capture: null, fetched_at: page.fetched_at };
      }
      let update: Omit<WatchUpdate, "next_at" | "last_at" | "last_kind" | "last_note" | "doc">;
      let suspected = false;
      let confirmed = false;
      if (seen === undefined) {
        kind = page !== undefined && REFUSALS.has(page.outcome) ? "refused" : "error";
        if (ok) note = note ?? "the page gave no document, so the watch cannot compare it";
        update = { changed: false };
      } else if (base === undefined) {
        // the first version that a watch sees is not a change: it is the start
        kind = seen.state === "gone" ? "gone" : "new";
        update = { changed: false, base: seen, pending: null };
      } else if (sameState(base, seen)) {
        kind = "unchanged";
        if (pending !== undefined)
          note =
            "the change that the last check saw did not repeat, so the watch takes it for a glitch";
        update = { changed: false, pending: null };
      } else {
        kind = seen.state === "gone" ? "gone" : base.state === "gone" ? "new" : "changed";
        // a second check of the same new version confirms it, and a stored copy is not a second check
        const repeated =
          sameState(pending, seen) && (seen.state === "gone" || pending?.capture !== seen.capture);
        if (row.confirm === 1 || repeated) {
          confirmed = true;
          update = { changed: true, base: seen, pending: null };
        } else {
          suspected = true;
          note =
            pending === undefined
              ? "the watch saw this change one time: the next check confirms it when it sees the same version"
              : "the watch saw a different change than the last check: the next check confirms it when it sees the same version";
          update = { changed: false, pending: { ...seen, since: at } };
        }
      }
      let diff: DiffSummary | null = null;
      if (
        kind === "changed" &&
        base?.state === "present" &&
        base.capture !== null &&
        version !== undefined &&
        !held
      ) {
        const docId = row.doc ?? version.doc;
        const before = runtime.index.versionText(docId, base.capture);
        if (before !== undefined && !isHeldBack(before)) {
          diff = diffTexts(
            { text: before.text, fields: { title: before.title, meta: before.meta } },
            { text: version.text, fields: { title: version.title, meta: version.meta } },
          ).summary;
        }
      }
      // a stopped host is due at the end of its stop, or later
      let next = at + row.every_ms;
      const stop = runtime.crawler.hostStop(row.target);
      if (stop !== undefined && Number.isFinite(stop.until) && stop.until > next) next = stop.until;
      store.settle(row.url, owner, {
        ...update,
        next_at: next,
        last_at: at,
        last_kind: kind,
        last_note: note,
        doc: page?.doc ?? null,
      });
      const event: WatchEvent = {
        url: row.target,
        doc: page?.doc ?? row.doc,
        kind,
        suspected,
        confirmed,
        capture: seen?.capture ?? null,
        fetched_at: seen?.fetched_at ?? null,
        previous: base?.capture ?? null,
        previous_fetched_at: base?.fetched_at ?? null,
        outcome: page?.outcome ?? "error",
        status: page?.status ?? 0,
        diff,
        held_back: held,
        next_at: iso(next),
        note,
      };
      return { kind: "event", host: row.host, event };
    };

    try {
      const store = typeof source === "function" ? await source() : source;
      opened = store;
      await options.ready?.();
      budgetMs = options.budgetMs ?? WATCH_LIMITS.budgetMs;
      if (!(budgetMs >= 0))
        throw new RangeError(`budgetMs must be 0 or more, not ${String(budgetMs)}`);
      maxPages = options.maxPages ?? WATCH_LIMITS.maxPages;
      if (!Number.isInteger(maxPages) || maxPages < 1)
        throw new RangeError(`maxPages must be an integer of 1 or more, not ${String(maxPages)}`);
      const deadline = startedAt + budgetMs;
      for (;;) {
        if (stopping === undefined && abort.signal.aborted) stopping = "cancelled";
        if (stopping === undefined && options.drain?.aborted === true) {
          // a drain starts no new check, and the checks in progress end with their state
          stopping = "cancelled";
          reason = "the run stopped for a shutdown: the checks in progress ended first";
        }
        if (stopping === undefined && now() >= deadline) stopping = "budget";
        while (
          stopping === undefined &&
          inflight.size < WATCH_LIMITS.hostsAtOnce &&
          started < maxPages
        ) {
          const claimed = store.claim(
            now(),
            owner,
            Math.max(now(), deadline) + WATCH_LIMITS.leaseMs,
            [...inflight.keys()],
          );
          if (claimed === undefined) break;
          started += 1;
          inflight.set(claimed.host, check(store, claimed, deadline));
        }
        if (inflight.size === 0) break;
        const done = await Promise.race(inflight.values());
        inflight.delete(done.host);
        if (done.kind === "deferred") {
          started -= 1;
          stopping ??= done.stop;
          continue;
        }
        const event = done.event;
        counts.checked += 1;
        counts[event.kind] += 1;
        if (event.suspected) counts.suspected += 1;
        if (event.confirmed) counts.confirmed += 1;
        yield event;
      }
      stopping ??= started >= maxPages && store.due(now()) > 0 ? "max-pages" : "done";
      finished = true;
    } catch (error) {
      stopping = "error";
      reason = error instanceof Error ? error.message : String(error);
      finished = true;
      throw error;
    } finally {
      // a loop that stopped early (a break) cancels the run
      if (!finished) {
        stopping ??= "cancelled";
        reason ??= "the caller stopped the loop";
      }
      outer?.removeEventListener("abort", cancel);
      abort.abort(new Error("the watch run ended"));
      // the checks in progress end, write their state or release their lease, before the summary
      await Promise.allSettled(inflight.values());
      const stop = stopping ?? "done";
      reason ??=
        stop === "done"
          ? "the run checked each entry that was due"
          : stop === "max-pages"
            ? `the run checked ${String(maxPages)} entries, its limit (maxPages)`
            : stop === "budget"
              ? `the budget of ${String(budgetMs)} ms ended (budgetMs)`
              : stop === "cancelled"
                ? "the caller cancelled the run"
                : "the crawler closed";
      let due = 0;
      try {
        due = opened?.due(now()) ?? 0;
      } catch {
        // a closed store has no count
      }
      resolveSummary({
        ...counts,
        due,
        stopped: stop,
        reason,
        elapsed_ms: Math.max(0, now() - startedAt),
      });
    }
  }

  return {
    summary,
    [Symbol.asyncIterator]() {
      if (used) throw new Error("a watch run operates one time: call run again for a new run");
      used = true;
      return events();
    },
  };
};
