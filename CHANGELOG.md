# Changelog

This file records the changes to [`polite-crawler`](packages/polite-crawler) in each version. The release workflow copies the section of a version into its GitHub release.

## Versions

`polite-crawler` uses semantic versioning. Before version 1.0.0, these rules apply:

- A minor version (`0.2.0`) can change the API. Its section here tells you what to change.
- A patch version (`0.1.1`) only corrects errors. It does not change the API.
- The store on disk stays the same across the 0.x versions: the capture log in `captures/`, the bodies in `blobs/` and the capture ids. Old citations name these ids. If a version must change the store, its section tells you how to move an old store.
- The search index (`index.sqlite`) is a projection. A version can change it, and `polite-crawler reindex` builds it again.

A prerelease version (`0.2.0-beta.1`) goes to the npm tag `next`. Each other version goes to `latest`.

## Unreleased

## 0.1.0

The first version. It needs Node.js 22.19 or later, and it is an ES module package.

- **The library.** `openCrawler({ dir })` gives `fetch`, `find`, `read`, `verify` and `reindex` over one folder.
- **The command line.** `polite-crawler fetch`, `find`, `read`, `verify`, `reindex` and `mcp`. The `--json` option gives output for programs.
- **The MCP server.** `polite-crawler mcp` gives four tools over standard input and output: `crawl_fetch`, `crawl_find`, `crawl_read` and `crawl_verify`.
- **Politeness.** The crawler obeys robots.txt (RFC 9309), and the rules for `Claude-User` when an assistant asks. It sends one request at a time to each host and obeys `Retry-After`. A challenge, a 402 or a 403 stops the host for the run. The `User-Agent` names the crawler and links to a page for site owners.
- **The store.** Each fetch decision goes into a capture log, and each body goes into a store by SHA-256 hash. A SQLite FTS5 index answers later questions with no request. A quote check finds the exact span of a quote, with the capture id to cite.
- **Reading.** The crawler reads JSON-LD, the visible text, the links and PDF files with no browser. With the optional peer `playwright-core`, it opens a headless browser for a page that shows almost nothing without JavaScript.
- **Usage signals.** When a page asks not to be AI input (`ai-input=no`), the crawler keeps the page but holds back its text from the AI reader.
- **The parts.** The entry points `polite-crawler/robots`, `/hours`, `/html`, `/classify`, `/politeness` and `/signals` have no Node.js dependency, so a browser can import them.
