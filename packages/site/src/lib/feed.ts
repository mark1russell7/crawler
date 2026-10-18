/**
 * The RSS 2.0 feed of the robots.txt study, at `/crawler/study/feed.xml`. The feed has one item for
 * each monthly run, the newest first. Each item links the CSV, the JSON and the DOI of its run. Each
 * address in the feed is a full address, because a feed reader has no base address.
 */
import { DATASET_TITLE, SITE_URL, STUDY_PAGE, doiUrl } from "./cite.ts";
import type { StudyHistory, StudyRun } from "./runs.ts";
import { runCsvPath, runJsonPath } from "./runs.ts";
import { DATA_LICENSE, formatDay } from "./study.ts";

/** This path is the feed, relative to the site. */
export const FEED_PATH = "study/feed.xml";
/** This address is the feed. */
export const FEED_URL = `${SITE_URL}${FEED_PATH}`;
/** This text is the title of the feed. The link in the head of the study page names it too. */
export const FEED_TITLE = "The robots.txt study of polite-crawler, each month";

/** This function escapes a text for XML: in an element and in an attribute. */
export const xmlEscape = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** This function gives the anchor of a run in the table of the runs on the study page. */
export const runAnchor = (version: string): string => `run-${version}`;

const shareOf = (run: StudyRun, token: string): string =>
  `${(run.agents.find((agent) => agent.token === token)?.share ?? 0).toFixed(1)}%`;

/** This function gives the HTML of the description of one item. The feed escapes it. */
const describe = (run: StudyRun): string => {
  const size = run.list.size.toLocaleString("en-US");
  const day = formatDay(run.fetched.from);
  const csv = `${SITE_URL}${runCsvPath(run.version)}`;
  const json = `${SITE_URL}${runJsonPath(run.version)}`;
  const doi =
    run.doi === null
      ? "<li>The DOI of this run on Zenodo comes after the owner publishes the version.</li>"
      : `<li>The DOI of this run: <a href="${doiUrl(run.doi)}">${run.doi}</a></li>`;
  return [
    `<p>On ${day}, polite-crawler read the robots.txt file of each of the top ${size} domains of the Tranco list ${run.list.id}. ${String(run.answered)} sites answered: ${String(run.states.file)} with a file and ${String(run.states.none)} with no file. ${String(run.states.blocked)} blocked the request at the edge, and ${String(run.states.unreachable)} were unreachable.</p>`,
    `<p>Of the sites that answered, ${shareOf(run, "GPTBot")} refuse GPTBot, ${shareOf(run, "ClaudeBot")} refuse ClaudeBot, ${shareOf(run, "ChatGPT-User")} refuse ChatGPT-User and ${shareOf(run, "Claude-User")} refuse Claude-User.</p>`,
    `<ul><li><a href="${csv}">The data of this run as CSV</a></li><li><a href="${json}">The data of this run as JSON</a></li>${doi}</ul>`,
    `<p>The data is under ${DATA_LICENSE.name}.</p>`,
  ].join("");
};

/**
 * This function gives the text of the feed. `csvBytes` gives the size of the CSV of each run, for the
 * enclosure. The feed has no time of the build, so the same history gives the same text.
 */
export const studyFeed = (
  history: StudyHistory,
  csvBytes: Readonly<Record<string, number>>,
  concept: string | undefined,
): string => {
  const runs = [...history.runs].reverse();
  const newest = runs[0];
  const items = runs.map((run) => {
    const bytes = csvBytes[run.version];
    if (bytes === undefined) throw new Error(`no CSV for the run ${run.version}`);
    const gpt = shareOf(run, "GPTBot");
    return [
      "<item>",
      `<title>${xmlEscape(`${formatDay(run.fetched.from)}: ${gpt} of the sites that answered refuse GPTBot`)}</title>`,
      `<link>${xmlEscape(`${STUDY_PAGE}#${runAnchor(run.version)}`)}</link>`,
      `<guid isPermaLink="false">polite-crawler-robots-study-${run.version}</guid>`,
      `<pubDate>${new Date(run.fetched.to).toUTCString()}</pubDate>`,
      `<description>${xmlEscape(describe(run))}</description>`,
      `<enclosure url="${xmlEscape(`${SITE_URL}${runCsvPath(run.version)}`)}" length="${String(bytes)}" type="text/csv"/>`,
      "</item>",
    ].join("\n");
  });
  const size = (newest?.list.size ?? 0).toLocaleString("en-US");
  const agents = String(newest?.agents.length ?? 0);
  const about = `One run each month: the robots.txt rules of the top ${size} domains for ${agents} crawlers and agents. Each item links the CSV and the DOI of its run.${concept === undefined ? "" : ` To cite the study and all its runs, use the concept DOI ${doiUrl(concept)}.`}`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "<channel>",
    `<title>${xmlEscape(FEED_TITLE)}</title>`,
    `<link>${xmlEscape(STUDY_PAGE)}</link>`,
    `<description>${xmlEscape(about)}</description>`,
    "<language>en</language>",
    `<copyright>${xmlEscape(`${DATASET_TITLE}: the data is under ${DATA_LICENSE.name}`)}</copyright>`,
    `<atom:link href="${xmlEscape(FEED_URL)}" rel="self" type="application/rss+xml"/>`,
    ...(newest === undefined
      ? []
      : [`<lastBuildDate>${new Date(newest.fetched.to).toUTCString()}</lastBuildDate>`]),
    ...items,
    "</channel>",
    "</rss>",
    "",
  ].join("\n");
};
