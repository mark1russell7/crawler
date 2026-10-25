import { describe, expect, it } from "vitest";
import partA from "../data/eval-a.json";
import data from "../data/eval-b.json";
import type { Arm, EvalBData, Run } from "./eval-b.ts";
import {
  ARMS,
  bySize,
  change,
  claimCost,
  costRatio,
  costsLess,
  linearScale,
  linearTicks,
  median,
  nextIndex,
  onPageOf,
  ratioText,
  seriesOf,
  sessionsOf,
  usd,
  webfetchRunOf,
} from "./eval-b.ts";

const evalB = data as EvalBData;
const { claims, runs } = evalB;
const runOf = (id: string): Run => runs.find((run) => run.id === id)!;
const sonnet = runOf("sonnet-0.2.1");
const opus = runOf("opus-0.2.1");
const lean = runOf("sonnet-0.2.3");

describe("the data of eval part B", () => {
  it("has each claim of part A, with each session of each run in each of its arms", () => {
    expect(claims.map((claim) => claim.id)).toEqual(partA.claims.map((claim) => claim.id));
    for (const run of runs)
      for (const { id: arm } of ARMS) {
        const summary = run.arms[arm];
        const sessions = claims.flatMap((claim) => sessionsOf(claim, run.id, arm));
        expect(sessions).toHaveLength(summary?.sessions ?? 0);
        expect(sessions).toHaveLength(summary === undefined ? 0 : claims.length * run.repeat);
      }
  });

  it("agrees with the summary of each arm", () => {
    for (const run of runs)
      for (const { id: arm } of ARMS) {
        const summary = run.arms[arm];
        if (summary === undefined) continue;
        const sessions = claims.flatMap((claim) => sessionsOf(claim, run.id, arm));
        const cost = sessions.reduce((total, session) => total + session.usd, 0);
        expect(cost).toBeCloseTo(summary.costUsd, 4);
        expect(summary.mainUsd + summary.helperUsd).toBeCloseTo(summary.costUsd, 5);
        const kinds = summary.mainKindsUsd;
        expect(kinds.input + kinds.cacheWrite + kinds.cacheRead + kinds.output).toBeCloseTo(
          summary.mainUsd,
          5,
        );
        expect(onPageOf(sessions)).toBe(summary.onPage);
        expect(sessions.filter((session) => session.check === "verified")).toHaveLength(
          summary.verified,
        );
        expect(median(sessions.map((session) => session.usd))).toBeCloseTo(
          summary.medianCostUsd,
          5,
        );
        expect(summary.costPerOnPageUsd).toBeCloseTo(summary.costUsd / summary.onPage, 5);
      }
  });

  it("gives the numbers of polite-crawler-mcp 0.2.1", () => {
    const cell = (arm: Arm, run = sonnet) => run.arms[arm]!;
    expect([cell("mcp").onPage, cell("webfetch").onPage]).toEqual([88, 82]);
    expect([cell("mcp", opus).onPage, cell("webfetch", opus).onPage]).toEqual([29, 30]);
    expect(usd(cell("mcp").medianCostUsd)).toBe("$0.0177");
    expect(usd(cell("webfetch").medianCostUsd)).toBe("$0.0099");
    expect(usd(cell("mcp").costPerOnPageUsd)).toBe("$0.0220");
    expect(usd(cell("webfetch").costPerOnPageUsd)).toBe("$0.0132");
    expect(usd(cell("mcp", opus).medianCostUsd)).toBe("$0.0408");
    expect(usd(cell("webfetch", opus).medianCostUsd)).toBe("$0.0201");
    expect(usd(cell("mcp", opus).costPerOnPageUsd)).toBe("$0.0464");
    expect(usd(cell("webfetch", opus).costPerOnPageUsd)).toBe("$0.0244");
    expect([cell("mcp").medianReadTokens, cell("webfetch").medianReadTokens]).toEqual([
      35_628, 19_945,
    ]);
    expect(usd(cell("webfetch").mainUsd)).toBe("$0.8019");
    expect(usd(cell("webfetch").helperUsd)).toBe("$0.2835");
    expect(usd(evalB.versions[0]!.costUsd)).toBe("$5.1755");
  });

  it("gives the numbers of polite-crawler-mcp 0.2.3, with WebFetch from the run of 0.2.1", () => {
    expect(lean.mcp).toBe("0.2.3");
    expect(lean.arms.webfetch).toBeUndefined();
    expect(lean.webfetchFrom).toBe(sonnet.id);
    expect(webfetchRunOf(lean)).toBe(sonnet.id);
    expect(webfetchRunOf(sonnet)).toBe(sonnet.id);
    const mcp = lean.arms.mcp!;
    const quote = lean.arms["mcp-quote"]!;
    expect([mcp.onPage, quote.onPage]).toEqual([86, 88]);
    expect([mcp.verified, quote.verified]).toEqual([81, 81]);
    expect([usd(mcp.medianCostUsd), usd(quote.medianCostUsd)]).toEqual(["$0.0166", "$0.0158"]);
    expect([usd(mcp.costPerOnPageUsd), usd(quote.costPerOnPageUsd)]).toEqual([
      "$0.0197",
      "$0.0188",
    ]);
    expect([mcp.medianReadTokens, quote.medianReadTokens]).toEqual([24_829, 21_752]);
    const before = sonnet.arms.mcp!;
    expect(change(before.medianReadTokens, mcp.medianReadTokens)).toBe(-30);
    expect(change(before.medianReadTokens, quote.medianReadTokens)).toBe(-39);
    expect(change(before.medianCostUsd, mcp.medianCostUsd)).toBe(-6);
    expect(change(before.medianCostUsd, quote.medianCostUsd)).toBe(-11);
    expect(change(before.costPerOnPageUsd, mcp.costPerOnPageUsd)).toBe(-10);
    expect(change(before.costPerOnPageUsd, quote.costPerOnPageUsd)).toBe(-14);
    expect(usd(lean.costUsd)).toBe("$3.3529");
    expect(usd(evalB.versions[1]!.dryRun.costUsd)).toBe("$0.0879");
  });

  it("splits the cost by the kind of token: the writes to the cache are the largest part", () => {
    const quote = lean.arms["mcp-quote"]!;
    const webfetch = sonnet.arms.webfetch!;
    expect(quote.mainTokens).toEqual({
      input: 8,
      cacheWrite: 4501.5,
      cacheRead: 17_744,
      output: 328,
    });
    expect(webfetch.mainTokens).toEqual({
      input: 4,
      cacheWrite: 2206,
      cacheRead: 4415,
      output: 184.5,
    });
    expect(webfetch.helperTokens.input).toBe(13_132.5);
    expect(quote.helperTokens).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    expect(quote.mainKindsUsd.cacheWrite / quote.costUsd).toBeCloseTo(0.689, 3);
    // the writes to the cache cost more than the whole difference between the arms
    const gap = quote.costUsd - webfetch.costUsd;
    expect(quote.mainKindsUsd.cacheWrite - webfetch.mainKindsUsd.cacheWrite).toBeGreaterThan(gap);
    const sonnetPrices = evalB.prices[sonnet.model]!;
    expect(sonnetPrices.cacheWrite! / sonnetPrices.cacheRead!).toBeCloseTo(25, 9);
    expect(evalB.prices[evalB.helper]!.input).toBe(sonnetPrices.cacheRead);
  });

  it("adds up the cost of each version and of the whole eval", () => {
    for (const version of evalB.versions) {
      const mine = runs.filter((run) => run.mcp === version.mcp);
      const total = version.dryRun.costUsd + mine.reduce((sum, run) => sum + run.costUsd, 0);
      expect(total).toBeCloseTo(version.costUsd, 5);
    }
    const all = evalB.versions.reduce((sum, version) => sum + version.costUsd, 0);
    expect(all).toBeCloseTo(evalB.costUsd, 5);
    expect(usd(evalB.costUsd)).toBe("$8.6163");
  });

  it("names the claims on which polite-crawler costs less: the longest pages", () => {
    const less = (run: Run, arm: Arm = "mcp"): string[] =>
      claims.filter((claim) => costsLess(claim, run, arm)).map((claim) => claim.id);
    expect(less(sonnet)).toEqual(["rfc9110-404", "w3c-wcag21-scope"]);
    expect(less(opus)).toEqual(["rfc9110-404", "wikipedia-web-crawler"]);
    // the page says that the two arms of 0.2.3 cost less on the same claims as 0.2.1
    expect(less(lean)).toEqual(less(sonnet));
    expect(less(lean, "mcp-quote")).toEqual(less(sonnet));
    const rfc = claims.find((claim) => claim.id === "rfc9110-404")!;
    expect(costRatio(rfc, sonnet)).toBeCloseTo(
      claimCost(rfc, sonnet.id, "mcp") / claimCost(rfc, sonnet.id, "webfetch"),
      9,
    );
    expect(costRatio(rfc, lean, "mcp-quote")).toBeCloseTo(
      claimCost(rfc, lean.id, "mcp-quote") / claimCost(rfc, sonnet.id, "webfetch"),
      9,
    );
  });

  it("gives the series of a run, with the WebFetch arm of an earlier run", () => {
    expect(seriesOf(sonnet)).toEqual([
      { arm: "mcp", run: sonnet.id, earlier: false },
      { arm: "webfetch", run: sonnet.id, earlier: false },
    ]);
    expect(seriesOf(lean)).toEqual([
      { arm: "mcp", run: lean.id, earlier: false },
      { arm: "mcp-quote", run: lean.id, earlier: false },
      { arm: "webfetch", run: sonnet.id, earlier: true },
    ]);
  });
});

describe("the order, the scale and the text", () => {
  it("orders the claims by the size of the page in part A", () => {
    const sorted = bySize(claims);
    expect(sorted[0]!.id).toBe("rfc1149-service");
    expect(sorted.at(-1)!.id).toBe("rfc9110-418");
    for (let index = 1; index < sorted.length; index++)
      expect(sorted[index]!.markdown).toBeGreaterThanOrEqual(sorted[index - 1]!.markdown);
  });

  it("gives the median of an odd and an even count", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });

  it("places a value on a linear scale, and clamps a value outside it", () => {
    const place = linearScale(0.125);
    expect(place(0)).toBe(0);
    expect(place(0.0625)).toBe(50);
    expect(place(0.2)).toBe(100);
    expect(place(-1)).toBe(0);
    expect(linearTicks(0.125, 0.02)).toEqual([0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.12]);
  });

  it("writes a ratio, an amount and a change", () => {
    expect(ratioText(2)).toBe("2.0× more");
    expect(ratioText(0.5)).toBe("2.0× less");
    expect(usd(0.017678)).toBe("$0.0177");
    expect(usd(0.04, 2)).toBe("$0.04");
    expect(change(100, 94)).toBe(-6);
    expect(change(100, 150)).toBe(50);
  });

  it("moves a selection with the arrow keys, Home and End", () => {
    expect(nextIndex("ArrowDown", 0, 30)).toBe(1);
    expect(nextIndex("ArrowUp", 0, 30)).toBe(0);
    expect(nextIndex("ArrowRight", 29, 30)).toBe(29);
    expect(nextIndex("End", 3, 30)).toBe(29);
    expect(nextIndex("Home", 3, 30)).toBe(0);
    expect(nextIndex("Enter", 3, 30)).toBeUndefined();
  });
});
