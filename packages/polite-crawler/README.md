# polite-crawler

**Fetch a source one time, keep it, and read it many times.** `polite-crawler` is a polite web crawler for research and for AI agents. It obeys robots.txt, sends one request at a time to each site, and keeps each response on your disk. Then it answers each later question from a local full-text index, with no new request.

[![npm](https://img.shields.io/npm/v/polite-crawler)](https://www.npmjs.com/package/polite-crawler)
[![CI](https://github.com/mark1russell7/crawler/actions/workflows/ci.yml/badge.svg)](https://github.com/mark1russell7/crawler/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/polite-crawler)](https://github.com/mark1russell7/crawler/blob/main/LICENSE)

The site has interactive demos with the real code: <https://mark1russell7.github.io/crawler/>

- **Polite.** The crawler obeys robots.txt (RFC 9309), and the rules for `Claude-User` too when an assistant asks. It sends one request at a time to each host, obeys `Retry-After`, and stops at a challenge, a 402 or a 403.
- **Fetch one time.** Each response goes into a capture log and a store of bodies by hash. A repeated question reads the disk, so it costs no request.
- **Read the cheap way.** The crawler reads JSON-LD, the visible text and the links with no browser. It opens a headless browser only for a page that shows almost nothing without JavaScript.
- **Cite exact text.** Full-text search (SQLite FTS5) gives ranked passages. A quote check finds the exact span in the stored text, with the capture id to cite.
- **An MCP server.** One command gives Claude and other MCP clients four tools: fetch, find, read and verify.

## Install

```sh
npm install polite-crawler
```

The package needs Node.js 22.13 or later. For pages that need JavaScript, install the optional browser too:

```sh
npm install playwright-core
npx playwright-core install chromium-headless-shell
```

Without the browser, the crawler reads each page as plain HTML.

## Use it from the command line

```sh
npx polite-crawler fetch https://en.wikipedia.org/wiki/Web_crawler
npx polite-crawler find "robots exclusion"
npx polite-crawler read "url:https://en.wikipedia.org/wiki/Web_crawler" --length 2000
npx polite-crawler verify "url:https://en.wikipedia.org/wiki/Web_crawler" "robots.txt protocol"
```

The store is in `~/.polite-crawler`. Use `--dir` or `POLITE_CRAWLER_DIR` for a different folder. Use `--json` for output that a program reads. `npx polite-crawler --help` shows all the options.

## Use it from Claude (MCP)

Add the server to Claude Code:

```sh
claude mcp add polite-crawler -- npx -y polite-crawler mcp
```

For Claude Desktop and other MCP clients, add this server to the configuration:

```json
{
  "mcpServers": {
    "polite-crawler": { "command": "npx", "args": ["-y", "polite-crawler", "mcp"] }
  }
}
```

The server gives four tools:

| Tool | What it does |
| --- | --- |
| `crawl_fetch` | It fetches pages into the store, and a page in the store answers with no request. |
| `crawl_find` | It searches the stored pages and gives ranked passages. |
| `crawl_read` | It gives a range of a stored document, with the capture ids to cite. |
| `crawl_verify` | It finds a quote in a stored document and gives the exact span. |

The MCP server applies the robots.txt rules for `Claude-User` too, because an assistant asks for these pages.

## Use it as a library

```ts
import { openCrawler } from "polite-crawler";

const crawler = openCrawler({ dir: "./crawl", contact: "ops@example.com" });

const page = await crawler.fetch("https://example.com/", { maxAge: "24h" });
console.log(page.outcome, page.title, page.structured);

for (const hit of crawler.find("documentation examples")) console.log(hit.doc, hit.snippet);

const read = await crawler.read(page.doc!, { length: 2000 });
const check = crawler.verify(page.doc!, "for use in documentation examples");

await crawler.close();
```

The package also exports the parts:

- `parseRobots`, `decide`: a robots.txt parser and matcher (RFC 9309).
- `classify`: the outcome of a response (a challenge, a refusal, a rate limit).
- `extractPage`: the JSON-LD, the visible text and the links of an HTML page.
- `fromText`, `fromSchemaOrg`, `fromCompact`: an opening-hours reader for page text, schema.org and OpenStreetMap.
- `HostScheduler`: a queue that keeps one request in progress for each host.
- `createMcpServer`: the MCP server, for a transport of your choice.

## How the crawler is polite

1. **robots.txt.** The crawler reads the robots.txt of each site and obeys it, as RFC 9309 specifies. When it cannot read robots.txt (a dead domain or a server error), it fetches nothing from the site.
2. **One request at a time for each host.** A host rests for 3 seconds or more between two requests, and longer after a slow response. Many hosts run in parallel, so a crawl is fast across sites and gentle on each one.
3. **Refusals.** A challenge, a 402 or a 403 stops the host for the run. The crawler does not try again with a different identity.
4. **An honest `User-Agent`.** The default is `PoliteCrawler/0.1.0 (+https://mark1russell7.github.io/crawler/bot/)`. The `contact` option adds an address.
5. **Usage signals.** When a page asks not to be AI input (`ai-input=no` content signals), the crawler keeps it but holds back its text from the AI reader.

To block the crawler, a site owner adds this group to robots.txt:

```text
User-agent: PoliteCrawler
Disallow: /
```

## The store

| Path | What it holds |
| --- | --- |
| `captures/fetch/<yyyy>/<mm>.ndjson` | The capture log: one line for each fetch decision, and the declined fetches too. |
| `blobs/` | The bodies of the responses, by SHA-256 hash. |
| `index.sqlite` | The search index. It is a projection: `polite-crawler reindex` builds it again from the other two. |

## License

MIT
