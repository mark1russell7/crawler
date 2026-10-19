/*
 * The API of 0.1.1 stays correct in each 0.1.x version. This file is the proof.
 *
 * - `pnpm typecheck` compiles this file. It implements and constructs the shapes of 0.1.1 with only
 *   the members that 0.1.1 had, the way an application of 0.1.1 did. A new required member of one
 *   of these types, or a change of a member, fails the typecheck.
 * - The tests then give these objects of 0.1.1 to the new code: a read at a time takes a
 *   `ReadingIndex` with no `versionAt`. polite-crawler-mcp proves that its MCP server takes a
 *   `PoliteCrawler` with no `discover`, `crawl`, `diff`, `watch` or `extract`.
 *
 * Do not add the new members of a later version here. Change this file only in a version that
 * breaks the API on purpose, and say so in CHANGELOG.md.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BlobStore,
  DocVersion,
  ExtractedDoc,
  Extractor,
  FetchOptions,
  FindOptions,
  Found,
  HostStateStore,
  OpenOptions,
  PageExtract,
  PageLink,
  PageResult,
  ReadOptions,
  ReadResult,
  ReadingIndex,
  ReindexResult,
  Renderer,
  VerifyOptions,
  VerifyResult,
} from "./index.ts";
import {
  DocIndex,
  Extractors,
  MemoryHostStateStore,
  RenderRefused,
  createRuntime,
  extractPage,
  readDocument,
} from "./index.ts";
import { removeDir, tempDir } from "./test-surfaces.ts";
import { htmlPage } from "./test-site.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// ── The shapes of 0.1.1 ──────────────────────────────────────────────────────

/** A reading index of 0.1.1 over a `DocIndex`: the members of `ReadingIndex` in 0.1.1, with no `versionAt`. */
const indexOf011 = (inner: DocIndex): ReadingIndex => ({
  get stale() {
    return inner.stale;
  },
  get: (doc) => inner.get(doc),
  upsert: (input, now) => inner.upsert(input, now),
  versions: (doc, options) => inner.versions(doc, options),
  versionText: (doc, capture) => inner.versionText(doc, capture),
  earlierTexts: (doc, options) => inner.earlierTexts(doc, options),
  docsOfCapture: (capture) => inner.docsOfCapture(capture),
  hasVersion: (capture) => inner.hasVersion(capture),
  find: (q, options) => inner.find(q, options),
  rankWithin: (q, docs, options) => inner.rankWithin(q, docs, options),
  latest: (url, variant) => inner.latest(url, variant),
  setLatest: (entry) => inner.setLatest(entry),
  newestFetch: () => inner.newestFetch(),
  counts: () => inner.counts(),
  beginRebuild: (options) => inner.beginRebuild(options),
});

/** A host state store of 0.1.1 with only its required members, so with no validator memo. */
const hostStateOf011 = (inner: MemoryHostStateStore): HostStateStore => ({
  reserve: (host, now, leaseMs) => inner.reserve(host, now, leaseMs),
  record: (host, result) => inner.record(host, result),
  release: (host, nextAt) => inner.release(host, nextAt),
  defer: (host, until) => inner.defer(host, until),
  stop: (host, until, reason) => inner.stop(host, until, reason),
  stopped: (host, now) => inner.stopped(host, now),
  reset: (host) => inner.reset(host),
});

const blobsOf011: BlobStore = {
  put: () => Promise.resolve({ hash: "0".repeat(64) }),
  get: () => Promise.resolve(undefined),
};

const rendererOf011: Renderer = {
  render: () => Promise.reject(new RenderRefused("browser", "this application has no browser")),
  close: () => Promise.resolve(),
};

const extractedOf011: ExtractedDoc = {
  doc: "menu:bakery",
  kind: "menu",
  title: "The menu",
  text: "focaccia, rye",
  url: "https://menu.example/menu.json",
  meta: {},
};
const extractorOf011: Extractor = () => [extractedOf011];

const link: PageLink = { href: "https://example.com/a", text: "a" };
/** The result of the page reader in 0.1.1: with no `feeds`. */
const extractOf011: PageExtract = {
  title: "Example",
  description: null,
  text: "Example text",
  jsonld: [],
  links: [link],
  lang: "en",
  visibleChars: 12,
  embedded: [],
  needsRender: false,
  renderReason: null,
  canonical: null,
  redirect: null,
  blocked: null,
  notes: [],
};

// The options of 0.1.1, with each member that 0.1.1 had.
const fetchOptions: FetchOptions = {
  render: "never",
  maxAge: "24h",
  onBehalfOf: ["Claude-User"],
  signal: new AbortController().signal,
  scope: "research",
  labels: { topic: "bread" },
};
const findOptions: FindOptions = { limit: 5, kind: "page", rank: "exact" };
const readOptions: ReadOptions = { from: 0, length: 100, userProvided: false, capture: "c1" };
const verifyOptions: VerifyOptions = { capture: "c1", userProvided: false };
const openOptions = (dir: string): OpenOptions => ({
  dir,
  contact: "ops@example.com",
  renderer: false,
  egress: { allowPrivate: true },
  hostState: hostStateOf011(new MemoryHostStateStore()),
  extractors: { menu: extractorOf011 },
  onBehalfOf: ["Claude-User"],
});

// The results of 0.1.1: an application constructs them in its own tests and mocks.
const pageOf011: PageResult = {
  url: "https://example.com/",
  doc: "url:https://example.com/",
  outcome: "ok",
  status: 200,
  title: "Example",
  chars: 12,
  rendered: false,
  structured: [],
  links: 1,
  captures: ["c1"],
  capture: "c1",
  capture_count: 1,
  fetched_at: "2026-10-01T00:00:00.000Z",
  from_cache: false,
  held_back: false,
  note: null,
};
const foundOf011: Found = {
  doc: "url:https://example.com/",
  kind: "page",
  title: "Example",
  url: "https://example.com/",
  snippet: "Example text",
  score: 1,
  ai_input: "unset",
  fetched_at: "2026-10-01T00:00:00.000Z",
  capture: "c1",
};
const readOf011: ReadResult = {
  doc: "url:https://example.com/",
  kind: "page",
  title: "Example",
  url: "https://example.com/",
  meta: {},
  from: 0,
  to: 12,
  total: 12,
  text: "Example text",
  captures: ["c1"],
  capture: "c1",
  fetched_at: "2026-10-01T00:00:00.000Z",
  ai_input: "unset",
  held_back: false,
  note: null,
};
const verifyOf011: VerifyResult = {
  doc: "url:https://example.com/",
  found: true,
  start: 0,
  end: 7,
  excerpt: "Example",
  url: "https://example.com/",
  captures: ["c1"],
  capture: "c1",
  blob: "b1",
  fetched_at: "2026-10-01T00:00:00.000Z",
  stale: false,
  in_full_text: false,
  complete: true,
  count: 1,
  held_back: false,
  note: null,
};
const versionOf011: DocVersion = {
  doc: "url:https://example.com/",
  capture: "c1",
  recipe: "page",
  rendered: false,
  fetched_at: "2026-10-01T00:00:00.000Z",
  blob: "b1",
  kind: "page",
  title: "Example",
  url: "https://example.com/",
  ai_input: "unset",
  chars: 12,
  cut: false,
};
const reindexOf011: ReindexResult = {
  captures: 1,
  docs: 1,
  urls: 1,
  failed: 0,
  missing: 0,
  damaged: 0,
  carried: 0,
  unknown_recipes: [],
  errors: [],
};

// ── The new code with the objects of 0.1.1 ───────────────────────────────────

describe("the API of 0.1.1", () => {
  it("constructs each shape of 0.1.1 with only its members of 0.1.1", () => {
    expect(extractOf011.links).toEqual([link]);
    // the page reader still gives each field of 0.1.1, and the feeds that it added
    const read = extractPage(htmlPage("Bakery"), "https://example.com/");
    expect(Object.keys(extractOf011).every((key) => key in read)).toBe(true);
    expect(read.feeds).toEqual([]);
    expect(
      [
        fetchOptions,
        findOptions,
        readOptions,
        verifyOptions,
        pageOf011,
        foundOf011,
        readOf011,
        verifyOf011,
        versionOf011,
        reindexOf011,
        blobsOf011,
        rendererOf011,
      ].length,
    ).toBe(12);
  });

  it("reads a version at a time through a ReadingIndex of 0.1.1, which has no versionAt", async () => {
    const dir = await tempDir("compat");
    cleanups.push(() => removeDir(dir));
    const inner = new DocIndex(join(dir, "own.sqlite"));
    cleanups.push(() => inner.close());
    const index = indexOf011(inner);
    expect("versionAt" in index).toBe(false);
    const runtime = createRuntime({ dir, index, renderer: false });
    cleanups.push(() => runtime.close());
    const doc = "url:https://example.com/";
    for (const [capture, at, text] of [
      ["c1", "2026-10-01T00:00:00.000Z", "The bakery opens at seven."],
      ["c2", "2026-10-03T00:00:00.000Z", "The bakery opens at eight."],
    ] as const) {
      index.upsert(
        {
          doc,
          kind: "page",
          title: "Bakery",
          text,
          url: "https://example.com/",
          meta: {},
          captures: [capture],
          capture,
          fetched_at: at,
          blob: capture,
        },
        at,
      );
    }
    const then = await readDocument(runtime, doc, { at: "2026-10-02T00:00:00.000Z" });
    expect(then).toMatchObject({ capture: "c1", text: "The bakery opens at seven." });
    const now = await readDocument(runtime, doc, {});
    expect(now).toMatchObject({ capture: "c2", text: "The bakery opens at eight." });
    expect("validators" in (openOptions(dir).hostState ?? {})).toBe(false);
  });

  it("lets an application register its own archive-copy extractor one time, as 0.1.1 did", () => {
    const extractors = new Extractors();
    const own: Extractor = () => [];
    extractors.register("archive-copy", own);
    expect(extractors.get("archive-copy")).toBe(own);
    expect(() => extractors.register("archive-copy", own)).toThrow("already has an extractor");
    expect(() => extractors.register("page", own)).toThrow("already has an extractor");
  });
});
