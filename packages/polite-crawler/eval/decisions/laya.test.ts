import { signTest } from "@mark1russell7/rigor-statistics";
import { describe, expect, it } from "vitest";
import type { LinkLabel, ReadingLabel, VenueLabel } from "./label.mts";
import {
  type Forecast,
  MAX_BATCH_STATES,
  QUESTIONS,
  TEMPERATURES,
  batchesOf,
  byVenue,
  calibrationOf,
  chosenLinks,
  fitTemperature,
  itemsOf,
  layaMarkdownOf,
  linkState,
  linkTarget,
  modelBestOutcome,
  modelLinksOutcome,
  pairedOf,
  probabilitiesOf,
  readingState,
  readingTarget,
  scaled,
  scoreArm,
  trainingPlan,
  trainingRows,
} from "./laya.mts";

const linkOf = (position: number, label: LinkLabel["label"], text = `link ${String(position)}`) =>
  ({
    url: `https://venue.example/page-${String(position)}`,
    text,
    path: `/page-${String(position)}`,
    position,
    rule_rank: null,
    label,
    readings: label === "no-page" ? 0 : 1,
  }) satisfies LinkLabel;

const readingOf = (agreement: ReadingLabel["agreement"], rank = 1) =>
  ({
    page: "https://venue.example/hours?lang=en",
    from: "jsonld",
    rank,
    schedule: "opening",
    label: null,
    inferred: false,
    partial: false,
    season: null,
    hours: "Mo-Fr 09:00-17:00",
    agreement,
  }) satisfies ReadingLabel;

/** A made-up label with only the fields that the Laya arm reads. */
const labelOf = (extra: Partial<VenueLabel> = {}): VenueLabel => ({
  osm: "node/1",
  area: "one",
  half: "test",
  website: "https://venue.example/",
  home: "https://venue.example/",
  osm_hours: "Mo-Fr 09:00-17:00",
  home_label: "no-hours",
  links: [],
  rule_pages: 1,
  readings: [],
  best: null,
  links_outcome: "rule-hit",
  best_outcome: "hit",
  ...extra,
});

/** A batch response of the server, with the probability of the yes of each state. */
const responseOf = (id: string, yes: string, other: string, values: readonly number[]) => ({
  results: values.map((p) => ({
    answers: {
      [id]: {
        type: "choice",
        choice: p >= 0.5 ? yes : other,
        confidence: Math.max(p, 1 - p),
        probabilities: { [yes]: p, [other]: 1 - p },
      },
    },
  })),
});

describe("the states and the targets", () => {
  it("gives a link the host of the website, the text, the path and the place, and not the rank of the rule", () => {
    const link = { ...linkOf(3, "agrees", "Opening times"), rule_rank: 1 };
    const state = linkState(labelOf({ home: "https://www.venue.example/en/" }), link);
    expect(state).toEqual({
      website: "www.venue.example",
      link_text: "Opening times",
      link_path: "/page-3",
      position: 3,
    });
    expect(Object.keys(state)).not.toContain("rule_rank");
  });

  it("gives a reading the path of its page and not the rank of the rule", () => {
    const state = readingState(readingOf("agrees", 2));
    expect(state.page_path).toBe("/hours");
    expect(Object.keys(state)).not.toContain("rank");
    expect(readingState({ ...readingOf("agrees"), page: null }).page_path).toBeNull();
  });

  it("gives a target only to a link that agrees or has no hours, and to a reading that agrees or disagrees", () => {
    expect(
      ["agrees", "no-hours", "disagrees", "no-page"].map((label) =>
        linkTarget(linkOf(1, label as LinkLabel["label"])),
      ),
    ).toEqual(["hours", "other", null, null]);
    expect(
      ["agrees", "disagrees", "no-overlap"].map((agreement) =>
        readingTarget(readingOf(agreement as ReadingLabel["agreement"])),
      ),
    ).toEqual(["regular", "other", null]);
  });
});

describe("the requests and the answers", () => {
  it("splits the states in batches of at most 64, each with the one question of its kind", () => {
    const states = Array.from({ length: 130 }, (_, at) => readingState(readingOf("agrees", at)));
    const batches = batchesOf("untrained", "reading", states);
    expect(batches.map((batch) => batch.states.length)).toEqual([64, 64, 2]);
    for (const batch of batches) {
      expect(batch.model).toBe("untrained");
      expect(batch.questions).toEqual({ reading: QUESTIONS.reading.question });
    }
    expect(batchesOf("untrained", "link", [])).toEqual([]);
  });

  it("refuses a batch size out of 1 to 64", () => {
    for (const size of [0, MAX_BATCH_STATES + 1, 1.5]) {
      expect(() => batchesOf("m", "link", [], size)).toThrow(RangeError);
    }
  });

  it("reads the probability of the yes of each result", () => {
    expect(probabilitiesOf(responseOf("link", "hours", "other", [0.9, 0.2]), "link", 2)).toEqual([
      0.9, 0.2,
    ]);
  });

  it("throws on a response with the wrong count, the wrong question or no probability from 0 to 1", () => {
    const good = responseOf("link", "hours", "other", [0.9]);
    expect(() => probabilitiesOf(good, "link", 2)).toThrow("needs 2 results");
    expect(() => probabilitiesOf(good, "reading", 1)).toThrow('"regular"');
    expect(() => probabilitiesOf(responseOf("link", "hours", "other", [1.5]), "link", 1)).toThrow(
      'result 0: no probability of "hours"',
    );
    expect(() => probabilitiesOf({ results: [{}] }, "link", 1)).toThrow(
      'result 0: no probability of "hours"',
    );
    expect(() => probabilitiesOf(null, "link", 0)).toThrow("needs 0 results");
  });

  it("puts the probabilities back in their venues", () => {
    const labels = [
      labelOf({ osm: "node/1", links: [linkOf(1, "agrees"), linkOf(2, "no-hours")] }),
      labelOf({ osm: "way/2", readings: [readingOf("agrees"), readingOf("disagrees")] }),
    ];
    const items = itemsOf(labels);
    expect(items.map((item) => `${item.osm} ${item.kind} ${String(item.at)}`)).toEqual([
      "node/1 link 0",
      "node/1 link 1",
      "way/2 reading 0",
      "way/2 reading 1",
    ]);
    const venues = byVenue(labels, items, [0.1, 0.2, 0.3, 0.4]);
    expect(venues.get("node/1")).toEqual({ links: [0.1, 0.2], readings: [] });
    expect(venues.get("way/2")).toEqual({ links: [], readings: [0.3, 0.4] });
    expect(() => byVenue(labels, items, [0.1])).toThrow("4 items need 4 probabilities");
    expect(() => byVenue(labels.slice(1), items, [0.1, 0.2, 0.3, 0.4])).toThrow("no venue node/1");
  });
});

describe("the choices", () => {
  it("fetches the links of the highest probability, and the first on the page of equal ones", () => {
    const links = [linkOf(1, "no-hours"), linkOf(2, "agrees"), linkOf(3, "no-hours")];
    expect(chosenLinks(links, [0.2, 0.9, 0.5], 2).map((link) => link.position)).toEqual([2, 3]);
    expect(chosenLinks(links, [0.5, 0.5, 0.5], 2).map((link) => link.position)).toEqual([1, 2]);
  });

  it("fetches as many links as the rule, and counts only the venues of the link score", () => {
    const links = [linkOf(1, "no-hours"), linkOf(2, "agrees")];
    const label = labelOf({ links, rule_pages: 1 });
    expect(modelLinksOutcome(label, [0.9, 0.1])).toBe("miss");
    expect(modelLinksOutcome(label, [0.1, 0.9])).toBe("hit");
    expect(modelLinksOutcome({ ...label, rule_pages: 2 }, [0.9, 0.1])).toBe("hit");
    expect(modelLinksOutcome({ ...label, links_outcome: "home-agrees" }, [0.1, 0.9])).toBeNull();
  });

  it("chooses the reading of the highest probability, and the first of equal ones", () => {
    const label = labelOf({ readings: [readingOf("disagrees"), readingOf("agrees")] });
    expect(modelBestOutcome(label, [0.2, 0.8])).toBe("hit");
    expect(modelBestOutcome(label, [0.5, 0.5])).toBe("miss");
    expect(modelBestOutcome({ ...label, best_outcome: "none-agrees" }, [0.2, 0.8])).toBeNull();
  });

  it("compares the two, venue by venue, with the sign test over the venues where only one hits", () => {
    const pairs = [
      ...Array.from({ length: 8 }, () => ({ rule: "miss", model: "hit" }) as const),
      { rule: "hit", model: "miss" } as const,
      ...Array.from({ length: 5 }, () => ({ rule: "hit", model: "hit" }) as const),
    ];
    const paired = pairedOf(pairs);
    expect([paired.better, paired.worse]).toEqual([8, 1]);
    expect([paired.rule.k, paired.rule.n, paired.model.k, paired.model.n]).toEqual([6, 14, 13, 14]);
    expect(paired.p).toBe(Math.round(signTest(8, 1, 2) * 10_000) / 10_000);
    expect(paired.p).toBeLessThan(0.05);
    expect(pairedOf([]).p).toBe(1);
  });
});

describe("the calibration", () => {
  it("tries temperatures from 1/8 to 8, with 1 among them", () => {
    expect(TEMPERATURES[0]).toBe(0.125);
    expect(TEMPERATURES.at(-1)).toBe(8);
    expect(TEMPERATURES).toContain(1);
    expect(scaled(0.5, 3)).toBeCloseTo(0.5, 12);
    expect(scaled(0.8, 1)).toBeCloseTo(0.8, 12);
  });

  it("recovers the temperature of a model that is too sure", () => {
    // in each group, the share of hits is q, and the model says the logit of q times 2
    const forecasts: Forecast[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((tenths) => {
      const q = tenths / 10;
      const p = 1 / (1 + Math.exp(-2 * Math.log(q / (1 - q))));
      return Array.from({ length: 10 }, (_, at) => ({ p, hit: at < tenths }));
    });
    expect(fitTemperature(forecasts)).toBe(2);
    const calibrated = forecasts.map((one) => ({ ...one, p: scaled(one.p, 2) }));
    expect(fitTemperature(calibrated)).toBe(1);
    expect(fitTemperature([])).toBe(1);
  });

  it("fits on the train half and scores the test half", () => {
    const train = labelOf({
      osm: "node/1",
      half: "train",
      links: [linkOf(1, "agrees"), linkOf(2, "no-hours")],
    });
    const test = labelOf({ osm: "node/2", half: "test", links: [linkOf(1, "agrees")] });
    const probabilities = new Map([
      ["node/1", { links: [0.9, 0.1], readings: [] }],
      ["node/2", { links: [0.8], readings: [] }],
    ]);
    const link = calibrationOf([train, test], probabilities, "link");
    expect([link.train, link.test]).toEqual([2, 1]);
    expect(link.brier_raw).toBeCloseTo(0.04, 4);
    const reading = calibrationOf([train, test], probabilities, "reading");
    expect(reading).toEqual({
      temperature: 1,
      train: 0,
      test: 0,
      brier_raw: null,
      brier_scaled: null,
    });
  });
});

describe("the score of an arm", () => {
  it("counts the choices on the test half only", () => {
    const links = [linkOf(1, "no-hours"), linkOf(2, "agrees")];
    const readings = [readingOf("disagrees"), readingOf("agrees")];
    const labels = [
      labelOf({ osm: "node/1", half: "train", links, readings, best_outcome: "miss" }),
      labelOf({ osm: "node/2", half: "test", links, readings, links_outcome: "rule-miss" }),
    ];
    const probabilities = new Map([
      ["node/1", { links: [0.9, 0.1], readings: [0.9, 0.1] }],
      ["node/2", { links: [0.1, 0.9], readings: [0.1, 0.9] }],
    ]);
    const score = scoreArm(labels, probabilities);
    expect([score.links.rule.n, score.links.rule.k, score.links.model.k]).toEqual([1, 0, 1]);
    expect([score.links.better, score.links.worse]).toEqual([1, 0]);
    expect([score.best.rule.n, score.best.rule.k, score.best.model.k]).toEqual([1, 1, 1]);
    expect(score.calibration.link.train).toBe(2);
    expect(() => scoreArm(labels, new Map())).toThrow("no probabilities");
  });

  it("writes the tables with the arm, the model and the attribution", () => {
    const score = scoreArm([], new Map());
    const markdown = layaMarkdownOf(score, {
      arm: "untrained",
      model: "untrained",
      commit: null,
      attribution: "© OpenStreetMap contributors (ODbL)",
    });
    expect(markdown).toContain("Laya (untrained) against the rule");
    expect(markdown).toContain("commit `local`");
    expect(markdown).toContain("| The links | 0 | — (0 of 0) | — (0 of 0) | 0 | 0 | 1.0000 |");
    expect(markdown).toContain("© OpenStreetMap contributors (ODbL)");
  });
});

describe("the training", () => {
  it("gives rows only from the train half, and only for a link or a reading with a target", () => {
    const links = [linkOf(1, "agrees"), linkOf(2, "disagrees"), linkOf(3, "no-hours")];
    const readings = [readingOf("agrees"), readingOf("no-overlap")];
    const rows = trainingRows([
      labelOf({ osm: "node/1", half: "train", links, readings }),
      labelOf({ osm: "node/2", half: "test", links, readings }),
    ]);
    expect(rows.map((row) => row.expected)).toEqual([
      { link: "hours" },
      { link: "other" },
      { reading: "regular" },
    ]);
    expect(rows[0]?.questions).toEqual({ link: QUESTIONS.link.question });
    expect(rows[2]?.questions).toEqual({ reading: QUESTIONS.reading.question });
  });

  it("chooses the whole model when it fits, then the head, then nothing", () => {
    // 10 seconds for each row of the whole model, 1 second for the head alone
    const trial = { rows: 64, full_seconds: 640, head_seconds: 64 };
    expect(trainingPlan(trial, 120, 2, 120)).toEqual({
      mode: "full",
      budget_minutes: 120,
      full_minutes: 40,
      head_minutes: 4,
    });
    expect(trainingPlan(trial, 120, 2, 30).mode).toBe("head");
    expect(trainingPlan(trial, 120, 2, 3).mode).toBe("none");
    expect(trainingPlan(trial, 0, 2, 120).mode).toBe("none");
  });

  it("refuses a trial with no rows, no epochs or a budget below 0", () => {
    expect(() => trainingPlan({ rows: 0, full_seconds: 1, head_seconds: 1 }, 10, 1, 1)).toThrow(
      RangeError,
    );
    expect(() => trainingPlan({ rows: 1, full_seconds: 1, head_seconds: 1 }, 10, 0, 1)).toThrow(
      RangeError,
    );
    expect(() => trainingPlan({ rows: 1, full_seconds: 1, head_seconds: 1 }, 10, 1, -1)).toThrow(
      RangeError,
    );
  });
});
