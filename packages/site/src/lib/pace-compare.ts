/**
 * The request timeline of the page "Compare the crawlers": one site for 3 minutes, and the default
 * pace of each tool. The pace of polite-crawler is its real `restAfter`. The other tools are models
 * of their documented defaults. The sources are in `PACE_TOOLS`, and the page shows them.
 *
 * Each model sends one request at a time, and the site answers each request in the same time. The
 * other tools can send more requests at the same time, so the models show the lowest load of their
 * defaults, not the highest.
 */
import { DEFAULT_POLICY, restAfter } from "polite-crawler/politeness";

const SECOND = 1000;

/** The timeline shows this time from the first request. */
export const PACE_SPAN = 3 * 60 * SECOND;

/** The zoom shows this time from the first request. */
export const PACE_ZOOM = 20 * SECOND;

export type ToolId = "polite" | "crawlee" | "scrapy" | "crawl4ai";

/** One source of a default value. */
export interface PaceSource {
  readonly label: string;
  readonly href: string;
}

/** One tool of the timeline, with its default pace and the sources of the value. */
export interface PaceTool {
  readonly id: ToolId;
  readonly name: string;
  /** This text tells the default wait between two requests to one site. */
  readonly rule: string;
  /** This text tells the setting or the code that gives the value. */
  readonly setting: string;
  readonly sources: readonly PaceSource[];
}

export const PACE_TOOLS: readonly PaceTool[] = [
  {
    id: "polite",
    name: "polite-crawler",
    rule: "3 s or more, after the end of each request",
    setting: "pageIntervalMs 3 s, and 5 times the time of a slow answer",
    sources: [
      {
        label: "politeness.ts",
        href: "https://github.com/mark1russell7/crawler/blob/main/packages/polite-crawler/src/politeness.ts",
      },
    ],
  },
  {
    id: "crawlee",
    name: "Crawlee",
    rule: "no wait",
    setting: "sameDomainDelaySecs 0, maxRequestsPerMinute Infinity",
    sources: [
      {
        label: "BasicCrawlerOptions",
        href: "https://crawlee.dev/js/api/basic-crawler/interface/BasicCrawlerOptions",
      },
      {
        label: "AutoscaledPoolOptions",
        href: "https://crawlee.dev/js/api/core/interface/AutoscaledPoolOptions",
      },
    ],
  },
  {
    id: "scrapy",
    name: "Scrapy",
    rule: "a random 0.5 to 1.5 s, from the start of each request",
    setting: "DOWNLOAD_DELAY 1 s, DOWNLOAD_DELAY_JITTER 0.5",
    sources: [
      { label: "Settings", href: "https://docs.scrapy.org/en/latest/topics/settings.html" },
    ],
  },
  {
    id: "crawl4ai",
    name: "Crawl4AI",
    rule: "a random 0.1 to 0.4 s, from the start of each request",
    setting: "arun_many: mean_delay 0.1 s, max_range 0.3 s",
    sources: [
      { label: "Parameters", href: "https://docs.crawl4ai.com/api/parameters/" },
      {
        label: "Multi-URL crawling",
        href: "https://docs.crawl4ai.com/advanced/multi-url-crawling/",
      },
    ],
  },
];

/** One request of the timeline, in milliseconds from the first request. */
export interface PaceRequest {
  readonly start: number;
  readonly end: number;
}

/** The requests of one tool. */
export interface PaceLane {
  readonly tool: ToolId;
  readonly requests: readonly PaceRequest[];
  /** This value is the number of requests that start in the timeline, for each minute. */
  readonly perMinute: number;
}

/** A small random generator with a seed, so that each replay is the same. */
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

const between = (random: () => number, low: number, high: number): number =>
  low + random() * (high - low);

/** This rule gives the start of the next request from the start and the end of the last request. */
type Next = (start: number, end: number) => number;

/** This function makes the rule of the next request of one tool. */
const nextOf = (tool: ToolId, latencyMs: number, random: () => number): Next => {
  if (tool === "polite") {
    // the real rest of polite-crawler: it starts at the end of the request
    const rest = restAfter(DEFAULT_POLICY, { kind: "page", elapsedMs: latencyMs }).ms;
    return (_start, end) => end + rest;
  }
  if (tool === "crawlee") return (_start, end) => end;
  if (tool === "scrapy") {
    // DOWNLOAD_DELAY from the start of the last request, with a jitter of ±50%, one request at a time
    return (start, end) => Math.max(end, start + SECOND * between(random, 0.5, 1.5));
  }
  // Crawl4AI: the RateLimiter of arun_many waits its current delay from the start of the last
  // request. After a success, the delay is the longer of a new random delay and 3/4 of the old delay.
  let delay = between(random, 0.1, 0.4) * SECOND;
  return (start, end) => {
    delay = Math.max(between(random, 0.1, 0.4) * SECOND, delay * 0.75);
    return Math.max(end, start + delay);
  };
};

/** This function gives the requests of each tool to one site, with a server that answers in `latencyMs`. */
export const simulatePace = (latencyMs: number, seed = 5): PaceLane[] =>
  PACE_TOOLS.map((tool) => {
    const random = seeded(seed + tool.id.length);
    const next = nextOf(tool.id, latencyMs, random);
    const requests: PaceRequest[] = [];
    for (let start = 0; start < PACE_SPAN;) {
      const end = start + latencyMs;
      requests.push({ start, end });
      start = next(start, end);
    }
    return { tool: tool.id, requests, perMinute: requests.length / (PACE_SPAN / 60_000) };
  });
