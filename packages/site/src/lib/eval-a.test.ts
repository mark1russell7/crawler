import { describe, expect, it } from "vitest";
import data from "../data/eval-a.json";
import type { EvalData } from "./eval-a.ts";
import {
  costsMore,
  logScale,
  logTicks,
  ordered,
  ratioText,
  sessionTotals,
  stayAheadFrom,
  tickText,
} from "./eval-a.ts";

const evalA = data as EvalData;
const { claims, summary, toolDefinitions } = evalA;

describe("the data of eval part A", () => {
  it("has each claim of the run, each one verified, and agrees with the summary of the run", () => {
    expect(claims).toHaveLength(summary.claims);
    expect(summary.verified).toBe(summary.claims);
    const sum = (key: "polite" | "markdown" | "text" | "paged"): number =>
      claims.reduce((total, claim) => total + claim[key], 0);
    expect(sum("polite")).toBe(summary.polite.total);
    expect(sum("markdown")).toBe(summary.markdown.total);
    expect(sum("text")).toBe(summary.text.total);
    expect(sum("paged")).toBe(summary.paged.total);
    expect(Math.round((summary.markdown.total / summary.polite.total) * 100) / 100).toBe(
      summary.ratio.markdownTotal,
    );
  });

  it("gives the polite-crawler path as the sum of its four steps", () => {
    for (const claim of claims)
      expect(claim.fetch + claim.find + claim.read + claim.verify).toBe(claim.polite);
  });

  it("names the claims on which polite-crawler costs more: the very short pages", () => {
    expect(claims.filter(costsMore).map((claim) => claim.id)).toEqual([
      "rfc2119-must",
      "rfc1149-service",
      "python-zen-first",
      "gov-declaration-equal",
    ]);
  });
});

describe("a session of 30 claims", () => {
  it("adds the tool definitions one time, at the start", () => {
    const points = sessionTotals(claims, toolDefinitions);
    expect(points[0]!.polite).toBe(toolDefinitions + claims[0]!.polite);
    expect(points.at(-1)!.polite).toBe(toolDefinitions + summary.polite.total);
    expect(points.at(-1)!.markdown).toBe(summary.markdown.total);
  });

  it("gives the claim from which polite-crawler stays below the proxy, for each order", () => {
    const from = (order: "run" | "short" | "long"): number | undefined =>
      stayAheadFrom(sessionTotals(ordered(claims, order), toolDefinitions));
    expect(from("run")).toBe(4);
    expect(from("short")).toBe(13);
    expect(from("long")).toBe(1);
  });

  it("orders the claims by the size of the page as Markdown", () => {
    const short = ordered(claims, "short");
    expect(short[0]!.id).toBe("rfc1149-service");
    expect(short.at(-1)!.id).toMatch(/^rfc9110-/);
    expect(ordered(claims, "long")[0]!.markdown).toBe(short.at(-1)!.markdown);
    expect(ordered(claims, "run").map((claim) => claim.id)).toEqual(
      claims.map((claim) => claim.id),
    );
  });

  it("gives no claim when the total never stays below", () => {
    const one = { ...claims[0]!, polite: 10, markdown: 5 };
    expect(stayAheadFrom(sessionTotals([one, one], 0))).toBeUndefined();
  });
});

describe("the scale and the text", () => {
  it("places a value on a log scale, and clamps a value outside it", () => {
    const place = logScale(100, 100_000);
    expect(place(100)).toBe(0);
    expect(place(10_000)).toBeCloseTo(66.67, 1);
    expect(place(100_000)).toBe(100);
    expect(place(10)).toBe(0);
  });

  it("gives the ticks 1, 2 and 5 of each power of ten, and their text", () => {
    expect(logTicks(400, 200_000)).toEqual([
      500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000,
    ]);
    expect([500, 2000, 100_000, 1_000_000].map(tickText)).toEqual(["500", "2k", "100k", "1M"]);
  });

  it("writes a ratio as fewer or more tokens", () => {
    const long = claims.find((claim) => claim.id === "rfc9110-404")!;
    const short = claims.find((claim) => claim.id === "rfc1149-service")!;
    expect(ratioText(long)).toBe("57 times fewer");
    expect(ratioText(short)).toBe("5.2 times more");
  });
});
