/**
 * The simulation of the figure "An hour of PoliteCrawler on your site" (the page for site owners).
 * It starts the real parts of polite-crawler on a virtual clock:
 *
 * - `parseRobots` and `decide` read the robots.txt of the reader and decide each path.
 * - `HostScheduler` keeps one request at a time for the site, and it waits the rest of the site.
 * - `restAfter` gives each rest: the pace, the crawl delay and the rule for a slow site.
 * - `classify` reads each status and its `Retry-After` header.
 * - `validatorsToSend` and the validator memo choose the validators of a conditional request.
 *
 * The full crawler keeps its store on disk, so it does not operate in a browser. A small model
 * connects the parts in its place. The model follows these rules of the crawler (`crawler.ts`,
 * `frontier.ts` and `watch.ts`):
 *
 * - robots.txt comes first, and the crawler keeps it for 24 hours. A link that robots.txt refuses
 *   gets no request.
 * - A stored copy younger than 24 hours answers a fetch with no request.
 * - The result of a request sets the rest of the site, as `Crawler.settle` does it. A 429 or a 503
 *   waits, a long `Retry-After` stops the site, and a 403 stops it for 1 hour.
 * - A crawl stops at its limit of pages, and no request starts after its budget of 10 minutes.
 * - The daemon checks a watched page when it is due, after a random wait of up to 10 seconds.
 *
 * The site is made up, and the simulation sends no request.
 */
import { classify } from "polite-crawler/classify";
import type { Outcome } from "polite-crawler/classify";
import type { Rest } from "polite-crawler/politeness";
import {
  DEFAULT_POLICY,
  HostScheduler,
  HostStopped,
  MAX_STOP_MS,
  equalJitterMs,
  restAfter,
  validatorsToSend,
} from "polite-crawler/politeness";
import type { Robots } from "polite-crawler/robots";
import { decide, parseRobots } from "polite-crawler/robots";
import { VirtualClock } from "./sim.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** The simulation shows this time from the start. */
export const VISIT_SPAN = HOUR;

/** The made-up site of the simulation. */
export const VISIT_HOST = "www.your-site.example";

/** The work that the crawler does on the site. */
export type Scenario = "fetch" | "crawl" | "watch";

/** The answer of the site to the second page. Each other page gets a 200 or a 304. */
export type ServerAnswer = "ok" | "429" | "429-long" | "503" | "403";

/** The limit of pages of the crawl, as `--max-pages` gives it. */
export const CRAWL_PAGES = 12;

/** The robots.txt at the start of the figure. */
export const VISIT_ROBOTS = `User-agent: *
Crawl-delay: 5
Disallow: /account/
Disallow: /search
`;

/** The input of the simulation. */
export interface VisitInput {
  readonly robots: string;
  readonly scenario: Scenario;
  readonly answer: ServerAnswer;
  /** This value is the time that the site takes to answer one request. */
  readonly latencyMs: number;
}

/** The reason of a wait. */
export type WaitKind =
  "robots" | "pace" | "crawl-delay" | "slow" | "retry-after" | "backoff" | "stop";

/** The wait of the site after a request. */
export interface Wait {
  readonly ms: number;
  readonly kind: WaitKind;
  readonly text: string;
}

/**
 * The kind of a row of the log:
 *
 * - `ask`: a person, the crawl or the daemon asks for pages
 * - `request`: a request to the site
 * - `store`: a stored copy answers, with no request
 * - `refused`: robots.txt refuses the path, with no request
 * - `stopped`: the site is stopped, with no request
 * - `end`: the work ends
 */
export type RowKind = "ask" | "request" | "store" | "refused" | "stopped" | "end";

/** One row of the log of the site. Times are milliseconds from the start. */
export interface VisitRow {
  readonly at: number;
  readonly kind: RowKind;
  readonly path: string;
  /** This value is the end of the request, or null. */
  readonly end: number | null;
  readonly status: number | null;
  /** These texts name the validators that a conditional request sent. */
  readonly sent: readonly string[];
  readonly wait: Wait | null;
  readonly note: string;
}

/** A stop of the site: no request until its end. */
export interface VisitStop {
  readonly at: number;
  readonly until: number;
  /** This text is the reason of the stop, as the crawler records it. */
  readonly reason: string;
  /** This text names the answer that caused the stop, for the figure. */
  readonly cause: string;
}

/** The result of the simulation. */
export interface Visit {
  readonly rows: readonly VisitRow[];
  readonly stop: VisitStop | null;
  readonly tokens: readonly string[];
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: "200 OK",
  304: "304 Not Modified",
  403: "403 Forbidden",
  429: "429 Too Many Requests",
  503: "503 Service Unavailable",
};

/** This function gives the text of a status. */
export const statusText = (status: number): string => STATUS_TEXT[status] ?? String(status);

/** This function gives a time from the start as `m:ss`, or `h:mm:ss` from one hour. */
export const clockText = (ms: number, tenths = false): string => {
  const total = Math.max(0, ms) / 1000;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const secondsText = tenths
    ? seconds.toFixed(1).padStart(4, "0")
    : String(Math.floor(seconds)).padStart(2, "0");
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${secondsText}`
    : `${String(minutes)}:${secondsText}`;
};

/** This function gives a duration as a short text: `850 ms`, `5 s`, `2 min`, `1 h`. */
export const durationText = (ms: number): string => {
  if (ms < SECOND) return `${String(Math.round(ms))} ms`;
  if (ms < MINUTE) {
    const seconds = ms / SECOND;
    return `${Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)} s`;
  }
  if (ms < HOUR) {
    const minutes = ms / MINUTE;
    return `${Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1)} min`;
  }
  const hours = ms / HOUR;
  return `${Number.isInteger(hours) ? String(hours) : hours.toFixed(1)} h`;
};

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

/** The links of each page of the made-up site, for the crawl. */
const LINKS: Readonly<Record<string, readonly string[]>> = {
  "/": ["/menu", "/hours", "/about", "/blog/", "/account/login", "/search?q=bread"],
  "/menu": ["/menu/lunch", "/menu/dinner", "/menu/drinks"],
  "/hours": ["/contact"],
  "/about": ["/about/team", "/contact"],
  "/blog/": ["/blog/autumn-menu", "/blog/new-oven", "/blog/summer-hours", "/blog/page/2"],
  "/blog/page/2": ["/blog/spring-menu", "/blog/open-day"],
  "/menu/dinner": ["/account/orders"],
};

/** The watched pages: each is due at its time in the hour, and its watch checks it each hour. */
const WATCHED: ReadonlyArray<{
  readonly path: string;
  readonly due: number;
  readonly changed: boolean;
}> = [
  { path: "/menu", due: 0, changed: false },
  { path: "/hours", due: 14 * MINUTE, changed: false },
  { path: "/events", due: 33 * MINUTE, changed: true },
  { path: "/prices", due: 48 * MINUTE, changed: false },
];

/** The most random wait of the daemon before a tick (`DAEMON_DEFAULTS.jitterMs`). */
const DAEMON_JITTER = 10 * SECOND;

/** The settings of a crawl that the figure uses: the depth and the budget of `CRAWL_LIMITS`. */
const CRAWL_DEPTH = 3;
const CRAWL_BUDGET = 10 * MINUTE;

/** A stored copy answers a fetch while it is younger than this age (`maxAge`, 24 hours). */
const MAX_AGE = 24 * HOUR;

interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

interface SendOptions {
  readonly conditional: boolean;
  readonly changed: boolean;
  readonly crawlDelaySeconds: number;
  readonly deadline: number | null;
  readonly note: string;
}

/** This function starts the simulation and gives the log of the hour. */
export const simulateVisit = async (input: VisitInput, seed = 11): Promise<Visit> => {
  const clock = new VirtualClock(0);
  const policy = DEFAULT_POLICY;
  const scheduler = new HostScheduler(clock, 4);
  const store = scheduler.store;
  const random = seeded(seed);
  const rows: VisitRow[] = [];
  const kept = new Map<string, number>();
  // a fetch for an assistant obeys the rules for Claude-User too, as the MCP server does
  const tokens = input.scenario === "fetch" ? ["PoliteCrawler", "Claude-User"] : ["PoliteCrawler"];
  let pages = 0;
  let stop: VisitStop | null = null;
  let robotsRead: Promise<Robots> | undefined;

  const push = (row: Pick<VisitRow, "at" | "kind" | "path" | "note">): void => {
    rows.push({ ...row, end: null, status: null, sent: [], wait: null });
  };

  const answerOf = (page: boolean, conditional: boolean, changed: boolean): Answer => {
    if (page && pages === 2) {
      if (input.answer === "429") return { status: 429, headers: { "retry-after": "120" } };
      if (input.answer === "429-long") return { status: 429, headers: { "retry-after": "7200" } };
      if (input.answer === "503") return { status: 503, headers: {} };
      if (input.answer === "403") return { status: 403, headers: {} };
    }
    return { status: conditional && !changed ? 304 : 200, headers: {} };
  };

  /** This function gives the wait after a request, as `Crawler.settle` decides it. */
  const settle = (
    outcome: Outcome,
    retryAfterMs: number | undefined,
    rest: Rest,
    page: boolean,
  ): Wait => {
    const now = clock.now();
    const restWait = (): Wait => {
      if (!page) return { ms: rest.ms, kind: "robots", text: "the rest after a small request" };
      if (rest.reason === "crawl-delay")
        return { ms: rest.ms, kind: "crawl-delay", text: "your Crawl-delay" };
      if (rest.reason === "slow")
        return { ms: rest.ms, kind: "slow", text: "5 times the time of the answer" };
      return { ms: rest.ms, kind: "pace", text: "the default pace" };
    };
    if (outcome === "rate-limited" || outcome === "unavailable") {
      const { waits } = store.record(VISIT_HOST, "wait");
      if (retryAfterMs !== undefined && retryAfterMs > policy.maxRetryAfterMs) {
        // a wait longer than the limit stops the site, so no request sleeps for days
        const until = now + Math.min(retryAfterMs, MAX_STOP_MS);
        const reason = `asked to wait ${String(Math.round(retryAfterMs / SECOND))} s`;
        scheduler.stop(VISIT_HOST, reason, until);
        stop = { at: now, until, reason, cause: "the 429 with a long Retry-After" };
        return { ms: until - now, kind: "stop", text: "Retry-After is more than 1 hour: a stop" };
      }
      if (retryAfterMs !== undefined)
        return retryAfterMs > rest.ms
          ? { ms: retryAfterMs, kind: "retry-after", text: "your Retry-After" }
          : restWait();
      const backoff = equalJitterMs(waits, policy.backoffBaseMs, policy.backoffCapMs, random);
      return backoff > rest.ms
        ? { ms: backoff, kind: "backoff", text: "a backoff with jitter, with no Retry-After" }
        : restWait();
    }
    if (outcome === "blocked" && page) {
      const until = now + policy.blockedStopMs;
      scheduler.stop(VISIT_HOST, "blocked", until);
      stop = { at: now, until, reason: "blocked", cause: "a 403" };
      return { ms: until - now, kind: "stop", text: "a 403 stops the site for 1 hour" };
    }
    store.record(VISIT_HOST, "success");
    return restWait();
  };

  /** This function sends one request on the scheduler. It gives null when the site is stopped. */
  const send = (path: string, page: boolean, options: SendOptions): Promise<VisitRow | null> =>
    scheduler
      .run<VisitRow | null>(VISIT_HOST, async () => {
        const at = clock.now();
        if (options.deadline !== null && at >= options.deadline) {
          // no request starts at or after the deadline of the crawl
          push({ at, kind: "end", path, note: "budget" });
          return { value: null, delayMs: 0 };
        }
        if (page) pages += 1;
        const answer = answerOf(page, options.conditional, options.changed);
        const memo = page ? store.validators?.(VISIT_HOST) : undefined;
        const validators = options.conditional
          ? validatorsToSend(memo, { etag: true, lastModified: true }, at)
          : { etag: false, lastModified: false };
        const sent = [
          ...(validators.etag ? ["If-None-Match"] : []),
          ...(validators.lastModified ? ["If-Modified-Since"] : []),
        ];
        await clock.sleep(input.latencyMs);
        const end = clock.now();
        if (page && options.conditional && (answer.status === 304 || answer.status === 200))
          store.noteValidators?.(
            VISIT_HOST,
            { ...validators, answer: answer.status === 304 ? "not-modified" : "changed" },
            end,
          );
        const classified = classify(answer.status, (name) => answer.headers[name], end);
        const rest = page
          ? restAfter(policy, {
              kind: "page",
              elapsedMs: end - at,
              crawlDelaySeconds: options.crawlDelaySeconds,
            })
          : restAfter(policy, {
              kind: "api",
              elapsedMs: end - at,
              minIntervalMs: policy.apiIntervalMs,
            });
        const wait = settle(classified.outcome, classified.retryAfterMs, rest, page);
        const row: VisitRow = {
          at,
          kind: "request",
          path,
          end,
          status: answer.status,
          sent,
          wait,
          note: options.note,
        };
        rows.push(row);
        return { value: row, delayMs: wait.kind === "stop" ? rest.ms : wait.ms };
      })
      .catch((error: unknown) => {
        if (!(error instanceof HostStopped)) throw error;
        push({ at: clock.now(), kind: "stopped", path, note: "the site is stopped" });
        return null;
      });

  /** This function reads robots.txt one time. The crawler keeps it for 24 hours. */
  const readRobots = (stored: boolean): Promise<Robots> => {
    robotsRead ??= send("/robots.txt", false, {
      conditional: stored,
      changed: false,
      crawlDelaySeconds: 0,
      deadline: null,
      note: stored
        ? "a conditional request: the crawler has a stored copy"
        : "the first request to your site",
    }).then(() => parseRobots(input.robots));
    return robotsRead;
  };

  /** This function fetches one page, as a fetch of the crawler does it. */
  const fetchPage = async (
    path: string,
    options: {
      readonly maxAgeMs: number;
      readonly deadline: number | null;
      readonly conditional: boolean;
      readonly changed: boolean;
      readonly note: string;
    },
  ): Promise<"page" | "store" | "refused" | "stopped" | "budget" | "error"> => {
    const now = clock.now();
    const copyAt = kept.get(path);
    if (copyAt !== undefined && now - copyAt < options.maxAgeMs) {
      push({ at: now, kind: "store", path, note: `the copy from ${clockText(copyAt)}` });
      return "store";
    }
    if (scheduler.stopOf(VISIT_HOST) !== undefined) {
      push({ at: now, kind: "stopped", path, note: "the site is stopped" });
      return "stopped";
    }
    const robots = await readRobots(input.scenario === "watch");
    const decision = decide(robots, tokens, path);
    if (!decision.allowed) {
      push({
        at: clock.now(),
        kind: "refused",
        path,
        note: `line ${String(decision.rule?.line ?? "?")}, Disallow: ${decision.rule?.pattern ?? ""}`,
      });
      return "refused";
    }
    const row = await send(path, true, {
      conditional: options.conditional,
      changed: options.changed,
      crawlDelaySeconds: decision.crawlDelaySeconds ?? 0,
      deadline: options.deadline,
      note: options.note,
    });
    if (row === null) return rows.at(-1)?.kind === "end" ? "budget" : "stopped";
    if (row.status === 200 || row.status === 304) {
      kept.set(path, row.end ?? row.at);
      return "page";
    }
    return "error";
  };

  const until = async (at: number): Promise<void> => {
    await clock.sleep(Math.max(0, at - clock.now()));
  };

  const fetchScript = async (): Promise<void> => {
    const ask = { maxAgeMs: MAX_AGE, deadline: null, conditional: false, changed: false };
    push({ at: 0, kind: "ask", path: "", note: "An assistant asks for three pages at once." });
    await Promise.all(
      ["/", "/menu", "/hours"].map((path) =>
        fetchPage(path, { ...ask, note: "for the assistant" }),
      ),
    );
    await until(20 * MINUTE);
    push({ at: clock.now(), kind: "ask", path: "", note: "The assistant asks for /menu again." });
    await fetchPage("/menu", { ...ask, note: "for the assistant, again" });
    await until(35 * MINUTE);
    push({
      at: clock.now(),
      kind: "ask",
      path: "",
      note: "The assistant asks for /account/orders.",
    });
    await fetchPage("/account/orders", { ...ask, note: "for the assistant" });
    await until(50 * MINUTE);
    push({ at: clock.now(), kind: "ask", path: "", note: "The assistant asks for /contact." });
    await fetchPage("/contact", { ...ask, note: "a new page: robots.txt comes from memory" });
  };

  const crawlScript = async (): Promise<void> => {
    push({
      at: 0,
      kind: "ask",
      path: "",
      note: `A crawl starts at / with --max-pages ${String(CRAWL_PAGES)}.`,
    });
    const deadline = clock.now() + CRAWL_BUDGET;
    const queue: Array<{ readonly path: string; readonly depth: number }> = [
      { path: "/", depth: 0 },
    ];
    const seen = new Set<string>(["/"]);
    let given = 0;
    let reason = "The crawl ends: it followed each link.";
    for (;;) {
      if (clock.now() >= deadline) {
        reason = "The crawl ends at its budget: no request starts after 10 minutes.";
        break;
      }
      if (given >= CRAWL_PAGES) {
        reason = `The crawl ends at its limit of ${String(CRAWL_PAGES)} pages.`;
        break;
      }
      if (scheduler.stopOf(VISIT_HOST) !== undefined) {
        push({
          at: clock.now(),
          kind: "stopped",
          path: `${String(queue.length)} more links`,
          note: "the site is stopped for the rest of the crawl",
        });
        reason = "The crawl ends: the site is stopped, so the other pages get no request.";
        break;
      }
      const item = queue.shift();
      if (item === undefined) break;
      const result = await fetchPage(item.path, {
        maxAgeMs: MAX_AGE,
        deadline,
        conditional: false,
        changed: false,
        note: item.depth === 0 ? "the start of the crawl" : `a link, depth ${String(item.depth)}`,
      });
      if (result === "budget") {
        reason = "The crawl ends at its budget: no request starts after 10 minutes.";
        break;
      }
      // a link that robots.txt refuses costs no fetch, and it does not count as a page
      if (result === "refused") continue;
      given += 1;
      if (result !== "page" || item.depth >= CRAWL_DEPTH) continue;
      for (const link of LINKS[item.path] ?? []) {
        if (seen.has(link)) continue;
        seen.add(link);
        queue.push({ path: link, depth: item.depth + 1 });
      }
    }
    if (rows.at(-1)?.kind === "end") rows.pop();
    push({ at: clock.now(), kind: "end", path: "", note: reason });
  };

  const watchScript = async (): Promise<void> => {
    push({
      at: 0,
      kind: "ask",
      path: "",
      note: "The daemon starts. It watches four pages, each every 1 hour.",
    });
    await Promise.all(
      WATCHED.map(async (watched) => {
        await until(watched.due + Math.floor(random() * DAEMON_JITTER));
        await fetchPage(watched.path, {
          maxAgeMs: 0,
          deadline: null,
          conditional: true,
          changed: watched.changed,
          note: watched.changed ? "the page changed: a full answer" : "the page did not change",
        });
      }),
    );
  };

  const script =
    input.scenario === "fetch"
      ? fetchScript()
      : input.scenario === "crawl"
        ? crawlScript()
        : watchScript();
  void script.catch(() => undefined);
  await clock.advanceTo(VISIT_SPAN);
  const order = new Map(rows.map((row, index) => [row, index] as const));
  const sorted = rows
    .filter((row) => row.at <= VISIT_SPAN)
    .sort((a, b) => a.at - b.at || (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { rows: sorted, stop, tokens };
};

/** The numbers of the hour, for the figure and its test. */
export interface VisitStats {
  readonly requests: number;
  /** This value counts the answers with no request: the store, robots.txt and the stop. */
  readonly answeredLocally: number;
  /** This value is the most requests that started in one minute. */
  readonly peakPerMinute: number;
  /** This value is the shortest time from the end of one page to the start of the next page, or null. */
  readonly shortestGapMs: number | null;
  /** This value is the most requests in progress at one time. */
  readonly mostAtOnce: number;
}

/** This function counts the numbers of the hour. */
export const statsOf = (rows: readonly VisitRow[]): VisitStats => {
  const requests = rows.filter((row) => row.kind === "request");
  let peakPerMinute = 0;
  for (const row of requests) {
    const inMinute = requests.filter((one) => one.at >= row.at && one.at < row.at + MINUTE).length;
    peakPerMinute = Math.max(peakPerMinute, inMinute);
  }
  let shortestGapMs: number | null = null;
  let mostAtOnce = requests.length > 0 ? 1 : 0;
  for (let index = 1; index < requests.length; index += 1) {
    const before = requests[index - 1]!;
    const after = requests[index]!;
    const gap = after.at - (before.end ?? before.at);
    if (gap < 0) mostAtOnce = 2;
    // the rest after robots.txt is the rest after a small request, not the pace of the pages
    if (before.path === "/robots.txt" || after.path === "/robots.txt") continue;
    shortestGapMs = shortestGapMs === null ? gap : Math.min(shortestGapMs, gap);
  }
  return {
    requests: requests.length,
    answeredLocally: rows.filter(
      (row) => row.kind === "store" || row.kind === "refused" || row.kind === "stopped",
    ).length,
    peakPerMinute,
    shortestGapMs,
    mostAtOnce,
  };
};
