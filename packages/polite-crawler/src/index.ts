/*
 * The root entry point is the crawler for Node.js. It exports these parts:
 *
 * - `openCrawler`, with its options and its results.
 * - The parts of the runtime that an application uses to build its own: `Crawler`, `CaptureLog`,
 *   `DocIndex`, `FileBlobStore`, `Extractors`, `fetchAndIndex`, `fetchPage` and `reindex`.
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
export type {
  CacheEntry,
  CacheIndex,
  CaptureWriter,
  CrawlerOptions,
  FetchOutcome,
  FetchRequest,
  Fetched,
  RenderRequest,
} from "./crawler.ts";
export { CAPTURE_SCHEMA, Crawler, DEFAULT_SECRET_PARAMS, renderedKey } from "./crawler.ts";
export type { Doc, DocInput, Found, Latest, Verified } from "./docs.ts";
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
export type { CaptureFilter, CaptureReader } from "./log.ts";
export { CaptureLog } from "./log.ts";
export type {
  Duration,
  FetchOptions,
  OpenOptions,
  PoliteCrawler,
  ReadResult,
  VerifyResult,
} from "./open.ts";
export { BOT_PAGE, DEFAULT_TOKEN, defaultUserAgent, durationMs, openCrawler } from "./open.ts";
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
export type { PlaywrightRenderer, RenderOptions, Renderer, Rendered } from "./render.ts";
export { NO_PLAYWRIGHT, RenderRefused, playwrightRenderer } from "./render.ts";
export type { Robots, RobotsDecision, RobotsGroup, RobotsRule, RobotsSignal } from "./robots.ts";
export { ALLOW_ALL, decide, parseRobots } from "./robots.ts";
export type { CapturePayload, CrawlRuntime, Extractor, PageResult } from "./runtime.ts";
export {
  Extractors,
  fetchAndIndex,
  fetchPage,
  pageDocId,
  pageExtractor,
  reindex,
  renderAndIndex,
} from "./runtime.ts";
export type { AiInput, Signals } from "./signals.ts";
export { bodyEncoding, decodeBody } from "./text.ts";
export { VERSION } from "./version.ts";
