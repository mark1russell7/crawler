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
 * - The archived fallback: the types of an archived copy, `archivedDocId` and `archiveExtractor`.
 * - Signed requests (Web Bot Auth): `createWebBotAuthSigner`, `keyDirectory` and `verifySignature`.
 *
 * The other entry points give the rest:
 *
 * - `polite-crawler/mcp` gives the MCP server. Only it loads the MCP SDK and `zod`.
 * - `polite-crawler/robots`, `/hours`, `/html`, `/classify`, `/politeness` and `/signals` give each
 *   reader whole. They import no Node.js module, so a browser can use them.
 */
export type { BlobStore } from "./blobs.ts";
export { FileBlobStore } from "./blobs.ts";
export { checkedRenderer } from "./browser.ts";
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
  DiscoverOptions,
  DiscoverResult,
  DiscoverRunOptions,
  DiscoverSource,
  DiscoverStop,
  DiscoveredUrl,
} from "./discover.ts";
export { DISCOVER_LIMITS, discoverSite } from "./discover.ts";
export type {
  Doc,
  DocInput,
  DocVersion,
  ExtractedDoc,
  FindIndexOptions,
  Found,
  Latest,
  RankMode,
  ReadingIndex,
  Variant,
  Verified,
  VersionText,
} from "./docs.ts";
export { DocIndex, FAST_RANK_SHARE, locate } from "./docs.ts";
export type { EgressOptions } from "./egress.ts";
export type { Archived, WebArchive } from "./fallback.ts";
export { archiveExtractor, archivedDocId } from "./fallback.ts";
export { EgressRefused, egressLookup } from "./egress.ts";
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
export type { Day, Hours, Interval, Week } from "./hours.ts";
export {
  DAYS,
  describeWeek,
  disagreements,
  fromCompact,
  fromSchemaOrg,
  fromText,
  toHoursWeek,
} from "./hours.ts";
export type { PageExtract, PageLink } from "./html.ts";
export { extractPage, typesOf } from "./html.ts";
export { SqliteHostStateStore } from "./hoststate.ts";
export type { CaptureFilter, CaptureReader, DamagedLine, ScanOptions } from "./log.ts";
export { CaptureLog } from "./log.ts";
export type {
  Duration,
  FetchOptions,
  FindOptions,
  OpenOptions,
  PoliteCrawler,
  ReadOptions,
  ReadResult,
  RuntimeOptions,
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
  pageDocId,
  pageExtractor,
  readDocument,
  recordOverride,
  reindex,
  renderAndIndex,
  verifyQuote,
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
