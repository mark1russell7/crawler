/**
 * The file /crawler/llms.txt: a summary of the site for language models. The build writes it, and the
 * numbers of the study come from the dataset, so the file agrees with the page of the study.
 */
import study from "../data/robots-study.json";
import type { Study } from "../lib/study.ts";
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

> polite-crawler is a TypeScript web crawler for research and for AI agents, on npm as \`polite-crawler\` (Node.js 22.19 or later). It fetches a source one time, keeps the response in a capture log and a content-addressed blob store, and answers later questions from a local SQLite FTS5 index with no new request. It obeys robots.txt (RFC 9309, and the rules for Claude-User when an assistant asks), keeps one request in progress for each host, obeys Retry-After, and stops at a challenge, a 401, a 402 or a 403.

Install it with \`npm install polite-crawler\`. Use \`openCrawler({ dir })\` and its methods \`fetch(url, { maxAge, render })\`, \`find(q)\`, \`read(doc, { from, length })\`, \`verify(doc, quote)\` and \`reindex()\`. A command line (\`npx polite-crawler fetch|find|read|verify|reindex|mcp\`) and an MCP server (\`npx -y polite-crawler mcp\`, or \`claude mcp add polite-crawler -- npx -y polite-crawler mcp\` in Claude Code) with the tools \`crawl_fetch\`, \`crawl_find\`, \`crawl_read\` and \`crawl_verify\` use the same store. The MCP server gives page text in an \`<untrusted-web-content>\` envelope with the URL, the capture id and the fetch date, and the library exports it as \`polite-crawler/mcp\`. Pages that need JavaScript use the optional peer \`playwright-core\`.

## Docs

- [Quick start](${SITE}guide/quick-start/): install, the command line, the library
- [MCP web fetch server](${SITE}guide/mcp/): the MCP server for Claude Code, Claude Desktop, Cursor, VS Code and other clients, and its four tools
- [How it works](${SITE}guide/how-it-works/): the path of a request, the store, capture ids, recipes
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

## Field notes

- [Who lets AI agents in?](${SITE}notes/robots-txt-ai-agents/): the robots.txt files of the top ${summary.listSize.toLocaleString("en-US")} domains (Tranco list ${data.list.id}, read on ${day}). ${String(summary.answered)} sites answered with a file or with no file, ${String(summary.blocked)} blocked the request at the edge, and ${String(summary.unreachable)} were unreachable. Of the sites that answered, ${share("GPTBot")} refuse GPTBot, ${share("ClaudeBot")} refuse ClaudeBot, ${share("ChatGPT-User")} refuse ChatGPT-User, ${share("Claude-User")} refuse Claude-User and ${share("Googlebot")} refuse Googlebot. Of the ${String(summary.withFile)} sites with a robots.txt file, ${fileShare("GPTBot")} refuse GPTBot. The data is under ${DATA_LICENSE.name}: [JSON](${SITE}data/robots-study.json), [CSV](${SITE}data/robots-study.csv)

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
