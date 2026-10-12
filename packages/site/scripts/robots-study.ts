// The robots.txt study. polite-crawler reads /robots.txt of each domain of a Tranco list, and
// this script writes the decision for each AI agent to src/data/robots-study.json.
//
// Start it from the root of the repository:
//   pnpm exec tsx packages/site/scripts/robots-study.ts <tranco.csv> <list id> <list date> <store dir>
//
// Each domain gets one request for /robots.txt (and its redirects), with the default User-Agent of
// the crawler. The store dir keeps the capture log and the bodies; the dataset keeps only the
// decisions and the lines that decided them.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fetched, Robots, RobotsDecision } from "polite-crawler";
import {
  CaptureLog,
  Crawler,
  DEFAULT_TOKEN,
  DocIndex,
  FileBlobStore,
  decide,
  defaultUserAgent,
  robotsFromStatus,
  unreachableRobots,
} from "polite-crawler";

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

const [csv, listId, listDate, store] = process.argv.slice(2);
if (csv === undefined || listId === undefined || listDate === undefined || store === undefined) {
  console.error("usage: robots-study.ts <tranco.csv> <list id> <list date> <store dir>");
  process.exit(2);
}

const domains = readFileSync(csv, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => {
    const [rank, domain] = line.split(",");
    return { rank: Number(rank), domain: String(domain) };
  });

const blobs = new FileBlobStore(join(store, "blobs"));
const crawler = new Crawler({
  token: DEFAULT_TOKEN,
  userAgent: defaultUserAgent(),
  log: new CaptureLog(join(store, "captures")),
  blobs,
  index: new DocIndex(join(store, "index.sqlite")),
  maxActive: 24,
});

/** One code for each agent: refused by a named group, refused by `*`, allowed by a named group, allowed. */
const code = (robots: Robots, decision: RobotsDecision, token: string): string => {
  // the product token of a user-agent line, as the parser matches it
  const tokenOf = (agent: string): string => /^[a-z_-]+/.exec(agent.trim())?.[0] ?? "";
  const named = (decision.groups ?? []).some((group) =>
    group.agents.some((agent) => agent !== "*" && tokenOf(agent) === token.toLowerCase()),
  );
  if (robots.unreachable !== undefined) return "U";
  if (!decision.allowed) return named ? "N" : "S";
  return named ? "n" : ".";
};

interface Site {
  rank: number;
  domain: string;
  host?: string;
  status: number;
  state: "ok" | "missing" | "unreachable";
  reason?: string;
  html?: boolean;
  bytes?: number;
  groups?: number;
  delay?: number;
  signals?: string[];
  sitemaps?: number;
  /** codes for the page path, one for each agent */
  p: string;
  /** codes for the home page, when they differ from the page path */
  h?: string;
  /** for each agent: [line of the group, line of the rule], or 0 when nothing decided */
  r?: Array<[number, number] | 0>;
  /** the text of each line that `r` names */
  lines?: Record<string, string>;
}

const started = new Date().toISOString();
let done = 0;

const read = async (url: string): Promise<{ fetched: Fetched; robots: Robots; text?: string }> => {
  const fetched = await crawler.fetch({
    url,
    mode: "api",
    recipe: "robots.txt",
    accept: "text/plain",
    maxBytes: 512 * 1024,
  });
  const text = fetched.body === undefined ? undefined : new TextDecoder("utf-8").decode(fetched.body);
  const robots =
    fetched.status === 0
      ? unreachableRobots(fetched.note ?? "no response")
      : fetched.outcome === "redirect"
        ? unreachableRobots("too many redirects")
        : robotsFromStatus(fetched.status, text);
  return text === undefined ? { fetched, robots } : { fetched, robots, text };
};

const study = async ({ rank, domain }: { rank: number; domain: string }): Promise<Site> => {
  let { fetched, robots, text } = await read(`https://${domain}/robots.txt`);
  // a bare domain with no web server, for example a domain that has only www.<domain>
  if (fetched.status === 0) {
    const www = await read(`https://www.${domain}/robots.txt`);
    if (www.fetched.status !== 0) ({ fetched, robots, text } = www);
  }
  const host = new URL(fetched.url).host;
  const state =
    robots.unreachable !== undefined ? "unreachable" : fetched.status >= 400 ? "missing" : "ok";
  const site: Site = { rank, domain, status: fetched.status, state, p: "" };
  if (host !== domain) site.host = host;
  if (robots.unreachable !== undefined)
    site.reason = robots.unreachable.replace(/\s+/g, " ").trim().slice(0, 160);
  if (state === "ok" && text !== undefined) {
    const html =
      /html/i.test(fetched.contentType ?? "") || /^\s*<(!doctype|html|head|body)/i.test(text);
    if (html) site.html = true;
    site.bytes = fetched.body?.byteLength ?? 0;
    site.groups = robots.groups.length;
    // a file can repeat its signal in each group: keep each line one time
    const signals = [...new Set(robots.signals.map((line) => line.trim().slice(0, 200)))];
    if (signals.length > 0) site.signals = signals;
    if (robots.sitemaps.length > 0) site.sitemaps = robots.sitemaps.length;
  }
  const source = text?.split(/\r\n|\r|\n/) ?? [];
  const lines: Record<string, string> = {};
  const refs: Array<[number, number] | 0> = [];
  let page = "";
  let home = "";
  for (const agent of AGENTS) {
    const onPage = decide(robots, [agent.token], PAGE_PATH);
    const onHome = decide(robots, [agent.token], "/");
    page += code(robots, onPage, agent.token);
    home += code(robots, onHome, agent.token);
    const group = onPage.groups?.find((candidate) => candidate.rules.includes(onPage.rule!));
    const ruleLine = onPage.rule?.line ?? 0;
    const groupLine = group?.line ?? 0;
    if (ruleLine > 0 && state === "ok") {
      refs.push([groupLine, ruleLine]);
      for (const line of [groupLine, ruleLine]) {
        if (line > 0) lines[String(line)] = (source[line - 1] ?? "").trim().slice(0, 160);
      }
    } else refs.push(0);
    if (agent.token === DEFAULT_TOKEN && onPage.crawlDelaySeconds !== undefined && state === "ok")
      site.delay = onPage.crawlDelaySeconds;
  }
  site.p = page;
  if (home !== page) site.h = home;
  if (refs.some((ref) => ref !== 0)) {
    site.r = refs;
    site.lines = lines;
  }
  done += 1;
  if (done % 50 === 0) console.info(`${String(done)} of ${String(domains.length)}`);
  return site;
};

const sites = await Promise.all(domains.map(study));
await crawler.close();

const out = fileURLToPath(new URL("../src/data/robots-study.json", import.meta.url));
const head = JSON.stringify({
  list: {
    name: "Tranco",
    id: listId,
    date: listDate,
    url: `https://tranco-list.eu/list/${listId}/1000`,
    size: domains.length,
  },
  fetched: { from: started, to: new Date().toISOString() },
  userAgent: defaultUserAgent(),
  pagePath: PAGE_PATH,
  agents: AGENTS,
});
// one site on each line, so that the next run gives a readable diff
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  [
    `${head.slice(0, -1)},"sites":[`,
    sites.map((site) => JSON.stringify(site)).join(",\n"),
    "]}",
    "",
  ].join("\n"),
);
console.info(`wrote ${out}: ${String(sites.length)} sites`);
