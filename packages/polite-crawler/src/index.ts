/*
 * The root entry point is the crawler for Node.js. It exports these parts:
 *
 * - `openCrawler`, with its options and its results. `discover` and `crawl` give the types of their
 *   options and results here too.
 * - The parts of the runtime that an application uses to build its own: `createRuntime`, `Crawler`,
 *   `CaptureLog`, `DocIndex`, `FileBlobStore`, `SqliteHostStateStore`, `Extractors`,
 *   `fetchAndIndex`, `fetchPage`, `reindex` and `catchUpIndex`.
 * - The read, the verification and the rule for a held-back page over a runtime: `readDocument`,
 *   `verifyQuote`, `findDocuments`, `isHeldBack`, `heldBackMeta` and `recordOverride`.
 * - The readers that an application uses with the runtime: pages, PDF files, opening hours, and
 *   sitemaps and feeds (`readSitemap`).
 * - The discovery and the crawl over a runtime: `discoverSite` and `crawlSite`.
 * - The export of a store to the web archive formats: `exportWarc` and `exportWacz`.
 * - The time travel and the diff of the versions of a document: `versionAtTime`, `diffDocument`
 *   and `diffTexts`.
 * - The watch list: `WatchStore` and `runWatch`.
 * - The daemon: `startDaemon`, `scheduleWatches`, `changeCommand` and `readDaemonState`. It loads
 *   the MCP SDK only when it serves MCP over HTTP.
 * - The archived fallback: the types of an archived copy, `archivedDocId` and `archiveExtractor`.
 * - Signed requests (Web Bot Auth): `createWebBotAuthSigner`, `keyDirectory` and `verifySignature`.
 * - The check of proposed field values against a stored page: `checkFields` and `extractDocument`.
 * - Hybrid search: the `Embedder` interface, the adapters `transformersEmbedder` and
 *   `ollamaEmbedder`, and the engine `createHybridSearch`, `VectorStore`, `chunkText` and `fuseRanks`.
 * - The recipe SDK: `defineRecipe`, `runRecipe`, `registerRecipe` and `readJson`. The recipes of the package
 *   read the hours of a venue (`readVenue`) and a product page (`readProduct`).
 *
 * The other entry points give the rest:
 *
 * - `polite-crawler/mcp` gives the MCP server. Only it loads the MCP SDK and `zod`.
 * - `polite-crawler/robots`, `/hours`, `/html`, `/classify`, `/politeness` and `/signals` give each
 *   reader whole. They import no Node.js module, so a browser can use them.
 */
export type { BlobStore, FileBlobStoreOptions } from "./blobs.ts";
export { FileBlobStore } from "./blobs.ts";
export { checkedRenderer } from "./browser.ts";
export type { Outcome } from "./classify.ts";
// ── daemon ──
export type {
  ChangeCommandOptions,
  Daemon,
  DaemonDue,
  DaemonMcpHooks,
  DaemonMcpHost,
  DaemonMcpOptions,
  DaemonMcpService,
  DaemonOptions,
  DaemonState,
  DaemonStatus,
  DaemonTask,
  DaemonTick,
  ScheduleOptions,
  ScheduleResult,
  WatchSchedule,
} from "./daemon.ts";
export {
  DAEMON_DEFAULTS,
  DAEMON_STATE_SCHEMA,
  changeCommand,
  daemonStateFile,
  readDaemonState,
  scheduleWatches,
  startDaemon,
} from "./daemon.ts";
// ── end of daemon ──
export type {
  CacheEntry,
  CacheIndex,
  CaptureWriter,
  CrawlEvent,
  CrawlerOptions,
  FetchOutcome,
  FetchRequest,
  Fetched,
  RenderRequest,
} from "./crawler.ts";
export {
  CAPTURE_SCHEMA,
  Crawler,
  DEADLINE_NOTE,
  DEFAULT_SECRET_PARAMS,
  renderedKey,
} from "./crawler.ts";
export type {
  DiffHunk,
  DiffInput,
  DiffLimits,
  DiffLine,
  DiffOptions,
  DiffResult,
  DiffSide,
  DiffSummary,
  MetaChange,
  TextDiff,
  VersionChoice,
  WordPart,
} from "./diff.ts";
export { DIFF_LIMITS, diffDocument, diffTexts } from "./diff.ts";
export type {
  DiscoverOptions,
  DiscoverResult,
  DiscoverRunOptions,
  DiscoverSource,
  DiscoverStop,
  DiscoveredUrl,
} from "./discover.ts";
export { DISCOVER_LIMITS, discoverSite } from "./discover.ts";
export type {
  DigestOptions,
  Doc,
  DocDigest,
  DocIndexOptions,
  DocInput,
  DocVersion,
  ExtractedDoc,
  FindIndexOptions,
  Found,
  Latest,
  Passage,
  RankMode,
  ReadingIndex,
  SearchRank,
  Variant,
  Verified,
  VersionAt,
  VersionText,
} from "./docs.ts";
export { DocIndex, FAST_RANK_SHARE, NO_EMBEDDER, locate } from "./docs.ts";
// ── hybrid search ──
export type { ChunkOptions, EmbedCallOptions, Embedder, FusedRank, TextChunk } from "./embed.ts";
export {
  CHUNK_LIMITS,
  HYBRID_DEFAULTS,
  chunkText,
  chunkTokensOf,
  estimateTokens,
  fuseRanks,
  unitVector,
} from "./embed.ts";
export type {
  EmbedOptions,
  EmbedResult,
  EmbedStop,
  HybridFindOptions,
  HybridOptions,
  HybridSearch,
  HybridSearchOptions,
  Ranked,
} from "./hybrid.ts";
export { createHybridSearch } from "./hybrid.ts";
export type { EmbeddingModel, OllamaEmbedderOptions } from "./ollama.ts";
export { NO_OLLAMA, OLLAMA_MODELS, isLoopback, ollamaEmbedder } from "./ollama.ts";
export type {
  FeatureExtractor,
  Pooling,
  TransformersEmbedderOptions,
  TransformersModule,
} from "./transformers.ts";
export { NO_TRANSFORMERS, TRANSFORMERS_MODELS, transformersEmbedder } from "./transformers.ts";
export type {
  StoredChunk,
  VectorCounts,
  VectorHit,
  VectorStoreOptions,
  VectorWrite,
} from "./vectors.ts";
export { VECTORS_SCHEMA, VectorStore } from "./vectors.ts";
// ── end of hybrid search ──
export type { EgressOptions } from "./egress.ts";
export type { Archived, WebArchive } from "./fallback.ts";
export { archiveExtractor, archivedDocId } from "./fallback.ts";
export { EgressRefused, egressLookup } from "./egress.ts";
// ── extract ──
export type {
  ExtractOptions,
  ExtractResult,
  ExtractSource,
  ExtractSummary,
  FieldCandidate,
  FieldCheck,
  FieldClaim,
  FieldKind,
  FieldResult,
  FieldSpan,
  FieldStatus,
  FieldsChecked,
} from "./extract.ts";
export { FIELD_KINDS, checkFields, extractDocument } from "./extract.ts";
// ── end of extract ──
export type {
  CrawlOptions,
  CrawlPage,
  CrawlRun,
  CrawlRunOptions,
  CrawlStop,
  CrawlSummary,
  UrlPattern,
} from "./frontier.ts";
export { CRAWL_LIMITS, crawlSite } from "./frontier.ts";
export type { Day, Hours, HoursComparison, Interval, Week } from "./hours.ts";
export {
  DAYS,
  compareHours,
  describeWeek,
  disagreements,
  fromCompact,
  fromSchemaOrg,
  fromText,
  toHoursWeek,
} from "./hours.ts";
export type { PageExtract, PageLink } from "./html.ts";
export { extractPage, typesOf } from "./html.ts";
export type { SqliteHostStateOptions } from "./hoststate.ts";
export { SqliteHostStateStore } from "./hoststate.ts";
export type {
  CaptureFilter,
  CaptureLogOptions,
  CaptureReader,
  DamagedLine,
  ScanOptions,
} from "./log.ts";
export { CaptureLog } from "./log.ts";
export type {
  Duration,
  FetchOptions,
  FindOptions,
  HybridCrawler,
  OpenOptions,
  OpenedCrawler,
  PoliteCrawler,
  RankOptions,
  ReadOptions,
  ReadResult,
  RuntimeOptions,
  SearchOptions,
  StoreRuntime,
  VerifyOptions,
  VerifyResult,
} from "./open.ts";
export {
  BOT_PAGE,
  DEFAULT_TOKEN,
  createRuntime,
  defaultUserAgent,
  durationMs,
  isMailbox,
  openCrawler,
} from "./open.ts";
export type { PdfOptions, PdfText } from "./pdf.ts";
export { isPdf, readPdf } from "./pdf.ts";
export type {
  Clock,
  HostCounts,
  HostResult,
  HostStateStore,
  HostStop,
  PolicyOptions,
  PolitenessPolicy,
  ValidatorAnswer,
  ValidatorLimits,
  ValidatorMemo,
  ValidatorReport,
  ValidatorVerdict,
} from "./politeness.ts";
export {
  DEFAULT_POLICY,
  MemoryHostStateStore,
  VALIDATOR_MEMO,
  nextValidatorMemo,
  realClock,
} from "./politeness.ts";
export type { CaptureRecord, RecordInput } from "./record.ts";
export { makeRecord } from "./record.ts";
// ── recipes ──
export type {
  Recipe,
  RecipeCapture,
  RecipeDefinition,
  RecipeDoc,
  RecipeExtract,
  RecipeRequest,
  RecipeRequestOptions,
  RecipeResult,
  RecipeRunOptions,
  RecipeTarget,
} from "./recipe.ts";
export {
  RECIPE_LIMITS,
  RESERVED_RECIPES,
  defineRecipe,
  readJson,
  registerRecipe,
  runRecipe,
} from "./recipe.ts";
export type {
  VenueLink,
  VenueLocation,
  VenueOptions,
  VenueOsm,
  VenuePage,
  VenueRead,
  VenueReading,
  VenueResult,
  VenueSource,
} from "./recipe-venue.ts";
export {
  VENUE_LIMITS,
  locationMatches,
  namesVenue,
  rankHoursLinks,
  readVenue,
  venueReadingsOf,
} from "./recipe-venue.ts";
export type {
  Money,
  ProductOptions,
  ProductRead,
  ProductResult,
  ProductVariant,
} from "./recipe-product.ts";
export {
  PRODUCT_LIMITS,
  pickProduct,
  pickVariant,
  productOf,
  readAmount,
  readProduct,
} from "./recipe-product.ts";
// ── end of recipes ──
export type {
  PlaywrightRenderer,
  RefusedReason,
  RenderOptions,
  Renderer,
  Rendered,
} from "./render.ts";
export { NO_PLAYWRIGHT, RenderRefused, playwrightRenderer } from "./render.ts";
export type { Robots, RobotsDecision, RobotsGroup, RobotsRule, RobotsSignal } from "./robots.ts";
export { ALLOW_ALL, decide, parseRobots } from "./robots.ts";
export type {
  CapturePayload,
  CatchUpResult,
  CrawlRuntime,
  Extractor,
  Indexed,
  PageOptions,
  PageResult,
  ReindexResult,
} from "./runtime.ts";
export {
  Extractors,
  HELD_BACK,
  catchUpIndex,
  fetchAndIndex,
  fetchPage,
  findDocuments,
  heldBackMeta,
  isHeldBack,
  isoTime,
  pageDocId,
  pageExtractor,
  readDocument,
  recordOverride,
  reindex,
  renderAndIndex,
  verifyQuote,
  versionAtTime,
} from "./runtime.ts";
export type { AiInput, Signals } from "./signals.ts";
export type {
  Changefreq,
  SitemapEntry,
  SitemapKind,
  SitemapLimits,
  SitemapRead,
} from "./sitemaps.ts";
export { SITEMAP_LIMITS, feedDate, readSitemap } from "./sitemaps.ts";
export { bodyEncoding, decodeBody } from "./text.ts";
export type { ScopeOptions } from "./urls.ts";
export { VERSION } from "./version.ts";
export type { WaczResult } from "./wacz.ts";
export type {
  DirectoryKey,
  KeyDirectory,
  KeyInput,
  RequestSigner,
  SignatureAgentType,
  SignatureCheck,
  SignedRequest,
  WebBotAuthOptions,
  WebBotAuthSigner,
} from "./webbotauth.ts";
export {
  KEY_DIRECTORY_PATH,
  KEY_DIRECTORY_TYPE,
  createWebBotAuthSigner,
  keyDirectory,
  verifySignature,
} from "./webbotauth.ts";
export { exportWacz } from "./wacz.ts";
export type {
  ArchiveCounts,
  ArchiveFilter,
  ArchiveOptions,
  ArchiveSource,
  WarcResult,
} from "./warc.ts";
export { exportWarc } from "./warc.ts";
export type {
  WatchEntry,
  WatchEvent,
  WatchKind,
  WatchList,
  WatchOptions,
  WatchPending,
  WatchRun,
  WatchRunOptions,
  WatchRunnerOptions,
  WatchStop,
  WatchStoreOptions,
  WatchSummary,
} from "./watch.ts";
export { WATCH_LIMITS, WATCH_SCHEMA, WatchStore, runWatch } from "./watch.ts";
