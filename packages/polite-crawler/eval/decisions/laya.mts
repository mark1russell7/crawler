/**
 * The Laya arm of the decision eval (step 2). Each function here is pure: it builds the requests
 * of a Laya server, reads its answers, and scores the choices of the model against the choices of
 * the rule on the same venues.
 *
 * - Each candidate link is one state with one choice of two options (`hours` or `other`). Each
 *   reading is one state with one choice of two options (`regular` or `other`). The model chooses
 *   the links or the reading with the highest probability. A choice of many options loses accuracy
 *   (the model card), so a venue never gets one choice over all its links.
 * - A state holds only what the crawler sees when it chooses: the text, the path and the place of a
 *   link, and the fields of a reading. It does not hold the rank of the rule, so the arm measures
 *   the model alone.
 * - The test half decides. The train half gives the training rows and the temperature, and nothing
 *   of the test half goes into them.
 */
import { brier, logLoss, signTest } from "@mark1russell7/rigor-statistics";
import type { LinkLabel, ReadingLabel, VenueLabel } from "./label.mts";
import { type Rate, rateOf } from "./score.mts";

/** A choice question of the Laya wire: the instructions, and one description for each option. */
export interface LayaChoice {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

/** The question about a candidate link. The option `hours` is the yes. */
export const LINK_QUESTION: LayaChoice = {
  type: "choice",
  instructions:
    "The state is one link on the home page of the website of a venue, such as a shop, a restaurant or a museum. Does the page of this link show the opening hours of the venue?",
  criteria: {
    hours: "Yes. The page of the link shows the opening hours of the venue.",
    other: "No. The page of the link does not show the opening hours of the venue.",
  },
};

/** The question about a reading. The option `regular` is the yes. */
export const READING_QUESTION: LayaChoice = {
  type: "choice",
  instructions:
    "The state is one reading of the opening hours of a venue, from the website of the venue. Is it the regular weekly opening hours of the venue?",
  criteria: {
    regular: "Yes. These are the regular weekly opening hours of the venue.",
    other:
      "No. These are other hours, for example of a holiday, a season, one department or a kitchen.",
  },
};

/** The two questions, with the id of each question and the option that is the yes. */
export const QUESTIONS = {
  link: { id: "link", question: LINK_QUESTION, yes: "hours" },
  reading: { id: "reading", question: READING_QUESTION, yes: "regular" },
} as const;

/** The kind of a question: a candidate link or a reading. */
export type QuestionKind = keyof typeof QUESTIONS;

/** The state of a candidate link. */
export interface LinkState {
  /** This value is the host name of the website. */
  readonly website: string;
  readonly link_text: string;
  readonly link_path: string;
  /** This value is the place of the link among the links of the home page (1 is the first). */
  readonly position: number;
}

/** The state of a reading. */
export interface ReadingState {
  readonly hours: string;
  readonly from: ReadingLabel["from"];
  readonly schedule: ReadingLabel["schedule"];
  readonly label: string | null;
  readonly season: string | null;
  readonly partial: boolean;
  readonly inferred: boolean;
  /** This value is the path of the page of the reading, or null. */
  readonly page_path: string | null;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

/** This function gives the state of a candidate link of a venue. */
export const linkState = (label: VenueLabel, link: LinkLabel): LinkState => ({
  website: hostOf(label.home ?? label.website),
  link_text: link.text,
  link_path: link.path,
  position: link.position,
});

/** This function gives the state of a reading. */
export const readingState = (reading: ReadingLabel): ReadingState => ({
  hours: reading.hours,
  from: reading.from,
  schedule: reading.schedule,
  label: reading.label,
  season: reading.season,
  partial: reading.partial,
  inferred: reading.inferred,
  page_path: reading.page === null ? null : pathOf(reading.page),
});

/**
 * This function gives the target of a candidate link: `hours` when its page agrees with
 * OpenStreetMap, `other` when its page has no hours, or null. A page that disagrees has hours that
 * OpenStreetMap does not have (the hours of OpenStreetMap can be old), and a link with no page has
 * no label. So neither one is a target.
 */
export const linkTarget = (link: LinkLabel): "hours" | "other" | null =>
  link.label === "agrees" ? "hours" : link.label === "no-hours" ? "other" : null;

/**
 * This function gives the target of a reading: `regular` when it agrees with OpenStreetMap, `other`
 * when it disagrees, or null when the two weeks share no day.
 */
export const readingTarget = (reading: ReadingLabel): "regular" | "other" | null =>
  reading.agreement === "agrees" ? "regular" : reading.agreement === "disagrees" ? "other" : null;

/** One state for the server, with the venue and the place of its link or reading. */
export interface Item {
  readonly osm: string;
  readonly kind: QuestionKind;
  /** This value is the place of the link in `links`, or of the reading in `readings`, of the venue. */
  readonly at: number;
  readonly state: LinkState | ReadingState;
}

/** This function gives each state of a list of venues: each candidate link and each reading. */
export const itemsOf = (labels: readonly VenueLabel[]): Item[] =>
  labels.flatMap((label) => [
    ...label.links.map((link, at): Item => ({
      osm: label.osm,
      kind: "link",
      at,
      state: linkState(label, link),
    })),
    ...label.readings.map((reading, at): Item => ({
      osm: label.osm,
      kind: "reading",
      at,
      state: readingState(reading),
    })),
  ]);

/** The server takes at most this count of states in one batch request. */
export const MAX_BATCH_STATES = 64;

/** One batch request of the Laya wire (`POST /v1/systemone/batch`). */
export interface LayaBatch {
  readonly model: string;
  readonly states: ReadonlyArray<LinkState | ReadingState>;
  readonly questions: Readonly<Record<string, LayaChoice>>;
}

/**
 * This function gives the batch requests for the states of one kind, with at most `size` states in
 * each request. Each request asks the one question of the kind.
 */
export const batchesOf = (
  model: string,
  kind: QuestionKind,
  states: ReadonlyArray<LinkState | ReadingState>,
  size: number = MAX_BATCH_STATES,
): LayaBatch[] => {
  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH_STATES) {
    throw new RangeError(
      `a batch has 1 to ${String(MAX_BATCH_STATES)} states, not ${String(size)}`,
    );
  }
  const { id, question } = QUESTIONS[kind];
  const batches: LayaBatch[] = [];
  for (let at = 0; at < states.length; at += size) {
    batches.push({ model, states: states.slice(at, at + size), questions: { [id]: question } });
  }
  return batches;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * This function reads the probability of the yes of a kind from each result of a batch response.
 * It throws when the response does not have one result for each state, or when a result has no
 * probability from 0 to 1 for the yes.
 */
export const probabilitiesOf = (response: unknown, kind: QuestionKind, count: number): number[] => {
  const { id, yes } = QUESTIONS[kind];
  const results = isRecord(response) ? response["results"] : undefined;
  if (!Array.isArray(results) || results.length !== count) {
    throw new Error(`a batch response needs ${String(count)} results`);
  }
  return results.map((result: unknown, at) => {
    const answers = isRecord(result) ? result["answers"] : undefined;
    const answer = isRecord(answers) ? answers[id] : undefined;
    const probabilities = isRecord(answer) ? answer["probabilities"] : undefined;
    const p = isRecord(probabilities) ? probabilities[yes] : undefined;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new Error(`result ${String(at)}: no probability of "${yes}" for the question "${id}"`);
    }
    return p;
  });
};

/** The probabilities of the model for one venue: one for each candidate link and one for each reading. */
export interface VenueProbabilities {
  readonly links: readonly number[];
  readonly readings: readonly number[];
}

/**
 * This function puts the probabilities of the items back in their venues. `p` has one value for
 * each item, in the order of `items`. It throws when a venue has a link or a reading with no value.
 */
export const byVenue = (
  labels: readonly VenueLabel[],
  items: readonly Item[],
  p: readonly number[],
): Map<string, VenueProbabilities> => {
  if (p.length !== items.length) {
    throw new Error(`${String(items.length)} items need ${String(items.length)} probabilities`);
  }
  const lists = new Map<string, { links: number[]; readings: number[] }>();
  for (const label of labels) lists.set(label.osm, { links: [], readings: [] });
  for (const [index, item] of items.entries()) {
    const list = lists.get(item.osm);
    const value = p[index];
    if (list === undefined || value === undefined) throw new Error(`no venue ${item.osm}`);
    (item.kind === "link" ? list.links : list.readings)[item.at] = value;
  }
  for (const label of labels) {
    const list = lists.get(label.osm);
    const full = (values: readonly number[] | undefined, count: number): boolean =>
      values !== undefined &&
      values.length === count &&
      values.every((value) => typeof value === "number");
    if (!full(list?.links, label.links.length) || !full(list?.readings, label.readings.length)) {
      throw new Error(`the venue ${label.osm} has a link or a reading with no probability`);
    }
  }
  return lists;
};

/** The outcome of one choice for one venue. */
export type Outcome = "hit" | "miss";

/**
 * This function gives the links that the model fetches: the first `pages` links by probability,
 * then by place on the home page.
 */
export const chosenLinks = (
  links: readonly LinkLabel[],
  p: readonly number[],
  pages: number,
): LinkLabel[] =>
  links
    .map((link, at) => ({ link, p: p[at] ?? 0 }))
    .sort((a, b) => b.p - a.p || a.link.position - b.link.position)
    .slice(0, pages)
    .map((one) => one.link);

/** This function gives the outcome of the choice of links of the rule, or null when the venue does not count (as in `scoreLinks`). */
export const ruleLinksOutcome = (label: VenueLabel): Outcome | null =>
  label.links_outcome === "rule-hit" ? "hit" : label.links_outcome === "rule-miss" ? "miss" : null;

/**
 * This function gives the outcome of the choice of links of the model. The model fetches as many
 * links as the rule (`rule_pages`). The venues that count are those of `scoreLinks`: the home page
 * does not agree, and a candidate page agrees.
 */
export const modelLinksOutcome = (label: VenueLabel, p: readonly number[]): Outcome | null => {
  if (ruleLinksOutcome(label) === null) return null;
  return chosenLinks(label.links, p, label.rule_pages).some((link) => link.label === "agrees")
    ? "hit"
    : "miss";
};

/** This function gives the outcome of the choice of the best reading of the rule, or null when the venue does not count (as in `scoreBest`). */
export const ruleBestOutcome = (label: VenueLabel): Outcome | null =>
  label.best_outcome === "hit" ? "hit" : label.best_outcome === "miss" ? "miss" : null;

/**
 * This function gives the outcome of the choice of the best reading of the model: the reading with
 * the highest probability (the first of equal values). It chooses from the same readings as the
 * rule.
 */
export const modelBestOutcome = (label: VenueLabel, p: readonly number[]): Outcome | null => {
  if (ruleBestOutcome(label) === null) return null;
  let best = 0;
  for (const [at, value] of p.entries()) if (value > (p[best] ?? 0)) best = at;
  return label.readings[best]?.agreement === "agrees" ? "hit" : "miss";
};

/** The paired comparison of the model with the rule on the same venues. */
export interface Paired {
  readonly rule: Rate;
  readonly model: Rate;
  /** This value is the count of venues where the model hits and the rule misses. */
  readonly better: number;
  /** This value is the count of venues where the model misses and the rule hits. */
  readonly worse: number;
  /** This value is the two-sided p of the sign test over `better` and `worse`. */
  readonly p: number;
}

/** This function compares the outcomes of the model with those of the rule, venue by venue. */
export const pairedOf = (
  pairs: ReadonlyArray<{ readonly rule: Outcome; readonly model: Outcome }>,
): Paired => {
  const better = pairs.filter((pair) => pair.model === "hit" && pair.rule === "miss").length;
  const worse = pairs.filter((pair) => pair.model === "miss" && pair.rule === "hit").length;
  return {
    rule: rateOf(pairs.filter((pair) => pair.rule === "hit").length, pairs.length),
    model: rateOf(pairs.filter((pair) => pair.model === "hit").length, pairs.length),
    better,
    worse,
    p: Math.round(signTest(better, worse, 2) * 10_000) / 10_000,
  };
};

/** A forecast: the probability of the yes, and if the target is the yes. */
export interface Forecast {
  readonly p: number;
  readonly hit: boolean;
}

/** The probabilities are kept this far from 0 and 1, so a logit and a log-loss stay finite. */
const EDGE = 1e-6;

const logit = (p: number): number => {
  const q = Math.min(1 - EDGE, Math.max(EDGE, p));
  return Math.log(q / (1 - q));
};

/** This function scales a probability by a temperature: the logit divided by `t`. */
export const scaled = (p: number, t: number): number => {
  const q = 1 / (1 + Math.exp(-logit(p) / t));
  return Math.min(1 - EDGE, Math.max(EDGE, q));
};

/**
 * The temperatures that `fitTemperature` tries: from 1/8 to 8, at equal steps of the logarithm (a
 * step is 2^0.1, about 7 percent). 1 and 2 are among them.
 */
export const TEMPERATURES: readonly number[] = Array.from(
  { length: 61 },
  (_, at) => Math.round(2 ** (-3 + at / 10) * 10_000) / 10_000,
);

/**
 * This function fits the temperature that gives the lowest log-loss over the forecasts, from
 * `TEMPERATURES`. With no forecast, it gives 1.
 */
export const fitTemperature = (forecasts: readonly Forecast[]): number => {
  if (forecasts.length === 0) return 1;
  let best = 1;
  let bestLoss = Number.POSITIVE_INFINITY;
  for (const t of TEMPERATURES) {
    const loss = logLoss(forecasts.map((one) => ({ p: scaled(one.p, t), hit: one.hit })));
    if (loss < bestLoss) {
      bestLoss = loss;
      best = t;
    }
  }
  return best;
};

/**
 * This function gives the forecasts of a kind for a list of venues: one for each link or reading
 * with a target.
 */
export const forecastsOf = (
  labels: readonly VenueLabel[],
  probabilities: ReadonlyMap<string, VenueProbabilities>,
  kind: QuestionKind,
): Forecast[] =>
  labels.flatMap((label) => {
    const p = probabilities.get(label.osm);
    if (p === undefined) throw new Error(`the venue ${label.osm} has no probabilities`);
    const targets =
      kind === "link"
        ? label.links.map((link) => linkTarget(link))
        : label.readings.map((reading) => readingTarget(reading));
    const values = kind === "link" ? p.links : p.readings;
    return targets.flatMap((target, at): Forecast[] =>
      target === null ? [] : [{ p: values[at] ?? 0, hit: target === QUESTIONS[kind].yes }],
    );
  });

/** The calibration of one question: the temperature from the train half, and the Brier scores of the test half. */
export interface Calibration {
  readonly temperature: number;
  readonly train: number;
  readonly test: number;
  /** This value is the Brier score of the test half with the probabilities of the server, or null with no forecast. */
  readonly brier_raw: number | null;
  /** This value is the Brier score of the test half with the fitted temperature, or null with no forecast. */
  readonly brier_scaled: number | null;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** This function fits the temperature of a kind on the train half and scores the test half. */
export const calibrationOf = (
  labels: readonly VenueLabel[],
  probabilities: ReadonlyMap<string, VenueProbabilities>,
  kind: QuestionKind,
): Calibration => {
  const train = forecastsOf(
    labels.filter((label) => label.half === "train"),
    probabilities,
    kind,
  );
  const test = forecastsOf(
    labels.filter((label) => label.half === "test"),
    probabilities,
    kind,
  );
  const temperature = fitTemperature(train);
  return {
    temperature,
    train: train.length,
    test: test.length,
    brier_raw: test.length === 0 ? null : round4(brier(test)),
    brier_scaled:
      test.length === 0
        ? null
        : round4(brier(test.map((one) => ({ p: scaled(one.p, temperature), hit: one.hit })))),
  };
};

/** The score of one arm: the two choices of the test half against the rule, and the calibration of each question. */
export interface ArmScore {
  readonly links: Paired;
  readonly best: Paired;
  readonly calibration: { readonly link: Calibration; readonly reading: Calibration };
}

/** This function scores one arm. The choices count on the test half only. */
export const scoreArm = (
  labels: readonly VenueLabel[],
  probabilities: ReadonlyMap<string, VenueProbabilities>,
): ArmScore => {
  const test = labels.filter((label) => label.half === "test");
  const pairs = (
    rule: (label: VenueLabel) => Outcome | null,
    model: (label: VenueLabel) => Outcome | null,
  ): Array<{ rule: Outcome; model: Outcome }> =>
    test.flatMap((label) => {
      const a = rule(label);
      const b = model(label);
      return a === null || b === null ? [] : [{ rule: a, model: b }];
    });
  const of = (label: VenueLabel): VenueProbabilities => {
    const p = probabilities.get(label.osm);
    if (p === undefined) throw new Error(`the venue ${label.osm} has no probabilities`);
    return p;
  };
  return {
    links: pairedOf(pairs(ruleLinksOutcome, (label) => modelLinksOutcome(label, of(label).links))),
    best: pairedOf(pairs(ruleBestOutcome, (label) => modelBestOutcome(label, of(label).readings))),
    calibration: {
      link: calibrationOf(labels, probabilities, "link"),
      reading: calibrationOf(labels, probabilities, "reading"),
    },
  };
};

/** One training row of `laya-train` (JSONL): a state, its question and the expected option. */
export interface TrainingRow {
  readonly state: LinkState | ReadingState;
  readonly questions: Readonly<Record<string, LayaChoice>>;
  readonly expected: Readonly<Record<string, string>>;
}

/** This function gives the training rows of the train half: each link and each reading with a target. */
export const trainingRows = (labels: readonly VenueLabel[]): TrainingRow[] =>
  labels
    .filter((label) => label.half === "train")
    .flatMap((label) => [
      ...label.links.flatMap((link): TrainingRow[] => {
        const target = linkTarget(link);
        return target === null
          ? []
          : [
              {
                state: linkState(label, link),
                questions: { link: LINK_QUESTION },
                expected: { link: target },
              },
            ];
      }),
      ...label.readings.flatMap((reading): TrainingRow[] => {
        const target = readingTarget(reading);
        return target === null
          ? []
          : [
              {
                state: readingState(reading),
                questions: { reading: READING_QUESTION },
                expected: { reading: target },
              },
            ];
      }),
    ]);

/** How the training arm trains: the whole model, the head alone, or not at all. */
export type TrainMode = "full" | "head" | "none";

/** The timed trial of each mode: the seconds of one epoch over `rows` rows, with the load of the model. */
export interface Trial {
  readonly rows: number;
  readonly full_seconds: number;
  readonly head_seconds: number;
}

/** The plan of the training: the mode, and the minutes that the trial predicts for each mode. */
export interface TrainingPlan {
  readonly mode: TrainMode;
  readonly budget_minutes: number;
  readonly full_minutes: number;
  readonly head_minutes: number;
}

/**
 * This function chooses the mode of the training from a timed trial. The minutes of a mode are its
 * seconds for each row of the trial, times the rows, times the epochs. The trial time holds the load
 * of the model, so the estimate is high, never low. The mode is `full` when it fits in the budget,
 * then `head` (the encoder does not change) when it fits, else `none`.
 */
export const trainingPlan = (
  trial: Trial,
  rows: number,
  epochs: number,
  budgetMinutes: number,
): TrainingPlan => {
  if (trial.rows < 1 || rows < 0 || epochs < 1 || budgetMinutes < 0) {
    throw new RangeError("a plan needs a trial of 1 row or more, 1 epoch or more and a budget");
  }
  const minutes = (seconds: number): number =>
    Math.round(((seconds / trial.rows) * rows * epochs) / 60);
  const full = minutes(trial.full_seconds);
  const head = minutes(trial.head_seconds);
  const mode: TrainMode =
    rows === 0 ? "none" : full <= budgetMinutes ? "full" : head <= budgetMinutes ? "head" : "none";
  return { mode, budget_minutes: budgetMinutes, full_minutes: full, head_minutes: head };
};

const percent = (rate: Rate): string =>
  rate.value === null
    ? "— (0 of 0)"
    : `${(rate.value * 100).toFixed(1)}% (${String(rate.k)} of ${String(rate.n)}; ${(rate.low * 100).toFixed(1)}–${(rate.high * 100).toFixed(1)}%)`;

const number = (value: number | null): string => (value === null ? "—" : value.toFixed(4));

/** This function writes the tables of one arm as Markdown. */
export const layaMarkdownOf = (
  score: ArmScore,
  context: {
    readonly arm: string;
    readonly model: string;
    readonly commit: string | null;
    readonly attribution: string;
  },
): string =>
  [
    `## The decision eval, step 2: Laya (${context.arm}) against the rule`,
    "",
    `Model \`${context.model}\`, commit \`${context.commit ?? "local"}\`. The rows are the venues of the test half. Each rate has a 95% Wilson interval. Better and worse count the venues where only one of the two hits, and p is the two-sided sign test over them.`,
    "",
    "| Choice | Venues | The rule | Laya | Laya better | Laya worse | p |",
    "| --- | ---: | --- | --- | ---: | ---: | ---: |",
    ...(
      [
        ["The links", score.links],
        ["The best reading", score.best],
      ] as const
    ).map(
      ([name, paired]) =>
        `| ${name} | ${String(paired.rule.n)} | ${percent(paired.rule)} | ${percent(paired.model)} | ${String(paired.better)} | ${String(paired.worse)} | ${paired.p.toFixed(4)} |`,
    ),
    "",
    "The calibration of the probability of the yes. The temperature is fitted on the train half, and the Brier score is of the test half (lower is better).",
    "",
    "| Question | Train forecasts | Test forecasts | Temperature | Brier, raw | Brier, scaled |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...(
      [
        ["The link has the hours", score.calibration.link],
        ["The reading is the regular week", score.calibration.reading],
      ] as const
    ).map(
      ([name, one]) =>
        `| ${name} | ${String(one.train)} | ${String(one.test)} | ${String(one.temperature)} | ${number(one.brier_raw)} | ${number(one.brier_scaled)} |`,
    ),
    "",
    `The hours data is ${context.attribution}.`,
    "",
  ].join("\n");
