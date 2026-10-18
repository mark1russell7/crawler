import { describe, expect, it } from "vitest";
import { PACE_SPAN, simulatePace } from "./pace-compare.ts";

const lane = (latencyMs: number, tool: string) =>
  simulatePace(latencyMs).find((one) => one.tool === tool)!;

describe("the default pace of each crawler", () => {
  it("rests polite-crawler 3 seconds after a fast answer, and 5 times the time of a slow answer", () => {
    const fast = lane(200, "polite").requests;
    expect(fast[1]!.start - fast[0]!.end).toBe(3000);
    const slow = lane(2000, "polite").requests;
    expect(slow[1]!.start - slow[0]!.end).toBe(10_000);
    // 12 seconds from the start of one request to the next: 15 requests in 3 minutes
    expect(slow).toHaveLength(15);
  });

  it("starts the next request of Crawlee at the end of the last one", () => {
    const requests = lane(200, "crawlee").requests;
    expect(requests[1]!.start).toBe(requests[0]!.end);
    expect(requests).toHaveLength(PACE_SPAN / 200);
  });

  it("keeps the delay of Scrapy between 0.5 and 1.5 seconds from the start of a request", () => {
    const requests = lane(200, "scrapy").requests;
    for (let index = 1; index < requests.length; index += 1) {
      const gap = requests[index]!.start - requests[index - 1]!.start;
      expect(gap).toBeGreaterThanOrEqual(500);
      expect(gap).toBeLessThanOrEqual(1500);
    }
  });

  it("keeps the delay of Crawl4AI between 0.1 and 0.4 seconds, or the time of the answer", () => {
    const requests = lane(200, "crawl4ai").requests;
    for (let index = 1; index < requests.length; index += 1) {
      const gap = requests[index]!.start - requests[index - 1]!.start;
      expect(gap).toBeGreaterThanOrEqual(200);
      expect(gap).toBeLessThanOrEqual(400);
    }
  });

  it("sends one request at a time in each lane", () => {
    for (const one of simulatePace(500))
      for (let index = 1; index < one.requests.length; index += 1)
        expect(one.requests[index]!.start).toBeGreaterThanOrEqual(one.requests[index - 1]!.end);
  });
});
