/**
 * The split and the scores of the decision eval. Each function here is pure.
 *
 * - `splitVenues` puts each venue in the train half or the test half, by a seeded hash of its
 *   OpenStreetMap id, in each area.
 * - `scoreLinks` and `scoreBest` count the outcomes of the two choices of the rule. Each rate has
 *   a 95% Wilson interval.
 */
import { deriveSeed, seedOf } from "@mark1russell7/rigor-generators";
import { Z95, wilson } from "@mark1russell7/rigor-statistics";
import type { Half, VenueLabel } from "./label.mts";

/** The seed of the split. A different seed gives a different split. */
export const SPLIT_SEED = "polite-crawler decisions split 1";

/**
 * This function puts each venue in a half. In each area, it orders the venues by a seeded hash of
 * the id, and the first half of the order is the train half. With an odd count, the train half
 * has one more venue. The result does not depend on the order of the input.
 */
export const splitVenues = (
  venues: ReadonlyArray<{ readonly osm: string; readonly area: string }>,
  seed: string = SPLIT_SEED,
): Map<string, Half> => {
  const base = seedOf(seed);
  const byArea = new Map<string, Array<{ readonly osm: string; readonly hash: number }>>();
  for (const venue of venues) {
    const list = byArea.get(venue.area) ?? [];
    list.push({ osm: venue.osm, hash: deriveSeed(base, venue.osm) });
    byArea.set(venue.area, list);
  }
  const halves = new Map<string, Half>();
  for (const list of byArea.values()) {
    list.sort((a, b) => a.hash - b.hash || (a.osm < b.osm ? -1 : a.osm > b.osm ? 1 : 0));
    const train = Math.ceil(list.length / 2);
    for (const [at, item] of list.entries()) halves.set(item.osm, at < train ? "train" : "test");
  }
  return halves;
};

/** A rate of `k` in `n`, with its 95% Wilson interval. The value is null when `n` is 0. */
export interface Rate {
  readonly k: number;
  readonly n: number;
  readonly value: number | null;
  readonly low: number;
  readonly high: number;
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000;

/** This function gives a rate of `k` in `n`, with its 95% Wilson interval from `wilson`. */
export const rateOf = (k: number, n: number): Rate => {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) {
    throw new RangeError(
      `a rate needs whole numbers with 0 <= k <= n, not ${String(k)} of ${String(n)}`,
    );
  }
  const interval = wilson(k, n, Z95);
  return {
    k,
    n,
    value: n === 0 ? null : round(k / n),
    low: round(interval.low),
    high: round(interval.high),
  };
};

/** The score of the choice of links for a group of venues. */
export interface LinksScore {
  readonly venues: number;
  /** This value is the count of venues with no home page that the crawler can read. */
  readonly no_home: number;
  /** This rate is the venues whose home page alone agrees, of the venues with a home page. */
  readonly home_agrees: Rate;
  /** This rate is the venues where no page agrees, of the venues with a home page. Hours of OpenStreetMap can be old. */
  readonly no_page_agrees: Rate;
  /** This rate is the score: the venues where a page of the rule agrees, of the venues that need a link. */
  readonly rule: Rate;
}

/** The score of the choice of the best reading for a group of venues. */
export interface BestScore {
  readonly venues: number;
  readonly no_home: number;
  /** This value is the count of venues whose pages of the rule give no reading. */
  readonly no_reading: number;
  /** This rate is the venues where no reading agrees, of the venues with a reading. */
  readonly none_agrees: Rate;
  /** This rate is the score: the venues whose best reading agrees, of the venues where a reading agrees. */
  readonly rule: Rate;
}

const count = <T extends string>(outcomes: readonly T[], value: T): number =>
  outcomes.filter((outcome) => outcome === value).length;

/** This function scores the choice of links over the labels of a group of venues. */
export const scoreLinks = (labels: readonly VenueLabel[]): LinksScore => {
  const outcomes = labels.map((label) => label.links_outcome);
  const noHome = count(outcomes, "no-home");
  const withHome = labels.length - noHome;
  const hits = count(outcomes, "rule-hit");
  return {
    venues: labels.length,
    no_home: noHome,
    home_agrees: rateOf(count(outcomes, "home-agrees"), withHome),
    no_page_agrees: rateOf(count(outcomes, "no-page-agrees"), withHome),
    rule: rateOf(hits, hits + count(outcomes, "rule-miss")),
  };
};

/** This function scores the choice of the best reading over the labels of a group of venues. */
export const scoreBest = (labels: readonly VenueLabel[]): BestScore => {
  const outcomes = labels.map((label) => label.best_outcome);
  const noHome = count(outcomes, "no-home");
  const noReading = count(outcomes, "no-reading");
  const hits = count(outcomes, "hit");
  return {
    venues: labels.length,
    no_home: noHome,
    no_reading: noReading,
    none_agrees: rateOf(count(outcomes, "none-agrees"), labels.length - noHome - noReading),
    rule: rateOf(hits, hits + count(outcomes, "miss")),
  };
};

/** The scores of one choice: all the venues, each half, and each area. */
export interface Scores<S> {
  readonly all: S;
  readonly train: S;
  readonly test: S;
  readonly areas: Readonly<Record<string, S>>;
}

/** This function scores a choice over all the venues, each half and each area. */
export const scoresOf = <S,>(
  labels: readonly VenueLabel[],
  score: (group: readonly VenueLabel[]) => S,
): Scores<S> => {
  const areas = [...new Set(labels.map((label) => label.area))].sort();
  return {
    all: score(labels),
    train: score(labels.filter((label) => label.half === "train")),
    test: score(labels.filter((label) => label.half === "test")),
    areas: Object.fromEntries(
      areas.map((area) => [area, score(labels.filter((label) => label.area === area))]),
    ),
  };
};

const percent = (rate: Rate): string =>
  rate.value === null
    ? `— (0 of 0)`
    : `${(rate.value * 100).toFixed(1)}% (${String(rate.k)} of ${String(rate.n)}; ${(rate.low * 100).toFixed(1)}–${(rate.high * 100).toFixed(1)}%)`;

const rowsOf = <S,>(scores: Scores<S>): Array<readonly [string, S]> => [
  ["all", scores.all],
  ["train", scores.train],
  ["test", scores.test],
  ...Object.entries(scores.areas).map(([area, score]) => [`area ${area}`, score] as const),
];

/** This function writes the two tables of the scores as Markdown, with the attribution of OpenStreetMap. */
export const markdownOf = (
  links: Scores<LinksScore>,
  best: Scores<BestScore>,
  context: { readonly attribution: string; readonly commit: string | null; readonly wacz: string },
): string => {
  const lines = [
    "## The decision eval: the rule of the venue recipe against OpenStreetMap",
    "",
    `Archive \`${context.wacz}\`, commit \`${context.commit ?? "local"}\`. Each rate has a 95% Wilson interval.`,
    "",
    "### The choice of links",
    "",
    "The score is the share of venues where a page of the first links of the rule agrees, of the venues whose home page does not agree and where a candidate page agrees.",
    "",
    "| Group | Venues | No home page | Home page agrees | No page agrees | The rule |",
    "| --- | ---: | ---: | --- | --- | --- |",
    ...rowsOf(links).map(
      ([name, score]) =>
        `| ${name} | ${String(score.venues)} | ${String(score.no_home)} | ${percent(score.home_agrees)} | ${percent(score.no_page_agrees)} | ${percent(score.rule)} |`,
    ),
    "",
    "### The choice of the best reading",
    "",
    "The score is the share of venues whose best reading agrees, of the venues where a reading agrees.",
    "",
    "| Group | Venues | No home page | No reading | No reading agrees | The rule |",
    "| --- | ---: | ---: | ---: | --- | --- |",
    ...rowsOf(best).map(
      ([name, score]) =>
        `| ${name} | ${String(score.venues)} | ${String(score.no_home)} | ${String(score.no_reading)} | ${percent(score.none_agrees)} | ${percent(score.rule)} |`,
    ),
    "",
    `The hours data is ${context.attribution}.`,
    "",
  ];
  return lines.join("\n");
};
