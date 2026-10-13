// The robots.txt study. polite-crawler reads /robots.txt of each domain of a Tranco list, and this
// script writes the verdict for each AI agent to src/data/robots-study.json and
// public/data/robots-study.csv.
//
// Start it from the root of the repository:
//   pnpm exec tsx packages/site/scripts/robots-study.ts fetch <tranco.csv> <list id> <list date> [store dir]
//   pnpm exec tsx packages/site/scripts/robots-study.ts derive <store dir>
//
// `fetch` sends one request for /robots.txt to each domain (and follows its redirects), with the
// default User-Agent of the crawler and no contact. It needs a fresh store: with no stored copy, the
// crawler sends no conditional request, so no answer is a 304. Without a store dir, it makes one in
// the temp folder. The store keeps the capture log, the bodies and answers.ndjson.
//
// `derive` reads answers.ndjson and the bodies again and writes the dataset. It sends no request,
// so a change to the classification in src/lib/study.ts needs no new run.
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
}

const site = fileURLToPath(new URL("..", import.meta.url));
const jsonOut = join(site, "src/data/robots-study.json");
const csvOut = join(site, "public/data/robots-study.csv");

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
  const run: Run = {
    list: {
      name: "Tranco",
      id: listId,
      date: listDate,
      url: `https://tranco-list.eu/list/${listId}/1000`,
      size: domains.length,
    },
    fetched: { from, to: new Date().toISOString() },
    userAgent: defaultUserAgent(),
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
    pagePath: PAGE_PATH,
    license: DATA_LICENSE.id,
    agents: AGENTS,
  });
  // one site on each line, so that the next run gives a readable diff
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(
    jsonOut,
    [
      `${head.slice(0, -1)},"sites":[`,
      sites.map((entry) => JSON.stringify(entry)).join(",\n"),
      "]}",
      "",
    ].join("\n"),
  );
  const study = JSON.parse(readFileSync(jsonOut, "utf8")) as Study;
  mkdirSync(dirname(csvOut), { recursive: true });
  writeFileSync(csvOut, toCsv(study));
  const states = new Map<string, number>();
  for (const entry of sites) states.set(entry.state, (states.get(entry.state) ?? 0) + 1);
  console.info(
    `wrote ${jsonOut} and ${csvOut}: ${String(sites.length)} sites`,
    Object.fromEntries(states),
  );
};

const [command, ...args] = process.argv.slice(2);
if (command === "fetch" && args.length >= 3) {
  const [csv, listId, listDate, store] = args as [string, string, string, string | undefined];
  await derive(await fetchAll(csv, listId, listDate, store));
} else if (command === "derive" && args[0] !== undefined) {
  await derive(args[0]);
} else {
  console.error(
    "usage: robots-study.ts fetch <tranco.csv> <list id> <list date> [store dir]\n       robots-study.ts derive <store dir>",
  );
  process.exit(2);
}
