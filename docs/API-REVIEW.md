# API review before 1.0

This file records which exports of `polite-crawler` are stable for version 1.0.0, which are beta, and which leave the root entry point in 0.2.0. It is the review of the roadmap item `api-review`. Since 0.2.0, the MCP server is the package `polite-crawler-mcp`, on the shared MCP host (the item `mcp-host`). polite-crawler has no MCP entry point. The section "polite-crawler-mcp" gives the tiers of that package.

## What 1.0 promises

- **Stable.** An export with no release tag is stable. Before 2.0.0, a change to it does not break code that uses it. The command line, its exit codes, the store on disk and `record.schema.json` are stable too.
- **Beta.** The declaration of a beta export has the TSDoc tag `@beta`, and your editor shows it. A minor version can change a beta export, also after 1.0.0. Its section in `CHANGELOG.md` then tells you what to change. A member of a stable type can be beta too: it has its own `@beta` tag.
- **Deprecated.** The declaration of an export that leaves the root entry point has the tags `@beta` and `@deprecated`. Version 0.2.0 removes it. No documented use needs it.

The tiers follow the section "Which parts are stable" of the package README. The README names the beta tier "the engine". This review adds the tags and closes the gaps between the two:

- A stable signature uses only stable types. API Extractor checks it (`ae-incompatible-release-tags`), and the report shows each exception.
- A function over a runtime (`CrawlRuntime`) is beta, because `CrawlRuntime` is the engine. Thus `diffDocument`, `versionAtTime`, `runWatch`, `WatchStore` and `registerRecipe` move from the stable list of the README to beta. The stable way is the method of the crawler: `crawler.diff`, `crawler.read(doc, { at })` and `crawler.watch`.
- The interfaces of the store (`BlobStore`, `CaptureReader`, `CaptureFilter`, `ScanOptions`, `DamagedLine`), `FetchOutcome`, `ExtractedDoc`, `Extractor` and `RuntimeOptions` move from the engine to stable, because stable signatures use them.

## The report that CI compares

`packages/polite-crawler/api/` holds one report for each entry point of the npm package. API Extractor makes each report from the declarations of the build. To make the reports again, start `pnpm build`, then `pnpm api`, and commit the reports.

CI starts `pnpm api --check`. The check fails when the API of the build is not the API in the reports. Thus each change to the public API is a change to a report, and each pull request shows it. A change to a stable export also needs its entry in `CHANGELOG.md`, with its level of semantic versioning.

The reports also show what API Extractor found:

- `ae-forgotten-export`: a signature uses a type that no entry point exports. The list of 0.2.0 below names each one.
- `ae-incompatible-release-tags`: a stable signature uses a beta type. Two exceptions stay on purpose:
  - `RecipeTarget` is a `PoliteCrawler` or a `CrawlRuntime`. A recipe operates on either one, and only the runtime is beta.
  - `transformersEmbedder` takes a function that loads transformers.js (`TransformersModule`). The tests use it. That type follows a package of another project, so it stays beta.

## Stable

| Exports | Entry point | Reason |
| --- | --- | --- |
| `BOT_PAGE`, `DEFAULT_TOKEN`, `defaultUserAgent`, `Duration`, `FetchOptions`, `FindOptions`, `HybridCrawler`, `openCrawler`, `OpenedCrawler`, `OpenOptions`, `PoliteCrawler`, `RankOptions`, `ReadOptions`, `ReadResult`, `RuntimeOptions`, `SearchOptions`, `VerifyOptions`, `VerifyResult` | root | The main API: `openCrawler`, the methods of `PoliteCrawler`, their options and results, and the identity of the crawler (`BOT_PAGE`, `DEFAULT_TOKEN`, `defaultUserAgent`). `OpenOptions` extends `RuntimeOptions`, so `RuntimeOptions` is stable too. |
| `BlobStore`, `CaptureFilter`, `CaptureReader`, `DamagedLine`, `ScanOptions` | root | The interfaces of the store on disk, which is stable. `ArchiveSource` uses them. |
| `CrawlEvent`, `FetchOutcome` | root | The events of the option `onEvent` of `openCrawler`. |
| `changeCommand`, `ChangeCommandOptions`, `Daemon`, `DAEMON_DEFAULTS`, `DAEMON_STATE_SCHEMA`, `DaemonDue`, `DaemonOptions`, `DaemonState`, `daemonStateFile`, `DaemonStatus`, `DaemonTask`, `DaemonTick`, `readDaemonState`, `ScheduleOptions`, `ScheduleResult`, `scheduleWatches`, `startDaemon`, `WatchSchedule` | root | The daemon and its state file. The README and the site document them. |
| `DIFF_LIMITS`, `DiffHunk`, `DiffInput`, `DiffLimits`, `DiffLine`, `DiffOptions`, `DiffResult`, `DiffSide`, `DiffSummary`, `diffTexts`, `MetaChange`, `TextDiff`, `VersionChoice`, `WordPart` | root | The diff of two versions, as `crawler.diff` gives it. |
| `Changefreq`, `CrawlOptions`, `CrawlPage`, `CrawlRun`, `CrawlStop`, `CrawlSummary`, `DiscoveredUrl`, `DiscoverOptions`, `DiscoverResult`, `DiscoverSource`, `DiscoverStop`, `ScopeOptions`, `SitemapKind`, `UrlPattern` | root | The options and the results of `discover` and `crawl`. |
| `Doc`, `DocVersion`, `ExtractedDoc`, `Found`, `NO_EMBEDDER`, `Passage`, `RankMode`, `SearchRank`, `VersionAt`, `VersionText` | root | The results of `find`, `read` and `versions`, and the documents that an extractor gives. |
| `EgressOptions` | root | The option `egress` of `openCrawler`. |
| `EmbedCallOptions`, `Embedder`, `EmbeddingModel`, `EmbedOptions`, `EmbedResult`, `EmbedStop`, `HYBRID_DEFAULTS`, `HybridFindOptions`, `HybridOptions`, `HybridSearch`, `NO_OLLAMA`, `NO_TRANSFORMERS`, `OLLAMA_MODELS`, `ollamaEmbedder`, `OllamaEmbedderOptions`, `Pooling`, `Ranked`, `TRANSFORMERS_MODELS`, `transformersEmbedder`, `TransformersEmbedderOptions` | root | Hybrid search: the extension point `Embedder`, the two adapters, and the options and results of `find`, `embed` and `rankWithin`. |
| `ExtractOptions`, `ExtractResult`, `ExtractSummary`, `FieldCandidate`, `FieldCheck`, `FieldClaim`, `FieldKind`, `FieldResult`, `FieldSpan`, `FieldStatus` | root | The options and the results of `extract`. |
| `Archived`, `WebArchive` | root | The field `archived` of the results. |
| `defineRecipe`, `readJson`, `Recipe`, `RecipeCapture`, `RecipeDefinition`, `RecipeDoc`, `RecipeExtract`, `RecipeRequest`, `RecipeRequestOptions`, `RecipeResult`, `RecipeRunOptions`, `RecipeTarget`, `RESERVED_RECIPES`, `runRecipe` | root | The recipe SDK. |
| `Money`, `productOf`, `ProductOptions`, `ProductRead`, `ProductResult`, `ProductVariant`, `readProduct`, `readVenue`, `VenueLink`, `VenueLocation`, `VenueOptions`, `VenueOsm`, `VenuePage`, `VenueRead`, `VenueReading`, `venueReadingsOf`, `VenueResult`, `VenueSource` | root | The two recipes, with their options and results. The site documents them. |
| `CaptureRecord` | root | A record of the capture log, as `record.schema.json` gives it. |
| `Extractor`, `isoTime`, `PageResult`, `ReindexResult` | root | The results of `fetch` and `reindex`, the type of the option `extractors`, and the time of `at`. |
| `VERSION` | root | The version of the package. |
| `ArchiveCounts`, `ArchiveFilter`, `ArchiveOptions`, `ArchiveSource`, `exportWacz`, `exportWarc`, `WaczResult`, `WarcResult` | root | The export to WARC and WACZ. |
| `WATCH_LIMITS`, `WATCH_SCHEMA`, `WatchEntry`, `WatchEvent`, `WatchKind`, `WatchList`, `WatchOptions`, `WatchPending`, `WatchRun`, `WatchRunOptions`, `WatchStop`, `WatchSummary` | root | The watch list of `crawler.watch`. |
| `createWebBotAuthSigner`, `DirectoryKey`, `KEY_DIRECTORY_PATH`, `KEY_DIRECTORY_TYPE`, `keyDirectory`, `KeyDirectory`, `KeyInput`, `RequestSigner`, `SignatureAgentType`, `SignatureCheck`, `SignedRequest`, `verifySignature`, `WebBotAuthOptions`, `WebBotAuthSigner` | root | Signed requests (Web Bot Auth). |
| `AiInput`, `ALLOW_ALL`, `bodyEncoding`, `Clock`, `compareHours`, `Day`, `DAYS`, `decide`, `decodeBody`, `DEFAULT_POLICY`, `describeWeek`, `disagreements`, `extractPage`, `fromCompact`, `fromSchemaOrg`, `fromText`, `HostCounts`, `HostResult`, `HostStateStore`, `HostStop`, `Hours`, `HoursComparison`, `Interval`, `MemoryHostStateStore`, `nextValidatorMemo`, `Outcome`, `PageExtract`, `PageLink`, `parseRobots`, `PolicyOptions`, `PolitenessPolicy`, `realClock`, `Robots`, `RobotsDecision`, `RobotsGroup`, `RobotsRule`, `RobotsSignal`, `Signals`, `toHoursWeek`, `typesOf`, `VALIDATOR_MEMO`, `ValidatorAnswer`, `ValidatorLimits`, `ValidatorMemo`, `ValidatorReport`, `ValidatorVerdict`, `Week` | root | A reader. Its own entry point gives it too, and the readers are stable as a whole. |

## Beta

| Exports | Entry point | Reason |
| --- | --- | --- |
| `CacheEntry`, `CacheIndex`, `CAPTURE_SCHEMA`, `CaptureLog`, `CaptureLogOptions`, `CapturePayload`, `CaptureWriter`, `catchUpIndex`, `CatchUpResult`, `Crawler`, `CrawlerOptions`, `CrawlRuntime`, `createRuntime`, `DEADLINE_NOTE`, `DEFAULT_SECRET_PARAMS`, `Extractors`, `fetchAndIndex`, `Fetched`, `fetchPage`, `FetchRequest`, `FileBlobStore`, `FileBlobStoreOptions`, `findDocuments`, `HELD_BACK`, `heldBackMeta`, `Indexed`, `isHeldBack`, `isMailbox`, `PageOptions`, `readDocument`, `recordOverride`, `reindex`, `RenderRequest`, `SqliteHostStateOptions`, `SqliteHostStateStore`, `StoreRuntime`, `verifyQuote`, `versionAtTime` | root | The engine of a runtime of your own: `createRuntime`, the parts that it puts together, and the steps over a runtime. `versionAtTime` is a step over a runtime. `read` and `verify` with `at` are the stable way. jarvis builds on this tier. |
| `DaemonMcpHooks`, `DaemonMcpHost`, `DaemonMcpOptions`, `DaemonMcpService` | root | The MCP seam of the daemon. It changes in 0.2.0, when the MCP server moves to the shared MCP host. |
| `browserMissing`, `formatDiff` | root | New in 0.2.0 for `polite-crawler-mcp`: the check of the browser at start, and the text of a diff that the tool `crawl_diff` shows. |
| `DigestOptions`, `DocDigest`, `DocIndex`, `DocIndexOptions`, `DocInput`, `FAST_RANK_SHARE`, `FindIndexOptions`, `Latest`, `locate`, `ReadingIndex`, `Variant`, `Verified` | root | The reading index and its parts. |
| `CRAWL_LIMITS`, `CrawlRunOptions`, `crawlSite`, `DISCOVER_LIMITS`, `DiscoverRunOptions`, `discoverSite`, `feedDate`, `readSitemap`, `SITEMAP_LIMITS`, `SitemapEntry`, `SitemapLimits`, `SitemapRead` | root | The engine of discovery and of the crawl. |
| `diffDocument`, `runWatch`, `WatchRescheduleOptions`, `WatchRunnerOptions`, `WatchStore`, `WatchStoreOptions` | root | Functions over a runtime of your own. `crawler.diff` and `crawler.watch` are the stable way. |
| `CHUNK_LIMITS`, `ChunkOptions`, `chunkText`, `chunkTokensOf`, `createHybridSearch`, `estimateTokens`, `FeatureExtractor`, `FusedRank`, `fuseRanks`, `HybridSearchOptions`, `isLoopback`, `StoredChunk`, `TextChunk`, `TransformersModule`, `unitVector`, `VectorCounts`, `VectorHit`, `VECTORS_SCHEMA`, `VectorStore`, `VectorStoreOptions`, `VectorWrite` | root | The engine of hybrid search: the chunks, the fusion, the vector store, and the shape of the transformers.js module. |
| `egressLookup`, `EgressRefused` | root | The lookup for a dispatcher of your own. |
| `checkFields`, `extractDocument`, `ExtractSource`, `FIELD_KINDS`, `FieldsChecked` | root | The engine of the check of fields. |
| `archivedDocId`, `archiveExtractor` | root | The engine of the archived fallback. |
| `isPdf`, `PdfOptions`, `PdfText`, `readPdf` | root | The PDF reader of the page extractor. |
| `makeRecord`, `RecordInput` | root | The function that makes a record. jarvis checks that its hash stays the same. |
| `RECIPE_LIMITS`, `registerRecipe` | root | `registerRecipe` puts a recipe in the extractors of a runtime of your own. The limits can change. |
| `locationMatches`, `namesVenue`, `pickProduct`, `pickVariant`, `PRODUCT_LIMITS`, `rankHoursLinks`, `readAmount`, `VENUE_LIMITS` | root | The steps of the two recipes. The words that rank a link or a label can improve in each version. |
| `NO_PLAYWRIGHT`, `playwrightRenderer`, `PlaywrightRenderer`, `RefusedReason`, `Rendered`, `Renderer`, `RenderOptions`, `RenderRefused` | root | The renderer. The option `renderer` is beta too. |

These members of stable types are beta:

- `PoliteCrawler.runtime`
- `RuntimeOptions.log`, `blobs`, `index` and `renderer`
- `Recipe.request` and `Recipe.extractor`
- `ExtractedDoc.ai_input`
- `VenueRead.steps` and `ProductRead.steps`
- `DaemonOptions.mcp` and `mcpHost`, and `Daemon.mcp`
- `WatchList.reschedule` and `WatchOptions.keepSchedule`

## Deprecated

Version 0.2.0 removes these exports from the root entry point. `durationMs` stays, with the tag `@beta`, because `polite-crawler-mcp` uses it.

| Exports | Entry point | Reason |
| --- | --- | --- |
| `checkedRenderer` | root | `createRuntime` uses it for its default renderer. |
| `durationMs` | root | It stays in 0.2.0 as beta: `polite-crawler-mcp` reads the durations of its tools with it. |
| `pageDocId` | root | The result of `fetch` gives the document id (`doc`). |
| `pageExtractor` | root | The runtime uses it as the reader of the recipe `page`. |
| `renderAndIndex` | root | `fetchPage` with `render: "always"` does the same. |
| `renderedKey` | root | It gives the cache key of version 0.1. Only the index reads that form. |

## The entry points of the readers

`polite-crawler/robots`, `/hours`, `/html`, `/classify`, `/politeness` and `/signals` are stable as a whole. They import no Node.js module, so a browser can use them. The site and its tools use them.

## What 0.2.0 changes

Version 0.2.0 is a minor version, so it can break the API. It comes with the move of the MCP server to the shared MCP host. It does these things:

- It removes the deprecated exports above from the root entry point.
- The MCP server leaves for the package `polite-crawler-mcp`, with the entry point `polite-crawler/mcp` and its report. The MCP seam of the daemon (`DaemonMcpHooks`, `DaemonMcpHost`, `DaemonMcpOptions` and `DaemonMcpService`) stays: its default host is `mcpHttpHost` of `polite-crawler-mcp`.

## What 0.2.1 changes

Version 0.2.1 is a patch version: it adds exports and changes nothing that a program uses.

- Each type that a signature uses gets an export, with a name that tells what it is. Before, these types had no export, so no program could name them. The report has no `ae-forgotten-export` message.

| Type | Entry point | Tier | The signature that uses it |
| --- | --- | --- | --- |
| `DomNode` | `/html` | stable | `visibleText` |
| `JwkInput` (before: `JsonWebKey`, inside the package) | root | stable | `KeyInput` |
| `JsonRecord` (before: `Json`) | root | stable | `productOf`, `pickProduct`, `pickVariant` |
| `IndexBuild`, `IndexCounts` (before: `Counts`) | root | beta | `DocIndex` |
| `EgressResolve` (before: `Resolve`) | root | beta | `egressLookup` |
| `WatchRow`, `WatchState`, `WatchUpdate` (before: `Row`, `State`, `Update`) | root | beta | `WatchStore` |

- `polite-crawler-mcp` gets its own report in `packages/polite-crawler-mcp/api/`, and the tiers below.

## polite-crawler-mcp

The package is the MCP server of polite-crawler since 0.2.0. Its tiers follow the same rules. A program that starts the server uses the stable tier. The parts that put the tools on an MCP host of your own follow `@procedures/mcp-server`, which is before its 1.0, so they are beta.

| Exports | Tier | Reason |
| --- | --- | --- |
| `createMcpServer`, `CrawlMcpServer`, `CrawlServerOptions`, `CrawlToolOptions`, `startMcpServer`, `StartMcpOptions`, `startMcpHttpServer`, `StartMcpHttpOptions`, `McpHttpServer`, `McpHttpOptions`, `mcpHttpHost`, `MCP_HTTP_DEFAULTS`, `makeToken`, `sameToken`, `checkToken`, `SERVER_NAME`, `VERSION` | stable | The server over stdio and over HTTP, its options, the host of the daemon, and the rules of the token. The README and the site document them. |
| `crawlHostOptions`, `crawlTools`, `crawlContent`, `serveMcpHttp` | beta | The parts of the server on the shared MCP host. Their types come from `@procedures/mcp-server`, which can change before its 1.0. |
| `INSTRUCTIONS` | beta | The text that the MCP client gives to the model. A version can change the text. |
| `McpTaskStore`, `McpTaskInfo`, `McpTaskStoreOptions` | the tier of `@procedures/mcp-server` | Exports of the shared host, which the package gives again so that a program needs no second import. |

## Counts

| Entry point | Stable | Beta | Deprecated |
| --- | --- | --- | --- |
| polite-crawler root | 235 | 135 | 0 |
| `/robots`, `/hours`, `/html`, `/classify`, `/politeness`, `/signals` | 87 | 0 | 0 |
| polite-crawler-mcp | 17 | 5 | 0 |
