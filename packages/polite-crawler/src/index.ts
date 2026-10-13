/*
 * The root entry point is the crawler for Node.js. It exports these parts:
 *
 * - `openCrawler`, with its options and its results.
 * - The parts of the runtime that an application uses to build its own: `createRuntime`, `Crawler`,
 *   `CaptureLog`, `DocIndex`, `FileBlobStore`, `SqliteHostStateStore`, `Extractors`,
 *   `fetchAndIndex`, `fetchPage`, `reindex` and `catchUpIndex`.
 * - The read, the verification and the rule for a held-back page over a runtime: `readDocument`,
 *   `verifyQuote`, `findDocuments`, `isHeldBack`, `heldBackMeta` and `recordOverride`.
 * - The readers that an application uses with the runtime: pages, PDF files and opening hours.
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
export { CAPTURE_SCHEMA, Crawler, DEFAULT_SECRET_PARAMS, renderedKey } from "./crawler.ts";
export type {
  Doc,
  DocInput,
  DocVersion,
  ExtractedDoc,
  Found,
  Latest,
  ReadingIndex,
  Variant,
  Verified,
  VersionText,
} from "./docs.ts";
export { DocIndex, locate } from "./docs.ts";
export type { EgressOptions } from "./egress.ts";
export { EgressRefused, egressLookup } from "./egress.ts";
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
} from "./politeness.ts";
export { DEFAULT_POLICY, MemoryHostStateStore, realClock } from "./politeness.ts";
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
export { bodyEncoding, decodeBody } from "./text.ts";
export { VERSION } from "./version.ts";
