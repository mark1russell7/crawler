import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { browserMissing } from "./browser.ts";
import type { Duration } from "./duration.ts";
import { durationMs } from "./duration.ts";
import type { OpenOptions, OpenedCrawler } from "./open.ts";
import { openCrawler } from "./open.ts";
import type { Clock } from "./politeness.ts";
import { realClock } from "./politeness.ts";
import { VERSION } from "./version.ts";
import type { WatchEntry, WatchEvent, WatchList, WatchSummary } from "./watch.ts";

/*
 * The daemon is a local process that runs for a long time. It does these jobs:
 *
 * - It checks the watch list on a schedule (`scheduleWatches`). Each entry that is due gets its
 *   check at its time, with each polite rule of `watch.run`.
 * - It writes each change as one JSON line, and it can start a command of the operator for it.
 * - It can serve the MCP tools over HTTP, with the long tools as MCP tasks. This part loads the MCP
 *   SDK only when the daemon serves MCP, through a small seam (`DaemonMcpHost`).
 * - It writes a small state file, which `polite-crawler daemon status` reads.
 */

/** These are the defaults of the daemon. */
export const DAEMON_DEFAULTS = {
  /** The longest wait between two ticks: 1 minute. A tick comes sooner when an entry is due sooner. */
  tickMs: 60_000,
  /** The most random time that the daemon adds to each wait: 10 seconds. */
  jitterMs: 10_000,
  /** The budget of the checks of one tick: 10 minutes. No request starts after it. */
  budgetMs: 600_000,
  /** The most checks of one tick. */
  maxPages: 100,
  /** At a stop, the checks in progress get this time to end: 10 seconds. Then they abort. */
  graceMs: 10_000,
  /** The shortest wait between two ticks: 1 second. */
  minGapMs: 1_000,
  /** The shortest tick: 1 second. */
  minTickMs: 1_000,
  /** The status lists this number of the next due entries. */
  dueShown: 10,
  /** An on-change command that runs longer than this time stops: 1 minute. */
  hookTimeoutMs: 60_000,
} as const;

/** This value is the version of the format of the state file. */
export const DAEMON_STATE_SCHEMA = 1;

/** This is a watch entry that is due soon, as the status shows it. */
export interface DaemonDue {
  readonly url: string;
  /** This time (ISO 8601) is the time when the entry is due. */
  readonly next_at: string;
  readonly every_ms: number;
  /** This value is the kind of the last check, or null before the first check. */
  readonly last_kind: string | null;
}

/** This is one tick of the schedule: one run of the watch list. */
export interface DaemonTick {
  /** This time (ISO 8601) is the start of the run. */
  readonly started_at: string;
  /** This time (ISO 8601) is the end of the run. */
  readonly ended_at: string;
  /** This value is the summary of the run, or null when the run failed. */
  readonly summary: WatchSummary | null;
  /** This text tells why the run failed, or null. */
  readonly error: string | null;
  /** This time (ISO 8601) is the time of the next tick, or null when the schedule stops. */
  readonly next_at: string | null;
  /** These entries are the next due entries after the run, the first due first. */
  readonly due: readonly DaemonDue[];
}

/** These options control the schedule of the watch list. */
export interface ScheduleOptions {
  /** This value is the longest wait between two ticks. The default is `1m`, and the floor is `1s`. */
  readonly tick?: Duration | undefined;
  /** This value is the most random time that the schedule adds to each wait. The default is `10s`. */
  readonly jitter?: Duration | undefined;
  /** This value is the budget of the checks of one tick. The default is `10m`. */
  readonly budget?: Duration | undefined;
  /** This value is the most checks of one tick. The default is 100. */
  readonly maxPages?: number | undefined;
  /** This clock gives the time and the waits. Give the clock of the crawler. The default is the real clock. */
  readonly clock?: Clock | undefined;
  /** This function gives the random numbers of the jitter. The default is `Math.random`. */
  readonly random?: (() => number) | undefined;
  /** This function gets each event of each check. */
  readonly onEvent?: ((event: WatchEvent) => void) | undefined;
  /** This function gets each tick when its run ends. */
  readonly onTick?: ((tick: DaemonTick) => void) | undefined;
  /** This function gets the error of a run that failed. The schedule goes on at the next tick. */
  readonly onError?: ((error: Error) => void) | undefined;
}

/** This is the result of a schedule: the counts so far, and the last tick. */
export interface ScheduleResult {
  readonly ticks: number;
  /** This value counts the checks that gave an event. */
  readonly checked: number;
  /** This value counts the confirmed changes. */
  readonly changes: number;
  readonly last: DaemonTick | null;
}

/** A schedule that runs. `stop` ends it, and `done` resolves when it ends. */
export interface WatchSchedule {
  /** This promise resolves when the schedule ends. It does not reject. */
  readonly done: Promise<ScheduleResult>;
  /**
   * This method stops the schedule. The run in progress starts no new check. The checks in
   * progress get `grace` (10 seconds by default) to end and write their state. Then they abort,
   * and the run releases their leases. A second call with a shorter grace shortens it.
   */
  stop(grace?: Duration): Promise<ScheduleResult>;
  /** This method gives the counts so far. */
  result(): ScheduleResult;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** This function reads a duration of an option, with a floor. A bad value throws a `RangeError`. */
const msOf = (name: string, value: Duration, floor: number): number => {
  let ms: number;
  try {
    ms = durationMs(value);
  } catch (error) {
    throw new RangeError(`${name}: ${(error as Error).message}`, { cause: error });
  }
  if (ms < floor)
    throw new RangeError(`${name} must be ${String(floor)} ms or more, not ${String(ms)}`);
  return ms;
};

const pagesOf = (value: number | undefined): number => {
  const pages = value ?? DAEMON_DEFAULTS.maxPages;
  if (!Number.isInteger(pages) || pages < 1)
    throw new RangeError(`maxPages must be an integer of 1 or more, not ${String(pages)}`);
  return pages;
};

const errorOf = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/** This function gives the next due entries of a list, as the status shows them. */
const dueOf = (entries: readonly WatchEntry[]): DaemonDue[] =>
  [...entries]
    .sort((a, b) => Date.parse(a.next_at) - Date.parse(b.next_at) || a.url.localeCompare(b.url))
    .slice(0, DAEMON_DEFAULTS.dueShown)
    .map((entry) => ({
      url: entry.url,
      next_at: entry.next_at,
      every_ms: entry.every_ms,
      last_kind: entry.last_kind,
    }));

/**
 * This function gives the time of the next tick. It is the time when the first entry is due, or
 * the end of its lease. It is not later than one tick, and not sooner than `minGapMs`. A random
 * jitter from 0 to `jitterMs` comes after it, so a check does not come before its time.
 *
 * When the budget or `maxPages` of a run left due entries, they wait for the next tick, so one
 * tick does not exceed its budget. A run that failed also waits one tick.
 */
export const nextTickAt = (
  entries: readonly WatchEntry[],
  summary: WatchSummary | null,
  now: number,
  options: { readonly tickMs: number; readonly jitterMs: number; readonly random: () => number },
): number => {
  let next = now + options.tickMs;
  const leftover = summary === null || summary.stopped !== "done";
  for (const entry of entries) {
    const lease = entry.leased_until === null ? 0 : Date.parse(entry.leased_until);
    const due = Math.max(Date.parse(entry.next_at), lease);
    if (due <= now && leftover) continue;
    next = Math.min(next, Math.max(due, now + DAEMON_DEFAULTS.minGapMs));
  }
  const random = Math.min(Math.max(options.random(), 0), 1);
  return next + Math.min(options.jitterMs, Math.floor(random * options.jitterMs));
};

/**
 * This function checks a watch list on a schedule. The first tick starts at once. Each tick is one
 * `watch.run` with the budget and `maxPages` of a tick. Thus each polite rule of the run applies:
 * one request at a time to each host, the stops of a host, `Retry-After` and robots.txt.
 *
 * After a run, the schedule waits for the next tick (`nextTickAt`). An error of a run goes to
 * `onError`, and the schedule goes on.
 */
export const scheduleWatches = (watch: WatchList, options: ScheduleOptions = {}): WatchSchedule => {
  const tickMs = msOf("tick", options.tick ?? DAEMON_DEFAULTS.tickMs, DAEMON_DEFAULTS.minTickMs);
  const jitterMs = msOf("jitter", options.jitter ?? DAEMON_DEFAULTS.jitterMs, 0);
  const budgetMs = msOf("budget", options.budget ?? DAEMON_DEFAULTS.budgetMs, 0);
  const maxPages = pagesOf(options.maxPages);
  const clock = options.clock ?? realClock;
  const random = options.random ?? Math.random;
  // the drain starts no new check, the cancel aborts the checks in progress, the wake ends a wait
  const drain = new AbortController();
  const cancel = new AbortController();
  const wake = new AbortController();
  let stopping = false;
  const counts = { ticks: 0, checked: 0, changes: 0, last: null as DaemonTick | null };
  const result = (): ScheduleResult => ({ ...counts });
  const report = (error: unknown): void => {
    try {
      options.onError?.(errorOf(error));
    } catch {
      // an error of the error handler stops nothing
    }
  };
  const safely = (work: () => void): void => {
    try {
      work();
    } catch (error) {
      report(error);
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopping) {
      const started = clock.now();
      let summary: WatchSummary | null = null;
      let failure: string | null = null;
      try {
        const run = watch.run({
          budgetMs,
          maxPages,
          signal: cancel.signal,
          drain: drain.signal,
        });
        for await (const event of run) {
          counts.checked += 1;
          if (event.confirmed) counts.changes += 1;
          safely(() => options.onEvent?.(event));
        }
        summary = await run.summary;
      } catch (error) {
        failure = errorOf(error).message;
        report(error);
      }
      counts.ticks += 1;
      // the list gives the next due entries to the status, also at the last tick
      let entries: WatchEntry[] = [];
      try {
        entries = await watch.list();
      } catch (error) {
        report(error);
      }
      const next = stopping
        ? null
        : nextTickAt(entries, summary, clock.now(), { tickMs, jitterMs, random });
      const tick: DaemonTick = {
        started_at: iso(started),
        ended_at: iso(clock.now()),
        summary,
        error: failure,
        next_at: next === null ? null : iso(next),
        due: dueOf(entries),
      };
      counts.last = tick;
      safely(() => options.onTick?.(tick));
      if (next === null || stopping) break;
      await clock.sleep(Math.max(0, next - clock.now()), wake.signal);
    }
  };

  const done = loop().then(result, (error: unknown) => {
    report(error);
    return result();
  });
  return {
    done,
    result,
    stop(grace = DAEMON_DEFAULTS.graceMs) {
      const graceMs = msOf("grace", grace, 0);
      stopping = true;
      drain.abort(new Error("the schedule stops"));
      wake.abort(new Error("the schedule stops"));
      if (graceMs === 0) cancel.abort(new Error("the schedule stopped at once"));
      else {
        // a real timer: the grace is time of the process, not of the clock of the crawler
        const timer = setTimeout(
          () => cancel.abort(new Error("the grace time of the stop ended")),
          graceMs,
        );
        void done.finally(() => clearTimeout(timer));
      }
      return done;
    },
  };
};

// ── the state file ──────────────────────────────────────────────────────────

/** This is a task of the MCP server, as the status shows it. */
export interface DaemonTask {
  readonly id: string;
  /** This value is the name of the tool, for example `crawl_site`. */
  readonly tool: string;
  /** This value is `working`, `input_required`, `completed`, `failed` or `cancelled`. */
  readonly status: string;
  /** This text tells the progress, for example `3 of 10 done`, or null. */
  readonly message: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** This is the status of a daemon. The state file (`<store>/daemon/state.json`) holds the same JSON. */
export interface DaemonStatus {
  /** This value is the version of the format (`DAEMON_STATE_SCHEMA`). */
  readonly schema: number;
  /** This value is the version of polite-crawler. */
  readonly version: string;
  /** This value is the id of the process of the daemon. */
  readonly pid: number;
  readonly store: string;
  /** This value is false after the daemon stopped. */
  readonly running: boolean;
  readonly started_at: string;
  readonly updated_at: string;
  readonly stopped_at: string | null;
  readonly tick_ms: number;
  readonly jitter_ms: number;
  readonly budget_ms: number;
  readonly max_pages: number;
  /** This value counts the ticks. */
  readonly ticks: number;
  /** This value counts the checks. */
  readonly checked: number;
  /** This value counts the confirmed changes. */
  readonly changes: number;
  readonly last_tick: DaemonTick | null;
  /** This time (ISO 8601) is the time of the next tick, or null. */
  readonly next_tick_at: string | null;
  /** These entries are the next due entries at the last tick, the first due first. */
  readonly next_due: readonly DaemonDue[];
  /** These tasks of the MCP server did not end. */
  readonly tasks: readonly DaemonTask[];
  /** This value is the MCP endpoint and the file of its token, or null with no MCP server. */
  readonly mcp: { readonly url: string; readonly token_file: string | null } | null;
  /** This value is the last error: of a tick, of the event log, of an on-change hook or of the MCP server. */
  readonly last_error: { readonly at: string; readonly message: string } | null;
}

/** This is a status that `readDaemonState` read from a state file. */
export interface DaemonState extends DaemonStatus {
  /** This value is true when the daemon runs: the state says so, and its process is alive. */
  readonly alive: boolean;
}

/** These state files belong to a daemon that runs in this process. */
const RUNNING = new Set<string>();

/** This function tells if a process is alive. A process of a different user is alive too. */
const processAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
};

/** This function gives the path of the state file of a store. */
export const daemonStateFile = (dir: string): string => join(dir, "daemon", "state.json");

/**
 * This function reads the state file of a daemon. It gives undefined when the file is not there,
 * or when it is not a state file. `alive` tells if the daemon runs.
 */
export const readDaemonState = (
  dir: string,
  file: string = daemonStateFile(dir),
): DaemonState | undefined => {
  let state: DaemonStatus;
  try {
    state = JSON.parse(readFileSync(file, "utf8")) as DaemonStatus;
  } catch {
    return undefined;
  }
  if (typeof state !== "object" || state === null || typeof state.pid !== "number")
    return undefined;
  const alive =
    state.running === true &&
    (state.pid === process.pid ? RUNNING.has(file) : processAlive(state.pid));
  return { ...state, alive };
};

/** This function writes a state file for the owner only. A rename makes the change atomic where the system can. */
const writeState = (file: string, state: DaemonStatus): void => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(state, null, 2)}\n`;
  const temp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  try {
    renameSync(temp, file);
  } catch {
    // Windows can refuse the rename while a reader has the file open
    writeFileSync(file, text, { mode: 0o600 });
    try {
      unlinkSync(temp);
    } catch {
      // the next write replaces it
    }
  }
};

/** This function writes a new random token to a file for the owner only, and gives the token. */
const writeToken = (file: string): string => {
  const token = randomBytes(32).toString("base64url");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    // a new file gets the mode: an old file can have a wider mode
    unlinkSync(file);
  } catch {
    // no old file
  }
  writeFileSync(file, `${token}\n`, { mode: 0o600, flag: "wx" });
  return token;
};

// ── the on-change command ───────────────────────────────────────────────────

/** These options start an on-change command. */
export interface ChangeCommandOptions {
  /** A command that runs longer than this time stops. The default is `1m`. */
  readonly timeout?: Duration | undefined;
  /** This folder is the working folder of the command. The default is the working folder of the daemon. */
  readonly cwd?: string | undefined;
}

/**
 * This function gives an `onChange` hook that starts a command of the operator for each change.
 * The command operates in the shell of the system, as the user of the daemon. It gets the event as
 * one JSON line on its standard input, not in its command line. Thus no text of a page goes into
 * the command line. The output of the command goes nowhere. A command that exits with a code that
 * is not 0, or that runs too long, rejects with the end of its standard error.
 *
 * The command is the decision of the operator. Do not take it from a page or from an assistant.
 */
export const changeCommand = (
  command: string,
  options: ChangeCommandOptions = {},
): ((event: WatchEvent) => Promise<void>) => {
  if (command.trim() === "") throw new RangeError("the on-change command is empty");
  const timeoutMs = msOf("timeout", options.timeout ?? DAEMON_DEFAULTS.hookTimeoutMs, 1);
  return (event) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
      let tail = "";
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        child.kill();
      }, timeoutMs);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text: string) => {
        tail = (tail + text).slice(-2000);
      });
      // a command that does not read its input closes the pipe early
      child.stdin.on("error", () => undefined);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(
          new Error(`the on-change command did not start: ${error.message}`, { cause: error }),
        );
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const said = tail.trim() === "" ? "" : `: ${tail.trim().slice(-300)}`;
        if (late) {
          reject(
            new Error(
              `the on-change command ran for more than ${String(timeoutMs)} ms, so the daemon stopped it`,
            ),
          );
        } else if (code === 0) resolve();
        else
          reject(
            new Error(
              `the on-change command exited with ${code === null ? String(signal) : `code ${String(code)}`}${said}`,
            ),
          );
      });
      child.stdin.end(`${JSON.stringify(event)}\n`);
    });
};

// ── the daemon ──────────────────────────────────────────────────────────────

/**
 * These options serve the MCP tools over HTTP.
 *
 * @beta
 */
export interface DaemonMcpOptions {
  /** This value is the port. The default is 9307. The value 0 takes a free port. */
  readonly port?: number | undefined;
  /** This value is the host to bind. The default is `127.0.0.1`. A host that is not loopback needs `allowRemote`. */
  readonly host?: string | undefined;
  /** The value true permits a host that is not loopback. Read the warning in the README first. */
  readonly allowRemote?: boolean | undefined;
  /** This value is the bearer token. The default makes a new token at each start, in `<store>/daemon/mcp-token`. */
  readonly token?: string | undefined;
  /** This file holds the bearer token of the operator. The daemon reads it and writes nothing. */
  readonly tokenFile?: string | undefined;
  /** These tokens get their robots.txt rules applied to each fetch of a tool. The default is `["Claude-User"]`. */
  readonly onBehalfOf?: readonly string[] | undefined;
  /** The value true lets `user_provided` release held-back text when the client cannot ask the user. */
  readonly allowUserProvided?: boolean | undefined;
  /** This text tells why the server renders no page. */
  readonly renderOff?: string | undefined;
}

/**
 * These functions connect an MCP host to the daemon.
 *
 * @beta
 */
export interface DaemonMcpHooks {
  /** This function gives the status of the daemon, for the status route. */
  readonly status: () => DaemonStatus;
  /** This function operates when a task starts, changes or ends. */
  readonly onTasks: () => void;
  /** This function writes a message of the server. */
  readonly log: (line: string) => void;
}

/**
 * This is the MCP server of the daemon, as the MCP host gives it.
 *
 * @beta
 */
export interface DaemonMcpService {
  /** This URL is the MCP endpoint. */
  readonly url: string;
  /** This method gives the tasks that did not end. */
  tasks(): readonly DaemonTask[];
  /** This method stops the server and cancels its tasks. */
  close(): Promise<void>;
}

/**
 * This is the seam between the daemon and its MCP server. The default host (`mcpHttpHost` of
 * `polite-crawler/mcp`) serves the tools over Streamable HTTP. A different MCP host can replace it.
 *
 * @beta
 */
export interface DaemonMcpHost {
  start(
    crawler: OpenedCrawler,
    options: DaemonMcpOptions,
    hooks: DaemonMcpHooks,
  ): Promise<DaemonMcpService>;
}

/** These options start a daemon on a store. Only `dir` is necessary. */
export interface DaemonOptions extends OpenOptions {
  /** This value is the longest wait between two ticks. The default is `1m`, and the floor is `1s`. */
  readonly tick?: Duration | undefined;
  /** This value is the most random time that the daemon adds to each wait. The default is `10s`. */
  readonly jitter?: Duration | undefined;
  /** This value is the budget of the checks of one tick. The default is `10m`. */
  readonly budget?: Duration | undefined;
  /** This value is the most checks of one tick. The default is 100. */
  readonly maxPages?: number | undefined;
  /** At a stop, the checks in progress get this time to end. The default is `10s`. */
  readonly grace?: Duration | undefined;
  /**
   * The daemon writes each change event as one JSON line here: a file, a function, or the standard
   * output (the default). The value false writes no line. A change is an event with `confirmed: true`.
   */
  readonly events?: string | ((line: string) => void) | false | undefined;
  /** This function gets each change event. The daemon starts it in order, one at a time, and logs its error. */
  readonly onChange?: ((event: WatchEvent) => void | Promise<void>) | undefined;
  /**
   * These options serve the MCP tools over HTTP. Without them, the daemon serves no MCP.
   *
   * @beta
   */
  readonly mcp?: DaemonMcpOptions | undefined;
  /**
   * This host serves the MCP tools. The default serves them over Streamable HTTP.
   *
   * @beta
   */
  readonly mcpHost?: DaemonMcpHost | undefined;
  /** The value false installs no handler of `SIGINT` and `SIGTERM`. The default is true. */
  readonly signals?: boolean | undefined;
  /** This file keeps the state of the daemon. The default is `<store>/daemon/state.json`. */
  readonly stateFile?: string | undefined;
  /** This function writes the messages of the daemon. The default writes them to the standard error. */
  readonly log?: ((line: string) => void) | undefined;
}

/** This is a daemon that runs. */
export interface Daemon {
  /** This crawler is the crawler of the daemon. The daemon closes it when it stops. */
  readonly crawler: OpenedCrawler;
  /** This file keeps the state of the daemon. */
  readonly stateFile: string;
  /**
   * This value is the MCP server, or undefined.
   *
   * @beta
   */
  readonly mcp: DaemonMcpService | undefined;
  /** This method gives the status at this time. */
  status(): DaemonStatus;
  /**
   * This method stops the daemon. The checks in progress get the grace time to end, then they
   * abort and the run releases their leases. The MCP server stops and cancels its tasks. A second
   * call with `0` aborts the checks at once.
   */
  stop(grace?: Duration): Promise<DaemonStatus>;
  /** This promise resolves with the last status when the daemon stopped. */
  readonly done: Promise<DaemonStatus>;
}

/** The default MCP host loads the MCP SDK only when the daemon serves MCP. */
const defaultHost: DaemonMcpHost = {
  async start(crawler, options, hooks) {
    const { mcpHttpHost } = await import("./mcp.ts");
    return mcpHttpHost.start(crawler, options, hooks);
  },
};

/** This function gives the writer of the change events. */
const eventWriter = (events: DaemonOptions["events"]): ((line: string) => void) | undefined => {
  if (events === false) return undefined;
  if (typeof events === "function") return events;
  if (events === undefined) return (line) => void process.stdout.write(`${line}\n`);
  mkdirSync(dirname(events), { recursive: true });
  return (line) => appendFileSync(events, `${line}\n`, { mode: 0o600 });
};

/**
 * This function starts a daemon on a store. It opens the crawler, serves MCP when `mcp` is given,
 * and checks the watch list on a schedule (`scheduleWatches`). It writes each change event as one
 * JSON line, and it gives each change to `onChange`. The state file tells `daemon status` what runs.
 *
 * Only one daemon operates on a store: a second start rejects. At `SIGINT` or `SIGTERM`, the daemon
 * stops cleanly (`stop`). A second signal aborts the checks at once.
 */
export const startDaemon = async (options: DaemonOptions): Promise<Daemon> => {
  const {
    tick,
    jitter,
    budget,
    maxPages,
    grace,
    events,
    onChange,
    mcp,
    mcpHost,
    signals = true,
    stateFile: givenState,
    log = (line: string) => void process.stderr.write(`${line}\n`),
    ...open
  } = options;
  const tickMs = msOf("tick", tick ?? DAEMON_DEFAULTS.tickMs, DAEMON_DEFAULTS.minTickMs);
  const jitterMs = msOf("jitter", jitter ?? DAEMON_DEFAULTS.jitterMs, 0);
  const budgetMs = msOf("budget", budget ?? DAEMON_DEFAULTS.budgetMs, 0);
  const pages = pagesOf(maxPages);
  const graceMs = msOf("grace", grace ?? DAEMON_DEFAULTS.graceMs, 0);
  const stateFile = givenState ?? daemonStateFile(open.dir);
  const before = readDaemonState(open.dir, stateFile);
  if (before?.alive === true) {
    throw new Error(
      `a daemon runs on the store ${open.dir} already (process ${String(before.pid)}): stop it first, or remove ${stateFile} when no daemon runs`,
    );
  }
  const writeEvent = eventWriter(events);
  // a missing browser turns rendering off one time, at start
  const renderOff = open.renderer === undefined ? await browserMissing() : undefined;
  const crawler = openCrawler({
    ...open,
    ...(renderOff === undefined ? {} : { renderer: false as const }),
  });
  const clock = open.clock ?? realClock;
  const startedAt = iso(clock.now());
  let lastError: DaemonStatus["last_error"] = null;
  let service: DaemonMcpService | undefined;
  let tokenFile: string | null = null;
  let schedule: WatchSchedule | undefined;
  let nextDue: readonly DaemonDue[] = [];
  let stoppedAt: string | null = null;

  const status = (): DaemonStatus => {
    const counts = schedule?.result() ?? { ticks: 0, checked: 0, changes: 0, last: null };
    return {
      schema: DAEMON_STATE_SCHEMA,
      version: VERSION,
      pid: process.pid,
      store: open.dir,
      running: stoppedAt === null,
      started_at: startedAt,
      updated_at: iso(clock.now()),
      stopped_at: stoppedAt,
      tick_ms: tickMs,
      jitter_ms: jitterMs,
      budget_ms: budgetMs,
      max_pages: pages,
      ticks: counts.ticks,
      checked: counts.checked,
      changes: counts.changes,
      last_tick: counts.last,
      next_tick_at: stoppedAt === null ? (counts.last?.next_at ?? startedAt) : null,
      next_due: nextDue,
      tasks: service?.tasks() ?? [],
      mcp: service === undefined ? null : { url: service.url, token_file: tokenFile },
      last_error: lastError,
    };
  };
  const save = (): void => {
    try {
      writeState(stateFile, status());
    } catch (error) {
      log(`polite-crawler: the state file ${stateFile} does not write: ${errorOf(error).message}`);
    }
  };
  const fail = (error: unknown, where: string): void => {
    const message = `${where}: ${errorOf(error).message}`;
    lastError = { at: iso(clock.now()), message };
    log(`polite-crawler: ${message}`);
  };

  if (mcp !== undefined) {
    let given: DaemonMcpOptions = { ...mcp, renderOff: mcp.renderOff ?? renderOff };
    try {
      if (mcp.token === undefined && mcp.tokenFile === undefined) {
        // a new token at each start: a token that leaked ends at the next start
        tokenFile = join(dirname(stateFile), "mcp-token");
        given = { ...given, token: writeToken(tokenFile) };
      } else tokenFile = mcp.tokenFile ?? null;
      service = await (mcpHost ?? defaultHost).start(crawler, given, {
        status,
        onTasks: save,
        log,
      });
    } catch (error) {
      await crawler.close();
      throw error;
    }
  }

  // the hooks run in order, one at a time, so a slow hook does not start many processes
  let hooks: Promise<void> = Promise.resolve();
  const changed = (event: WatchEvent): void => {
    if (writeEvent !== undefined) {
      try {
        writeEvent(JSON.stringify(event));
      } catch (error) {
        fail(error, "the event log");
      }
    }
    if (onChange !== undefined) {
      hooks = hooks
        .then(() => onChange(event))
        .catch((error: unknown) => fail(error, "the on-change hook"));
    }
  };

  RUNNING.add(stateFile);
  const running = scheduleWatches(crawler.watch, {
    tick: tickMs,
    jitter: jitterMs,
    budget: budgetMs,
    maxPages: pages,
    clock,
    random: open.random,
    onEvent: (event) => {
      if (event.confirmed) changed(event);
    },
    onTick: (done) => {
      nextDue = done.due;
      // a run that failed went to onError
      if (done.summary !== null && done.summary.checked > 0) {
        const summary = done.summary;
        log(
          `polite-crawler: ${String(summary.checked)} checked: ${String(summary.confirmed)} changes, ${String(summary.suspected)} suspected, ${String(summary.refused)} refused, ${String(summary.error)} errors. Next tick at ${done.next_at ?? "the stop"}.`,
        );
      }
      save();
    },
    onError: (error) => fail(error, "a tick"),
  });
  schedule = running;
  save();
  log(
    `polite-crawler ${VERSION}: the daemon runs on the store ${open.dir}, a tick each ${String(tickMs)} ms${service === undefined ? "" : `, MCP at ${service.url}${tokenFile === null ? "" : ` (the token is in ${tokenFile})`}`}`,
  );
  if (renderOff !== undefined) log(`polite-crawler: rendering is off: ${renderOff}`);

  let resolveDone: (final: DaemonStatus) => void = () => undefined;
  const done = new Promise<DaemonStatus>((resolve) => {
    resolveDone = resolve;
  });
  let stopping: Promise<DaemonStatus> | undefined;
  let signalled = 0;
  const onSignal = (signal: NodeJS.Signals): void => {
    signalled += 1;
    log(
      signalled > 1
        ? `polite-crawler: ${signal} again: the checks in progress abort now`
        : `polite-crawler: ${signal}: the daemon stops, and the checks in progress get ${String(graceMs)} ms`,
    );
    void stop(signalled > 1 ? 0 : graceMs);
  };
  const stop = (stopGrace: Duration = graceMs): Promise<DaemonStatus> => {
    const ms = msOf("grace", stopGrace, 0);
    void running.stop(ms);
    stopping ??= (async () => {
      const closing = service?.close().catch((error: unknown) => fail(error, "the MCP server"));
      await running.done;
      // the hooks in the queue get the grace too
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        hooks,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
      clearTimeout(timer);
      await closing;
      stoppedAt = iso(clock.now());
      save();
      RUNNING.delete(stateFile);
      await crawler.close();
      if (signals) {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      }
      log("polite-crawler: the daemon stopped");
      const final = status();
      resolveDone(final);
      return final;
    })();
    return stopping;
  };
  if (signals) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  return { crawler, stateFile, mcp: service, status, stop, done };
};
