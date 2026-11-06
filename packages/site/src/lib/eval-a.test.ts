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
    // The build takes the newest run each week, so the test checks the rule and not the numbers of one run.
    for (const order of ["run", "short", "long"] as const) {
      const points = sessionTotals(ordered(claims, order), toolDefinitions);
      const from = stayAheadFrom(points);
      expect(from, order).toBeDefined();
      // Each total from that claim on is below the proxy, and the total before it is not.
      const after = points.filter((point) => point.n >= from!);
      expect(after.filter((point) => point.polite >= point.markdown)).toEqual([]);
      const before = points.find((point) => point.n === from! - 1);
      expect(before === undefined || before.polite >= before.markdown, order).toBe(true);
    }
    const claim = { ...claims[0]!, polite: 10 };
    const session = [
      { ...claim, markdown: 30 },
      { ...claim, markdown: 1 },
      { ...claim, markdown: 50 },
    ];
    // The totals are 15 against 30, 25 against 31 and 35 against 81, with 5 tokens of definitions.
    expect(stayAheadFrom(sessionTotals(session, 5))).toBe(1);
    // With 20 tokens of definitions: 30 against 30, 40 against 31 and 50 against 81.
    expect(stayAheadFrom(sessionTotals(session, 20))).toBe(3);
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
    const claim = claims[0]!;
    expect(ratioText({ ...claim, markdown: 5650, polite: 100 })).toBe("57 times fewer");
    expect(ratioText({ ...claim, markdown: 250, polite: 100 })).toBe("2.5 times fewer");
    expect(ratioText({ ...claim, markdown: 100, polite: 520 })).toBe("5.2 times more");
  });
});
