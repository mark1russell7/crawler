// The verdicts of the robots.txt study, from the raw answers of a run. The script robots-study.ts
// writes the dataset with this module, and CI counts the rules again with it at each commit. Thus
// the numbers of the pages always come from the parser of the workspace.
import type { Robots, RobotsDecision } from "polite-crawler";
import { ALLOW_ALL, DEFAULT_TOKEN, decide } from "polite-crawler";
import { robotsFromResponse } from "polite-crawler/robots";
import type { RawAnswer, Study, StudySite } from "./study.ts";
import { DATA_LICENSE, answerOf } from "./study.ts";
import type { KeptAnswer, RunFacts } from "./study-raw.ts";

/** The agents of the study, in the order of the dataset. */
export const AGENTS = [
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
export const PAGE_PATH = "/polite-crawler-study/a-page";

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

/** This function gives the entry of one domain in the dataset, from its answer and its body. */
export function siteOf(answer: KeptAnswer): StudySite {
  const body = answer.body;
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
    return out;
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
    if (agent.token === DEFAULT_TOKEN && onPage.crawlDelaySeconds !== undefined && state === "file")
      out.delay = onPage.crawlDelaySeconds;
  }
  out.p = page;
  if (home !== page) out.h = home;
  if (refs.some((ref) => ref !== 0)) {
    out.r = refs;
    out.lines = lines;
  }
  return out;
}

/** This function gives the entries of all domains, in the sequence of the ranks. */
export const sitesOf = (answers: readonly KeptAnswer[]): StudySite[] =>
  [...answers].sort((a, b) => a.rank - b.rank).map(siteOf);

/** The count of the sites with another entry in `after` than in `before`, for the same domains. */
export function changedSites(
  before: readonly StudySite[],
  after: readonly StudySite[],
): readonly string[] {
  const old = new Map(before.map((site) => [site.domain, JSON.stringify(site)]));
  return after
    .filter((site) => old.get(site.domain) !== JSON.stringify(site))
    .map((site) => site.domain);
}

/**
 * This function writes the text of a dataset: the facts of the run, then one site on each line. Thus
 * the next run gives a readable diff. A recount names the version of the parser and the count of the
 * sites that changed.
 */
export function studyText(
  run: RunFacts,
  sites: readonly StudySite[],
  recounted?: Study["recounted"],
): string {
  const head = JSON.stringify({
    list: run.list,
    fetched: run.fetched,
    userAgent: run.userAgent,
    ...(run.runner === undefined ? {} : { runner: run.runner }),
    ...(run.commit === undefined ? {} : { commit: run.commit }),
    ...(recounted === undefined ? {} : { recounted }),
    pagePath: PAGE_PATH,
    license: DATA_LICENSE.id,
    agents: AGENTS,
  });
  return [
    `${head.slice(0, -1)},"sites":[`,
    sites.map((entry) => JSON.stringify(entry)).join(",\n"),
    "]}",
    "",
  ].join("\n");
}
