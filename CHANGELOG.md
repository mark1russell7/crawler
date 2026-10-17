# Changelog

This file records the changes to [`polite-crawler`](packages/polite-crawler) in each version. The release workflow copies the section of a version into its GitHub release.

## Versions

`polite-crawler` uses semantic versioning. Before version 1.0.0, these rules apply:

- A minor version (`0.2.0`) can break the API. Its section here tells you what to change.
- A patch version (`0.1.1`) corrects errors or adds features. It does not break the API.
- The store on disk stays the same across the 0.x versions: the capture log in `captures/`, the bodies in `blobs/` and the capture ids. Old citations name these ids. If a version must change the store, its section tells you how to move an old store.
- The search index (`index.sqlite`) is a projection. A version can change it, and `polite-crawler reindex` builds it again.

A prerelease version (`0.2.0-beta.1`) goes to the npm tag `next`. Each other version goes to `latest`.

## Unreleased

- **Export to WARC and WACZ.** `exportWarc` and `exportWacz` write the stored captures as a web archive, for `warcio`, pywb and ReplayWeb.page. The command line has `polite-crawler export --out <file>`.
  - The WARC file is WARC/1.1, with one gzip member for each record. The WACZ file is WACZ 1.1.1, with a sorted CDXJ index, a page list and `datapackage.json`.
  - A capture with a body gives a `response` record, a 304 gives a `revisit` record, and a rendered page gives a `conversion` record. Each has a `metadata` record with the JSON of the capture.
  - A capture keeps only some headers. Thus the export rebuilds the HTTP header block from them and marks the record (`WARC-Polite-Crawler-Headers: rebuilt`). The README tells what goes into the archive, what does not, and why.
  - The filters are `since`, `until`, `host`, `urlPrefix` and `ids`. `includeRefusals` adds a `metadata` record for each capture with no body.
  - The export reads the log as a stream, and it sorts the index on the disk. Thus its memory does not grow with the store.
  - The MCP server has no export tool, because an export writes files on the disk of the operator.
  - The change only adds to the API. The capture log, the bodies and the capture ids do not change.
- **Discovery: the pages of a site from its sitemaps and feeds.** `crawler.discover(site, options)` reads the `Sitemap:` lines of robots.txt, or `/sitemap.xml` when robots.txt names none.
  - It follows sitemap indexes, the newest first, and it reads gzip sitemaps, text sitemaps, RSS 2.0, RSS 1.0 and Atom. It reads the feeds that the page links with `<link rel="alternate">`, and the feeds in `feeds`.
  - Each URL has its `lastmod`, its `changefreq` and its `source`. Discovery keeps only the URLs on the same site that robots.txt permits. `allowHosts` and `sameSite: false` keep more hosts.
  - The limits are `maxFiles` (20), `maxUrls` (10,000), `maxBytes` for each file (10 MiB), `maxNesting` (3) and `budgetMs` (1 minute).
  - Each file is a fetch of the crawler with the recipe `sitemap` or `feed`. Thus robots.txt, the pace, the stops, the egress policy and the capture log apply to it.
  - The sitemap reader (`readSitemap`) expands no entity, stops at a depth of 32 elements and reads in linear time. A hostile file stays bounded.
- **A small crawl with a budget.** `crawler.crawl(seeds, options)` fetches the seeds and follows the links of each page on the same site. It gives an async iterable of the pages, and a `summary`.
  - The options are `maxPages` (100), `maxDepth` (3), `budgetMs` (10 minutes), `sameSite` or `allowHosts`, `include` and `exclude` patterns, `useSitemaps`, and the options of `fetch`.
  - The seeds come first, then the pages of the sitemaps (the newest first), then the links, the lower depth first. The crawl fetches each page one time, also with a fragment, a tracking parameter or a canonical URL.
  - Each page is a fetch of the crawler: one request at a time for each host, at its pace. No request starts after the budget. A cancel or a `break` stops the requests in progress.
  - The summary gives the pages fetched, refused and failed, the links that the crawl did not follow, and the reason of the stop.
  - The state of the crawl is in memory, for one call. A later version can make it resumable.
- **The command line.** `polite-crawler discover <site>` and `polite-crawler crawl <url...> --max-pages N --max-depth N --budget 2m`. `crawl` also takes `--include`, `--exclude`, `--sitemaps`, `--render` and `--max-age`. The two commands take `--allow-host`.
- **Two MCP tools.** `crawl_discover` gives 1,000 URLs at most. `crawl_site` fetches 10 pages in 1 minute by default, and 50 pages in 5 minutes at most. It sends progress for each page, stops at a cancel, and keeps the titles in the `<untrusted-web-content>` envelope.
- **The engine.** These additions do not change the existing API:
  - `FetchRequest`, `RenderRequest` and `PageOptions` take `deadline`. A request does not start at or after its deadline, and it does not wait for its host past it. Its skip note starts with `DEADLINE_NOTE`. `HostScheduler` does not change.
  - `Crawler.robotsAllow(url, options)` gives the robots.txt decision for a URL. `Crawler.readRobots` takes the scope and the labels of its record.
  - `PageExtract` has `feeds`: the RSS and Atom feeds that the page links. The metadata of a page document has them too.
  - `reindex` reads the captures of the recipes `sitemap` and `feed` as captures of the crawler, as it reads robots.txt. They give no document.
  - The root entry point exports `discoverSite`, `crawlSite`, `readSitemap`, `feedDate`, `DISCOVER_LIMITS`, `CRAWL_LIMITS`, `SITEMAP_LIMITS`, `DEADLINE_NOTE` and the types of discovery and of the crawl.
- **Read a page as it was at a time.** `read` and `verify` take `at`, an ISO 8601 time or a `Date`. They use the version that was current at that time.
  - The rules that choose the current version apply to the versions of that time. A later capture does not change the answer.
  - The result names the `capture` and the `fetched_at` of the version, and it gives `at`. A time before the first capture gives `before_first: true` and a note with the time of the first capture.
  - `verify` with `at` examines that version only. Give `capture` or `at`, not the two.
  - A version that was held back at that time stays held back. When the document is held back at this time, each of its versions is held back too.
  - `find` has no `at`. A search at a time needs an index entry for each version, or a scan of each stored text, and neither is cheap.
- **Compare two versions.** `crawler.diff(doc, { from, to })` compares two versions of a stored document, by capture id or by `{ at }`. The default compares the newest version with the version before it of the same kind.
  - The text comes as a line diff (Myers) with 2 lines of context, and a word diff inside each changed line.
  - The title, the URL and the metadata (the JSON-LD too) come as changes at a path, for example `meta.jsonld[0].openingHours`.
  - The summary counts the lines, the words and the changes of the metadata.
  - `DIFF_LIMITS` bounds the characters, the lines, the steps, the hunk lines and the changes of the metadata. A diff over a bound says so in its note, with `exact` and `truncated`.
  - A held-back side gives no text and no title, and only the structural metadata.
- **Watch pages.** `crawler.watch` keeps a list of pages to check again, in the new file `watch.sqlite` of the store. It has `add`, `remove`, `list` and `run`.
  - `watch.run({ budgetMs, maxPages })` checks the entries that are due through the normal fetch, so each polite rule applies. It gives an async iterable of events and a `summary`.
  - Each event has the URL, the document, the capture of the check, the last confirmed capture, the kind (`new`, `changed`, `unchanged`, `gone`, `refused` or `error`) and the counts of the diff.
  - With `confirm: 2` (the default), a change is suspected at its first check and confirmed when the next check sees the same version. `confirm: 1` confirms at once.
  - `every` has a floor of 1 hour (`watchFloor` of `openCrawler` changes it). A check that finds a stopped host is due again at the end of the stop.
  - A run claims each entry with a lease in `watch.sqlite`, so two processes do not check one entry two times. The list stays after a restart.
  - The package has no daemon: a scheduler of the operator starts `watch.run`.
- **The command line.** `polite-crawler diff <doc> [--from <version>] [--to <version>]`, `watch add <url...>`, `watch remove <url...>`, `watch list` and `watch run`. `read` and `verify` take `--at <time>`. `watch add` takes `--every`, `--confirm`, `--render`, `--scope` and `--label`, and `watch run` takes `--budget` and `--max-pages`.
- **The MCP server.** `crawl_read` and `crawl_verify` take `at`, and their results give `at` and `before_first`. `crawl_verify` gives its `note` too. Two new tools:
  - `crawl_diff` compares two versions. The changes come in the `<untrusted-web-content>` envelope, and the JSON gives only the counts and the captures.
  - `crawl_watch_list` lists the watched pages, with no scope and no labels.
  - No tool adds a watch, because a watch commits future requests to a site. The operator adds it.
- **The API.** These additions do not break the API:
  - `PoliteCrawler` has two new optional members, `diff` and `watch`. `openCrawler` gives an `OpenedCrawler`, a `PoliteCrawler` that has them. An object of your own that implements `PoliteCrawler` stays correct.
  - `ReadOptions` and `VerifyOptions` have the optional `at`. `ReadResult` and `VerifyResult` have the optional `at` and `before_first`.
  - The root entry point exports `diffDocument`, `diffTexts`, `DIFF_LIMITS`, `versionAtTime`, `isoTime`, `WatchStore`, `runWatch`, `WATCH_LIMITS`, `WATCH_SCHEMA` and `OpenedCrawler`. It also exports the types of the diff and of the watch list. The README lists them in the stable API.
  - The engine has the optional method `ReadingIndex.versionAt`, `DocIndex.versionAt` and `Crawler.hostStop`. A `ReadingIndex` of your own without `versionAt` gives the newest version at or before the time.
  - The capture log, the bodies and the capture ids do not change. A store with no watch has no `watch.sqlite`.
- **An archived copy after a refusal (opt-in).** `fetch(url, { fallback: "archive" })` gives a copy from the Wayback Machine, then Common Crawl, when the site refuses the page or is down. The command line has `fetch --archive-fallback`, and `crawl_fetch` has `archive_fallback`.
  - A 401, a 402, a 403, a challenge, a stop of the host, a 5xx error and a dead host get a copy. A 404, a 429 and a cancel do not.
  - A copy is a document of its own (`archive:<url>`, of the kind `archived`). The result keeps the outcome of the live fetch, and `archived` gives the archive, the date of the copy and its URL there.
  - `read`, `verify` and `find` give `archived` for a copy, and the notes of `read` and `verify` name the archive and the date. A citation thus cannot show a copy as the current page.
  - By default, a page that the current robots.txt of its site disallows gets no copy. `archiveDespiteRobots` (`--archive-despite-robots`) gives one. The MCP server has no such parameter.
  - Each request to an archive is a fetch of the crawler: robots.txt, the pace, the egress policy, the identity and the capture log apply. A URL with a secret does not go to an archive.
  - The usage signals of a copy apply as for a live page. They include the content signals of the robots.txt of its site, and the archived headers.
- **Signed requests (Web Bot Auth).** The option `signer` signs each request with HTTP Message Signatures (RFC 9421). It follows `draft-ietf-webbotauth-httpsig-protocol-00`. robots.txt, the redirects and the requests of a rendered page get a signature too.
  - `createWebBotAuthSigner` takes an Ed25519 key (a `KeyObject`, PKCS#8 or a JWK) and the URL of the key directory. `keyDirectory` makes the JSON Web Key Set to host, and `verifySignature` checks a request.
  - The signature covers `@authority` and the member of `Signature-Agent`, with `created`, `expires`, the JWK thumbprint as `keyid`, `alg="ed25519"`, a nonce and `tag="web-bot-auth"`. The tests check the vectors of RFC 9421 and of the draft.
  - The command line has `--sign-key <file>` and `--signature-agent <url>` for `fetch`, `discover`, `crawl`, `watch run` and `mcp`. `polite-crawler key-directory` prints the key directory.
  - The `User-Agent` does not change. The capture log records the key id and the agent of each signed request (`signed`), and not the key. The package uses `node:crypto` and adds no dependency.
  - The README tells how to host the key directory, and why a project site of GitHub Pages cannot serve it at the well-known path.
- **The engine of the fallback and of the signatures.** These additions do not change the existing API:
  - `FetchRequest` takes `range`, `signalLines` and `originalHeaderPrefix`. A range request keeps no stored copy and sends no validators. `CrawlerOptions`, `RuntimeOptions` and `OpenOptions` take `signer`, and `RenderOptions` takes `sign`.
  - `ExtractedDoc` takes `ai_input`: an extractor can hold back a document whose body refuses AI input. `Crawler.robotsAllow` also gives the content signals of robots.txt (`signals`).
  - `record.schema.json` describes the new payload fields `range` and `signed`. The capture ids do not change.
  - The recipes `archive-copy` and `archive-index` belong to the crawler. An application that registers an extractor named `archive-copy` gets an error.

## 0.1.1 - 2026-10-17

- **Conditional requests learn the validator that works for each host.** A server examines `If-None-Match` first, and it ignores `If-Modified-Since` with it (RFC 9110, section 13.1.3). Thus a host that gives a new `ETag` at each response sent the full page at each revisit, also with a stable `Last-Modified` date. The crawler keeps a validator memo for each host:
  - After 3 full responses in sequence with the stored body, it sends only `If-Modified-Since` to that host, and the host can answer 304.
  - After 20 such requests or 7 days, it sends the `ETag` again one time. A 304 starts the `ETag` again.
  - When the date alone also fails, it sends the two validators again, and the memo records that neither works.
  - The memo is in `hosts.sqlite`, so the processes on one store share it, and it stays after a restart. An existing `hosts.sqlite` gets the new table when it opens. The capture log and the bodies do not change.
  - A capture of a conditional request records the validators that it sent (`validators`). `record.schema.json` describes the field.
  - `HostStateStore` has two new optional methods, `validators` and `noteValidators`. A store of your own without them works as before, with no memo. The root entry point exports `nextValidatorMemo`, `VALIDATOR_MEMO` and the types of the memo.
- **An optional fast ranking for long questions.** The default ranking does not change. `find` takes `rank: "fast"`, the command line takes `find --rank fast`, and `crawl_find` takes `rank`. `DocIndex.find` and `DocIndex.rankWithin` take it too.
  - In the mode `fast`, the second part of a search gives the documents that hold one word. It leaves out the words that more than 20 percent of the documents hold.
  - In a benchmark of 30,000 documents, a question of 16 words was 2.5 times faster, and 85 percent of its top 10 was the same. A question of 1 or 4 words was not faster. The README gives the numbers.
  - `parseQuery` gives `anyParts`, the parts of the form that needs one part.
- **A benchmark of the search.** `bench/find.mts` and the workflow `bench.yml` measure `find` and `rankWithin` in each ranking mode on a synthetic index. They give the speed and the change of the top 10.

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
  - The `contact` option adds an address to the `User-Agent`. Only an email address goes into the `From` header (RFC 9110).
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
  - At open, the crawler rebuilds a stale index and gives an index that is behind the log the captures that it missed. `catchUpIndex` does the same after `createRuntime`. A runtime takes any `ReadingIndex`.
  - The log and the bodies go to the disk before a fetch finishes. Two processes can use one store: the index waits for a lock, and `hosts.sqlite` keeps one pace for each host.
  - A capture shows `REDACTED` in place of a user name, a password and the values of secret query parameters.
  - The package publishes the JSON Schema of a capture record: `polite-crawler/record.schema.json`.
  - A body longer than the limit keeps its first part, and the capture says `truncated`. A body that does not download or decode gives the outcome `error`.
  - `FetchRequest.maxAgeMs` can be `"auto"`, the freshness that the server gave.
- **Reading.** The crawler reads JSON-LD, the visible text, the links and PDF files with no browser. With the optional peer `playwright-core`, it opens a headless browser for a page that shows almost nothing without JavaScript.
  - The text and the links leave out hidden text: `display: none` in a `style` attribute, `hidden`, `aria-hidden="true"` and a font size of zero.
  - `decodeBody` and `bodyEncoding` decode a body in the encoding that it declares.
  - `PageExtract` gives `canonical`, `redirect`, `blocked` and `notes`. `Hours` gives `partial` and `season`. `PdfOptions` sets the limits of the PDF reader.
  - A renderer throws `RenderRefused` for a page that it did not render, and the crawler does not count it as a failure of the host.
  - `maxRenders` (default 2) limits the pages that the browser renders at one time.
  - The default renderer checks one time that the browser is installed. With no browser, each page that needs JavaScript gets a note at once, with no wait and no error capture.
- **Usage signals.** When a page asks not to be AI input (`ai-input=no`), the crawler keeps the page but holds back its text from the AI reader. The read gives no title, no text and only the structural metadata, the quote check gives no match, and the search leaves the page out.
  - The capture records the RSL `License` lines of robots.txt and the TDMRep `tdm-reservation` and `tdm-policy` headers and `<meta>` tags. They do not change what the crawler does.
- **The parts.** The entry points `polite-crawler/robots`, `/hours`, `/html`, `/classify`, `/politeness` and `/signals` have no Node.js dependency, so a browser can import them.
