/**
 * The data stamps of the pages that show measured numbers (schema data-stamp/1). The freshness gate of the
 * Pages workflow reads them from `/data-stamps.json`. The stamps come from the data files, so a new run
 * moves its stamp with no edit here.
 */
import evalA from "../data/eval-a.json";
import evalB from "../data/eval-b.json";
import survey from "../data/restaurant-survey.json";
import study from "../data/robots-study.json";

const REPOSITORY = "https://github.com/mark1russell7/crawler";

/** One run that made the data of a page. */
export interface StampRun {
  readonly id: string;
  readonly url: string;
  readonly date: string;
  readonly engines: Readonly<Record<string, string>>;
  /** The full commit of the code of the run. */
  readonly commit?: string;
}

/** The largest age of the data of a page, and the scheduled workflow that meets it. */
export interface StampLimit {
  readonly days: number;
  readonly reason: string;
  readonly workflow: string;
  readonly ruling: string;
}

/** The two statements of a study with no age limit. The page shows both. */
export interface NoLimit {
  /** The reason that no run of the current code can reproduce the numbers. */
  readonly reproduce: string;
  /** The reason that the page claims nothing about today. */
  readonly today: string;
}

/** The stamp of one page. A study has no limit only if no run of the current code can reproduce its numbers and its page claims nothing about today. */
export interface PageStamp {
  readonly page: string;
  readonly study?: true;
  readonly limit?: StampLimit;
  readonly noLimit?: NoLimit;
  readonly runs: readonly StampRun[];
}

const runUrl = (run: string | number): string => `${REPOSITORY}/actions/runs/${run}`;

/**
 * This value is the first version of polite-crawler in this repository. The survey file names no version. The survey
 * of 2026-10-07 used the code before that first commit of 2026-10-11, and its page says so.
 */
export const SURVEY_VERSION = "0.1.0";
const SURVEY_COMMIT = "37b9032b12bd040e348f4a7bb3b7876d99349138";

/** This function gives the version in a text, for example `polite-crawler 0.1.2`. */
export function versionOf(text: string): string {
  const version = /\d+\.\d+\.\d+/.exec(text)?.[0];
  if (version === undefined) throw new Error(`No version in "${text}".`);
  return version;
}

/** The largest age of the robots.txt study. The largest gap of its schedule is 31 days, and the run and its merge take 2 days. */
export const STUDY_LIMIT_DAYS = 33;
const STUDY_REASON = "The robots.txt study runs again on day 2 of each month.";

/** This text tells a reader the limit. Each page of `STUDY_PAGES` shows it. */
export const STUDY_LIMIT_TEXT = `${STUDY_REASON} A check stops a new deploy of this site when the data is more than ${STUDY_LIMIT_DAYS} days old.`;

/** The built pages that show a figure of the robots.txt study. Each reads the one data file, so one age holds for all of them. */
export const STUDY_PAGES = [
  "index.html",
  "notes/robots-txt-ai-agents/index.html",
  "block-ai-training-crawlers/index.html",
  "bot/index.html",
] as const;

/** This function gives the stamps of the pages that show the robots.txt study. */
export function studyLimitStamps(): PageStamp[] {
  return STUDY_PAGES.map((page) => ({
    page,
    limit: {
      days: STUDY_LIMIT_DAYS,
      reason: STUDY_REASON,
      workflow: ".github/workflows/study-monthly.yml",
      ruling: `${REPOSITORY}/pull/109`,
    },
    runs: [
      {
        id: `study of ${study.fetched.from.slice(0, 10)}`,
        url: `${REPOSITORY}/actions/workflows/study-monthly.yml`,
        date: study.fetched.from,
        engines: { "polite-crawler": versionOf(study.userAgent) },
      },
    ],
  }));
}

/** The largest age of eval part A. Its workflow starts each Monday, and the run and the next deploy take 2 days. */
export const EVAL_A_LIMIT_DAYS = 9;
const EVAL_A_REASON =
  "Eval part A runs again each Monday, and each build of this site takes its newest green run.";

/** This text tells a reader the limit of eval part A. Its page shows it. */
export const EVAL_A_LIMIT_TEXT = `${EVAL_A_REASON} A check stops a new deploy of this site when the data is more than ${EVAL_A_LIMIT_DAYS} days old.`;

/** This function gives the stamp of eval part A: the newest green run of eval.yml on main, which the build reads. */
export function evalAStamp(): PageStamp {
  return {
    page: "notes/tokens-per-claim/index.html",
    limit: {
      days: EVAL_A_LIMIT_DAYS,
      reason: EVAL_A_REASON,
      workflow: ".github/workflows/eval.yml",
      ruling: `${REPOSITORY}/pull/109`,
    },
    runs: [
      {
        id: String(evalA.run),
        url: runUrl(evalA.run),
        date: evalA.started,
        engines: { "polite-crawler": versionOf(evalA.package) },
        commit: evalA.commitSha,
      },
    ],
  };
}

/** The statements of the study of the sessions of eval part B. */
export const EVAL_B_NO_LIMIT: NoLimit = {
  reproduce:
    "Each run is a set of sessions of a model, and the model behind one name changes. So no run of the current code gives these numbers again.",
  today:
    "The page tells what the sessions with those versions did on their dates. It claims nothing about a session today.",
};

/** The statements of the survey of restaurant websites. */
export const SURVEY_NO_LIMIT: NoLimit = {
  reproduce:
    "The survey read the live websites on its date, and the websites changed after that day. So no run of the current code reads the same pages.",
  today: "The page tells what those websites had on that day. It claims nothing about them today.",
};

/** This function gives the stamps of the fixed studies. */
export function studyStamps(): PageStamp[] {
  return [
    {
      page: "notes/claude-code-sessions/index.html",
      study: true,
      noLimit: EVAL_B_NO_LIMIT,
      runs: evalB.runs.map((run) => {
        const version = evalB.versions.find((entry) => entry.mcp === run.mcp);
        if (version === undefined) throw new Error(`The run ${run.id} has no version entry.`);
        return {
          id: String(run.run),
          url: runUrl(run.run),
          date: version.date,
          engines: { "polite-crawler-mcp": run.mcp },
        };
      }),
    },
    {
      page: "notes/restaurant-websites/index.html",
      study: true,
      noLimit: SURVEY_NO_LIMIT,
      runs: [
        {
          id: `survey of ${survey.date}`,
          url: `${REPOSITORY}/blob/${SURVEY_COMMIT}/packages/site/src/data/restaurant-survey.json`,
          date: survey.date,
          engines: { "polite-crawler": SURVEY_VERSION },
        },
      ],
    },
  ];
}
