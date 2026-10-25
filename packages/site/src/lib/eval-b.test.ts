import { describe, expect, it } from "vitest";
import partA from "../data/eval-a.json";
import data from "../data/eval-b.json";
import type { Arm, EvalBData } from "./eval-b.ts";
import {
  ARMS,
  bySize,
  claimCost,
  costRatio,
  costsLess,
  linearScale,
  linearTicks,
  median,
  nextIndex,
  onPageOf,
  ratioText,
  sessionsOf,
  usd,
} from "./eval-b.ts";

const evalB = data as EvalBData;
const { claims, models } = evalB;
const sonnet = models.find((model) => model.id === "sonnet")!;
const opus = models.find((model) => model.id === "opus")!;

describe("the data of eval part B", () => {
  it("has each claim of part A, with each session of each model in each arm", () => {
    expect(claims.map((claim) => claim.id)).toEqual(partA.claims.map((claim) => claim.id));
    for (const model of models)
      for (const { id: arm } of ARMS) {
        const sessions = claims.flatMap((claim) => sessionsOf(claim, model.id, arm));
        expect(sessions).toHaveLength(model.arms[arm].sessions);
        expect(sessions).toHaveLength(claims.length * model.repeat);
      }
  });

  it("agrees with the summary of each arm", () => {
    for (const model of models)
      for (const { id: arm } of ARMS) {
        const summary = model.arms[arm];
        const sessions = claims.flatMap((claim) => sessionsOf(claim, model.id, arm));
        const cost = sessions.reduce((total, session) => total + session.usd, 0);
        expect(cost).toBeCloseTo(summary.costUsd, 4);
        expect(summary.mainUsd + summary.helperUsd).toBeCloseTo(summary.costUsd, 5);
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

  it("gives the numbers of the page", () => {
    const cell = (arm: Arm, model = sonnet) => model.arms[arm];
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
    expect(usd(evalB.costUsd)).toBe("$5.1755");
    const total = evalB.dryRun.costUsd + models.reduce((sum, model) => sum + model.costUsd, 0);
    expect(total).toBeCloseTo(evalB.costUsd, 5);
  });

  it("names the claims on which polite-crawler costs less: the longest pages", () => {
    const less = (model: string): string[] =>
      claims.filter((claim) => costsLess(claim, model)).map((claim) => claim.id);
    expect(less("sonnet")).toEqual(["rfc9110-404", "w3c-wcag21-scope"]);
    expect(less("opus")).toEqual(["rfc9110-404", "wikipedia-web-crawler"]);
    const rfc = claims.find((claim) => claim.id === "rfc9110-404")!;
    expect(costRatio(rfc, "sonnet")).toBeCloseTo(
      claimCost(rfc, "sonnet", "mcp") / claimCost(rfc, "sonnet", "webfetch"),
      9,
    );
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

  it("writes a ratio and an amount", () => {
    expect(ratioText(2)).toBe("2.0× more");
    expect(ratioText(0.5)).toBe("2.0× less");
    expect(usd(0.017678)).toBe("$0.0177");
    expect(usd(0.04, 2)).toBe("$0.04");
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
