/**
 * The file /crawler/llms.txt: a summary of the site for language models. The build writes it, and the
 * numbers of the study come from the dataset, so the file agrees with the page of the study.
 */
import crawlerPackage from "polite-crawler/package.json";
import study from "../data/robots-study.json";
import type { Study } from "../lib/study.ts";
import { FEED_URL } from "../lib/feed.ts";
import { DATA_LICENSE, agentRows, summarize } from "../lib/study.ts";

const SITE = "https://mark1russell7.github.io/crawler/";

/** This function gives the text of llms.txt for a dataset. */
export const llmsText = (data: Study): string => {
  const summary = summarize(data);
  const rows = agentRows(data);
  const share = (token: string): string =>
    `${(rows.find((row) => row.token === token)?.share ?? 0).toFixed(1)}%`;
  const fileShare = (token: string): string =>
    `${(rows.find((row) => row.token === token)?.fileShare ?? 0).toFixed(1)}%`;
  const day = data.fetched.from.slice(0, 10);
  return `# polite-crawler

> polite-crawler is a TypeScript web crawler for research and for AI agents, on npm as \`polite-crawler\` (version ${crawlerPackage.version}, Node.js 22.19 or later). It fetches a source one time, keeps the response in a capture log and a content-addressed blob store, and answers later questions from a local SQLite FTS5 index with no new request. It obeys robots.txt (RFC 9309, and the rules for Claude-User when an assistant asks), keeps one request in progress for each host, obeys Retry-After, and stops at a challenge, a 401, a 402 or a 403.

Install it with \`npm install polite-crawler\`. Use \`openCrawler({ dir })\` and its methods \`fetch(url, { maxAge, render, fallback })\`, \`find(q)\`, \`read(doc, { from, length, at })\`, \`verify(doc, quote, { at })\`, \`extract(doc, fields)\`, \`versions(doc)\`, \`diff(doc, { from, to })\`, \`watch\` (\`add\`, \`remove\`, \`list\` and \`run\`), \`discover(site)\`, \`crawl(seeds, { maxPages, maxDepth, budgetMs })\` and \`reindex()\`. Hybrid search is opt-in: with an \`embedder\` (\`transformersEmbedder\` or \`ollamaEmbedder\`, a local model), \`embed()\` gives vectors to the stored pages and \`find(q, { rank: "hybrid" })\` fuses the BM25 ranks and the vector ranks by reciprocal rank fusion. The recipes \`readVenue\` (the opening hours of a venue, with a quote for each reading) and \`readProduct\` (the price, the variants and the availability of a product page) read a source the polite way, and \`defineRecipe\` with \`runRecipe\` reads a source of your own into documents that \`verify\` can cite. The daemon (\`startDaemon\`, \`scheduleWatches\`) checks the watch list on a schedule and writes each confirmed change as one JSON line. A command line (\`npx polite-crawler fetch|find|read|verify|reindex|discover|crawl|export|extract|diff|watch|daemon|embed|venue|product|key-directory\`) and an MCP server (\`npx -y polite-crawler-mcp\`, or \`claude mcp add polite-crawler -- npx -y polite-crawler-mcp\` in Claude Code) with the nine tools \`crawl_fetch\`, \`crawl_find\`, \`crawl_read\`, \`crawl_verify\`, \`crawl_extract\`, \`crawl_discover\`, \`crawl_site\`, \`crawl_diff\` and \`crawl_watch_list\` use the same store. \`polite-crawler daemon --mcp-http\` also serves the nine tools over local HTTP, with a bearer token. The MCP server gives page text in an \`<untrusted-web-content>\` envelope with the URL, the capture id and the fetch date. It is the package \`polite-crawler-mcp\` (until 0.2.0, the entry point \`polite-crawler/mcp\`). Pages that need JavaScript use the optional peer \`playwright-core\`.

## Docs

- [Quick start](${SITE}guide/quick-start/): install, the command line, the library
- [MCP web fetch server](${SITE}guide/mcp/): the MCP server for Claude Code, Claude Desktop, Cursor, VS Code and other clients, and its tools
- [How it works](${SITE}guide/how-it-works/): the path of a request, the store, capture ids, recipes
- [How hybrid search ranks](${SITE}guide/search/): the BM25 ranking, the vector ranking of a local model and their reciprocal rank fusion (\`rank: "hybrid"\`, \`fusionK\`, \`candidates\`, \`neighbors\`), with an interactive figure
- [Write a recipe](${SITE}guide/recipes/): \`defineRecipe\` with \`name\`, \`fetch\` and \`extract\`, \`runRecipe\`, \`readJson\`, and the path from a capture to documents that \`verify\` can cite
- [The daemon, tick by tick](${SITE}guide/daemon/): \`polite-crawler daemon\` and \`scheduleWatches\`: due times, \`--tick\`, \`--jitter\`, \`--tick-budget\`, \`--tick-pages\`, the drain at a stop and the JSON line of a confirmed change
- [How the crawler is polite](${SITE}guide/politeness/): rests, refusals, the User-Agent, content signals
- [Library API](${SITE}reference/api/): each option, method and part
- [Command line](${SITE}reference/cli/): each command and option
- [Standards](${SITE}reference/standards/): how the crawler follows RFC 9309 (robots.txt), RFC 9111 (caching), RFC 9110 (redirects, Retry-After) and the AI preference signals, rule by rule, with the test for each rule
- [polite-crawler vs Crawlee, Scrapy, Firecrawl and Crawl4AI](${SITE}guide/compare/): which crawler to use for which job, and the MCP fetch server

## For site owners

- [About PoliteCrawler](${SITE}bot/): what the bot is, and how to slow or block it
- [Block AI training crawlers, let AI assistants in](${SITE}block-ai-training-crawlers/): a robots.txt that refuses GPTBot, ClaudeBot and the other training crawlers and permits Claude-User and ChatGPT-User

## Tools

- [robots.txt tester](${SITE}tools/robots-txt-tester/): which rule permits or refuses a path, for GPTBot, ClaudeBot, Claude-User and your own user agent, and the verdict of the MCP server
- [What the crawler sees](${SITE}tools/page-reader/): JSON-LD, visible text, links and the JavaScript decision for pasted HTML
- [Opening hours parser](${SITE}tools/opening-hours/): the week that page text, schema.org or OpenStreetMap hours give
- [Recipe reader](${SITE}tools/recipe-reader/): the opening hours (\`venueReadingsOf\`, with the rank, the source and the quote of each reading, and \`compareHours\`) and the product (\`productOf\`, \`pickProduct\`, \`readAmount\`) of pasted HTML

## Field notes

- [Who lets AI agents in?](${SITE}notes/robots-txt-ai-agents/): the robots.txt files of the top ${summary.listSize.toLocaleString("en-US")} domains (Tranco list ${data.list.id}, read on ${day}). ${String(summary.answered)} sites answered with a file or with no file, ${String(summary.blocked)} blocked the request at the edge, and ${String(summary.unreachable)} were unreachable. Of the sites that answered, ${share("GPTBot")} refuse GPTBot, ${share("ClaudeBot")} refuse ClaudeBot, ${share("ChatGPT-User")} refuse ChatGPT-User, ${share("Claude-User")} refuse Claude-User and ${share("Googlebot")} refuse Googlebot. Of the ${String(summary.withFile)} sites with a robots.txt file, ${fileShare("GPTBot")} refuse GPTBot. The data is under ${DATA_LICENSE.name}: [JSON](${SITE}data/robots-study.json), [CSV](${SITE}data/robots-study.csv)
- [The robots.txt study, each month](${FEED_URL}): an RSS feed with one item for each monthly run of the study. Each item links the CSV of its run (\`data/robots-study-<YYYY-MM-DD>.csv\`) and its DOI on Zenodo.

## Optional

- [What 300 restaurant websites taught a crawler](${SITE}notes/restaurant-websites/): a survey
- [The source](https://github.com/mark1russell7/crawler)
- [Sitemap](${SITE}sitemap-index.xml): each page of the site, with the date of its last change
`;
};

export const GET = (): Response =>
  new Response(llmsText(study as unknown as Study), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
