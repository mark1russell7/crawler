import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import evalA from "../data/eval-a.json";
import evalB from "../data/eval-b.json";
import survey from "../data/restaurant-survey.json";
import study from "../data/robots-study.json";
import history from "../data/study-history.json";
import {
  EVAL_A_LIMIT_DAYS,
  EVAL_A_LIMIT_TEXT,
  STUDY_LIMIT_DAYS,
  STUDY_LIMIT_TEXT,
  STUDY_PAGES,
  evalAStamp,
  studyLimitStamps,
  studyStamps,
  versionOf,
} from "./data-stamps.ts";

const noteOf = (page: string): string =>
  readFileSync(
    new URL(`../content/docs/${page.replace("/index.html", "")}.mdx`, import.meta.url),
    "utf8",
  );

describe("evalAStamp", () => {
  it("takes the run, its start, its version and its full commit from the data file", () => {
    const stamp = evalAStamp();
    expect(stamp.study).toBeUndefined();
    expect(stamp.runs).toEqual([
      {
        id: String(evalA.run),
        url: `https://github.com/mark1russell7/crawler/actions/runs/${String(evalA.run)}`,
        date: evalA.started,
        engines: { "polite-crawler": versionOf(evalA.package) },
        commit: evalA.commitSha,
      },
    ]);
    expect(evalA.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(evalA.commitSha.startsWith(evalA.commit)).toBe(true);
  });

  it("gives a limit that the weekly schedule of eval.yml meets, with no ruling over 14 days", () => {
    const { limit } = evalAStamp();
    expect(limit?.workflow).toBe(".github/workflows/eval.yml");
    expect(limit?.days).toBe(EVAL_A_LIMIT_DAYS);
    expect(EVAL_A_LIMIT_DAYS).toBeGreaterThanOrEqual(7);
    expect(EVAL_A_LIMIT_DAYS).toBeLessThanOrEqual(14);
    const workflow = readFileSync(
      new URL("../../../../.github/workflows/eval.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toMatch(/cron: "\d+ \d+ \* \* 1"/);
  });

  it("shows the limit in plain words on the page, and no claim that the page is fixed", () => {
    const text = noteOf(evalAStamp().page);
    expect(text).toContain("{EVAL_A_LIMIT_TEXT}");
    expect(text).not.toContain("fixed study");
    expect(EVAL_A_LIMIT_TEXT).toContain(`${EVAL_A_LIMIT_DAYS} days`);
  });
});

describe("studyStamps", () => {
  it("takes the run, the date and the version from each data file", () => {
    const [sessions, restaurants] = studyStamps();
    expect(sessions?.runs.map((run) => run.id)).toEqual(evalB.runs.map((run) => String(run.run)));
    expect(sessions?.runs.map((run) => run.engines["polite-crawler-mcp"])).toEqual(
      evalB.runs.map((run) => run.mcp),
    );
    expect(restaurants?.runs[0]?.date).toBe(survey.date);
  });

  it("gives each page a run with a date and a link", () => {
    for (const stamp of studyStamps()) {
      expect(stamp.runs.length).toBeGreaterThan(0);
      for (const run of stamp.runs) {
        expect(Number.isNaN(Date.parse(run.date))).toBe(false);
        expect(run.url.startsWith("https://")).toBe(true);
      }
    }
  });

  it("gives each study both statements of no limit, and shows both on its page", () => {
    for (const stamp of studyStamps()) {
      expect(stamp.study).toBe(true);
      expect(stamp.limit).toBeUndefined();
      expect(stamp.noLimit?.reproduce.length).toBeGreaterThan(0);
      expect(stamp.noLimit?.today.length).toBeGreaterThan(0);
      const text = noteOf(stamp.page);
      expect(text).toContain("This page is a fixed study of");
      expect(text).toMatch(/\{[A-Z_]+_NO_LIMIT\.reproduce\} \{[A-Z_]+_NO_LIMIT\.today\}/);
    }
  });

  it("fails on a text with no version", () => {
    expect(() => versionOf("polite-crawler")).toThrow(/No version/);
  });
});

const SRC = new URL("../", import.meta.url);

/** This function gives the path and the text of each source file of the pages, the components and the content. */
function sources(): { readonly path: string; readonly text: string }[] {
  return ["content/docs", "components", "pages"].flatMap((folder) =>
    readdirSync(new URL(`${folder}/`, SRC), { recursive: true, encoding: "utf8" })
      .map((name) => `${folder}/${name.replaceAll("\\", "/")}`)
      .filter((path) => /\.(mdx|astro|tsx|ts)$/.test(path) && !path.includes(".test."))
      .map((path) => ({ path, text: readFileSync(new URL(path, SRC), "utf8") })),
  );
}

const DATA_FILE = /data\/robots-study\.json/;

/** The source files of the pages of the limit. The home page shows the study through its hero and `StudyTeaser`. */
const SOURCE_OF_PAGE: Readonly<Record<(typeof STUDY_PAGES)[number], string>> = {
  "index.html": "components/StudyTeaser.astro",
  "notes/robots-txt-ai-agents/index.html": "content/docs/notes/robots-txt-ai-agents.mdx",
  "block-ai-training-crawlers/index.html": "content/docs/block-ai-training-crawlers.mdx",
  "bot/index.html": "content/docs/bot.mdx",
};

/** This function finds a number of the study that a source file holds as its own copy. */
function ownCopies(text: string): string[] {
  const shares = history.runs.flatMap((run) => run.agents.map((agent) => agent.share));
  const answered = history.runs.map((run) => run.answered);
  const hits = [...new Set(shares)]
    .filter((share) => new RegExp(`(?<![\\d.])${String(share).replace(".", "\\.")} ?%`).test(text))
    .map((share) => `${share}%`);
  return [
    ...hits,
    ...[...new Set(answered)]
      .filter((count) => new RegExp(`(?<![\\d.,])${count} (?:sites|domains)`).test(text))
      .map(String),
  ];
}

describe("studyLimitStamps", () => {
  it("gives each page of the study the same limit, run and date", () => {
    const stamps = studyLimitStamps();
    expect(stamps.map((stamp) => stamp.page)).toEqual([...STUDY_PAGES]);
    expect(new Set(stamps.map((stamp) => JSON.stringify([stamp.limit, stamp.runs]))).size).toBe(1);
    expect(stamps[0]?.limit?.days).toBe(33);
    expect(stamps[0]?.runs[0]?.date).toBe(study.fetched.from);
    expect(stamps[0]?.runs[0]?.engines).toEqual({ "polite-crawler": versionOf(study.userAgent) });
  });

  it("shows the limit in plain words on each page, from the one data file", () => {
    for (const page of STUDY_PAGES) {
      const text = readFileSync(new URL(SOURCE_OF_PAGE[page], SRC), "utf8");
      expect(text, page).toContain("{STUDY_LIMIT_TEXT}");
      expect(text, page).toMatch(DATA_FILE);
    }
    expect(STUDY_LIMIT_TEXT).toContain(`${STUDY_LIMIT_DAYS} days`);
  });

  it("names each content page that reads the study, so the list of pages cannot get old", () => {
    const named = new Set(Object.values(SOURCE_OF_PAGE));
    const readers = sources().filter(
      ({ path, text }) => path.startsWith("content/docs/") && DATA_FILE.test(text),
    );
    expect(readers.map(({ path }) => path).filter((path) => !named.has(path))).toEqual([]);
  });

  it("finds no page that holds its own copy of a number of the study", () => {
    const copies = sources().flatMap(({ path, text }) =>
      ownCopies(text).map((hit) => `${path}: ${hit}`),
    );
    expect(copies).toEqual([]);
  });

  it("fails on a copy of a number", () => {
    const share = history.runs[0]?.agents[0]?.share;
    expect(ownCopies(`In the study, ${share}% refuse the agent.`)).toEqual([`${share}%`]);
    expect(ownCopies(`${history.runs[0]?.answered} sites answered.`)).toEqual([
      String(history.runs[0]?.answered),
    ]);
    expect(ownCopies("This page reads {summary.share}% from the data file.")).toEqual([]);
  });
});
