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

The first version. It needs Node.js 22.19 or later, and it is ESM only.

<!-- This section tells what 0.1.0 contains. No earlier version is on npm, so the changes before the first release are part of it. -->

- **The library.** `openCrawler({ dir })` gives `fetch`, `find`, `read`, `verify`, `versions` and `reindex` over one folder. Each method gives a promise. The root entry point also exports the parts of the runtime for an application. Examples are `createRuntime`, `Crawler`, `DocIndex`, `SqliteHostStateStore`, `fetchAndIndex`, `reindex`, `readDocument`, `verifyQuote` and the rule for a held-back page.
  - A result of `fetch` gives `capture`, `fetched_at`, `from_cache` and `held_back`. A result of `read` gives the `capture` and the `fetched_at` of its text.
  - `read` and `verify` take `capture`, the text of one capture. `verify` tells the capture, the blob and the fetch time of the text that holds a quote. `stale` is true when only an earlier capture holds it.
  - `openCrawler` takes `egress`, `politeness`, `hostState`, `clock`, `scope`, `onEvent` and `extractors`.
- **The command line.** `polite-crawler fetch`, `find`, `read`, `verify`, `reindex` and `mcp`. The `--json` option gives output for programs.
  - The exit codes are 0 (done), 1 (not done: a page not fetched, no match, a quote not found, a document unknown or held back, or an error) and 2 (a wrong command line).
  - The command checks the command line before it opens the store. `--version` and `--help` load no part of the crawler.
  - `--dir` and `POLITE_CRAWLER_DIR` expand `~` and resolve a relative path.
  - `read --user-provided` reads a page that refuses AI input, for a URL that you gave yourself.
  - `reindex` keeps the documents of the recipes of another application.
- **The MCP server.** `polite-crawler mcp` gives four tools over standard input and output: `crawl_fetch`, `crawl_find`, `crawl_read` and `crawl_verify`. Its entry point is `polite-crawler/mcp`, so the root entry point does not load the MCP SDK.
  - The text of each page comes in an `<untrusted-web-content>` envelope with the URL, the capture id and the fetch date. A page cannot close its envelope.
  - `user_provided` releases held-back text only when the user confirms it (MCP elicitation), or when the operator permits it (`POLITE_CRAWLER_ALLOW_USER_PROVIDED=1`).
  - Each tool has descriptions of its parameters, an output schema and structured content. A result gives the age of each copy.
  - `crawl_read` gives the page metadata with the first range only, and the position of the next range.
  - A bad URL in `crawl_fetch` is an error of that URL only, and a URL given twice is fetched one time. The server sends progress for each URL.
  - With no browser installed, the server turns rendering off at start and writes one note.
- **Politeness.** The crawler obeys robots.txt (RFC 9309), and the rules for `Claude-User` when an assistant asks. It sends one request at a time to each host and obeys `Retry-After`. The `User-Agent` names the crawler and links to a page for site owners.
  - A 401 or a 403 stops the host for 1 hour, a challenge or a 402 for 24 hours, and five failures in sequence for 1 hour. A longer `Retry-After` stops the host for that time, up to 30 days.
  - A client error, a 429 and a 503 do not count toward a stop. The backoff starts at 5 seconds and stops at 300 seconds, with random jitter.
  - When robots.txt cannot be read, the crawler fetches nothing from the site and tries again after some minutes. A good copy from the last 30 days applies in that time. A 401 or a 403 for robots.txt means that the site has no file.
  - `CrawlerOptions.politeness` changes the limits for each host or for some hosts, and `hostState` keeps the state of each host. `crawler.resetHosts()` removes the stops.
- **Egress.** By default, the crawler fetches only `http:` and `https:` URLs on public addresses, and it checks the address after DNS. In the headless browser, it checks each request of the page and each step of its redirects, up to the limit of a plain fetch. `CrawlerOptions.egress` and the flag `--allow-private` permit private addresses.
- **The store.** Each fetch decision goes into a capture log, and each body goes into a store by SHA-256 hash. A SQLite FTS5 index answers later questions with no request. A quote check finds the exact span of a quote, with the capture id to cite.
  - The index keeps each capture of a document as a version: the latest capture is the current text. A page that asks not to be AI input stops being held back when a later capture does not ask it. The earlier versions that asked it stay held back, also from a quote check of the earlier texts.
  - The search folds case, accents and Unicode forms, reads phrases and prefixes, and finds Chinese, Japanese and Thai words.
  - The quote check ignores soft hyphens, zero-width characters and the differences of NFKC, NFC and NFD.
  - `reindex` builds a new index beside the old one, so a rebuild that fails keeps the old index. It counts damaged lines, missing bodies and readers that fail, and it does not stop at them.
  - The log and the bodies go to the disk before a fetch finishes. Two processes can use one store: the index waits for a lock, and `hosts.sqlite` keeps one pace for each host.
  - A capture shows `REDACTED` in place of a user name, a password and the values of secret query parameters.
  - A body longer than the limit keeps its first part, and the capture says `truncated`. A body that does not download or decode gives the outcome `error`.
  - `FetchRequest.maxAgeMs` can be `"auto"`, the freshness that the server gave.
- **Reading.** The crawler reads JSON-LD, the visible text, the links and PDF files with no browser. With the optional peer `playwright-core`, it opens a headless browser for a page that shows almost nothing without JavaScript.
  - The text and the links leave out hidden text: `display: none` in a `style` attribute, `hidden`, `aria-hidden="true"` and a font size of zero.
  - `decodeBody` and `bodyEncoding` decode a body in the encoding that it declares.
  - `PageExtract` gives `canonical`, `redirect`, `blocked` and `notes`. `Hours` gives `partial` and `season`. `PdfOptions` sets the limits of the PDF reader.
  - A renderer throws `RenderRefused` for a page that it did not render, and the crawler does not count it as a failure of the host.
- **Usage signals.** When a page asks not to be AI input (`ai-input=no`), the crawler keeps the page but holds back its text from the AI reader. The read gives no title, no text and only the structural metadata, the quote check gives no match, and the search leaves the page out.
- **The parts.** The entry points `polite-crawler/robots`, `/hours`, `/html`, `/classify`, `/politeness` and `/signals` have no Node.js dependency, so a browser can import them.
