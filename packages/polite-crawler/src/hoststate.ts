import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StatementSync } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import type { HostCounts, HostResult, HostStateStore, HostStop } from "./politeness.ts";

/** A stop with no end goes into the table as this value, which is past each date that JavaScript can hold. */
const NO_END = 9e15;
/** A process that shares the store asks again after this wait, at most, during the lease of a different process. */
const SHARED_WAIT_MS = 1000;
/** The store removes the rows of idle hosts after this many reservations. */
const SWEEP_EVERY = 1000;

interface Row {
  next_at: number;
  leased_until: number;
  owner: string | null;
  failures: number;
  waits: number;
  stop_until: number | null;
  stop_reason: string | null;
}

/** These options change a SQLite host state store. */
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
 * The state is not a projection of the capture log. A deletion of the file loses only the pace,
 * the counts and the stops, and the crawler starts them again.
 */
export class SqliteHostStateStore implements HostStateStore {
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
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.pollMs = Math.max(1, Math.min(SHARED_WAIT_MS, options.pollMs ?? SHARED_WAIT_MS));
    this.db = new DatabaseSync(path);
    const wait = Math.max(0, Math.floor(options.busyTimeoutMs ?? 10_000));
    this.db.exec(`PRAGMA busy_timeout = ${String(wait)};`);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS hosts (
      host TEXT PRIMARY KEY,
      next_at REAL NOT NULL DEFAULT 0,
      leased_until REAL NOT NULL DEFAULT 0,
      owner TEXT,
      failures INTEGER NOT NULL DEFAULT 0,
      waits INTEGER NOT NULL DEFAULT 0,
      stop_until REAL,
      stop_reason TEXT
    )`);
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
