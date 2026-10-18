// The robots.txt study. polite-crawler reads /robots.txt of each domain of a Tranco list, and this
// script writes the verdict for each AI agent. Each run keeps its own files, and the newest run is
// also the "latest" copy that the pages read:
//   src/data/study/<version>.json, public/data/robots-study-<version>.csv  each run
//   src/data/robots-study.json, public/data/robots-study.csv               the newest run
//   src/data/study-history.json                                            the numbers and the DOI of each run
//
// Start it from the root of the repository:
//   pnpm exec tsx packages/site/scripts/robots-study.ts tranco <out.csv>
//   pnpm exec tsx packages/site/scripts/robots-study.ts fetch <tranco.csv> <list id> <list date> [store dir]
//   pnpm exec tsx packages/site/scripts/robots-study.ts derive <store dir>
//   pnpm exec tsx packages/site/scripts/robots-study.ts history
//   pnpm exec tsx packages/site/scripts/robots-study.ts doi <version> <doi>
//   pnpm exec tsx packages/site/scripts/robots-study.ts report <out.md> [check...]
//
// `tranco` gets the newest daily Tranco list through polite-crawler, with its User-Agent, and writes
// its top 1,000 domains. It also writes the id and the date of the list to GITHUB_OUTPUT.
//
// `fetch` sends one request for /robots.txt to each domain (and follows its redirects), with the
// default User-Agent of the crawler and no contact. It needs a fresh store: with no stored copy, the
// crawler sends no conditional request, so no answer is a 304. Without a store dir, it makes one in
// the temp folder. The store keeps the capture log, the bodies and answers.ndjson. The environment
// variable STUDY_RUNNER names the computer of the run in the dataset, for example a GitHub runner.
//
// `derive` reads answers.ndjson and the bodies again and writes the files of the run. It sends no
// request, so a change to the classification in src/lib/study.ts needs no new run.
//
// `history` writes study-history.json again from the files in src/data/study, and keeps each DOI.
// `doi` records the DOI of a version on Zenodo in the history, and in study-doi.json for the newest run.
// `report` writes the body of the pull request of the newest run, with the checks that passed.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Robots, RobotsDecision } from "polite-crawler";
import {
  ALLOW_ALL,
  CaptureLog,
  Crawler,
  DEFAULT_TOKEN,
  DocIndex,
  FileBlobStore,
  decide,
  defaultUserAgent,
} from "polite-crawler";
import { robotsFromResponse } from "polite-crawler/robots";
import type { StudyDoi } from "../src/lib/cite.ts";
import { studyVersion } from "../src/lib/cite.ts";
import { studyDoiFile } from "../src/lib/dataset.ts";
import type { StudyHistory } from "../src/lib/runs.ts";
import {
  STUDY_SIZE,
  TRANCO,
  historyText,
  latestRun,
  runCsvPath,
  runOf,
  runReport,
  topDomains,
  trancoListOf,
  withDoi,
  withRun,
} from "../src/lib/runs.ts";
import type { RawAnswer, Study, StudySite } from "../src/lib/study.ts";
import { DATA_LICENSE, answerOf, toCsv } from "../src/lib/study.ts";

/** The agents of the study, in the order of the dataset. */
const AGENTS = [
  // crawlers that collect training data (or tokens that control the use for training)
  { token: "GPTBot", owner: "OpenAI", role: "training" },
  { token: "ClaudeBot", owner: "Anthropic", role: "training" },
  { token: "Google-Extended", owner: "Google", role: "training" },
  { token: "CCBot", owner: "Common Crawl", role: "training" },
  { token: "Applebot-Extended", owner: "Apple", role: "training" },
  { token: "Bytespider", owner: "ByteDance", role: "training" },
  { token: "meta-externalagent", owner: "Meta", role: "training" },
  // crawlers for AI search
  { token: "OAI-SearchBot", owner: "OpenAI", role: "search" },
  { token: "Claude-SearchBot", owner: "Anthropic", role: "search" },
  { token: "PerplexityBot", owner: "Perplexity", role: "search" },
  // agents that fetch a page because a person asked
  { token: "ChatGPT-User", owner: "OpenAI", role: "user" },
  { token: "Claude-User", owner: "Anthropic", role: "user" },
  { token: "Perplexity-User", owner: "Perplexity", role: "user" },
  // controls
  { token: "Googlebot", owner: "Google", role: "control" },
  { token: DEFAULT_TOKEN, owner: "polite-crawler", role: "control" },
] as const;

/** A page path that no rule names: a site that refuses it refuses the agent for its pages. */
const PAGE_PATH = "/polite-crawler-study/a-page";

/** One line of answers.ndjson: what the crawler got for one domain. */
interface Stored {
  readonly rank: number;
  readonly domain: string;
  readonly url: string;
  readonly status: number;
  readonly outcome: string;
  readonly contentType?: string;
  readonly note?: string;
  readonly blob?: string;
  readonly bytes?: number;
}

/** The facts of a run, in run.json. */
interface Run {
  readonly list: Study["list"];
  readonly fetched: Study["fetched"];
  readonly userAgent: string;
  readonly runner?: string;
}

const site = fileURLToPath(new URL("..", import.meta.url));
const jsonOut = join(site, "src/data/robots-study.json");
const csvOut = join(site, "public/data/robots-study.csv");
const runsDir = join(site, "src/data/study");
const historyOut = join(site, "src/data/study-history.json");
const doiOut = join(site, "src/data/study-doi.json");
const runJson = (version: string): string => join(runsDir, `${version}.json`);
const runCsv = (version: string): string => join(site, "public", runCsvPath(version));

const readHistory = (): StudyHistory =>
  existsSync(historyOut)
    ? (JSON.parse(readFileSync(historyOut, "utf8")) as StudyHistory)
    : { runs: [] };

/**
 * This function writes the files of one run: its dataset, its CSV and its line in the history. When
 * the run is the newest, it also writes the latest copy that the pages read.
 */
const writeRun = (text: string): void => {
  const study = JSON.parse(text) as Study;
  const version = studyVersion(study);
  const csv = toCsv(study);
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(runJson(version), text);
  mkdirSync(dirname(runCsv(version)), { recursive: true });
  writeFileSync(runCsv(version), csv);
  const history = withRun(readHistory(), runOf(study));
  writeFileSync(historyOut, historyText(history));
  const written = [runJson(version), runCsv(version), historyOut];
  if (latestRun(history)?.version === version) {
    writeFileSync(jsonOut, text);
    writeFileSync(csvOut, csv);
    written.push(jsonOut, csvOut);
  }
  console.info(`wrote ${written.join(", ")}`);
};

/** This function gets the newest daily Tranco list through polite-crawler and writes its top domains. */
const tranco = async (out: string): Promise<void> => {
  const store = mkdtempSync(join(tmpdir(), "tranco-"));
  const crawler = new Crawler({
    token: DEFAULT_TOKEN,
    userAgent: defaultUserAgent(),
    log: new CaptureLog(join(store, "captures")),
    blobs: new FileBlobStore(join(store, "blobs")),
    index: new DocIndex(join(store, "index.sqlite")),
    maxActive: 1,
  });
  // the Tranco API is documented for programs (mode "api"), and it asks for one request each second
  const get = async (url: string, accept: string): Promise<string> => {
    const fetched = await crawler.fetch({
      url,
      mode: "api",
      recipe: "tranco",
      accept,
      maxBytes: 4 * 1024 * 1024,
      minIntervalMs: 1100,
    });
    if (fetched.status !== 200 || fetched.body === undefined)
      throw new Error(
        `${url}: status ${String(fetched.status)}, ${fetched.outcome}${fetched.note === undefined ? "" : `, ${fetched.note}`}`,
      );
    return new TextDecoder("utf-8").decode(fetched.body);
  };
  try {
    const id = (await get(`${TRANCO}/top-1m-id`, "text/plain")).trim();
    const list = trancoListOf(
      id,
      JSON.parse(await get(`${TRANCO}/api/lists/id/${id}`, "application/json")) as unknown,
    );
    const csv = topDomains(
      await get(`${TRANCO}/download/${id}/${String(STUDY_SIZE)}`, "text/csv"),
      STUDY_SIZE,
    );
    writeFileSync(out, csv);
    console.info(`the Tranco list ${list.id} of ${list.date}: ${String(STUDY_SIZE)} domains`);
    const output = process.env["GITHUB_OUTPUT"];
    if (output !== undefined && output.length > 0)
      appendFileSync(output, [`id=${list.id}`, `date=${list.date}`, ""].join("\n"));
  } finally {
    await crawler.close();
  }
};

/** One code for each agent: refused by a named group, refused by `*`, permitted by a named group, permitted. */
const code = (decision: RobotsDecision, token: string): string => {
  // the product token of a user-agent line, as the parser matches it
  const tokenOf = (agent: string): string => /^[a-z_-]+/.exec(agent.trim())?.[0] ?? "";
  const named = (decision.groups ?? []).some((group) =>
    group.agents.some((agent) => agent !== "*" && tokenOf(agent) === token.toLowerCase()),
  );
  if (!decision.allowed) return named ? "N" : "S";
  return named ? "n" : ".";
};

const fetchAll = async (
  csv: string,
  listId: string,
  listDate: string,
  given: string | undefined,
): Promise<string> => {
  const store = given ?? mkdtempSync(join(tmpdir(), "robots-study-"));
  if (existsSync(store) && readdirSync(store).length > 0) {
    console.error(
      `${store} is not empty. A study needs a fresh store, so that no request is conditional.`,
    );
    process.exit(2);
  }
  mkdirSync(store, { recursive: true });
  const domains = readFileSync(csv, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [rank, domain] = line.split(",");
      return { rank: Number(rank), domain: String(domain) };
    });
  const crawler = new Crawler({
    token: DEFAULT_TOKEN,
    userAgent: defaultUserAgent(),
    log: new CaptureLog(join(store, "captures")),
    blobs: new FileBlobStore(join(store, "blobs")),
    index: new DocIndex(join(store, "index.sqlite")),
    maxActive: 24,
  });
  const answers = join(store, "answers.ndjson");
  const from = new Date().toISOString();
  let done = 0;
  await Promise.all(
    domains.map(async ({ rank, domain }) => {
      // one request for each domain, with its redirects: no second try and no www.<domain>
      const fetched = await crawler.fetch({
        url: `https://${domain}/robots.txt`,
        mode: "api",
        recipe: "robots.txt",
        accept: "text/plain",
        maxBytes: 512 * 1024,
      });
      const stored: Stored = {
        rank,
        domain,
        url: fetched.url,
        status: fetched.status,
        outcome: fetched.outcome,
        ...(fetched.contentType !== undefined ? { contentType: fetched.contentType } : {}),
        ...(fetched.note !== undefined ? { note: fetched.note } : {}),
        ...(fetched.blob !== undefined ? { blob: fetched.blob } : {}),
        ...(fetched.body !== undefined ? { bytes: fetched.body.byteLength } : {}),
      };
      appendFileSync(answers, `${JSON.stringify(stored)}\n`);
      done += 1;
      if (done % 50 === 0) console.info(`${String(done)} of ${String(domains.length)}`);
    }),
  );
  await crawler.close();
  const runner = process.env["STUDY_RUNNER"]?.trim();
  const run: Run = {
    list: {
      name: "Tranco",
      id: listId,
      date: listDate,
      url: `${TRANCO}/list/${listId}/${String(STUDY_SIZE)}`,
      size: domains.length,
    },
    fetched: { from, to: new Date().toISOString() },
    userAgent: defaultUserAgent(),
    ...(runner === undefined || runner.length === 0 ? {} : { runner }),
  };
  writeFileSync(join(store, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  console.info(`the store is ${store}`);
  return store;
};

const derive = async (store: string): Promise<void> => {
  const run = JSON.parse(readFileSync(join(store, "run.json"), "utf8")) as Run;
  const blobs = new FileBlobStore(join(store, "blobs"));
  const stored = readFileSync(join(store, "answers.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Stored)
    .sort((a, b) => a.rank - b.rank);
  const sites: StudySite[] = [];
  for (const answer of stored) {
    const body = answer.blob === undefined ? undefined : await blobs.get(answer.blob);
    const text = body === undefined ? undefined : new TextDecoder("utf-8").decode(body);
    const raw: RawAnswer = {
      status: answer.status,
      outcome: answer.outcome,
      contentType: answer.contentType,
      text,
      note: answer.note,
    };
    const { state, html, reason } = answerOf(raw);
    const host = new URL(answer.url).host;
    const counted = state === "file" || state === "none";
    // the rules: a file is read as the crawler reads it (robotsFromResponse), and no file gives no rules
    const robots: Robots =
      state === "file"
        ? robotsFromResponse(200, answer.contentType, body ?? new Uint8Array())
        : ALLOW_ALL;
    const out: {
      -readonly [key in keyof StudySite]: StudySite[key];
    } = { rank: answer.rank, domain: answer.domain, status: answer.status, state, p: "" };
    if (host !== answer.domain) out.host = host;
    if (reason !== undefined) out.reason = reason.replace(/\s+/g, " ").trim().slice(0, 160);
    if (html) out.html = true;
    if (state === "file") {
      out.bytes = answer.bytes ?? 0;
      out.groups = robots.groups.length;
      // a file can repeat its signal in each group: keep each line one time. Only the content signals
      // count here, not the RSL License lines that the parser also keeps
      const signals = [
        ...new Set(
          robots.signals
            .filter((line) => /^content-(?:signal|usage):/i.test(line))
            .map((line) => line.trim().slice(0, 200)),
        ),
      ];
      if (signals.length > 0) out.signals = signals;
      if (robots.sitemaps.length > 0) out.sitemaps = robots.sitemaps.length;
    }
    if (!counted) {
      const mark = state === "blocked" ? "B" : "U";
      out.p = mark.repeat(AGENTS.length);
      sites.push(out);
      continue;
    }
    const source = text?.split(/\r\n|\r|\n/) ?? [];
    const lines: Record<string, string> = {};
    const refs: Array<[number, number] | 0> = [];
    let page = "";
    let home = "";
    for (const agent of AGENTS) {
      const onPage = decide(robots, [agent.token], PAGE_PATH);
      const onHome = decide(robots, [agent.token], "/");
      page += code(onPage, agent.token);
      home += code(onHome, agent.token);
      const group = onPage.groups?.find(
        (candidate) => onPage.rule !== undefined && candidate.rules.includes(onPage.rule),
      );
      const ruleLine = onPage.rule?.line ?? 0;
      const groupLine = group?.line ?? 0;
      if (ruleLine > 0 && state === "file") {
        refs.push([groupLine, ruleLine]);
        for (const line of [groupLine, ruleLine]) {
          if (line > 0) lines[String(line)] = (source[line - 1] ?? "").trim().slice(0, 160);
        }
      } else refs.push(0);
      if (
        agent.token === DEFAULT_TOKEN &&
        onPage.crawlDelaySeconds !== undefined &&
        state === "file"
      )
        out.delay = onPage.crawlDelaySeconds;
    }
    out.p = page;
    if (home !== page) out.h = home;
    if (refs.some((ref) => ref !== 0)) {
      out.r = refs;
      out.lines = lines;
    }
    sites.push(out);
  }

  const head = JSON.stringify({
    list: run.list,
    fetched: run.fetched,
    userAgent: run.userAgent,
    ...(run.runner === undefined ? {} : { runner: run.runner }),
    pagePath: PAGE_PATH,
    license: DATA_LICENSE.id,
    agents: AGENTS,
  });
  // one site on each line, so that the next run gives a readable diff
  writeRun(
    [
      `${head.slice(0, -1)},"sites":[`,
      sites.map((entry) => JSON.stringify(entry)).join(",\n"),
      "]}",
      "",
    ].join("\n"),
  );
  const states = new Map<string, number>();
  for (const entry of sites) states.set(entry.state, (states.get(entry.state) ?? 0) + 1);
  console.info(`${String(sites.length)} sites`, Object.fromEntries(states));
};

/** This function writes study-history.json again from the files of the runs, and keeps each DOI. */
const rebuildHistory = (): void => {
  const old = readHistory();
  let history: StudyHistory = { runs: [] };
  const names = readdirSync(runsDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of names) {
    const study = JSON.parse(readFileSync(join(runsDir, name), "utf8")) as Study;
    const version = studyVersion(study);
    if (name !== `${version}.json`) throw new Error(`${name} has the version ${version}`);
    const doi = old.runs.find((run) => run.version === version)?.doi ?? null;
    history = withRun(history, runOf(study, doi));
  }
  writeFileSync(historyOut, historyText(history));
  console.info(`wrote ${historyOut}: ${String(history.runs.length)} runs`);
};

/** This function records the DOI of a version on Zenodo, and names it in study-doi.json for the newest run. */
const recordDoi = (version: string, doi: string): void => {
  const history = withDoi(readHistory(), version, doi);
  writeFileSync(historyOut, historyText(history));
  const written = [historyOut];
  if (latestRun(history)?.version === version) {
    const current = JSON.parse(readFileSync(doiOut, "utf8")) as StudyDoi;
    writeFileSync(doiOut, studyDoiFile(doi, version, current.concept));
    written.push(doiOut);
  }
  console.info(`wrote ${written.join(" and ")}`);
};

const USAGE = [
  "usage: robots-study.ts tranco <out.csv>",
  "       robots-study.ts fetch <tranco.csv> <list id> <list date> [store dir]",
  "       robots-study.ts derive <store dir>",
  "       robots-study.ts history",
  "       robots-study.ts doi <version> <doi>",
  "       robots-study.ts report <out.md> [check...]",
];

const [command, ...args] = process.argv.slice(2);
if (command === "fetch" && args.length >= 3) {
  const [csv, listId, listDate, store] = args as [string, string, string, string | undefined];
  await derive(await fetchAll(csv, listId, listDate, store));
} else if (command === "derive" && args[0] !== undefined) {
  await derive(args[0]);
} else if (command === "tranco" && args[0] !== undefined) {
  await tranco(args[0]);
} else if (command === "history") {
  rebuildHistory();
} else if (command === "doi" && args[0] !== undefined && args[1] !== undefined) {
  recordDoi(args[0], args[1]);
} else if (command === "report" && args[0] !== undefined) {
  const [out, ...checks] = args as [string, ...string[]];
  const repository = process.env["GITHUB_REPOSITORY"] ?? "mark1russell7/crawler";
  writeFileSync(out, runReport(readHistory(), { checks, repository }));
  console.info(`wrote ${out}`);
} else {
  console.error(USAGE.join("\n"));
  process.exit(2);
}
