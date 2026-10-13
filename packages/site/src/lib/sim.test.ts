import { describe, expect, it } from "vitest";
import type { Segment } from "./sim.ts";
import {
  SITES,
  Timeline,
  VirtualClock,
  askAgain,
  crawlImpolitely,
  crawlPolitely,
  endOf,
  peakOf,
} from "./sim.ts";

const run = async (crawl: typeof crawlPolitely) => {
  const clock = new VirtualClock();
  const timeline = new Timeline();
  const done = crawl(SITES, clock, timeline);
  let finished = false;
  void done.then(() => (finished = true));
  for (let t = 0; !finished && t < 120_000; t += 250) await clock.advanceTo(t);
  expect(finished).toBe(true);
  return timeline;
};

const requests = (lane: readonly Segment[]) =>
  lane.filter(
    (segment): segment is Extract<Segment, { kind: "request" }> => segment.kind === "request",
  );

describe("the polite crawl", () => {
  it("keeps one request in progress for each host, with a rest of 3 seconds or more between two", async () => {
    const timeline = await run(crawlPolitely);
    for (const site of SITES) {
      const lane = requests(timeline.lane(site.host));
      for (let index = 1; index < lane.length; index += 1) {
        const before = lane[index - 1]!;
        expect(lane[index]!.start - before.end!).toBeGreaterThanOrEqual(3000);
      }
    }
  });

  it("rests longer after a slow page, a 429 and a crawl delay", async () => {
    const timeline = await run(crawlPolitely);
    const gap = (host: string) => {
      const [a, b] = requests(timeline.lane(host));
      return b!.start - a!.end!;
    };
    expect(gap("museum.example")).toBe(11_000);
    expect(gap("news.example")).toBe(8000);
    const busy = requests(timeline.lane("api.busy.example"));
    expect(busy[2]!.start - busy[1]!.end!).toBe(9000);
  });

  it("stops a host after a 403, and fetches nothing from a site that robots.txt refuses", async () => {
    const timeline = await run(crawlPolitely);
    expect(requests(timeline.lane("shop.example"))).toHaveLength(1);
    expect(
      timeline.lane("shop.example").filter((segment) => segment.kind === "refused"),
    ).toHaveLength(2);
    expect(requests(timeline.lane("members.example"))).toHaveLength(0);
    expect(endOf(timeline)).toBeLessThan(25_000);
  });

  it("measures one request at a time to each host", async () => {
    const timeline = await run(crawlPolitely);
    expect(peakOf(timeline.segments, endOf(timeline))).toBe(1);
  });

  it("answers the second time from the store, with no request", async () => {
    const timeline = await run(crawlPolitely);
    const sent = timeline.requests;
    askAgain(SITES, timeline, endOf(timeline) + 2000);
    expect(timeline.requests).toBe(sent);
    expect(timeline.stored).toBe(19);
  });
});

describe("the impolite crawl", () => {
  it("sends all pages of a host at the same time", async () => {
    const timeline = await run(crawlImpolitely);
    const wiki = requests(timeline.lane("en.wikipedia.org"));
    expect(new Set(wiki.map((request) => request.start))).toEqual(new Set([0]));
    expect(requests(timeline.lane("members.example"))).toHaveLength(3);
  });

  it("measures the requests at once to one host from the lanes", async () => {
    const timeline = await run(crawlImpolitely);
    expect(peakOf(timeline.segments, endOf(timeline))).toBe(
      Math.max(...SITES.map((site) => site.pages.length)),
    );
    // two requests in sequence do not overlap
    expect(
      peakOf(
        [
          { kind: "request", host: "a", start: 0, end: 100, status: 200, row: 0 },
          { kind: "request", host: "a", start: 100, end: 200, status: 200, row: 0 },
        ],
        300,
      ),
    ).toBe(1);
  });
});
