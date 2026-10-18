import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import historyData from "../data/study-history.json";
import studyDoi from "../data/study-doi.json";
import type { StudyHistory, StudyRun } from "./runs.ts";
import {
  TREND_AGENTS,
  historyText,
  monthAfter,
  runOf,
  runReport,
  topDomains,
  trancoListOf,
  trendOf,
  withDoi,
  withRun,
  zenodoRecordOf,
} from "./runs.ts";
import type { Study } from "./study.ts";
import { toCsv } from "./study.ts";

// No test sends a request: the files of the runs are on disk, and the other runs are synthetic.

const site = new URL("../../", import.meta.url);
const bytesOf = (path: string): Buffer => readFileSync(new URL(path, site));
const textOf = (path: string): string => bytesOf(path).toString("utf8");
const md5 = (bytes: Buffer): string => createHash("md5").update(bytes).digest("hex");
const history = historyData as unknown as StudyHistory;
const versions = readdirSync(new URL("src/data/study/", site))
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.slice(0, -".json".length))
  .sort();
const studyOf = (version: string): Study =>
  JSON.parse(textOf(`src/data/study/${version}.json`)) as Study;

/** A synthetic run with the given share for each agent of the trend. */
const synthetic = (
  version: string,
  shares: Readonly<Record<string, number>>,
  answered = 500,
): StudyRun => ({
  version,
  doi: null,
  fetched: { from: `${version}T06:17:00.000Z`, to: `${version}T06:18:00.000Z` },
  list: { id: "TEST1", date: version, size: 1000 },
  answered,
  states: { file: answered - 50, none: 50, blocked: 100, unreachable: 400 },
  agents: Object.entries(shares).map(([token, share]) => ({
    token,
    refused: Math.round((share / 100) * answered),
    byName: 0,
    byStar: 0,
    welcomed: 0,
    share,
  })),
});

describe("the move of the first run into the history", () => {
  it("keeps the files of the run of 12 October 2026 as the published version on Zenodo has them", () => {
    // the checksums of robots-study.json and robots-study.csv in the record 10.5281/zenodo.23443375
    expect(md5(bytesOf("src/data/study/2026-10-12.json"))).toBe("f253f53e24eba0ef22f6a5cad88ddff6");
    expect(md5(bytesOf("public/data/robots-study-2026-10-12.csv"))).toBe(
      "67c296445c9b15bbdc0ad8654c7e101e",
    );
  });

  it("keeps the numbers of the run of 12 October 2026 as the study page showed them", () => {
    const run = history.runs.find((entry) => entry.version === "2026-10-12");
    expect(run).toMatchObject({
      doi: "10.5281/zenodo.23443375",
      fetched: { from: "2026-10-12T19:10:28.855Z", to: "2026-10-12T19:11:25.306Z" },
      list: { id: "4672X", date: "2026-10-11", size: 1000 },
      answered: 559,
      states: { file: 510, none: 49, blocked: 77, unreachable: 364 },
    });
    const agent = (token: string) => run?.agents.find((entry) => entry.token === token);
    expect(agent("GPTBot")).toEqual({
      token: "GPTBot",
      refused: 116,
      byName: 84,
      byStar: 32,
      welcomed: 44,
      share: 20.8,
    });
    expect(agent("ClaudeBot")).toMatchObject({ refused: 116, share: 20.8 });
    expect(agent("ChatGPT-User")).toMatchObject({ refused: 80, share: 14.3 });
    expect(agent("Claude-User")).toMatchObject({ refused: 78, share: 14 });
    expect(agent("Googlebot")).toMatchObject({ refused: 23, share: 4.1 });
    expect(run?.agents).toHaveLength(15);
  });

  it("gives study-doi.json the DOI that the history has for its version, and the concept DOI", () => {
    const named = history.runs.find((run) => run.version === studyDoi.version);
    expect(named?.doi ?? null).toBe(studyDoi.doi);
    expect(studyDoi.concept).toBe("10.5281/zenodo.23443374");
  });
});

describe("the files of the runs", () => {
  it("has one line in the history for each file of a run, the oldest first", () => {
    expect(history.runs.map((run) => run.version)).toEqual(versions);
    expect(versions).toContain("2026-10-12");
  });

  it("gives the numbers of each run from its dataset", () => {
    for (const run of history.runs) expect(runOf(studyOf(run.version), run.doi)).toEqual(run);
  });

  it("keeps a CSV for each run that agrees with its JSON", () => {
    for (const version of versions)
      expect(textOf(`public/data/robots-study-${version}.csv`)).toBe(toCsv(studyOf(version)));
  });

  it("keeps the newest run as the latest copy that the pages read", () => {
    const newest = versions.at(-1) ?? "";
    expect(textOf("src/data/robots-study.json")).toBe(textOf(`src/data/study/${newest}.json`));
    expect(textOf("public/data/robots-study.csv")).toBe(
      textOf(`public/data/robots-study-${newest}.csv`),
    );
  });

  it("writes the history in the format of the file, one agent on each line", () => {
    expect(textOf("src/data/study-history.json")).toBe(historyText(history));
    expect(JSON.parse(historyText(history))).toEqual(history);
  });
});

describe("a new run in the history", () => {
  const one = { runs: [synthetic("2026-10-12", { GPTBot: 20 })] };

  it("adds a run in the sequence of the versions, and replaces a run of the same version", () => {
    const two = withRun(one, synthetic("2026-11-02", { GPTBot: 21 }));
    expect(two.runs.map((run) => run.version)).toEqual(["2026-10-12", "2026-11-02"]);
    const back = withRun(two, synthetic("2026-09-02", { GPTBot: 19 }));
    expect(back.runs.map((run) => run.version)).toEqual(["2026-09-02", "2026-10-12", "2026-11-02"]);
    const again = withRun(two, synthetic("2026-11-02", { GPTBot: 22 }));
    expect(again.runs).toHaveLength(2);
    expect(again.runs[1]?.agents[0]?.share).toBe(22);
  });

  it("keeps the DOI of a version when the run of that version is written again", () => {
    const published = withDoi(one, "2026-10-12", "10.5281/zenodo.1234567");
    expect(published.runs[0]?.doi).toBe("10.5281/zenodo.1234567");
    expect(withRun(published, synthetic("2026-10-12", { GPTBot: 20 })).runs[0]?.doi).toBe(
      "10.5281/zenodo.1234567",
    );
    expect(() => withDoi(one, "2026-10-12", "zenodo.1234567")).toThrow(/not a DOI/);
    expect(() => withDoi(one, "2026-11-02", "10.5281/zenodo.1234567")).toThrow(/no run/);
    expect(zenodoRecordOf("10.5281/zenodo.1234567")).toBe("1234567");
    expect(zenodoRecordOf(null)).toBeUndefined();
  });

  it("writes the body of the pull request with the change against the run before", () => {
    const two = withRun(
      withDoi(one, "2026-10-12", "10.5281/zenodo.1234567"),
      synthetic("2026-11-02", { GPTBot: 21.5 }, 510),
    );
    const body = runReport(two, {
      checks: ["The site builds"],
      repository: "mark1russell7/crawler",
    });
    expect(body).toContain("## The robots.txt study of 2 November 2026");
    expect(body).toContain("| Sites that answered | 510 | 500 | +10 |");
    expect(body).toContain("| `GPTBot` | 21.5% (110) | 20.0% (100) | +1.5 |");
    expect(body).toContain("- The site builds");
    expect(body).toContain("-f new_version_of=1234567");
    expect(body).toContain("robots-study.ts doi 2026-11-02 <doi>");
    expect(runReport(one, { checks: [], repository: "a/b" })).toContain("the first run");
  });
});

describe("the trend", () => {
  it("shows one point for each agent when the history has one run, and names the next month", () => {
    const trend = trendOf(history.runs.length === 1 ? history : { runs: [history.runs[0]!] });
    expect(trend.runs).toHaveLength(1);
    expect(trend.runs[0]).toMatchObject({ version: "2026-10-12", label: "Oct 2026", x: 50 });
    expect(trend.next).toBe("November 2026");
    expect(trend.series.map((entry) => entry.token)).toEqual([...TREND_AGENTS]);
    expect(trend.series.map((entry) => entry.slot)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const entry of trend.series) expect(entry.points).toHaveLength(1);
    expect(trend.series[0]).toMatchObject({ token: "GPTBot", latest: 20.8 });
    // the axis holds the largest share: CCBot, 23.6%
    expect(trend.max).toBe(25);
    expect(trend.ticks).toEqual([0, 5, 10, 15, 20, 25]);
  });

  it("puts two runs at the ends of the axis, and keeps the sequence of the series", () => {
    const shares = (gpt: number, claude: number) =>
      Object.fromEntries(TREND_AGENTS.map((token, index) => [token, index === 0 ? gpt : claude]));
    const two = {
      runs: [synthetic("2026-10-12", shares(20.8, 14)), synthetic("2026-11-02", shares(31, 15))],
    };
    const trend = trendOf(two);
    expect(trend.runs.map((run) => run.x)).toEqual([0, 100]);
    expect(trend.runs.map((run) => run.label)).toEqual(["Oct 2026", "Nov 2026"]);
    expect(trend.next).toBeUndefined();
    // the series keep their colors when the values change places
    expect(trend.series.map((entry) => entry.token)).toEqual([...TREND_AGENTS]);
    expect(trend.series[0]?.points.map((point) => point.share)).toEqual([20.8, 31]);
    expect(trend.series[0]?.latest).toBe(31);
    expect(trend.max).toBe(35);
  });

  it("puts a run in proportion to its time, and gives no point for an agent that a run does not have", () => {
    const trend = trendOf({
      runs: [
        synthetic("2026-01-01", { GPTBot: 10 }),
        synthetic("2026-01-11", { GPTBot: 10, ClaudeBot: 5 }),
        synthetic("2026-01-31", { GPTBot: 12 }),
      ],
    });
    expect(trend.runs.map((run) => Math.round(run.x))).toEqual([0, 33, 100]);
    expect(trend.series[1]?.points).toEqual([{ run: 1, share: 5, refused: 25 }]);
    expect(trend.series[2]?.points).toEqual([]);
    expect(trend.series[2]?.latest).toBeUndefined();
  });

  it("gives the month after a day, also across the end of a year", () => {
    expect(monthAfter("2026-10-12")).toBe("November 2026");
    expect(monthAfter("2026-12-02")).toBe("January 2027");
  });
});

describe("the Tranco list", () => {
  const meta = {
    list_id: "4672X",
    available: true,
    failed: false,
    created_on: "2026-10-11T22:00:02.355906",
    configuration: { isDailyList: true, endDate: "2026-10-11" },
  };

  it("reads the id and the date of a daily list from the API", () => {
    expect(trancoListOf("4672X", meta)).toEqual({ id: "4672X", date: "2026-10-11" });
    expect(() => trancoListOf("4672X", { ...meta, list_id: "OTHER" })).toThrow(/gave the list/);
    expect(() => trancoListOf("4672X", { ...meta, configuration: { isDailyList: false } })).toThrow(
      /not a daily list/,
    );
    expect(() => trancoListOf("4672X", { ...meta, available: false })).toThrow(/not available/);
    expect(() => trancoListOf("<x>", meta)).toThrow(/not a Tranco list id/);
  });

  it("keeps the top domains of the CSV, and refuses a short or a broken list", () => {
    const csv = Array.from(
      { length: 5 },
      (_, index) => `${String(index + 1)},d${String(index)}.example`,
    )
      .join("\r\n")
      .concat("\r\n");
    expect(topDomains(csv, 3)).toBe("1,d0.example\n2,d1.example\n3,d2.example\n");
    expect(() => topDomains(csv, 6)).toThrow(/has 5 domains/);
    expect(() => topDomains("1,a.example\n3,b.example\n", 2)).toThrow(/rank 3/);
    expect(() => topDomains("1,a.example\nb.example\n", 2)).toThrow(/not a rank/);
  });
});
