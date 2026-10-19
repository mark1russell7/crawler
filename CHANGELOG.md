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

- **The MCP server is the package `polite-crawler-mcp`.** This version breaks the API, so it is a minor version (0.2.0). The library loads no MCP SDK and no `zod`, and it depends on neither.
  - The entry point `polite-crawler/mcp` is gone. Import `createMcpServer`, `startMcpServer`, `startMcpHttpServer` and `mcpHttpHost` from `polite-crawler-mcp`. `createMcpServer` gives a `CrawlMcpServer` with `connect(transport)` and `close()`, and the store of the tasks is `McpTaskStore`. The README of `polite-crawler-mcp` tells the rest.
  - The nine tools, their names, their parameters, their answers and the envelope of the page text do not change. They are procedures on the shared MCP host of `@procedures/mcp-server`.
  - `polite-crawler mcp` still starts the server in 0.2.x when `polite-crawler-mcp` is installed next to polite-crawler, and it writes a note that the command is deprecated. Without the package, it tells you to start `npx polite-crawler-mcp`, and it exits with 2. Version 0.3.0 removes the command.
  - `polite-crawler daemon --mcp-http` needs `polite-crawler-mcp` too. The daemon finds it next to polite-crawler, or in the project of the working folder.
  - To move: change `npx -y polite-crawler mcp` to `npx -y polite-crawler-mcp` in the configuration of each MCP client, and `polite-crawler/mcp` to `polite-crawler-mcp` in your imports.
  - In the MCP registry, the entry `io.github.mark1russell7/polite-crawler` names the package `polite-crawler-mcp`.
- **Two new exports.** `formatDiff` gives the text of a diff, as the tool `crawl_diff` shows it. `browserMissing` tells why the default renderer cannot start a browser.

## 0.1.4 - 2026-10-18

- **The recipes on the command line.** `polite-crawler venue <url>` and `polite-crawler product <url>` read a venue or a product page with `readVenue` and `readProduct`. The MCP server does not change.
  - `venue` prints the week of the site and each reading with its source URL, its rank and its quote. It also prints the days where the readings disagree, the menus, the phone, the pages and the notes.
  - `venue` takes `--name`, `--require-name`, `--address`, `--lat` and `--lon`, `--osm` and `--pages`. `--compare <file>` compares the week of the site with a kept week (JSON) through `compareHours`, day by day.
  - `product` prints the name, the brand, the codes, and the price as money with the range of the offers. It also prints the availability, the variant, the seller, and a wall or a held-back page.
  - The two commands take `--render`, `--max-age`, `--budget`, `--user-provided`, `--archive-fallback`, `--archive-despite-robots` and the options of the signed requests. The new option `--on-behalf-of <agent>` applies the robots.txt rules of an agent too.
  - `--json` prints the `VenueResult` or the `ProductResult`. With `--compare`, the JSON also has the field `compare`.
  - The new exit code 3 tells that the command read nothing, and 4 tells that the site refused the crawler (a wall). The other commands keep their exit codes.
  - This change only adds to the command line. The API of the library, the capture log, the bodies and the capture ids do not change.
- **The declaration files type-check with `@types/node` 26.** The declaration files of 0.1.3 import `JsonWebKey` from `node:crypto`. `@types/node` 26 has no such export. Thus a project with `skipLibCheck: false` gets the error TS2305.
  - The type comes from `JsonWebKeyInput`, which `@types/node` 22 and 26 both have. The type of a key does not change.
  - The smoke test type-checks the tarball with the oldest and the newest `@types/node` of the workspace.

## 0.1.3 - 2026-10-18

- **The recipes only add to the API.** Code that compiled against 0.1.1 or 0.1.2 compiles against this version, and `compat.test.ts` and `compat-012.test.ts` stay green. The capture log, the bodies and the capture ids do not change.
  - `RuntimeOptions`, and thus `OpenOptions`, has the optional `recipes`. `OpenedCrawler`, `HybridCrawler` and `PoliteCrawler` do not change.
  - `polite-crawler/hours` has the new `compareHours` and `HoursComparison`. Its size for a browser stays in its budget.
  - In this version, `createRuntime` registers the extractors before it opens a file of the store. Thus an extractor that it refuses leaves no open file.
- **The recipe SDK.** `defineRecipe({ name, fetch, extract })` declares what a recipe fetches and how it reads a body into documents. The README section "Writing a recipe" gives a full example and the rules.
  - `runRecipe(crawler, recipe, input)` fetches the request of an input through the crawler and gives the documents of its capture. `registerRecipe` registers a recipe in a runtime of your own.
  - `readJson(body, capture)` reads a body as JSON in its declared encoding. A body that is not JSON throws an error that names the URL and the content type.
  - `mode: "page"` obeys robots.txt. `mode: "api"` is a documented API: robots.txt does not apply, and the pace (`minInterval`) does.
  - `reindex` reads the captures of each recipe again, and the time travel (`at`, `versions`, `diff`) works on its documents. A runtime with no recipe keeps the documents.
  - The extractor of a recipe checks each document. A document that is not valid, a document id with the prefix `archive:` and the kind `archived` make the extractor throw. The runtime reports the error.
  - When the extractor cannot read a stored copy, `runRecipe` asks the source one more time. A held-back document shows no title and only its structural metadata, unless `userProvided`.
  - With `fallback: "archive"`, a recipe of the mode `page` gets an archived copy after a refusal. The page reader reads the copy, so the documents of the recipe come only from live captures.
  - A recipe cannot use a name of the crawler (`RESERVED_RECIPES`): `page`, `archive-copy`, `archive-index`, `robots.txt`, `sitemap` and `feed`.
- **The venue recipe.** `readVenue(crawler, url)` reads the opening hours of a venue from its own site. It reads the JSON-LD and the text of the home page, and of the pages that most likely hold hours or a menu.
  - Each reading names its page, its document and its capture. The result gives the best reading, the best reading of the site with no guess (`from_site`), and the days where the readings disagree.
  - It reads an OpenStreetMap `opening_hours` value that the caller gives (`osm`). It sends no request to OpenStreetMap.
  - On a page that lists more than one location, it reads only the location that matches `location`. With `name`, it tells if the home page names the venue. `requireName` stops at a site that does not name it.
  - It gives the menu links and the phone, and it tells when the site moved to a different host.
  - `venueReadingsOf` reads one stored document or version with no request. `compareHours` compares a reading with the week that an application keeps.
- **The product recipe.** `readProduct(crawler, url)` reads the schema.org Product data of a product page. It gives the name, the brand, the SKU, the GTIN, the price, the availability, the seller and the image.
  - A price is an amount and an ISO 4217 currency. `price` and `price_to` give the range of the variants. A list price and a struck-through price are not the price.
  - It picks the product of the page, not a related product on the page. It reads the variant that the URL names.
  - It reads a product that is larger than the JSON-LD of the index from the stored body. It renders the page once when the plain page has no Product data.
  - A shop that refuses the crawler gives `wall: true` and a note. `productOf` reads JSON-LD records with no request, and `readAmount` reads an amount as a shop writes it.
- **The library only.** The command line and the MCP server do not change: the MCP server keeps its nine tools.

- **A failed question keeps the text held back.** When the MCP client can ask the user about `user_provided`, but the question fails (a timeout, a lost connection or a cancel), the text stays held back. Before, the opt-in of the operator (`--allow-user-provided`) released it. That opt-in applies only to a client that cannot ask.

- **This version only adds to the API.** Code that compiled against 0.1.1 or 0.1.2 compiles against this version. `compat.test.ts` (0.1.1) and `compat-012.test.ts` (0.1.2) are the proof. The capture log, the bodies and the capture ids do not change.
  - `OpenedCrawler` does not change. `openCrawler` gives a `HybridCrawler`: an `OpenedCrawler` with `hybrid`, `embed`, `rankWithin` and a `find` that takes `SearchOptions`.
  - `PoliteCrawler` has the optional `hybrid`, `embed` and `rankWithin`. `ReadingIndex` has the optional `digests`, and `Found` has the optional `passage`.
  - The class `DocIndex` has the new method `digests`. A subclass of your own with a member of the same name can conflict with it.
- **Hybrid search, opt-in.** `find(q, { rank: "hybrid" })` fuses the BM25 ranking with the ranking of the vectors of a local embedding model. The default ranking stays exact BM25.
  - `Embedder` is the extension point: `{ id, dimensions, maxInputTokens?, embed(texts, { signal, purpose }) }`. The option `embedder` of `openCrawler` takes one.
  - `transformersEmbedder` uses transformers.js (`@huggingface/transformers`) in the process. The package is an optional peer (`^3.0.0 || ^4.0.0`), and it loads at the first text. The default model is `Xenova/bge-small-en-v1.5`.
  - The first use of a transformers.js model downloads it from the Hugging Face Hub. That download does not go through the polite crawler.
  - `ollamaEmbedder` sends the texts to a local Ollama server (`POST /api/embed`), with no new dependency. It accepts only a loopback address, unless `allowRemote` is true. Its errors say `ollama serve` and `ollama pull <model>`.
  - The vectors go into `vectors.sqlite`, a projection beside the index, with WAL and `busy_timeout`. The key of a row is the hash of the text, the chunk and the id of the embedder. Thus a reindex keeps each vector.
  - A chunk is a window of whole sentences that ends at a paragraph when it can. It fits the input of the model (512 tokens at most), with an overlap of 10 percent. Each hit gives the `passage` of its best chunk.
  - A search gives vectors to its BM25 candidates. `crawler.embed({ budget })` and the command `embed` give vectors to each stored page. A held-back page does not go to the embedder, and no result gives it.
  - The fusion is reciprocal rank fusion with k = 60, over 50 BM25 candidates and 50 vector neighbors (`HYBRID_DEFAULTS`). Each one is an option of `find` and `rankWithin`.
  - Without an embedder, `rank: "hybrid"` rejects with `NO_EMBEDDER`. It does not change to BM25 in silence.
  - The command line has `--embedder transformers|ollama`, `--embed-model`, `--ollama-url`, `--allow-remote-ollama`, `find --rank hybrid` and `embed`. `embed` takes `--budget`, `--max-docs` and `--kind`.
  - The MCP tool `crawl_find` takes `rank: "hybrid"` only when the server has an embedder.
  - The search compares the question with each stored vector. The README gives the measured time: 82 ms for 89,100 chunks of 384 dimensions.
- **The benchmark.** `bench/find.mts --hybrid` and the input `hybrid` of `bench.yml` time hybrid search with a fake embedder.
- **The daemon only adds to the API.** Code that compiled against 0.1.2 compiles against this version, and `compat.test.ts` stays green. The capture log, the bodies and the capture ids do not change.
  - `WatchRunOptions` has the optional `drain`, and `CrawlServerOptions` has the optional `tasks`. Without `tasks`, the MCP server on the standard input and output does not change.
  - The daemon writes its own folder, `<store>/daemon/`, with `state.json` and `mcp-token`. The other files of the store do not change.
- **The daemon.** `polite-crawler daemon` and `startDaemon(options)` check the watch list on a schedule. Each tick is one `watch run`, so each polite rule applies.
  - A due entry wakes the daemon at its time, with a random jitter after it (`--tick`, `--jitter`). A tick keeps its budget and its maximum (`--tick-budget`, `--tick-pages`). The entries that a tick leaves wait for the next tick.
  - The daemon writes each confirmed change as one JSON line, to the standard output or to `--events <file>`. `onChange` and `--on-change <command>` get each change. The command gets the event on its standard input, not in its command line.
  - At `SIGINT` or `SIGTERM`, the daemon starts no new check. The checks in progress get `--grace` to end, then they abort, and the daemon releases their leases.
  - `polite-crawler daemon status` reads `<store>/daemon/state.json`: the next due watches, the last tick, the tasks that run and the last error. It exits with 0 when a daemon operates on the store.
  - `scheduleWatches` gives the schedule over the watch list of a crawler of your own. `watch.run` takes `drain`: the run starts no new check, and the checks in progress end with their state.
  - The package installs no service. The README gives example files for systemd, launchd and the Task Scheduler of Windows.
- **MCP over local HTTP, with MCP tasks.** `daemon --mcp-http` serves the nine tools over the Streamable HTTP transport, at `http://127.0.0.1:9307/mcp`.
  - Each request needs a bearer token. The daemon makes a new token at each start in `<store>/daemon/mcp-token`, for the owner only, or it reads `--mcp-token-file`. The check compares SHA-256 digests in constant time.
  - The server binds to a loopback address. A different host needs `--allow-remote`. On a loopback address, the server refuses a `Host` or an `Origin` header of a different site.
  - `crawl_site` and `crawl_discover` are MCP tasks, with the native tasks of the MCP SDK 1.32.1. A client gets a task id, polls the status, gets the result and can cancel the task. A client with no tasks gets the result in the call, with progress.
  - The library has `startMcpHttpServer` and `mcpHttpHost` in `polite-crawler/mcp`. The daemon reaches MCP through the seam `DaemonOptions.mcpHost`, and it loads the MCP SDK only for `--mcp-http`.
  - The MCP SDK marks its task API as experimental. When the SDK changes it, the tasks change with it.

## 0.1.2 - 2026-10-17

- **This version only adds to the API.** Code that compiled against 0.1.1 compiles against this version, and `packages/polite-crawler/src/compat.test.ts` is the proof. The capture log, the bodies and the capture ids do not change.
  - Each new member of an existing interface is optional. `PoliteCrawler` has the optional `discover`, `crawl`, `diff`, `watch` and `extract`. `openCrawler` gives an `OpenedCrawler`, which has the five.
  - `PageExtract.feeds` and `ReadingIndex.versionAt` are optional too.
  - The archived fallback uses the recipes `archive-copy` and `archive-index`. An application that registered its own `archive-copy` extractor in 0.1.1 can still register it. That extractor replaces the built-in one, and the fallback then reads its copies with it.
  - The classes `Crawler` and `DocIndex` have new methods: `robotsAllow`, `hostStop` and `versionAt`. A subclass of your own with a member of the same name can conflict with them.
- **Verified structured extraction.** `crawler.extract(doc, fields, options)` checks the values that a caller proposes for the fields of a stored page, and it locates each value. It does not make values. Each field gets `verified`, `normalized`, `ambiguous`, `not-found`, `held-back` or `invalid`, with its span or JSON-LD path and its capture.
  - The kinds are `text`, `number`, `money`, `date`, `url`, `email`, `phone` and `json-ld:<path>`. Each normalization has a name, and a normalized field gives it. Examples are `thousands-separator`, `decimal-comma`, `currency-symbol`, `date-written`, `url-resolved` and `phone-suffix`.
  - A normalized match must have one meaning. `1,234`, `03/04/2026`, `$12` for `USD 12` and two places with different meanings give `ambiguous`, with each place. The check does not guess.
  - `capture` and `at` choose the version. A held-back page gives `held-back` for each field, with no position, unless `userProvided`. The result is the same for each value, so the check is not an oracle.
  - The time of the check is linear in the length of the text. The tests count the steps.
  - The MCP tool `crawl_extract` gives the statuses and the positions in JSON, and the stored text in the `<untrusted-web-content>` envelope. Its description says that it checks values and does not make them.
  - The command line has `polite-crawler extract <doc> --field name=value[:kind]`, with `--capture` or `--at`. It exits with 0 when each field is `verified` or `normalized`.
  - A value from an archived copy says so, as a quote does. The result and `crawl_extract` give `archived`, and the note names the archive and the date.
  - The change only adds to the API. `PoliteCrawler.extract` is optional, so a `PoliteCrawler` of your own still compiles. `openCrawler` gives an `OpenedCrawler`, which has `extract`. The root entry point exports `checkFields`, `extractDocument`, `FIELD_KINDS` and the types.
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
  - `PageExtract` has the optional `feeds`: the RSS and Atom feeds that the page links. `extractPage` always gives them, and the metadata of a page document has them too.
  - `PoliteCrawler` has two new optional members, `discover` and `crawl`. `OpenedCrawler`, the result of `openCrawler`, has them. A `PoliteCrawler` of your own without them stays correct: `crawl_discover` and `crawl_site` then use `discoverSite` and `crawlSite` over its runtime.
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
  - The archived fallback uses the recipes `archive-copy` and `archive-index`. An application can replace the built-in `archive-copy` extractor one time.

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
