import { wilson } from "@mark1russell7/rigor-statistics";
import { describe, expect, it } from "vitest";
import type { BestOutcome, LinksOutcome, VenueLabel } from "./label.mts";
import {
  markdownOf,
  rateOf,
  scoreBest,
  scoreLinks,
  scoresOf,
  splitVenues,
  SPLIT_SEED,
} from "./score.mts";

/** A made-up label with only the fields that the scores read. */
const labelOf = (
  links_outcome: LinksOutcome,
  best_outcome: BestOutcome,
  extra: Partial<VenueLabel> = {},
): VenueLabel => ({
  osm: "node/1",
  area: "one",
  half: "train",
  website: "https://venue.example/",
  home: "https://venue.example/",
  osm_hours: "",
  home_label: "no-hours",
  links: [],
  rule_pages: 3,
  readings: [],
  best: null,
  links_outcome,
  best_outcome,
  ...extra,
});

const venuesOf = (area: string, count: number, type = "node") =>
  Array.from({ length: count }, (_, at) => ({ osm: `${type}/${String(at + 1)}`, area }));

describe("the split", () => {
  const venues = [...venuesOf("one", 21), ...venuesOf("two", 10, "way")];

  it("gives the same halves at each run, and for each order of the input", () => {
    const first = splitVenues(venues);
    expect([...splitVenues(venues)]).toEqual([...first]);
    expect(Object.fromEntries(splitVenues([...venues].reverse()))).toEqual(
      Object.fromEntries(first),
    );
  });

  it("splits each area in two halves, with one more venue in the train half for an odd count", () => {
    const halves = splitVenues(venues);
    const countOf = (area: string, half: string) =>
      venues.filter((venue) => venue.area === area && halves.get(venue.osm) === half).length;
    expect([countOf("one", "train"), countOf("one", "test")]).toEqual([11, 10]);
    expect([countOf("two", "train"), countOf("two", "test")]).toEqual([5, 5]);
  });

  it("does not put the venues in order of their ids", () => {
    const halves = splitVenues(venuesOf("one", 40));
    const train = venuesOf("one", 40).filter((venue) => halves.get(venue.osm) === "train");
    expect(train.map((venue) => venue.osm)).not.toEqual(
      venuesOf("one", 20).map((venue) => venue.osm),
    );
  });

  it("gives a different split with a different seed", () => {
    const venues = venuesOf("one", 40);
    const halves = (seed: string) =>
      venues.map((venue) => splitVenues(venues, seed).get(venue.osm)).join(",");
    expect(halves(SPLIT_SEED)).not.toBe(halves("another seed"));
  });
});

describe("a rate", () => {
  it("has the 95% Wilson interval of rigor-statistics", () => {
    const rate = rateOf(7, 10);
    const interval = wilson(7, 10);
    expect(rate).toMatchObject({ k: 7, n: 10, value: 0.7 });
    expect(rate.low).toBeCloseTo(interval.low, 4);
    expect(rate.high).toBeCloseTo(interval.high, 4);
    expect(rate.low).toBeLessThan(0.7);
    expect(rate.high).toBeGreaterThan(0.7);
  });

  it("has no value with no venue", () => {
    expect(rateOf(0, 0)).toEqual({ k: 0, n: 0, value: null, low: 0, high: 1 });
  });

  it("refuses counts that are not a rate", () => {
    expect(() => rateOf(3, 2)).toThrow(RangeError);
    expect(() => rateOf(-1, 2)).toThrow(RangeError);
    expect(() => rateOf(0.5, 2)).toThrow(RangeError);
  });
});

describe("the score of the choice of links", () => {
  it("counts each outcome in its place", () => {
    const outcomes: LinksOutcome[] = [
      "no-home",
      "home-agrees",
      "home-agrees",
      "rule-hit",
      "rule-hit",
      "rule-hit",
      "rule-miss",
      "no-page-agrees",
    ];
    const score = scoreLinks(outcomes.map((outcome) => labelOf(outcome, "no-reading")));
    expect(score.venues).toBe(8);
    expect(score.no_home).toBe(1);
    expect(score.home_agrees).toMatchObject({ k: 2, n: 7 });
    expect(score.no_page_agrees).toMatchObject({ k: 1, n: 7 });
    expect(score.rule).toMatchObject({ k: 3, n: 4, value: 0.75 });
  });

  it("has no value for the rule when no venue needs a link", () => {
    expect(scoreLinks([labelOf("home-agrees", "hit")]).rule.value).toBeNull();
  });
});

describe("the score of the choice of the best reading", () => {
  it("counts each outcome in its place", () => {
    const outcomes: BestOutcome[] = [
      "no-home",
      "no-reading",
      "no-reading",
      "none-agrees",
      "hit",
      "hit",
      "miss",
    ];
    const score = scoreBest(outcomes.map((outcome) => labelOf("no-page-agrees", outcome)));
    expect(score).toMatchObject({ venues: 7, no_home: 1, no_reading: 2 });
    expect(score.none_agrees).toMatchObject({ k: 1, n: 4 });
    expect(score.rule).toMatchObject({ k: 2, n: 3 });
  });
});

describe("the scores of the groups", () => {
  const labels = [
    labelOf("rule-hit", "hit", { area: "one", half: "train" }),
    labelOf("rule-miss", "miss", { area: "one", half: "test" }),
    labelOf("rule-hit", "hit", { area: "two", half: "test" }),
  ];

  it("scores all the venues, each half and each area", () => {
    const scores = scoresOf(labels, scoreLinks);
    expect(scores.all.rule).toMatchObject({ k: 2, n: 3 });
    expect(scores.train.rule).toMatchObject({ k: 1, n: 1 });
    expect(scores.test.rule).toMatchObject({ k: 1, n: 2 });
    expect(Object.keys(scores.areas)).toEqual(["one", "two"]);
    expect(scores.areas["one"]?.rule).toMatchObject({ k: 1, n: 2 });
  });

  it("writes the tables with the attribution of OpenStreetMap", () => {
    const markdown = markdownOf(scoresOf(labels, scoreLinks), scoresOf(labels, scoreBest), {
      attribution: "© OpenStreetMap contributors (ODbL)",
      commit: null,
      wacz: "decisions.wacz",
    });
    expect(markdown).toContain("© OpenStreetMap contributors (ODbL)");
    expect(markdown).toContain("| all | 3 | 0 |");
    expect(markdown).toContain("| area two | 1 |");
    expect(markdown).toContain("66.7% (2 of 3;");
  });
});
