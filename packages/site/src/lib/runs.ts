/**
 * The robots.txt study, each month. Each run keeps its dataset in `src/data/study/<version>.json`
 * and its CSV in `public/data/robots-study-<version>.csv`. The file `src/data/study-history.json` keeps
 * the headline numbers of each run and the DOI of its version on Zenodo. The files
 * `src/data/robots-study.json` and `public/data/robots-study.csv` stay a copy of the newest run.
 *
 * This module gives the numbers of a run and the data of the trend chart. It also gives the text of
 * the pull request of a run, and it reads the Tranco list. It sends no request.
 */
import { isDoi, studyVersion } from "./cite.ts";
import type { State, Study } from "./study.ts";
import { agentRows, answered, formatDay, niceMax, ticks } from "./study.ts";

/** The number of domains in each run: the top 1,000 domains of the Tranco list. */
export const STUDY_SIZE = 1000;

/** The numbers of one agent in one run. */
export interface RunAgent {
  readonly token: string;
  readonly refused: number;
  /** refused by a group that names the agent */
  readonly byName: number;
  /** refused by the group `*` */
  readonly byStar: number;
  /** permitted by a group that names the agent */
  readonly welcomed: number;
  /** the share of the sites that answered, in percent with one decimal */
  readonly share: number;
}

/** The headline numbers of one run. */
export interface StudyRun {
  /** the day of the run, `YYYY-MM-DD` in UTC: the version of the dataset */
  readonly version: string;
  /** the DOI of this version on Zenodo, or null until the owner publishes it */
  readonly doi: string | null;
  readonly fetched: { readonly from: string; readonly to: string };
  readonly list: { readonly id: string; readonly date: string; readonly size: number };
  readonly runner?: string;
  /** the sites with a file or with no file: the shares count only these sites */
  readonly answered: number;
  /** the domains in each state */
  readonly states: Readonly<Record<State, number>>;
  readonly agents: readonly RunAgent[];
}

/** The runs of the study, the oldest first. */
export interface StudyHistory {
  readonly runs: readonly StudyRun[];
}

/** These addresses are the data files of one run, relative to the site. */
export const runCsvPath = (version: string): string => `data/robots-study-${version}.csv`;
export const runJsonPath = (version: string): string => `data/robots-study-${version}.json`;

const VERSION = /^\d{4}-\d{2}-\d{2}$/;

/** This function gives the headline numbers of one run from its dataset. */
export const runOf = (study: Study, doi: string | null = null): StudyRun => {
  const count = (state: State): number => study.sites.filter((site) => site.state === state).length;
  return {
    version: studyVersion(study),
    doi,
    fetched: { from: study.fetched.from, to: study.fetched.to },
    list: { id: study.list.id, date: study.list.date, size: study.list.size },
    ...(study.runner === undefined ? {} : { runner: study.runner }),
    answered: answered(study).length,
    states: {
      file: count("file"),
      none: count("none"),
      blocked: count("blocked"),
      unreachable: count("unreachable"),
    },
    agents: agentRows(study).map((row) => ({
      token: row.token,
      refused: row.refused,
      byName: row.byName,
      byStar: row.byStar,
      welcomed: row.welcomed,
      share: row.share,
    })),
  };
};

const byVersion = (a: StudyRun, b: StudyRun): number =>
  a.version < b.version ? -1 : a.version > b.version ? 1 : 0;

/**
 * This function adds a run to the history, or replaces the run of the same version. A run with no DOI
 * keeps the DOI of the run that it replaces, because the DOI names the version.
 */
export const withRun = (history: StudyHistory, run: StudyRun): StudyHistory => {
  if (!VERSION.test(run.version)) throw new Error(`not a version: ${run.version}`);
  const old = history.runs.find((entry) => entry.version === run.version);
  const next: StudyRun = { ...run, doi: run.doi ?? old?.doi ?? null };
  return {
    runs: [...history.runs.filter((entry) => entry.version !== run.version), next].sort(byVersion),
  };
};

/** This function sets the DOI of one version. It fails when the history has no run of that version. */
export const withDoi = (history: StudyHistory, version: string, doi: string): StudyHistory => {
  if (!isDoi(doi)) throw new Error(`not a DOI: ${doi}`);
  if (!history.runs.some((run) => run.version === version))
    throw new Error(`the history has no run ${version}`);
  return {
    runs: history.runs.map((run) => (run.version === version ? { ...run, doi } : run)),
  };
};

/** This function gives the newest run, or undefined for an empty history. */
export const latestRun = (history: StudyHistory): StudyRun | undefined => history.runs.at(-1);

/**
 * This function gives the text of `study-history.json`. Each agent is on its own line, so the diff of
 * a new run is easy to read.
 */
export const historyText = (history: StudyHistory): string => {
  const runs = history.runs.map((run) => {
    const { agents, ...head } = run;
    return `${JSON.stringify(head).slice(0, -1)},"agents":[\n${agents.map((agent) => JSON.stringify(agent)).join(",\n")}\n]}`;
  });
  return `{"runs":[\n${runs.join(",\n")}\n]}\n`;
};

/* ---------------------------------------------------------------------------------------------- */
/* The trend                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The agents of the trend chart, in the fixed sequence of the series colors. These are the agents
 * that the study names first: the training crawlers of four companies and two agents for a person.
 */
export const TREND_AGENTS = [
  "GPTBot",
  "ClaudeBot",
  "Google-Extended",
  "CCBot",
  "ChatGPT-User",
  "Claude-User",
] as const;

export interface TrendPoint {
  /** the index of the run in `Trend.runs` */
  readonly run: number;
  readonly share: number;
  readonly refused: number;
}

export interface TrendSeries {
  readonly token: string;
  /** the series color: `--series-1` for the first agent, and so on */
  readonly slot: number;
  readonly points: readonly TrendPoint[];
  /** the share of the newest run that has the agent */
  readonly latest: number | undefined;
}

export interface TrendRun {
  readonly version: string;
  /** the month, as the axis shows it: `Oct 2026` */
  readonly label: string;
  /** the day, as the tip shows it: `12 October 2026` */
  readonly day: string;
  /** the position on the axis, from 0 to 100, in proportion to the time of the run */
  readonly x: number;
  readonly answered: number;
}

export interface Trend {
  readonly runs: readonly TrendRun[];
  readonly series: readonly TrendSeries[];
  /** the top of the axis, in percent */
  readonly max: number;
  readonly ticks: readonly number[];
  /** the month of the next run when the history has only one run: `November 2026` */
  readonly next: string | undefined;
}

/** This function gives the month after the month of a day: `2026-10-12` gives `November 2026`. */
export const monthAfter = (version: string): string => {
  const [year, month] = version.split("-").map(Number) as [number, number];
  // the months of Date.UTC count from 0, so the number of this month is the index of the next
  return new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
};

/**
 * This function gives the data of the trend chart: for each agent, the share of the sites that
 * refuse it in each run. The series keep the sequence of `tokens`, whatever their values. A run
 * without an agent gives no point for it.
 */
export const trendOf = (history: StudyHistory, tokens: readonly string[] = TREND_AGENTS): Trend => {
  const times = history.runs.map((run) => Date.parse(run.fetched.from));
  const first = times[0] ?? 0;
  const last = times.at(-1) ?? 0;
  const runs = history.runs.map((run, index) => ({
    version: run.version,
    label: new Date(run.fetched.from).toLocaleDateString("en-GB", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }),
    day: formatDay(run.fetched.from),
    x: last === first ? 50 : (((times[index] ?? first) - first) / (last - first)) * 100,
    answered: run.answered,
  }));
  const series = tokens.map((token, index) => {
    const points = history.runs.flatMap((run, at) => {
      const agent = run.agents.find((entry) => entry.token === token);
      return agent === undefined ? [] : [{ run: at, share: agent.share, refused: agent.refused }];
    });
    return { token, slot: index + 1, points, latest: points.at(-1)?.share };
  });
  const max = niceMax(Math.max(0, ...series.flatMap((entry) => entry.points.map((p) => p.share))));
  const only = history.runs.length === 1 ? history.runs[0] : undefined;
  return {
    runs,
    series,
    max,
    ticks: ticks(max),
    next: only === undefined ? undefined : monthAfter(only.version),
  };
};

/* ---------------------------------------------------------------------------------------------- */
/* The pull request of a run                                                                      */
/* ---------------------------------------------------------------------------------------------- */

const STATE_ROWS: ReadonlyArray<readonly [State, string]> = [
  ["file", "A robots.txt file"],
  ["none", "No file"],
  ["blocked", "Blocked at the edge"],
  ["unreachable", "Unreachable"],
];

const signed = (value: number, digits: number): string => {
  const text = Math.abs(value).toFixed(digits);
  return Number(text) === 0 ? "0" : `${value > 0 ? "+" : "-"}${text}`;
};

/** This function gives the id of a record on Zenodo from the DOI of a version, or undefined. */
export const zenodoRecordOf = (doi: string | null): string | undefined =>
  doi === null ? undefined : /^10\.5281\/zenodo\.(\d+)$/.exec(doi)?.[1];

/**
 * This function gives the body of the pull request of the newest run, in Markdown. The body has the
 * headline numbers, the change against the run before it, the checks that passed and the next steps.
 */
export const runReport = (
  history: StudyHistory,
  options: { readonly checks: readonly string[]; readonly repository: string },
): string => {
  const run = latestRun(history);
  if (run === undefined) throw new Error("the history has no run");
  const before = history.runs.at(-2);
  const size = run.list.size.toLocaleString("en-US");
  const lines: string[] = [
    `## The robots.txt study of ${formatDay(run.fetched.from)}`,
    "",
    `The workflow read \`/robots.txt\` of the top ${size} domains of the Tranco list \`${run.list.id}\` (${run.list.date})${run.runner === undefined ? "" : `, from ${run.runner}`}. The requests went out from \`${run.fetched.from}\` to \`${run.fetched.to}\`.`,
    "",
    before === undefined
      ? "This is the first run of the history, so the tables show no change."
      : `The change is against the run of ${formatDay(before.fetched.from)} (\`${before.version}\`).`,
    "",
    "### The answers",
    "",
    "| | This run | The run before | Change |",
    "| --- | ---: | ---: | ---: |",
    `| Sites that answered | ${String(run.answered)} | ${before === undefined ? "–" : String(before.answered)} | ${before === undefined ? "–" : signed(run.answered - before.answered, 0)} |`,
    ...STATE_ROWS.map(([state, label]) => {
      const now = run.states[state];
      const then = before?.states[state];
      return `| ${label} | ${String(now)} | ${then === undefined ? "–" : String(then)} | ${then === undefined ? "–" : signed(now - then, 0)} |`;
    }),
    "",
    "### The share of the sites that answered that refuse each agent",
    "",
    "| Agent | This run | The run before | Change in points |",
    "| --- | ---: | ---: | ---: |",
    ...run.agents.map((agent) => {
      const then = before?.agents.find((entry) => entry.token === agent.token);
      return `| \`${agent.token}\` | ${agent.share.toFixed(1)}% (${String(agent.refused)}) | ${then === undefined ? "–" : `${then.share.toFixed(1)}% (${String(then.refused)})`} | ${then === undefined ? "–" : signed(agent.share - then.share, 1)} |`;
    }),
    "",
    "### The checks that passed",
    "",
    ...options.checks.map((check) => `- ${check}`),
    "",
    "### After the merge",
    "",
  ];
  const record = [...history.runs]
    .reverse()
    .map((entry) => zenodoRecordOf(entry.doi))
    .find((id) => id !== undefined);
  lines.push(
    record === undefined
      ? `1. Make the record on Zenodo: \`gh workflow run study-zenodo.yml -R ${options.repository}\``
      : `1. Make the new version on Zenodo: \`gh workflow run study-zenodo.yml -R ${options.repository} -f new_version_of=${record}\``,
    "2. Check the draft on Zenodo, then click Publish.",
    `3. Record the DOI of the version: \`pnpm exec tsx packages/site/scripts/robots-study.ts doi ${run.version} <doi>\`, then commit the change on a branch and open a pull request.`,
    "",
  );
  return lines.join("\n");
};

/* ---------------------------------------------------------------------------------------------- */
/* The Tranco list                                                                                */
/* ---------------------------------------------------------------------------------------------- */

/** This address is the site of the Tranco list. */
export const TRANCO = "https://tranco-list.eu";

/** The facts of a Tranco list that a run records. */
export interface TrancoList {
  readonly id: string;
  /** the last day of the 30 days of the list, `YYYY-MM-DD` */
  readonly date: string;
}

/**
 * This function reads the answer of the Tranco API for one list (`/api/lists/id/<id>`). It fails
 * when the list is not a daily list that Tranco has made, because the study uses only daily lists.
 */
export const trancoListOf = (id: string, answer: unknown): TrancoList => {
  if (!/^[A-Z0-9]{4,8}$/.test(id)) throw new Error(`not a Tranco list id: ${id}`);
  const meta = answer as {
    readonly list_id?: unknown;
    readonly available?: unknown;
    readonly failed?: unknown;
    readonly created_on?: unknown;
    readonly configuration?: { readonly isDailyList?: unknown; readonly endDate?: unknown };
  };
  if (meta.list_id !== id) throw new Error(`the Tranco API gave the list ${String(meta.list_id)}`);
  if (meta.available !== true || meta.failed === true)
    throw new Error(`the Tranco list ${id} is not available`);
  if (meta.configuration?.isDailyList !== true)
    throw new Error(`the Tranco list ${id} is not a daily list`);
  const day = [meta.configuration.endDate, meta.created_on].find(
    (value): value is string => typeof value === "string",
  );
  const date = (day ?? "").slice(0, 10);
  if (!VERSION.test(date)) throw new Error(`the Tranco list ${id} has no date`);
  return { id, date };
};

/**
 * This function reads the CSV of a Tranco list (`rank,domain` on each line) and gives its first
 * `size` lines. It fails when a line is not a rank and a domain, or when a rank is out of sequence.
 */
export const topDomains = (csv: string, size: number = STUDY_SIZE): string => {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, size);
  if (lines.length < size)
    throw new Error(`the list has ${String(lines.length)} domains, not ${String(size)}`);
  lines.forEach((line, index) => {
    const match = /^(\d+),([a-z0-9.-]+)$/i.exec(line);
    if (match === null) throw new Error(`line ${String(index + 1)} is not a rank and a domain`);
    if (Number(match[1]) !== index + 1)
      throw new Error(`line ${String(index + 1)} has the rank ${String(match[1])}`);
  });
  return `${lines.join("\n")}\n`;
};
