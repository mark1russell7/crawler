/**
 * The simulation of the guide "The daemon, tick by tick". The schedule is the real
 * `scheduleWatches` of polite-crawler on a virtual clock. Its code makes the ticks, the jitter, the
 * budget and `maxPages` of each tick, and the drain at a stop.
 *
 * The watch list is a model of `watch.run`, because the real list keeps its state in SQLite. The
 * model keeps these rules of the real run:
 *
 * - the order of the due entries, and one check at a time for each host
 * - the polite rest of a host (the real `restAfter`), and no request after the deadline
 * - the drain at a stop, and a change that a second check confirms.
 *
 * Its pages are made up, and it sends no request.
 */
import type {
  DaemonTick,
  WatchEntry,
  WatchEvent,
  WatchKind,
  WatchList,
  WatchRun,
  WatchRunOptions,
  WatchSchedule,
  WatchStop,
  WatchSummary,
} from "polite-crawler";
import { WATCH_LIMITS, diffTexts, scheduleWatches } from "polite-crawler";
import { DEFAULT_POLICY, restAfter } from "polite-crawler/politeness";
import { VirtualClock } from "./sim.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** The simulation starts at this time. */
export const DAEMON_START = Date.parse("2026-10-18T06:00:00.000Z");

/** The options of the daemon of the simulation, as the command line takes them. */
export const DAEMON_SETTINGS = { tick: "20m", jitter: "2m", budget: "30s", maxPages: 3 } as const;

/** The same options in milliseconds, for the drawing. */
export const DAEMON_MS = { tick: 20 * MINUTE, jitter: 2 * MINUTE, budget: 30 * SECOND } as const;

/** One version of a page: from this time (after the start), the page shows this text. */
interface PageVersion {
  readonly from: number;
  readonly title: string;
  readonly text: string;
}

/** One page of the watch list of the simulation. */
export interface SimPage {
  readonly url: string;
  readonly host: string;
  /** This text is the short name of the page in the drawing. */
  readonly label: string;
  readonly everyMs: number;
  /** This value is the time that the site takes to answer. */
  readonly latencyMs: number;
  readonly versions: readonly PageVersion[];
}

const fornoBefore = "Hours\nTuesday to Sunday: 7 am to 3 pm\nClosed on Mondays";
const fornoAfter =
  "Hours\nTuesday to Saturday: 7 am to 2 pm\nSunday: 8 am to 1 pm\nClosed on Mondays";
const museo = "Visit\nTuesday to Sunday: 10 am to 6 pm\nA ramp leads to the side door.";

/** The made-up watch list: six pages on four sites. */
export const SIM_PAGES: readonly SimPage[] = [
  {
    url: "https://albergo-campione.example/faq",
    host: "albergo-campione.example",
    label: "albergo/faq",
    everyMs: 2 * HOUR,
    latencyMs: 700,
    versions: [{ from: 0, title: "FAQ", text: "Late checkout until 2 pm, on request." }],
  },
  {
    url: "https://bottega-campione.example/products/fx-2207",
    host: "bottega-campione.example",
    label: "bottega/fx-2207",
    everyMs: HOUR,
    latencyMs: 5200,
    versions: [{ from: 0, title: "Water filter FX-2207", text: "FX-2207: 14.90 EUR. In stock." }],
  },
  {
    url: "https://bottega-campione.example/products/olio-esempio",
    host: "bottega-campione.example",
    label: "bottega/olio",
    everyMs: HOUR,
    latencyMs: 6100,
    versions: [{ from: 0, title: "Olio Esempio, 500 ml", text: "Olio Esempio: 12.50 EUR." }],
  },
  {
    url: "https://bottega-campione.example/products/olio-esempio-1l",
    host: "bottega-campione.example",
    label: "bottega/olio-1l",
    everyMs: HOUR,
    latencyMs: 5800,
    versions: [{ from: 0, title: "Olio Esempio, 1 l", text: "Olio Esempio, 1 l: 21.00 EUR." }],
  },
  {
    url: "https://forno-esempio.example/hours",
    host: "forno-esempio.example",
    label: "forno/hours",
    everyMs: HOUR,
    latencyMs: 1400,
    versions: [
      { from: 0, title: "Hours | Forno Esempio", text: fornoBefore },
      { from: 90 * MINUTE, title: "Hours | Forno Esempio", text: fornoAfter },
    ],
  },
  {
    url: "https://museo-esempio.example/visit",
    host: "museo-esempio.example",
    label: "museo/visit",
    everyMs: HOUR,
    latencyMs: 900,
    versions: [
      { from: 0, title: "Visit | Museo Esempio", text: museo },
      // a page in maintenance for 40 minutes: one check sees it, and the next check does not
      {
        from: 2 * HOUR,
        title: "Maintenance",
        text: "The site is in maintenance. Come back soon.",
      },
      { from: 2 * HOUR + 40 * MINUTE, title: "Visit | Museo Esempio", text: museo },
    ],
  },
];

/**
 * The operator stops the daemon during the first tick after this time from the start. The stop
 * comes 2 seconds after the start of the tick, while a check is in progress.
 */
export const STOP_AFTER = 3 * HOUR + 20 * MINUTE;
const STOP_INTO_TICK = 2 * SECOND;

/** One check of the drawing: from the claim of the entry to the end of its request. */
export interface CheckMark {
  readonly url: string;
  readonly host: string;
  /** This value is the number of the tick, from 0. */
  readonly tick: number;
  readonly claimed: number;
  /** This value is the start of the request, after the rest of the host. It is null when the request did not start. */
  readonly start: number | null;
  readonly end: number;
  /** This value is the end of the rest of the host after the request, or null. */
  readonly restUntil: number | null;
  /** The value `deferred` tells that the check did not start: the entry stays due. */
  readonly kind: WatchKind | "deferred";
  readonly suspected: boolean;
  readonly confirmed: boolean;
  readonly note: string | null;
}

/** One tick of the drawing: the run of the watch list, and the wait after it. */
export interface TickMark {
  readonly index: number;
  readonly start: number;
  readonly end: number | null;
  /** This value is the time of the next tick, or null when the schedule stopped. */
  readonly next: number | null;
  /** This value is the random part of the wait after the tick. */
  readonly jitter: number | null;
  readonly summary: WatchSummary | null;
}

/** One time when an entry is due, after a check. */
export interface DueMark {
  readonly url: string;
  readonly at: number;
}

/** What the simulation shows at one time. */
export interface DaemonView {
  readonly now: number;
  readonly ticks: readonly TickMark[];
  readonly checks: readonly CheckMark[];
  readonly due: readonly DueMark[];
  /** These texts are the JSON lines of the confirmed changes, as the daemon writes them. */
  readonly lines: readonly string[];
  /** This value is true while the checks of a tick are in progress. */
  readonly running: boolean;
  /** This value is the time of the stop signal, or null. */
  readonly stoppedAt: number | null;
  /** This value is true when the schedule ended. */
  readonly done: boolean;
}

/** A small random generator with a seed, so that each replay has the same jitter. */
const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** This function gives a short hash of a text in hex (FNV-1a), for the made-up capture ids. */
const hashOf = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

const iso = (ms: number): string => new Date(ms).toISOString();

interface Seen {
  readonly sha: string;
  readonly capture: string;
  readonly fetched_at: string;
  readonly version: PageVersion;
}

interface Entry {
  readonly page: SimPage;
  readonly added: number;
  next: number;
  leased: number;
  checked: number | null;
  kind: WatchKind | null;
  note: string | null;
  checks: number;
  changes: number;
  base: Seen | undefined;
  pending: (Seen & { readonly since: number }) | undefined;
}

type Done =
  | { readonly kind: "event"; readonly host: string; readonly event: WatchEvent }
  | { readonly kind: "deferred"; readonly host: string; readonly stop: WatchStop };

/** The daemon of the simulation: the real schedule over the model of the watch list. */
export class DaemonSim {
  readonly clock = new VirtualClock(DAEMON_START);
  private readonly entries: Entry[];
  private readonly hostFree = new Map<string, number>();
  private readonly ticks: TickMark[] = [];
  private readonly checks: CheckMark[] = [];
  private readonly dueMarks: DueMark[] = [];
  private readonly lines: string[] = [];
  private readonly jitters: number[] = [];
  private running = false;
  private stoppedAt: number | null = null;
  /** This value is the time of the stop of the operator, when the tick of the stop started. */
  private stopAt: number | null = null;
  private ended = false;
  private schedule: WatchSchedule | undefined;

  constructor(seed = 7) {
    this.entries = SIM_PAGES.map((page) => ({
      page,
      added: DAEMON_START,
      next: DAEMON_START,
      leased: 0,
      checked: null,
      kind: null,
      note: null,
      checks: 0,
      changes: 0,
      base: undefined,
      pending: undefined,
    }));
    for (const page of SIM_PAGES) this.dueMarks.push({ url: page.url, at: DAEMON_START });
    const random = seeded(seed);
    this.random = () => {
      const value = random();
      this.jitters.push(Math.min(DAEMON_MS.jitter, Math.floor(value * DAEMON_MS.jitter)));
      return value;
    };
  }

  private readonly random: () => number;

  /** This method starts the real schedule. The first tick starts at once. */
  start(): void {
    if (this.schedule !== undefined) return;
    this.schedule = scheduleWatches(this.list(), {
      ...DAEMON_SETTINGS,
      clock: this.clock,
      random: this.random,
      onEvent: (event) => {
        // the daemon writes each confirmed change as one JSON line
        if (event.confirmed) this.lines.push(JSON.stringify(event));
      },
      onTick: (tick: DaemonTick) => this.ticked(tick),
    });
    void this.schedule.done.then(() => {
      this.ended = true;
    });
  }

  /**
   * This method sends the stop signal. The real daemon gives the checks in progress 10 seconds of
   * real time (`grace`). The simulation gives them one hour, so that the drain does not depend on
   * the speed of the animation.
   */
  stop(): void {
    if (this.schedule === undefined || this.stoppedAt !== null) return;
    this.stoppedAt = this.clock.now();
    void this.schedule.stop("1h");
  }

  /** This method moves the virtual clock to `target`, and sends the stop signal of the operator at its time. */
  async advanceTo(target: number): Promise<void> {
    for (;;) {
      const stopAt = this.stopAt;
      if (this.stoppedAt === null && stopAt !== null && stopAt <= target) {
        await this.clock.advanceTo(stopAt);
        this.stop();
        continue;
      }
      // one sleep at a time, so that a tick that starts on the way can plan the stop
      const next = this.clock.nextAt;
      const until = next === undefined || next > target ? target : next;
      await this.clock.advanceTo(Math.max(until, this.clock.now()));
      if (until >= target) return;
    }
  }

  /** This value is the time of the next event: a tick, the start or the end of a check, or the stop. */
  get nextAt(): number | undefined {
    const next = this.clock.nextAt;
    const stopAt = this.stopAt;
    if (this.stoppedAt === null && stopAt !== null && (next === undefined || next > stopAt))
      return stopAt;
    return next;
  }

  /** This value is true when the schedule ended. */
  get done(): boolean {
    return this.ended;
  }

  /** This method gives what the drawing shows at this time. */
  view(): DaemonView {
    return {
      now: this.clock.now(),
      ticks: [...this.ticks],
      checks: [...this.checks],
      due: [...this.dueMarks],
      lines: [...this.lines],
      running: this.running,
      stoppedAt: this.stoppedAt,
      done: this.ended,
    };
  }

  private ticked(tick: DaemonTick): void {
    const index = this.ticks.length - 1;
    const open = this.ticks[index];
    if (open === undefined) return;
    this.ticks[index] = {
      ...open,
      end: Date.parse(tick.ended_at),
      next: tick.next_at === null ? null : Date.parse(tick.next_at),
      jitter: tick.next_at === null ? null : (this.jitters[index] ?? null),
      summary: tick.summary,
    };
  }

  private versionOf(page: SimPage, at: number): PageVersion {
    let shown = page.versions[0]!;
    for (const version of page.versions) if (at - DAEMON_START >= version.from) shown = version;
    return shown;
  }

  private dueCount(now: number): number {
    return this.entries.filter((entry) => entry.next <= now && entry.leased <= now).length;
  }

  /** This method gives the first due entry, as the real store does: by due time, then by URL. */
  private claim(now: number, busy: ReadonlySet<string>): Entry | undefined {
    return this.entries
      .filter((entry) => entry.next <= now && entry.leased <= now && !busy.has(entry.page.host))
      .sort((a, b) => a.next - b.next || (a.page.url < b.page.url ? -1 : 1))[0];
  }

  private entryOf(entry: Entry): WatchEntry {
    return {
      url: entry.page.url,
      every_ms: entry.page.everyMs,
      render: "auto",
      confirm: 2,
      scope: null,
      labels: null,
      on_behalf_of: [],
      added_at: iso(entry.added),
      next_at: iso(entry.next),
      checked_at: entry.checked === null ? null : iso(entry.checked),
      last_kind: entry.kind,
      last_note: entry.note,
      checks: entry.checks,
      changes: entry.changes,
      doc: `url:${entry.page.url}`,
      capture: entry.base?.capture ?? null,
      fetched_at: entry.base?.fetched_at ?? null,
      gone: false,
      pending:
        entry.pending === undefined
          ? null
          : { kind: "changed", capture: entry.pending.capture, since: iso(entry.pending.since) },
      leased_until: entry.leased > this.clock.now() ? iso(entry.leased) : null,
    };
  }

  /** This method checks one entry, with the rules of a check of the real run. */
  private async check(entry: Entry, deadline: number, tick: number): Promise<Done> {
    const clock = this.clock;
    const page = entry.page;
    const claimed = clock.now();
    // the host rests after its last request, and no request starts at or after the deadline
    const ready = Math.max(claimed, this.hostFree.get(page.host) ?? 0);
    if (ready >= deadline) {
      entry.leased = 0;
      this.checks.push({
        url: page.url,
        host: page.host,
        tick,
        claimed,
        start: null,
        end: claimed,
        restUntil: null,
        kind: "deferred",
        suspected: false,
        confirmed: false,
        note: `deadline reached: the host is free at ${iso(ready)}, and the request must start before ${iso(deadline)}`,
      });
      return { kind: "deferred", host: page.host, stop: "budget" };
    }
    await clock.sleep(ready - claimed);
    const start = clock.now();
    await clock.sleep(page.latencyMs);
    const at = clock.now();
    const restUntil = at + restAfter(DEFAULT_POLICY, { kind: "page", elapsedMs: at - start }).ms;
    this.hostFree.set(page.host, restUntil);
    const version = this.versionOf(page, start);
    const sha = hashOf(`${version.title}\n${version.text}`);
    const seen: Seen = {
      sha,
      capture: `fetch.${hashOf(`${page.url}@${String(at)}`)}${sha.slice(0, 4)}`,
      fetched_at: iso(at),
      version,
    };
    const base = entry.base;
    const pending = entry.pending;
    let kind: WatchKind;
    let suspected = false;
    let confirmed = false;
    let note: string | null = null;
    if (base === undefined) {
      // the first version that a watch sees is not a change: it is the start
      kind = "new";
      entry.base = seen;
      entry.pending = undefined;
    } else if (base.sha === seen.sha) {
      kind = "unchanged";
      if (pending !== undefined)
        note =
          "the change that the last check saw did not repeat, so the watch takes it for a glitch";
      entry.pending = undefined;
    } else {
      kind = "changed";
      if (pending?.sha === seen.sha) {
        confirmed = true;
        entry.base = seen;
        entry.pending = undefined;
        entry.changes += 1;
      } else {
        suspected = true;
        note =
          pending === undefined
            ? "the watch saw this change one time: the next check confirms it when it sees the same version"
            : "the watch saw a different change than the last check: the next check confirms it when it sees the same version";
        entry.pending = { ...seen, since: at };
      }
    }
    const diff =
      kind === "changed" && base !== undefined
        ? diffTexts(
            { text: base.version.text, fields: { title: base.version.title } },
            { text: version.text, fields: { title: version.title } },
          ).summary
        : null;
    entry.next = at + page.everyMs;
    entry.leased = 0;
    entry.checked = at;
    entry.kind = kind;
    entry.note = note;
    entry.checks += 1;
    this.dueMarks.push({ url: page.url, at: entry.next });
    this.checks.push({
      url: page.url,
      host: page.host,
      tick,
      claimed,
      start,
      end: at,
      restUntil,
      kind,
      suspected,
      confirmed,
      note,
    });
    const event: WatchEvent = {
      url: page.url,
      doc: `url:${page.url}`,
      kind,
      suspected,
      confirmed,
      capture: seen.capture,
      fetched_at: seen.fetched_at,
      previous: base?.capture ?? null,
      previous_fetched_at: base?.fetched_at ?? null,
      outcome: "ok",
      status: 200,
      diff,
      held_back: false,
      next_at: iso(entry.next),
      note,
    };
    return { kind: "event", host: page.host, event };
  }

  /** This method is one run of the model of the watch list: a tick of the schedule. */
  private async *events(
    options: WatchRunOptions,
    resolveSummary: (summary: WatchSummary) => void,
  ): AsyncGenerator<WatchEvent, void, undefined> {
    const startedAt = this.clock.now();
    const tick = this.ticks.length;
    this.ticks.push({
      index: tick,
      start: startedAt,
      end: null,
      next: null,
      jitter: null,
      summary: null,
    });
    this.running = true;
    if (this.stopAt === null && startedAt - DAEMON_START >= STOP_AFTER)
      this.stopAt = startedAt + STOP_INTO_TICK;
    const budgetMs = options.budgetMs ?? WATCH_LIMITS.budgetMs;
    const maxPages = options.maxPages ?? WATCH_LIMITS.maxPages;
    const deadline = startedAt + budgetMs;
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
    try {
      for (;;) {
        if (stopping === undefined && options.signal?.aborted === true) stopping = "cancelled";
        if (stopping === undefined && options.drain?.aborted === true) {
          stopping = "cancelled";
          reason = "the run stopped for a shutdown: the checks in progress ended first";
        }
        if (stopping === undefined && this.clock.now() >= deadline) stopping = "budget";
        while (
          stopping === undefined &&
          inflight.size < WATCH_LIMITS.hostsAtOnce &&
          started < maxPages
        ) {
          const entry = this.claim(this.clock.now(), new Set(inflight.keys()));
          if (entry === undefined) break;
          started += 1;
          entry.leased = Math.max(this.clock.now(), deadline) + WATCH_LIMITS.leaseMs;
          inflight.set(entry.page.host, this.check(entry, deadline, tick));
        }
        if (inflight.size === 0) break;
        const done = await Promise.race(inflight.values());
        inflight.delete(done.host);
        if (done.kind === "deferred") {
          started -= 1;
          stopping ??= done.stop;
          continue;
        }
        counts.checked += 1;
        counts[done.event.kind] += 1;
        if (done.event.suspected) counts.suspected += 1;
        if (done.event.confirmed) counts.confirmed += 1;
        yield done.event;
      }
      stopping ??=
        started >= maxPages && this.dueCount(this.clock.now()) > 0 ? "max-pages" : "done";
    } finally {
      await Promise.allSettled(inflight.values());
      const stop = stopping ?? "cancelled";
      reason ??=
        stop === "done"
          ? "the run checked each entry that was due"
          : stop === "max-pages"
            ? `the run checked ${String(maxPages)} entries, its limit (maxPages)`
            : stop === "budget"
              ? `the budget of ${String(budgetMs)} ms ended (budgetMs)`
              : "the caller cancelled the run";
      this.running = false;
      resolveSummary({
        ...counts,
        due: this.dueCount(this.clock.now()),
        stopped: stop,
        reason,
        elapsed_ms: this.clock.now() - startedAt,
      });
    }
  }

  /** This method gives the model of the watch list, for `scheduleWatches`. */
  private list(): WatchList {
    return {
      add: () => Promise.reject(new Error("the simulation has a fixed list")),
      remove: () => Promise.resolve(false),
      list: () =>
        Promise.resolve(
          [...this.entries]
            .sort((a, b) => a.next - b.next || (a.page.url < b.page.url ? -1 : 1))
            .map((entry) => this.entryOf(entry)),
        ),
      run: (options: WatchRunOptions = {}): WatchRun => {
        let resolveSummary: (summary: WatchSummary) => void = () => undefined;
        const summary = new Promise<WatchSummary>((resolve) => {
          resolveSummary = resolve;
        });
        return { summary, [Symbol.asyncIterator]: () => this.events(options, resolveSummary) };
      },
    };
  }

  /** This method moves the clock to the end of the schedule. It gives up after `limit` of time. */
  async finish(limit = 6 * HOUR): Promise<void> {
    this.start();
    const end = DAEMON_START + limit;
    while (!this.ended && this.clock.now() < end) {
      const next = this.nextAt;
      if (next === undefined) {
        await this.advanceTo(this.clock.now());
        if (this.clock.nextAt === undefined) break;
        continue;
      }
      await this.advanceTo(next);
    }
  }
}
