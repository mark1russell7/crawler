import type { Clock } from "polite-crawler/politeness";
import { HostScheduler, HostStopped } from "polite-crawler/politeness";

/** One page that the crawl asks for: the time the server takes, and its answer. */
export interface PageScript {
  readonly latencyMs: number;
  readonly status: 200 | 403 | 429;
  /** The wait that a 429 asks for in its `Retry-After` header. */
  readonly retryAfterMs?: number;
}

/** One site of the demonstration crawl. */
export interface SiteScript {
  readonly host: string;
  /** The value `disallow` is a robots.txt that refuses the crawler. */
  readonly robots: "allow" | "disallow";
  readonly crawlDelaySeconds?: number;
  readonly pages: readonly PageScript[];
}

/** A mark in the lane of a host. */
export type Segment =
  | {
      readonly kind: "request";
      readonly host: string;
      readonly start: number;
      end: number | undefined;
      status: number | undefined;
      /** The row in the lane. A polite crawl uses one row. An impolite crawl stacks its requests. */
      readonly row: number;
    }
  | {
      readonly kind: "rest";
      readonly host: string;
      readonly start: number;
      readonly end: number;
      readonly reason: "pace" | "slow" | "retry-after" | "crawl-delay";
    }
  | { readonly kind: "refused"; readonly host: string; readonly at: number; readonly reason: string }
  | { readonly kind: "stored"; readonly host: string; readonly at: number; readonly index: number };

/** The sites of the demonstration. The names are examples, and the timing comes from real sites. */
export const SITES: readonly SiteScript[] = [
  {
    host: "en.wikipedia.org",
    robots: "allow",
    pages: [420, 380, 510, 450, 400].map((latencyMs) => ({ latencyMs, status: 200 as const })),
  },
  {
    host: "docs.example.org",
    robots: "allow",
    pages: [160, 140, 180, 150].map((latencyMs) => ({ latencyMs, status: 200 as const })),
  },
  {
    host: "museum.example",
    robots: "allow",
    pages: [2200, 1900].map((latencyMs) => ({ latencyMs, status: 200 as const })),
  },
  {
    host: "api.busy.example",
    robots: "allow",
    pages: [
      { latencyMs: 300, status: 200 },
      { latencyMs: 280, status: 429, retryAfterMs: 9000 },
      { latencyMs: 300, status: 200 },
    ],
  },
  {
    host: "news.example",
    robots: "allow",
    crawlDelaySeconds: 8,
    pages: [400, 380, 420].map((latencyMs) => ({ latencyMs, status: 200 as const })),
  },
  {
    host: "shop.example",
    robots: "allow",
    pages: [
      { latencyMs: 350, status: 403 },
      { latencyMs: 300, status: 200 },
      { latencyMs: 300, status: 200 },
    ],
  },
  {
    host: "members.example",
    robots: "disallow",
    pages: [300, 300, 300].map((latencyMs) => ({ latencyMs, status: 200 as const })),
  },
  {
    host: "blog.example",
    robots: "allow",
    pages: [600, 550, 500].map((latencyMs) => ({ latencyMs, status: 200 as const })),
  },
];

/**
 * A clock whose time moves only when the page moves it. The scheduler sleeps on it, so the
 * animation can show the real scheduler at any speed.
 */
export class VirtualClock implements Clock {
  private time = 0;
  private sequence = 0;
  private readonly timers: Array<{ at: number; seq: number; resolve: () => void }> = [];

  readonly now = (): number => this.time;

  readonly sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      this.timers.push({ at: this.time + Math.max(0, ms), seq: this.sequence++, resolve });
    });

  /** This value is true when a sleep waits. */
  get waiting(): boolean {
    return this.timers.length > 0;
  }

  /** This method moves the time to `target`, and it wakes each sleep that ends on the way, in order. */
  async advanceTo(target: number, settle: () => Promise<void> = macrotask): Promise<void> {
    for (;;) {
      await settle();
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers[0];
      if (next === undefined || next.at > target) break;
      this.timers.shift();
      this.time = next.at;
      next.resolve();
    }
    this.time = Math.max(this.time, target);
    await settle();
  }
}

/** This function waits until the promise jobs that wait at this time are done. */
export const macrotask = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });

/** The pace of the fetcher: 3 seconds or more between two pages of a host, and longer after a slow page. */
const restAfter = (
  site: SiteScript,
  page: PageScript,
  elapsedMs: number,
): { readonly ms: number; readonly reason: "pace" | "slow" | "retry-after" | "crawl-delay" } => {
  const crawlDelay = (site.crawlDelaySeconds ?? 0) * 1000;
  let ms = Math.max(3000, crawlDelay);
  let reason: "pace" | "slow" | "retry-after" | "crawl-delay" = crawlDelay > 3000 ? "crawl-delay" : "pace";
  const slow = Math.min(30_000, 5 * elapsedMs);
  if (slow > ms) {
    ms = slow;
    reason = "slow";
  }
  if (page.status === 429 && (page.retryAfterMs ?? 0) > ms) {
    ms = page.retryAfterMs ?? ms;
    reason = "retry-after";
  }
  return { ms, reason };
};

/** The record of a crawl, which the page draws. */
export class Timeline {
  readonly segments: Segment[] = [];
  requests = 0;
  stored = 0;

  lane(host: string): readonly Segment[] {
    return this.segments.filter((segment) => segment.host === host);
  }
}

/**
 * This function starts the polite crawl on the real `HostScheduler`. The scheduler keeps one request
 * in progress for each host. Each task tells the scheduler how long the host rests after it.
 */
export const crawlPolitely = (sites: readonly SiteScript[], clock: VirtualClock, timeline: Timeline): Promise<void> => {
  const scheduler = new HostScheduler(clock, 16);
  const work: Array<Promise<void>> = [];
  for (const site of sites) {
    if (site.robots === "disallow") {
      timeline.segments.push({ kind: "refused", host: site.host, at: 0, reason: "robots.txt: Disallow: /" });
      continue;
    }
    site.pages.forEach((page, index) => {
      const job = scheduler
        .run(site.host, async () => {
          const start = clock.now();
          const request: Segment = { kind: "request", host: site.host, start, end: undefined, status: undefined, row: 0 };
          timeline.segments.push(request);
          timeline.requests += 1;
          await clock.sleep(page.latencyMs);
          request.end = clock.now();
          request.status = page.status;
          if (page.status === 403) scheduler.stop(site.host, "403");
          const rest = restAfter(site, page, request.end - start);
          if (page.status !== 403 && index < site.pages.length - 1)
            timeline.segments.push({ kind: "rest", host: site.host, start: request.end, end: request.end + rest.ms, reason: rest.reason });
          return { value: undefined, delayMs: rest.ms };
        })
        .catch((error: unknown) => {
          if (!(error instanceof HostStopped)) throw error;
          timeline.segments.push({ kind: "refused", host: site.host, at: clock.now(), reason: "stopped for the run after a 403" });
        });
      work.push(job);
    });
  }
  return Promise.all(work).then(() => undefined);
};

/**
 * This function starts the same crawl with no politeness. It sends all pages of a site at the same
 * time, and it ignores robots.txt and refusals. A server under the burst answers more slowly.
 */
export const crawlImpolitely = (sites: readonly SiteScript[], clock: VirtualClock, timeline: Timeline): Promise<void> => {
  const work: Array<Promise<void>> = [];
  for (const site of sites) {
    const load = site.pages.length;
    site.pages.forEach((page, index) => {
      const request: Segment = { kind: "request", host: site.host, start: 0, end: undefined, status: undefined, row: index };
      timeline.segments.push(request);
      timeline.requests += 1;
      const busy = site.host === "api.busy.example" && index > 0;
      const refused = site.host === "shop.example";
      work.push(
        clock.sleep(page.latencyMs * (1 + 0.6 * (load - 1))).then(() => {
          request.end = clock.now();
          request.status = refused ? 403 : busy ? 429 : 200;
        }),
      );
    });
  }
  return Promise.all(work).then(() => undefined);
};

/** This function answers each page of the crawl again from the store, at the time `at`, with no request. */
export const askAgain = (sites: readonly SiteScript[], timeline: Timeline, at: number): void => {
  for (const site of sites) {
    const fetched = timeline
      .lane(site.host)
      .filter((segment) => segment.kind === "request" && segment.status === 200);
    fetched.forEach((_, index) => {
      timeline.segments.push({ kind: "stored", host: site.host, at, index });
      timeline.stored += 1;
    });
  }
};

/**
 * This function measures the most requests in progress at the same time to one host, from the
 * requests that the lanes show. A request in progress ends at the time of the clock.
 */
export const peakOf = (segments: readonly Segment[], now: number): number => {
  let peak = 0;
  const hosts = new Set(segments.map((segment) => segment.host));
  for (const host of hosts) {
    const events: Array<readonly [number, number]> = [];
    for (const segment of segments) {
      if (segment.kind !== "request" || segment.host !== host || segment.start > now) continue;
      events.push([segment.start, 1], [segment.end ?? now, -1]);
    }
    // an end before a start at the same time: two requests in sequence do not overlap
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let open = 0;
    for (const [, step] of events) {
      open += step;
      peak = Math.max(peak, open);
    }
  }
  return peak;
};

/** This function gives the end of the crawl: the end of the last request or rest. */
export const endOf = (timeline: Timeline): number =>
  timeline.segments.reduce((end, segment) => {
    if (segment.kind === "request") return Math.max(end, segment.end ?? segment.start);
    if (segment.kind === "rest") return end;
    return Math.max(end, segment.at);
  }, 0);
