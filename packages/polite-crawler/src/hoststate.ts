import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Migration } from "@mark1russell7/sqlite";
import { migrate, openDatabase, transaction } from "@mark1russell7/sqlite";
import type {
  HostCounts,
  HostResult,
  HostStateStore,
  HostStop,
  QuotaRecord,
  QuotaStore,
  ValidatorMemo,
  ValidatorReport,
  ValidatorVerdict,
} from "./politeness.ts";
import { nextValidatorMemo } from "./politeness.ts";

/** A stop with no end goes into the table as this value, which is past each date that JavaScript can hold. */
const NO_END = 9e15;
/** A process that shares the store asks again after this wait, at most, during the lease of a different process. */
const SHARED_WAIT_MS = 1000;
/** The store removes the rows of idle hosts after this many reservations. */
const SWEEP_EVERY = 1000;
/**
 * These are the steps of the schema of the file, for `migrate` of `@mark1russell7/sqlite`. The
 * version of a file (`PRAGMA user_version`) is the count of its steps. Do not change a step: add a step.
 */
const MIGRATIONS: readonly Migration[] = [
  // Step 1 makes the tables of version 1. A file of version 0.1.0 (version 0) has the table
  // `hosts` already, so the step keeps it and adds the table `validators`.
  `CREATE TABLE IF NOT EXISTS hosts (
    host TEXT PRIMARY KEY,
    next_at REAL NOT NULL DEFAULT 0,
    leased_until REAL NOT NULL DEFAULT 0,
    owner TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    waits INTEGER NOT NULL DEFAULT 0,
    stop_until REAL,
    stop_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS validators (
    host TEXT PRIMARY KEY,
    skip_etag INTEGER NOT NULL DEFAULT 0,
    etag TEXT NOT NULL DEFAULT 'unknown',
    last_modified TEXT NOT NULL DEFAULT 'unknown',
    etag_misses INTEGER NOT NULL DEFAULT 0,
    date_misses INTEGER NOT NULL DEFAULT 0,
    since_probe INTEGER NOT NULL DEFAULT 0,
    changed_at REAL NOT NULL DEFAULT 0
  )`,
  // Step 2 (0.6.3) adds the record of each quota and key, as JSON (`QuotaRecord`).
  `CREATE TABLE IF NOT EXISTS quotas (
    quota TEXT NOT NULL,
    key TEXT NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (quota, key)
  )`,
];

/**
 * This value is the version of the schema of the file (`PRAGMA user_version`). Version 0 (0.1.0)
 * has the table `hosts`. Version 1 adds the table `validators`, and it reads a file of version 0.
 * Version 2 (0.6.3) adds the table `quotas`.
 */
export const HOST_STATE_SCHEMA: number = MIGRATIONS.length;

interface MemoRow {
  skip_etag: number;
  etag: string;
  last_modified: string;
  etag_misses: number;
  date_misses: number;
  since_probe: number;
  changed_at: number;
}

const verdictOf = (value: string): ValidatorVerdict =>
  value === "works" || value === "fails" ? value : "unknown";

const memoOf = (row: MemoRow): ValidatorMemo => ({
  skipEtag: row.skip_etag === 1,
  etag: verdictOf(row.etag),
  lastModified: verdictOf(row.last_modified),
  etagMisses: row.etag_misses,
  dateMisses: row.date_misses,
  sinceProbe: row.since_probe,
  changedAt: row.changed_at,
});

interface Row {
  next_at: number;
  leased_until: number;
  owner: string | null;
  failures: number;
  waits: number;
  stop_until: number | null;
  stop_reason: string | null;
}

/**
 * These options change a SQLite host state store.
 *
 * @beta
 */
export interface SqliteHostStateOptions {
  /** This value is the time in milliseconds that a step waits for the lock of a different process. The default is 10 seconds. */
  readonly busyTimeoutMs?: number | undefined;
  /** During the lease of a different process, a request asks again after this wait at most. The default is 1 second. */
  readonly pollMs?: number | undefined;
}

/**
 * This store keeps the state of each host in a SQLite file. Two or more processes on one store
 * share it, so they share the pace and the stops of each host. Thus a host gets one request at a
 * time from all of them. Each method is one transaction (`BEGIN IMMEDIATE`), and it waits for the lock
 * of a different process (`busy_timeout`).
 *
 * The lease of a request belongs to the store that gave it. A different process that asks during
 * the lease gets a wait of one second or less, and asks again. A process that stops during a
 * request holds its lease until the lease ends (5 minutes by default).
 *
 * The table `validators` keeps the validator memo of each host (`ValidatorMemo`), so the processes
 * share it and it stays after a restart. A file of version 0.1.0 gets the table when it opens.
 *
 * The table `quotas` keeps the record of each quota and key of `polite-crawler/api` (`QuotaStore`). Give
 * the store to `quotaGate`, so the count of a key stays after a restart and the processes share it.
 *
 * The state is not a projection of the capture log. A deletion of the file loses only the pace,
 * the counts, the stops and the memos, and the crawler starts them again.
 *
 * @beta
 */
export class SqliteHostStateStore implements HostStateStore, QuotaStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  /** This id names the leases of this store. */
  private readonly owner = randomUUID();
  private reservations = 0;
  private closed = false;
  private readonly pollMs: number;

  constructor(
    readonly path: string,
    options: SqliteHostStateOptions = {},
  ) {
    this.pollMs = Math.max(1, Math.min(SHARED_WAIT_MS, options.pollMs ?? SHARED_WAIT_MS));
    this.db = openDatabase(path, {
      wal: path !== ":memory:",
      synchronous: "NORMAL",
      busyTimeoutMs: Math.max(0, Math.floor(options.busyTimeoutMs ?? 10_000)),
      makeFolder: true,
      folderMode: 0o700,
    });
    try {
      // Each step of the schema adds only tables or columns, so this code works on the file of a
      // later version, and the file keeps its number (`newer: "keep"`). Two versions of the crawler
      // can thus share one file.
      migrate(this.db, MIGRATIONS, { name: "host state store", newer: "keep" });
    } catch (error) {
      this.db.close();
      throw error;
    }
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
    if (this.closed) throw new Error("the host state store is closed");
    return transaction(this.db, work);
  }

  private row(host: string): Row {
    this.stmt("INSERT OR IGNORE INTO hosts (host) VALUES (?)").run(host);
    return this.stmt(
      "SELECT next_at, leased_until, owner, failures, waits, stop_until, stop_reason FROM hosts WHERE host = ?",
    ).get(host) as unknown as Row;
  }

  /** This method removes the hosts that have nothing to remember: no rest, no lease, no counts and no stop. */
  private sweep(now: number): void {
    this.stmt(
      `DELETE FROM hosts WHERE next_at <= ? AND leased_until <= ? AND failures = 0 AND waits = 0
         AND (stop_until IS NULL OR stop_until <= ?)`,
    ).run(now, now, now);
  }

  reserve(host: string, now: number, leaseMs: number): number {
    return this.step(() => {
      this.reservations += 1;
      if (this.reservations % SWEEP_EVERY === 0) this.sweep(now);
      const row = this.row(host);
      if (row.leased_until > now) {
        // the holder usually releases early, so a short wait and a new question
        return row.owner === this.owner
          ? row.leased_until - now
          : Math.min(this.pollMs, row.leased_until - now);
      }
      if (row.next_at > now) return row.next_at - now;
      this.stmt("UPDATE hosts SET leased_until = ?, owner = ? WHERE host = ?").run(
        now + leaseMs,
        this.owner,
        host,
      );
      return 0;
    });
  }

  record(host: string, result: HostResult): HostCounts {
    return this.step(() => {
      const row = this.row(host);
      let { failures, waits } = row;
      if (result === "success") {
        failures = 0;
        waits = 0;
      } else if (result === "failure") failures += 1;
      else if (result === "wait") waits += 1;
      if (failures !== row.failures || waits !== row.waits) {
        this.stmt("UPDATE hosts SET failures = ?, waits = ? WHERE host = ?").run(
          failures,
          waits,
          host,
        );
      }
      return { failures, waits };
    });
  }

  release(host: string, nextAt: number): void {
    this.step(() => {
      this.row(host);
      this.stmt(
        `UPDATE hosts SET next_at = max(next_at, ?),
           leased_until = CASE WHEN owner = ? THEN 0 ELSE leased_until END,
           owner = CASE WHEN owner = ? THEN NULL ELSE owner END
         WHERE host = ?`,
      ).run(nextAt, this.owner, this.owner, host);
    });
  }

  defer(host: string, until: number): void {
    this.step(() => {
      this.row(host);
      this.stmt("UPDATE hosts SET next_at = max(next_at, ?) WHERE host = ?").run(until, host);
    });
  }

  stop(host: string, until: number, reason: string): void {
    const end = Number.isFinite(until) ? until : NO_END;
    this.step(() => {
      this.row(host);
      this.stmt(
        `UPDATE hosts SET stop_until = ?, stop_reason = ?
         WHERE host = ? AND (stop_until IS NULL OR stop_until < ?)`,
      ).run(end, reason, host, end);
    });
  }

  stopped(host: string, now: number): HostStop | undefined {
    if (this.closed) throw new Error("the host state store is closed");
    const row = this.stmt("SELECT stop_until, stop_reason FROM hosts WHERE host = ?").get(host) as
      { stop_until: number | null; stop_reason: string | null } | undefined;
    if (row === undefined || row.stop_until === null || row.stop_until <= now) return undefined;
    return {
      until: row.stop_until >= NO_END ? Number.POSITIVE_INFINITY : row.stop_until,
      reason: row.stop_reason ?? "stopped",
    };
  }

  reset(host?: string): void {
    this.step(() => {
      if (host === undefined) {
        this.stmt(
          "UPDATE hosts SET failures = 0, waits = 0, stop_until = NULL, stop_reason = NULL",
        ).run();
      } else {
        this.stmt(
          "UPDATE hosts SET failures = 0, waits = 0, stop_until = NULL, stop_reason = NULL WHERE host = ?",
        ).run(host);
      }
    });
  }

  validators(host: string): ValidatorMemo | undefined {
    if (this.closed) throw new Error("the host state store is closed");
    const row = this.stmt(
      `SELECT skip_etag, etag, last_modified, etag_misses, date_misses, since_probe, changed_at
         FROM validators WHERE host = ?`,
    ).get(host) as MemoRow | undefined;
    return row === undefined ? undefined : memoOf(row);
  }

  noteValidators(host: string, report: ValidatorReport, now: number): ValidatorMemo {
    return this.step(() => {
      const memo = nextValidatorMemo(this.validators(host), report, now);
      this.stmt(
        `INSERT INTO validators (host, skip_etag, etag, last_modified, etag_misses, date_misses, since_probe, changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(host) DO UPDATE SET skip_etag = excluded.skip_etag, etag = excluded.etag,
           last_modified = excluded.last_modified, etag_misses = excluded.etag_misses,
           date_misses = excluded.date_misses, since_probe = excluded.since_probe,
           changed_at = excluded.changed_at`,
      ).run(
        host,
        memo.skipEtag ? 1 : 0,
        memo.etag,
        memo.lastModified,
        memo.etagMisses,
        memo.dateMisses,
        memo.sinceProbe,
        memo.changedAt,
      );
      return memo;
    });
  }

  /**
   * This method changes the record of a quota and a key in one transaction. So two processes cannot
   * count one call twice or lose a call. A row that is not JSON goes to `step` as no record. The gate
   * of `quotaGate` examines each record that it gets.
   */
  changeQuota(
    quota: string,
    key: string,
    step: (record: QuotaRecord | undefined) => QuotaRecord,
  ): QuotaRecord {
    return this.step(() => {
      const row = this.stmt("SELECT record FROM quotas WHERE quota = ? AND key = ?").get(
        quota,
        key,
      ) as { record: string } | undefined;
      let stored: QuotaRecord | undefined;
      try {
        stored = row === undefined ? undefined : (JSON.parse(row.record) as QuotaRecord);
      } catch {
        stored = undefined;
      }
      const next = step(stored);
      this.stmt(
        "INSERT INTO quotas (quota, key, record) VALUES (?, ?, ?) ON CONFLICT(quota, key) DO UPDATE SET record = excluded.record",
      ).run(quota, key, JSON.stringify(next));
      return next;
    });
  }

  /** This value is the number of hosts that the store holds. */
  get size(): number {
    return (this.stmt("SELECT count(*) AS n FROM hosts").get() as { n: number }).n;
  }

  /** This method closes the file. A second close does nothing. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }
}
