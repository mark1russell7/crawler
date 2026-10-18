import { describe, expect, it } from "vitest";
import type { VisitInput, VisitRow } from "./site-visit.ts";
import { CRAWL_PAGES, VISIT_ROBOTS, simulateVisit, statsOf } from "./site-visit.ts";

const base: VisitInput = {
  robots: VISIT_ROBOTS,
  scenario: "fetch",
  answer: "ok",
  latencyMs: 200,
};

const requests = (rows: readonly VisitRow[]): VisitRow[] =>
  rows.filter((row) => row.kind === "request");

describe("an hour of PoliteCrawler on a site", () => {
  it("reads robots.txt first, one time, and then sends one request at a time with the crawl delay", async () => {
    const { rows } = await simulateVisit(base);
    const sent = requests(rows);
    expect(sent[0]?.path).toBe("/robots.txt");
    expect(sent.filter((row) => row.path === "/robots.txt")).toHaveLength(1);
    for (let index = 2; index < sent.length; index += 1) {
      const before = sent[index - 1]!;
      expect(sent[index]!.at - before.end!).toBeGreaterThanOrEqual(5000);
    }
    expect(statsOf(rows).mostAtOnce).toBe(1);
  });

  it("answers a second question from the store and a refused path from robots.txt, with no request", async () => {
    const { rows } = await simulateVisit(base);
    expect(rows.some((row) => row.kind === "store" && row.path === "/menu")).toBe(true);
    expect(rows.some((row) => row.kind === "refused" && row.path === "/account/orders")).toBe(true);
    expect(requests(rows).map((row) => row.path)).toEqual([
      "/robots.txt",
      "/",
      "/menu",
      "/hours",
      "/contact",
    ]);
  });

  it("stops the site for 1 hour after a 403", async () => {
    const { rows, stop } = await simulateVisit({ ...base, answer: "403" });
    expect(stop?.until).toBe((stop?.at ?? 0) + 3_600_000);
    const forbidden = rows.findIndex((row) => row.status === 403);
    expect(forbidden).toBeGreaterThan(0);
    expect(requests(rows.slice(forbidden + 1))).toHaveLength(0);
    expect(rows.filter((row) => row.kind === "stopped").length).toBeGreaterThan(0);
  });

  it("waits the time of Retry-After after a 429", async () => {
    const { rows } = await simulateVisit({ ...base, answer: "429" });
    const sent = requests(rows);
    const limited = sent.findIndex((row) => row.status === 429);
    expect(sent[limited]?.wait?.kind).toBe("retry-after");
    expect(sent[limited + 1]!.at - sent[limited]!.end!).toBeGreaterThanOrEqual(120_000);
  });

  it("stops the site when Retry-After is longer than 1 hour", async () => {
    const { rows, stop } = await simulateVisit({ ...base, answer: "429-long" });
    expect(stop?.reason).toBe("asked to wait 7200 s");
    const limited = rows.findIndex((row) => row.status === 429);
    expect(requests(rows.slice(limited + 1))).toHaveLength(0);
  });

  it("ends a crawl at its limit of pages, or at its budget with a long crawl delay", async () => {
    const crawl = await simulateVisit({ ...base, scenario: "crawl", robots: VISIT_ROBOTS });
    expect(crawl.rows.at(-1)?.note).toMatch(/at its limit of 12 pages/);
    expect(requests(crawl.rows)).toHaveLength(CRAWL_PAGES + 1);
    const slow = await simulateVisit({
      ...base,
      scenario: "crawl",
      robots: "User-agent: *\nCrawl-delay: 90\n",
    });
    expect(slow.rows.at(-1)?.note).toMatch(/at its budget/);
    // the crawler obeys a crawl delay up to 60 seconds
    const pages = requests(slow.rows).slice(1);
    expect(pages[1]!.at - pages[0]!.end!).toBe(60_000);
  });

  it("rechecks a watched page with a conditional request", async () => {
    const { rows } = await simulateVisit({ ...base, scenario: "watch" });
    const checks = requests(rows).slice(1);
    expect(checks.map((row) => row.status)).toEqual([304, 304, 200, 304]);
    for (const check of checks) expect(check.sent).toEqual(["If-None-Match", "If-Modified-Since"]);
  });
});
