import type { BlobStore } from "./blobs.ts";
import type { Crawler, FetchRequest, Fetched, RenderRequest } from "./crawler.ts";
import type {
  Doc,
  DocInput,
  ExtractedDoc,
  Found,
  Latest,
  RankMode,
  ReadingIndex,
  Variant,
  VersionAt,
} from "./docs.ts";
import { locate } from "./docs.ts";
import type { PageExtract } from "./html.ts";
import { extractPage, typesOf } from "./html.ts";
import type { CaptureLog, CaptureReader } from "./log.ts";
import { isPdf, readPdf } from "./pdf.ts";
import type { CaptureRecord } from "./record.ts";
import { makeRecord } from "./record.ts";
import type { AiInput } from "./signals.ts";
import { decodeBody } from "./text.ts";
import { canonicalUrl } from "./urls.ts";
// ── archived fallback ──
import type { Archived } from "./fallback.ts";
import { archiveExtractor, archivedNote, archivedOf, archivedPage } from "./fallback.ts";
// ── end of archived fallback ──

/**
 * An extractor changes one captured body into the documents that it holds. It has no side effects,
 * so `reindex` can replay each capture through it and build the index again with no request. It can
 * answer later, because the crawler reads a PDF asynchronously.
 *
 * An extractor that throws does not stop a fetch, a render or a rebuild. The runtime records the
 * error and gives no document for that capture.
 */
export type Extractor = (
  body: Uint8Array,
  capture: { readonly url: string; readonly contentType: string | null },
) => ReadonlyArray<ExtractedDoc> | Promise<ReadonlyArray<ExtractedDoc>>;

/**
 * This function gives the document id of a web page. Each page has one id.
 *
 * This export is internal: the root entry point does not have it since 0.2.0.
 */
export const pageDocId = (url: string): string => `url:${canonicalUrl(url)}`;

/** The JSON-LD that a document keeps, in characters of JSON. */
const MAX_JSONLD_CHARS = 30_000;
/** These properties make a JSON-LD record large, and they say little about the place: they go first when a record is too large. */
const BULKY = [
  "review",
  "reviews",
  "comment",
  "hasMenu",
  "hasMenuSection",
  "hasMenuItem",
  "menu",
  "photo",
  "image",
  "subjectOf",
  "makesOffer",
  "hasOfferCatalog",
];
/** These properties say where and when a place is open. A record with one of them is kept first. */
const PLACE_KEYS = ["openingHours", "openingHoursSpecification", "address", "geo", "telephone"];

/**
 * This function keeps the JSON-LD records that fit the limit. A record with hours, an address or a
 * position goes first. A large record loses its reviews and its menu before it is left out. A
 * record that does not fit does not stop the records after it.
 */
const keepJsonLd = (
  records: readonly Record<string, unknown>[],
): { readonly kept: Record<string, unknown>[]; readonly dropped: number } => {
  const place = (record: Record<string, unknown>): boolean =>
    PLACE_KEYS.some((key) => record[key] !== undefined);
  const ordered = [...records.filter(place), ...records.filter((record) => !place(record))];
  const kept: Record<string, unknown>[] = [];
  let dropped = 0;
  let room = MAX_JSONLD_CHARS;
  for (const record of ordered) {
    let size = JSON.stringify(record).length;
    let candidate = record;
    if (size > room) {
      candidate = Object.fromEntries(
        Object.entries(record).filter(([key]) => !BULKY.includes(key)),
      );
      size = JSON.stringify(candidate).length;
    }
    if (size > room) {
      dropped += 1;
      continue;
    }
    kept.push(candidate);
    room -= size;
  }
  return { kept, dropped };
};

/**
 * This extractor is the built-in recipe for a web page, plain or rendered. It keeps the visible
 * text, the JSON-LD (whole objects, up to a limit) and the links. It decodes the body in the
 * encoding that the page declares, with `decodeBody`. It does not throw: a page that it cannot read
 * gives a document that names the error. When the reader cut the text, the document keeps the whole
 * text in `full_text`, so `verify` finds a quote past the cut.
 *
 * This export is internal: the root entry point does not have it since 0.2.0.
 */
export const pageExtractor: Extractor = (body, capture) => {
  if (isPdf(body, capture.contentType)) return pdfDocs(body, capture.url);
  if (capture.contentType !== null && !/html|xml/i.test(capture.contentType)) return [];
  const doc = pageDocId(capture.url);
  let page: PageExtract;
  try {
    page = extractPage(decodeBody(body, capture.contentType), capture.url);
  } catch (error) {
    // one page that breaks the reader must not break the fetch, or each later reindex
    return [
      {
        doc,
        kind: "page",
        title: capture.url,
        text: capture.url,
        url: capture.url,
        meta: {
          extract_error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        },
      },
    ];
  }
  const jsonld = keepJsonLd(page.jsonld);
  return [
    {
      doc,
      kind: "page",
      title: page.title,
      text: page.text.length > 0 ? page.text : page.title,
      url: capture.url,
      meta: {
        description: page.description,
        lang: page.lang,
        jsonld_types: [...new Set(page.jsonld.flatMap(typesOf))],
        jsonld: jsonld.kept,
        ...(jsonld.dropped > 0 ? { jsonld_dropped: jsonld.dropped } : {}),
        links: page.links.slice(0, 100),
        visible_chars: page.visibleChars,
        embedded: page.embedded,
        needs_render: page.needsRender,
        render_reason: page.renderReason,
        canonical: page.canonical,
        ...(page.feeds !== undefined && page.feeds.length > 0 ? { feeds: page.feeds } : {}),
        redirect: page.redirect,
        blocked: page.blocked,
        ...(page.notes.length > 0 ? { notes: page.notes } : {}),
      },
      ...(page.fullText !== undefined ? { full_text: page.fullText } : {}),
    },
  ];
};

const MAX_PDF_TEXT_CHARS = 200_000;

/**
 * This function changes a PDF into one document of its text. A PDF with no text, a scan for
 * example, gives a document of its title only, and the document says that it needs OCR. A damaged
 * file gives no document.
 */
const pdfDocs = async (body: Uint8Array, url: string): Promise<ReadonlyArray<ExtractedDoc>> => {
  let read;
  try {
    read = await readPdf(body, { maxChars: MAX_PDF_TEXT_CHARS });
  } catch {
    return [];
  }
  const file = new URL(url).pathname.split("/").pop() ?? "";
  let named = file;
  try {
    named = decodeURIComponent(file);
  } catch {
    // a malformed escape: the name as written
  }
  const title = read.title ?? (named || url);
  const notes = {
    ...(read.truncated ? { truncated: true } : {}),
    ...(read.note !== null ? { note: read.note } : {}),
  };
  if (read.text.length === 0) {
    return [
      {
        doc: pageDocId(url),
        kind: "pdf",
        title,
        text: title,
        url,
        meta: {
          format: "pdf",
          pages: read.pages,
          visible_chars: 0,
          // a file that a budget stopped is not a scan
          ocr_needed: read.note === null,
          ...notes,
        },
      },
    ];
  }
  return [
    {
      doc: pageDocId(url),
      kind: "pdf",
      title,
      text: read.text.slice(0, MAX_PDF_TEXT_CHARS),
      url,
      meta: { format: "pdf", pages: read.pages, visible_chars: read.text.length, ...notes },
    },
  ];
};

/** @beta */
export class Extractors {
  // the archived fallback reads its copies with the built-in recipe `archive-copy`
  private readonly byRecipe = new Map<string, Extractor>([
    ["page", pageExtractor],
    ["archive-copy", archiveExtractor],
  ]);

  // 0.1.1 let an application register `archive-copy`. Thus an application can replace that built-in once.
  private readonly replaceable = new Set(["archive-copy"]);

  register(recipe: string, extractor: Extractor): void {
    if (this.byRecipe.has(recipe) && !this.replaceable.delete(recipe)) {
      throw new Error(`recipe ${recipe} already has an extractor`);
    }
    this.byRecipe.set(recipe, extractor);
  }

  get(recipe: string): Extractor | undefined {
    return this.byRecipe.get(recipe);
  }

  /** This method gives the names of the recipes that have an extractor. */
  recipes(): string[] {
    return [...this.byRecipe.keys()];
  }
}

/** @beta */
export interface CrawlRuntime {
  readonly crawler: Crawler;
  /** This index keeps the documents and the cache entries. `DocIndex` is the SQLite index. */
  readonly index: ReadingIndex;
  readonly blobs: BlobStore;
  /** This reader is the read side of the capture log. The function `reindex` replays it. */
  readonly captures: CaptureReader;
  /** This log is the write side of the capture log. */
  readonly log: CaptureLog;
  readonly extractors: Extractors;
  readonly now: () => string;
}

/**
 * This is the payload of a capture record, as the crawler writes it.
 *
 * @beta
 */
export interface CapturePayload {
  readonly url: string;
  readonly recipe: string;
  readonly mode: "api" | "page";
  readonly status?: number;
  readonly outcome?: string;
  readonly blob?: string | null;
  readonly content_type?: string | null;
  readonly etag?: string | null;
  readonly last_modified?: string | null;
  readonly fetched_at: string;
  readonly signals?: { readonly ai_input?: AiInput };
  /** This value is true when the headless browser made the capture, not a plain request. */
  readonly rendered?: boolean;
  /** This value is true when the body is only the first part of the response. */
  readonly truncated?: boolean;
  /** This value is true when the server cut a compressed body. The capture is not a copy to keep. */
  readonly cut?: boolean;
  /** This value is true when an API answered with a web page that the request did not accept. The capture is not a copy to keep. */
  readonly unasked?: boolean;
  /** This time (ISO 8601) is the end of the freshness that the server gave. Captures before version 0.2 do not have it. */
  readonly fresh_until?: string | null;
  /** This text holds the request headers that the response varies on. Captures before version 0.2 do not have it. */
  readonly vary_key?: string | null;
  /** This URL is the target of a redirect, with its secrets as `REDACTED`. */
  readonly location?: string | null;
  readonly note?: string;
  /** This text is the byte range of a range request (`bytes=0-99`). The capture is a part of the resource, not its stored copy. */
  readonly range?: string;
}

/** The structural fields of the metadata of a page: they hold no text of the page. A held-back page shows only these. */
export const STRUCTURAL_META: readonly string[] = [
  "jsonld_types",
  "jsonld_dropped",
  "visible_chars",
  "lang",
  "embedded",
  "needs_render",
  "render_reason",
  "canonical",
  "redirect",
  "blocked",
  "format",
  "pages",
  "ocr_needed",
  "truncated",
  // the label of an archived copy holds no text of the page
  "archived",
  "archived_kind",
];

/**
 * The note of a document that is held back.
 *
 * @beta
 */
export const HELD_BACK =
  "This page asked not to be used as AI input, so its text is held back. Open the URL to read it, or read again with userProvided when a person gave this URL directly (the crawler logs that).";

/**
 * This function tells if a document is held back: the page asked not to be AI input, and no person
 * gave its URL directly. The only way to read a held-back document is `userProvided`.
 *
 * @beta
 */
export const isHeldBack = (doc: { readonly ai_input: AiInput }, userProvided = false): boolean =>
  doc.ai_input === "no" && !userProvided;

/**
 * This function gives the metadata that a held-back document shows: only the structural fields, which hold no text of the page.
 *
 * @beta
 */
export const heldBackMeta = (meta: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(meta).filter(([key]) => STRUCTURAL_META.includes(key)));

const messageOf = (error: unknown): string =>
  error instanceof Error ? (error.message.split(/\r?\n/)[0] ?? "") : String(error);

/** This function tells which bot check or firewall sent its page in place of the content, or gives undefined. */
const blockedBy = (doc: ExtractedDoc): string | undefined => {
  const blocked = doc.meta["blocked"];
  return typeof blocked === "string" && blocked.length > 0 ? blocked : undefined;
};

/**
 * The result of `fetchAndIndex` and `renderAndIndex`.
 *
 * @beta
 */
export interface Indexed {
  readonly fetched: Fetched;
  readonly docs: readonly Doc[];
  /** This text tells why the capture gave no document: the error of the extractor, or a bot check. */
  readonly error?: string | undefined;
  /** This value names the bot check or the firewall that sent its page in place of the content. */
  readonly blocked?: string | undefined;
}

/** This function reads one capture with its extractor, and adds each document to the index as a version of the capture. */
const indexCapture = async (
  runtime: CrawlRuntime,
  fetched: Fetched,
  recipe: string,
  rendered: boolean,
): Promise<Omit<Indexed, "fetched">> => {
  const capture = fetched.capture;
  if (fetched.body === undefined || capture === undefined) return { docs: [] };
  // a stored capture that the index already read gives its documents with no new reading
  if (fetched.fromCache) {
    const known = runtime.index.docsOfCapture(capture);
    if (known.length > 0) return { docs: known };
  }
  const extractor = runtime.extractors.get(recipe);
  if (extractor === undefined) return { docs: [] };
  let extracted: ReadonlyArray<ExtractedDoc>;
  try {
    extracted = await extractor(fetched.body, {
      url: fetched.url,
      contentType: rendered ? "text/html; charset=utf-8" : (fetched.contentType ?? null),
    });
  } catch (error) {
    return { docs: [], error: `extract failed (${recipe}): ${messageOf(error)}` };
  }
  const blocked = extracted.map(blockedBy).find((name) => name !== undefined);
  if (blocked !== undefined) {
    // a bot check is not the content: the index keeps the earlier text, and the host stops
    runtime.crawler.reportBlocked(fetched.url, blocked);
    return {
      docs: [],
      blocked,
      error: `the page is a bot check (${blocked}), not the content, so the crawler keeps nothing of it and stops the host`,
    };
  }
  const now = runtime.now();
  const docs = extracted.map((doc) =>
    runtime.index.upsert(
      {
        ...doc,
        captures: [capture],
        capture,
        fetched_at: fetched.fetchedAt ?? now,
        blob: fetched.blob ?? null,
        recipe,
        rendered,
        // an extractor can find a "no" in the body (the headers of an archived response), never a "yes"
        ai_input: doc.ai_input === "no" ? "no" : fetched.signals.ai_input,
        ...(fetched.scope !== undefined ? { scope: fetched.scope } : {}),
        ...(fetched.labels !== undefined ? { labels: fetched.labels } : {}),
      },
      now,
    ),
  );
  return { docs };
};

/**
 * This function fetches one URL and adds its documents to the index. Each recipe uses it. A fetch
 * from the cache gives the documents that the index has for that capture. Thus a repeated
 * question sends no request and reads nothing again. An extractor that throws gives no document and an
 * `error`, and the fetch still succeeds.
 *
 * @beta
 */
export const fetchAndIndex = async (
  runtime: CrawlRuntime,
  request: FetchRequest,
): Promise<Indexed> => {
  const fetched = await runtime.crawler.fetch(request);
  if (fetched.outcome !== "ok" && fetched.outcome !== "not-modified") return { fetched, docs: [] };
  return { fetched, ...(await indexCapture(runtime, fetched, request.recipe, false)) };
};

/**
 * This function renders a page in the headless browser and adds what the page shows to the index.
 *
 * This export is internal: the root entry point does not have it since 0.2.0.
 */
export const renderAndIndex = async (
  runtime: CrawlRuntime,
  request: RenderRequest,
): Promise<Indexed> => {
  const fetched = await runtime.crawler.render(request);
  if (fetched.outcome !== "ok") return { fetched, docs: [] };
  return { fetched, ...(await indexCapture(runtime, fetched, request.recipe, true)) };
};

export interface PageResult {
  readonly url: string;
  readonly doc: string | null;
  readonly outcome: string;
  readonly status: number;
  /** This value is the title of the page. A held-back page shows no title. */
  readonly title: string | null;
  readonly chars: number;
  readonly rendered: boolean;
  /** These are the schema.org types that the JSON-LD of the page declares. */
  readonly structured: readonly string[];
  readonly links: number;
  /** These ids are the captures behind the current text, the newest first, 10 or fewer. */
  readonly captures: readonly string[];
  /** This id is the capture of the text that the document shows. A citation names it. */
  readonly capture: string | null;
  /** This value is the number of captures of the document. */
  readonly capture_count: number;
  /** This time (ISO 8601) is the fetch time of the text that the document shows. */
  readonly fetched_at: string | null;
  /** This value is true when the stored copy answered, and the crawler sent no request. */
  readonly from_cache: boolean;
  /** This value is true when the page asked not to be AI input. Its title and text are then held back. */
  readonly held_back: boolean;
  readonly note: string | null;
  /**
   * This value tells that the document is an archived copy, not a fresh fetch: the archive, the date
   * of the copy and its URL there. The outcome and the status stay those of the live fetch.
   */
  readonly archived?: Archived | undefined;
}

/**
 * These options control one page.
 *
 * @beta
 */
export interface PageOptions {
  readonly render: "auto" | "never" | "always";
  readonly maxAgeMs?: number | "auto" | undefined;
  readonly onBehalfOf?: readonly string[] | undefined;
  readonly job?: string | undefined;
  /** When this signal aborts, the crawler stops the fetch and the render. */
  readonly signal?: AbortSignal | undefined;
  readonly scope?: string | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
  /** This time (milliseconds since the epoch) is the end of a budget. No request of the page starts at or after it (`FetchRequest.deadline`). */
  readonly deadline?: number | undefined;
  // ── archived fallback ──
  /** The value `archive` gives a copy from a public web archive when the site refuses the page, or is down. The default is `none`. */
  readonly fallback?: "archive" | "none" | undefined;
  /** The value true also gives an archived copy of a page that the current robots.txt of its site disallows. The default is false. */
  readonly archiveDespiteRobots?: boolean | undefined;
  // ── end of archived fallback ──
}

const HTML_TYPE = /html|xml/i;

/**
 * This function reads one web page. It first sends a plain request. It opens the browser only when
 * the page shows almost nothing without JavaScript, or when the caller asks for it. It renders
 * only an HTML page: not a PDF, a different file or a bot check. A page that sends the reader on
 * with a `<meta http-equiv="refresh">` gets one more plain fetch, of its target.
 *
 * @beta
 */
export const fetchPage = async (
  runtime: CrawlRuntime,
  url: string,
  options: PageOptions,
): Promise<PageResult> => {
  const plainRequest = (target: string): FetchRequest => ({
    url: target,
    mode: "page",
    recipe: "page",
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    maxAgeMs: options.maxAgeMs,
    onBehalfOf: options.onBehalfOf,
    job: options.job,
    signal: options.signal,
    scope: options.scope,
    labels: options.labels,
    deadline: options.deadline,
  });
  let plain = await fetchAndIndex(runtime, plainRequest(url));
  const notes: string[] = [];
  if (plain.error !== undefined) notes.push(plain.error);
  const target = plain.docs[0]?.meta["redirect"];
  if (typeof target === "string" && target.length > 0 && plain.blocked === undefined) {
    const followed = await fetchAndIndex(runtime, plainRequest(target));
    notes.push(
      `the page sends the reader on to ${followed.fetched.url}, so the crawler fetched that page`,
    );
    if (followed.error !== undefined) notes.push(followed.error);
    plain = followed;
  }
  let docs = plain.docs;
  let rendered = false;
  let fromCache = plain.fetched.fromCache;
  const reachable = plain.fetched.outcome === "ok" || plain.fetched.outcome === "not-modified";
  const first = docs[0];
  const html =
    first?.kind === "page" &&
    (plain.fetched.contentType === undefined || HTML_TYPE.test(plain.fetched.contentType));
  const wanted =
    options.render === "always" ||
    (options.render === "auto" && first?.meta["needs_render"] === true);
  if (reachable && wanted) {
    if (plain.blocked !== undefined) notes.push("the crawler does not render a bot check");
    else if (first === undefined || !html) {
      notes.push("the crawler renders only an HTML page, not a PDF or a different file");
    } else {
      // a render of an earlier body is not the page now: the render is fresh when the plain body changed
      const current = runtime.index.get(first.doc);
      const stale = current !== undefined && !current.rendered && current.capture_count > 1;
      const shown = await renderAndIndex(runtime, {
        url: plain.fetched.url,
        recipe: "page",
        maxAgeMs: stale ? 0 : options.maxAgeMs,
        onBehalfOf: options.onBehalfOf,
        job: options.job,
        signal: options.signal,
        scope: options.scope,
        labels: options.labels,
        deadline: options.deadline,
      });
      if (shown.docs.length > 0) {
        docs = shown.docs;
        rendered = true;
        fromCache = fromCache && shown.fetched.fromCache;
      } else {
        notes.push(shown.error ?? shown.fetched.note ?? "the render gave no document");
      }
    }
  }
  // ── archived fallback: a refusal can get a copy from a web archive, clearly marked ──
  if (options.fallback === "archive" && docs.length === 0) {
    const fallback = await archivedPage(runtime, url, plain, options);
    if (fallback.page !== undefined) return fallback.page;
    notes.push(...fallback.notes);
  }
  // ── end of archived fallback ──
  const doc = docs[0] === undefined ? undefined : (runtime.index.get(docs[0].doc) ?? docs[0]);
  const held = doc !== undefined && isHeldBack(doc);
  const types = doc?.meta["jsonld_types"];
  const links = doc?.meta["links"];
  if (held) notes.push(HELD_BACK);
  const note = [plain.fetched.note, ...notes].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return {
    url,
    doc: doc?.doc ?? null,
    outcome: plain.fetched.outcome,
    status: plain.fetched.status,
    title: doc === undefined || held ? null : doc.title,
    chars: doc?.text.length ?? 0,
    rendered: doc?.rendered ?? rendered,
    structured: Array.isArray(types) ? (types as string[]) : [],
    links: Array.isArray(links) ? links.length : 0,
    captures: doc === undefined ? [] : [...doc.captures],
    capture: doc?.capture ?? null,
    capture_count: doc?.capture_count ?? 0,
    fetched_at: doc?.fetched_at ?? plain.fetched.fetchedAt ?? null,
    from_cache: fromCache,
    held_back: held,
    note: note.length > 0 ? note.join("; ") : null,
  };
};

// ── reading, verifying and finding ──────────────────────────────────────────

/** This result is a part of one stored document. */
export interface ReadResult {
  readonly doc: string;
  readonly kind: string;
  /** This value is the title of the document. A held-back document shows no title. */
  readonly title: string;
  readonly url: string | null;
  /** This value is the metadata of the document. A held-back document shows only the structural fields. */
  readonly meta: Readonly<Record<string, unknown>>;
  readonly from: number;
  readonly to: number;
  readonly total: number;
  readonly text: string;
  readonly captures: readonly string[];
  /** This id is the capture of the text that the result reads. */
  readonly capture: string;
  /** This time (ISO 8601) is the fetch time of the text that the result reads. */
  readonly fetched_at: string;
  readonly ai_input: AiInput;
  /** This value is true when the page asked not to be AI input. The text is then empty. */
  readonly held_back: boolean;
  readonly note: string | null;
  /** This time (ISO 8601) is the `at` of the read. The result has it only when the read gave `at`. */
  readonly at?: string | undefined;
  /**
   * This value is true when `at` is before the first capture of the document. Then no version
   * answers: the text, the title, `capture` and `fetched_at` are empty, and the note tells why.
   */
  readonly before_first?: boolean | undefined;
  /** This value tells that the text is an archived copy, with the archive and the date of the copy. */
  readonly archived?: Archived | undefined;
}

/** This result tells if a quote is in a stored document, and where. */
export interface VerifyResult {
  readonly doc: string;
  /** This value is true when the quote is in the text. A held-back document gives false. */
  readonly found: boolean;
  /** These values are the positions of the quote in the text of `capture`. */
  readonly start: number | null;
  readonly end: number | null;
  readonly excerpt: string | null;
  readonly url: string | null;
  readonly captures: readonly string[];
  /** This id is the capture whose text holds the quote, or the capture that the result examined. */
  readonly capture: string | null;
  /** This hash is the blob of that capture. */
  readonly blob: string | null;
  /** This time (ISO 8601) is the fetch time of that capture. */
  readonly fetched_at: string | null;
  /** This value is true when only an earlier version of the document holds the quote. */
  readonly stale: boolean;
  /** This value is true when the quote is in the whole text of a page that the reader cut. The positions are then in that whole text. */
  readonly in_full_text: boolean;
  /** This value is false when the examined text is not complete (a PDF that the reader stopped). A quote that is not found can then be in the file. */
  readonly complete: boolean;
  /** This value is the number of places where the quote is. */
  readonly count: number;
  readonly held_back: boolean;
  readonly note: string | null;
  /** This time (ISO 8601) is the `at` of the verification. The result has it only when the verification gave `at`. */
  readonly at?: string | undefined;
  /** This value is true when `at` is before the first capture of the document. Then no version holds the quote, and the note tells why. */
  readonly before_first?: boolean | undefined;
  /**
   * This value tells that the examined text is an archived copy, with the archive and the date of
   * the copy. A citation of it names the archive and that date, not a date of a fresh fetch.
   */
  readonly archived?: Archived | undefined;
}

/** These options control a read. */
export interface ReadOptions {
  /** This value is the first character to read. The default is 0. */
  readonly from?: number | undefined;
  /** This value is the number of characters to read. The default is 4000. */
  readonly length?: number | undefined;
  /** This value is true when a person gave this URL directly. It is the only way to read a held-back document. The crawler logs it. */
  readonly userProvided?: boolean | undefined;
  /** This id reads the version of one capture, not the current version. */
  readonly capture?: string | undefined;
  /**
   * This time reads the version that was current at that time: an ISO 8601 text or a `Date`. A
   * date with no time is the start of that day in UTC. Give `capture` or `at`, not the two.
   */
  readonly at?: string | Date | undefined;
}

/** These options control a verification. */
export interface VerifyOptions {
  /** This id examines the version of one capture only. A citation of that capture thus stays true after a new fetch. */
  readonly capture?: string | undefined;
  /** This value is true when a person gave this URL directly. It is the only way to verify a quote in a held-back document. */
  readonly userProvided?: boolean | undefined;
  /** This time examines only the version that was current at that time (`ReadOptions.at`). Give `capture` or `at`, not the two. */
  readonly at?: string | Date | undefined;
}

const knownDoc = (runtime: CrawlRuntime, id: string): Doc => {
  const doc = runtime.index.get(id);
  if (doc === undefined)
    throw new Error(`no stored document ${id}: find one with find(), or fetch its page`);
  return doc;
};

// ── time travel ─────────────────────────────────────────────────────────────

/**
 * This function gives the ISO 8601 form of a time. A text that is not a time throws a `RangeError`.
 * A date with no time is the start of that day in UTC.
 */
export const isoTime = (name: string, value: string | Date): string => {
  const ms =
    value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) {
    throw new RangeError(
      `${name} must be a time, such as 2026-10-01T12:00:00Z, not ${JSON.stringify(String(value))}`,
    );
  }
  return new Date(ms).toISOString();
};

/**
 * This function gives the version of a document that was current at a time (ISO 8601). It uses
 * `ReadingIndex.versionAt` when the index has it. Else it takes the newest version at or before
 * the time.
 *
 * @beta
 */
export const versionAtTime = (runtime: CrawlRuntime, id: string, at: string): VersionAt => {
  const index = runtime.index;
  if (index.versionAt !== undefined) return index.versionAt(id, at);
  const all = index.versions(id, { limit: 1_000_000 });
  const pick = all.find((version) => version.fetched_at <= at);
  return {
    version: pick === undefined ? undefined : index.versionText(id, pick.capture),
    first: all.at(-1)?.fetched_at,
  };
};

/** This function gives the note of a time before the first version of a document. */
const beforeFirstNote = (id: string, at: string, first: string | undefined): string =>
  `the document ${id} has no version at ${at} or before${first === undefined ? "" : `: its first capture is from ${first}`}`;

/** This function gives the time of `at`, or undefined. It refuses `capture` and `at` together. */
const atOf = (options: {
  readonly capture?: string | undefined;
  readonly at?: string | Date | undefined;
}): string | undefined => {
  if (options.at === undefined) return undefined;
  if (options.capture !== undefined)
    throw new RangeError("give capture or at, not the two: each one chooses a version");
  return isoTime("at", options.at);
};

// ── end of time travel ──────────────────────────────────────────────────────

const wholeNumber = (name: string, value: number | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a number of 0 or more, not ${String(value)}`);
  }
  return Math.floor(value);
};

/** This function moves a position off the second half of a surrogate pair, so a slice does not cut a character. */
const onBoundary = (text: string, position: number): number => {
  const code = text.charCodeAt(position);
  return position > 0 && position < text.length && code >= 0xdc00 && code <= 0xdfff
    ? position - 1
    : position;
};

/**
 * This function writes an `override` record to the capture log. A person gave the URL of a
 * held-back document directly, and the hold stops for one action (`read` or `verify`). The record
 * takes the scope and the labels of `marks`, or else those of the document, as its captures do.
 *
 * @beta
 */
export const recordOverride = async (
  runtime: CrawlRuntime,
  doc: {
    readonly doc: string;
    readonly url: string | null;
    readonly scope?: string | undefined;
    readonly labels?: Readonly<Record<string, string>> | undefined;
  },
  action: string,
  marks: {
    readonly scope?: string | undefined;
    readonly labels?: Readonly<Record<string, string>> | undefined;
  } = {},
): Promise<void> => {
  const at = runtime.now();
  const scope = marks.scope ?? doc.scope;
  const labels = marks.labels ?? doc.labels;
  await runtime.log.append(
    makeRecord({
      source: "fetch",
      kind: "override",
      payload: { doc: doc.doc, url: doc.url, action, reason: "a person provided this URL", at },
      received_at: at,
      external_id: doc.url ?? doc.doc,
      ...(scope !== undefined ? { scope } : {}),
      ...(labels !== undefined ? { labels } : {}),
    }),
  );
};

/**
 * This function reads a range of characters of one stored document. It applies the rule for a
 * held-back document: no title, no text, and only the structural metadata, unless `userProvided`.
 * The positions do not cut a character in two.
 *
 * @beta
 */
export const readDocument = async (
  runtime: CrawlRuntime,
  id: string,
  options: ReadOptions = {},
): Promise<ReadResult> => {
  const from = wholeNumber("from", options.from, 0);
  const length = wholeNumber("length", options.length, 4000);
  const at = atOf(options);
  const doc = knownDoc(runtime, id);
  let version =
    options.capture === undefined ? undefined : runtime.index.versionText(id, options.capture);
  if (options.capture !== undefined && version === undefined) {
    throw new Error(`the document ${id} has no version from the capture ${options.capture}`);
  }
  const timed = at === undefined ? {} : { at, before_first: false };
  if (at !== undefined) {
    const found = versionAtTime(runtime, id, at);
    if (found.version === undefined) {
      // no version answers, so there is no text to hold back
      return {
        doc: doc.doc,
        kind: doc.kind,
        title: "",
        url: doc.url,
        meta: {},
        from: 0,
        to: 0,
        total: 0,
        text: "",
        captures: doc.captures,
        capture: "",
        fetched_at: "",
        ai_input: doc.ai_input,
        held_back: false,
        note: beforeFirstNote(id, at, found.first),
        at,
        before_first: true,
      };
    }
    version = found.version;
  }
  const aiInput: AiInput =
    doc.ai_input === "no" || version?.ai_input === "no"
      ? "no"
      : (version?.ai_input ?? doc.ai_input);
  const userProvided = options.userProvided ?? false;
  const held = isHeldBack({ ai_input: aiInput }, userProvided);
  if (aiInput === "no" && userProvided) await recordOverride(runtime, doc, "read");
  const text = version?.text ?? doc.text;
  const start = onBoundary(text, Math.min(from, text.length));
  const end = held ? start : onBoundary(text, Math.min(text.length, start + length));
  const meta = version?.meta ?? doc.meta;
  // ── archived fallback: an archived copy says so in each read ──
  const archived = archivedOf(meta);
  const notes = [...(held ? [HELD_BACK] : []), ...(archived ? [archivedNote(archived)] : [])];
  return {
    doc: doc.doc,
    kind: version?.kind ?? doc.kind,
    title: held ? "" : (version?.title ?? doc.title),
    url: version?.url ?? doc.url,
    meta: held ? heldBackMeta(meta) : meta,
    from: start,
    to: end,
    total: text.length,
    text: held ? "" : text.slice(start, end),
    captures: doc.captures,
    capture: version?.capture ?? doc.capture,
    fetched_at: version?.fetched_at ?? doc.fetched_at,
    ai_input: aiInput,
    held_back: held,
    note: notes.length > 0 ? notes.join(" ") : null,
    ...timed,
    ...(archived !== undefined ? { archived } : {}),
  };
};

// ── archived fallback: the labels of an archived copy ──

/** This function gives the `archived` field of a result, for the metadata of an archived copy. */
const archivedField = (
  meta: Readonly<Record<string, unknown>>,
): { readonly archived?: Archived } => {
  const archived = archivedOf(meta);
  return archived === undefined ? {} : { archived };
};

/** This function gives the `archived` field and the note of a result: the note of an archived copy goes after the other note. */
const withArchived = (
  meta: Readonly<Record<string, unknown>>,
  note: string | null,
): { readonly note: string | null; readonly archived?: Archived } => {
  const archived = archivedOf(meta);
  if (archived === undefined) return { note };
  const said = archivedNote(archived);
  return { note: note === null ? said : `${note}; ${said}`, archived };
};

// ── end of archived fallback ──

/**
 * This function examines the versions of a document for a quote, and writes nothing. It also tells
 * if `userProvided` opened a held-back version, so that `verifyQuote` logs the override.
 */
const examineQuote = (
  runtime: CrawlRuntime,
  id: string,
  quote: string,
  options: VerifyOptions,
): { readonly result: VerifyResult; readonly override: boolean } => {
  const at = atOf(options);
  const doc = knownDoc(runtime, id);
  let pinned =
    options.capture === undefined ? undefined : runtime.index.versionText(id, options.capture);
  if (options.capture !== undefined && pinned === undefined) {
    throw new Error(`the document ${id} has no version from the capture ${options.capture}`);
  }
  const userProvided = options.userProvided ?? false;
  const base = { doc: doc.doc, url: doc.url, captures: doc.captures };
  const timed = at === undefined ? {} : { at, before_first: false };
  const nothing = {
    found: false,
    start: null,
    end: null,
    excerpt: null,
    capture: null,
    blob: null,
    fetched_at: null,
    stale: false,
    in_full_text: false,
    count: 0,
  } as const;
  if (at !== undefined) {
    // the version that was current at the time is the only version that the check examines
    const found = versionAtTime(runtime, id, at);
    if (found.version === undefined) {
      const result: VerifyResult = {
        ...base,
        ...nothing,
        complete: true,
        held_back: false,
        note: beforeFirstNote(id, at, found.first),
        at,
        before_first: true,
      };
      return { result, override: false };
    }
    pinned = found.version;
  }
  const aiInput: AiInput = doc.ai_input === "no" || pinned?.ai_input === "no" ? "no" : doc.ai_input;
  if (isHeldBack({ ai_input: aiInput }, userProvided)) {
    const result: VerifyResult = {
      ...base,
      ...nothing,
      complete: false,
      held_back: true,
      note: HELD_BACK,
      ...timed,
      ...archivedField(pinned?.meta ?? doc.meta),
    };
    return { result, override: false };
  }
  const current = pinned ?? runtime.index.versionText(id);
  const candidates =
    pinned !== undefined
      ? [pinned]
      : [...(current === undefined ? [] : [current]), ...runtime.index.earlierTexts(id)];
  // a version that asked not to be AI input stays held back after the page drops the signal
  const held = candidates.filter((version) => version.ai_input === "no").length;
  const override = userProvided && (aiInput === "no" || held > 0);
  for (const [index, version] of candidates.entries()) {
    if (isHeldBack(version, userProvided)) continue;
    let hit = locate(version.text, quote);
    let inFull = false;
    if (!hit.found && version.full_text !== undefined) {
      hit = locate(version.full_text, quote);
      inFull = hit.found;
    }
    if (!hit.found) continue;
    const stale = pinned === undefined && index > 0;
    const result: VerifyResult = {
      ...base,
      found: true,
      start: hit.start,
      end: hit.end,
      excerpt: hit.excerpt,
      capture: version.capture,
      blob: version.blob,
      fetched_at: version.fetched_at,
      stale,
      in_full_text: inFull,
      complete: true,
      count: hit.count,
      held_back: false,
      ...withArchived(
        version.meta,
        stale ? "only an earlier capture of the document holds the quote" : null,
      ),
      ...timed,
    };
    return { result, override };
  }
  const incomplete =
    current !== undefined && current.meta["truncated"] === true && current.full_text === undefined;
  // the note does not depend on the quote, so it tells nothing about the held-back text
  const notes = [
    ...(incomplete
      ? [
          "the reader stopped before the end of the file, so the quote can be in the part that it did not read",
        ]
      : []),
    ...(held > 0 && !userProvided
      ? [`the check did not examine the versions that asked not to be AI input (${String(held)})`]
      : []),
  ];
  const result: VerifyResult = {
    ...base,
    found: false,
    start: null,
    end: null,
    excerpt: null,
    capture: current?.capture ?? null,
    blob: current?.blob ?? null,
    fetched_at: current?.fetched_at ?? null,
    stale: false,
    in_full_text: false,
    complete: !incomplete,
    count: 0,
    held_back: false,
    ...withArchived(current?.meta ?? doc.meta, notes.length > 0 ? notes.join("; ") : null),
    ...timed,
  };
  return { result, override };
};

/**
 * This function finds a quote in a stored document, with `locate`, and writes nothing. It is the
 * synchronous part of `verifyQuote`. A held-back document gives `found: false` and no positions,
 * unless `userProvided`, and this function does not log the override. With no capture, it does not
 * examine a version that asked not to be AI input, also when a later capture dropped the signal.
 */
export const checkQuote = (
  runtime: CrawlRuntime,
  id: string,
  quote: string,
  options: VerifyOptions = {},
): VerifyResult => examineQuote(runtime, id, quote, options).result;

/**
 * This function finds a quote in a stored document, with `locate`. It tells which capture holds the
 * quote, with its blob, its fetch time and the positions:
 *
 * - With `capture`, it examines the version of that capture only.
 * - With no capture, it examines the current text first. When the quote is not there, it examines
 *   the earlier texts, the newest first. A match there has `stale: true`.
 * - When the reader cut a text, it also examines the whole text.
 *
 * A held-back document gives `found: false` and no positions, so a quote cannot test its text,
 * unless `userProvided`. The same rule applies to each version. A version that asked not to be AI
 * input stays held back after a later capture drops the signal. The crawler logs an override when
 * `userProvided` opens a held-back version.
 *
 * @beta
 */
export const verifyQuote = async (
  runtime: CrawlRuntime,
  id: string,
  quote: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> => {
  const { result, override } = examineQuote(runtime, id, quote, options);
  if (override) await recordOverride(runtime, knownDoc(runtime, id), "verify");
  return result;
};

/**
 * This function searches the stored documents. The syntax of the query is the syntax of
 * `parseQuery`. A held-back document is not in the results. The option `rank` chooses the
 * ranking (`RankMode`), and the default is `exact`.
 *
 * @beta
 */
export const findDocuments = async (
  runtime: CrawlRuntime,
  q: string,
  options: {
    readonly limit?: number | undefined;
    readonly kind?: string | null | undefined;
    readonly rank?: RankMode | undefined;
  } = {},
): Promise<Found[]> => {
  await Promise.resolve();
  const found = runtime.index.find(q, {
    limit: options.limit ?? 10,
    kind: options.kind ?? null,
    ...(options.rank !== undefined ? { rank: options.rank } : {}),
  });
  // ── archived fallback: a hit of an archived copy says so ──
  return found.map((hit) => {
    if (hit.kind !== "archived") return hit;
    const meta = runtime.index.get(hit.doc)?.meta;
    return meta === undefined ? hit : { ...hit, ...archivedField(meta) };
  });
};

// ── the rebuild ─────────────────────────────────────────────────────────────

/** The counts of a rebuild. */
export interface ReindexResult {
  /** This value is the number of captures that the rebuild read again. */
  readonly captures: number;
  readonly docs: number;
  readonly urls: number;
  /** This value is the number of captures whose extractor threw. */
  readonly failed: number;
  /** This value is the number of captures whose blob is missing or damaged. */
  readonly missing: number;
  /** This value is the number of damaged lines of the log that the rebuild skipped. */
  readonly damaged: number;
  /** This value is the number of documents of recipes with no extractor, kept from the old index. */
  readonly carried: number;
  /** These recipes have captures in the log and no extractor in this runtime. */
  readonly unknown_recipes: readonly string[];
  /** These are the first errors of the extractors. */
  readonly errors: ReadonlyArray<{ readonly capture: string; readonly error: string }>;
}

const RENDERED_MARK = "#rendered";
const MAX_ERRORS = 20;
/**
 * The crawler reads the captures of these recipes for itself. They are robots.txt, the sitemaps
 * and feeds of `discover`, and the indexes of the web archives. They give no document.
 */
const CRAWLER_RECIPES: ReadonlySet<string> = new Set([
  "robots.txt",
  "sitemap",
  "feed",
  "archive-index",
]);

/** This function gives the URL of a capture and its variant. A URL of version 0.1 can end in `#rendered`. */
const captureTarget = (
  payload: CapturePayload,
): { readonly url: string; readonly variant: Variant } => {
  if (payload.url.endsWith(RENDERED_MARK)) {
    return { url: payload.url.slice(0, -RENDERED_MARK.length), variant: "rendered" };
  }
  return { url: payload.url, variant: payload.rendered === true ? "rendered" : "plain" };
};

/** A replay writes into a new generation of the index (a rebuild), or into the index itself (the tail of the log). */
interface ReplayTarget {
  upsert(input: DocInput, now: string): unknown;
  setLatest(entry: Latest): void;
  latest(url: string, variant?: Variant): Latest | undefined;
}

/** These are the counts of a replay. */
interface ReplayTally {
  captures: number;
  failed: number;
  missing: number;
  readonly unknown: Set<string>;
  readonly errors: Array<{ readonly capture: string; readonly error: string }>;
}

const newTally = (): ReplayTally => ({
  captures: 0,
  failed: 0,
  missing: 0,
  unknown: new Set(),
  errors: [],
});

/** This function replays the cache entry of one capture, as the crawler made it at the time of the fetch. */
const replayLatest = (
  build: ReplayTarget,
  envelope: CaptureRecord,
  payload: CapturePayload,
): void => {
  const { url, variant } = captureTarget(payload);
  const fetchedAt = payload.fetched_at ?? envelope.received_at;
  if (payload.outcome === "redirect") {
    const location =
      payload.location ??
      (typeof payload.note === "string" && payload.note.startsWith("location ")
        ? payload.note.slice(9)
        : null);
    const permanent = payload.status === 301 || payload.status === 308;
    if (location !== null && (permanent || typeof payload.fresh_until === "string")) {
      build.setLatest({
        url,
        variant,
        capture: envelope.id,
        blob: null,
        etag: null,
        last_modified: null,
        content_type: null,
        fetched_at: fetchedAt,
        status: payload.status ?? 301,
        ai_input: "unset",
        location,
        fresh_until: payload.fresh_until ?? null,
        vary_key: payload.vary_key ?? null,
      });
    }
    return;
  }
  // a body that the server cut, a web page in place of the data of an API, or a part of a resource
  // from a range request was never the stored copy
  if (payload.cut === true || payload.unasked === true || payload.range !== undefined) return;
  const previous = build.latest(url, variant);
  const revisit = envelope.kind === "revisit" || payload.outcome === "not-modified";
  const truncated = payload.truncated === true;
  // a 304 updates the stored answer: its status stays, and its validators fill the gaps
  const etag = truncated ? null : (payload.etag ?? (revisit ? (previous?.etag ?? null) : null));
  const lastModified = truncated
    ? null
    : (payload.last_modified ?? (revisit ? (previous?.last_modified ?? null) : null));
  const kept = revisit ? (previous?.content_type ?? undefined) : undefined;
  const contentType =
    payload.content_type ?? kept ?? (variant === "rendered" ? "text/html; charset=utf-8" : null);
  const status = revisit
    ? previous === undefined || previous.status < 200 || previous.status >= 300
      ? 200
      : previous.status
    : (payload.status ?? 200);
  build.setLatest({
    url,
    variant,
    capture: envelope.id,
    blob: payload.blob ?? null,
    etag,
    last_modified: lastModified,
    content_type: contentType,
    fetched_at: fetchedAt,
    status,
    ai_input: payload.signals?.ai_input ?? "unset",
    ...(truncated ? { truncated: true } : {}),
    fresh_until: payload.fresh_until ?? null,
    vary_key: payload.vary_key ?? (revisit ? (previous?.vary_key ?? null) : null),
  });
};

/** This function replays one record of the log: its cache entry, and the documents that its extractor gives. */
const replayRecord = async (
  runtime: CrawlRuntime,
  target: ReplayTarget,
  envelope: CaptureRecord,
  tally: ReplayTally,
): Promise<void> => {
  if (envelope.kind !== "capture" && envelope.kind !== "revisit") return;
  const payload = envelope.payload as CapturePayload | null;
  if (payload === null || typeof payload !== "object" || typeof payload.url !== "string") return;
  if (payload.outcome === "redirect") {
    replayLatest(target, envelope, payload);
    return;
  }
  if (typeof payload.blob !== "string") return;
  if (payload.outcome !== "ok" && payload.outcome !== "not-modified") return;
  tally.captures += 1;
  replayLatest(target, envelope, payload);
  const extractor = runtime.extractors.get(payload.recipe);
  if (extractor === undefined) {
    // the crawler reads robots.txt, the sitemaps and the feeds for itself; they give no document
    if (!CRAWLER_RECIPES.has(payload.recipe)) tally.unknown.add(payload.recipe);
    return;
  }
  const body = await runtime.blobs.get(payload.blob);
  if (body === undefined) {
    tally.missing += 1;
    return;
  }
  const { url, variant } = captureTarget(payload);
  const latest = target.latest(url, variant);
  let extracted: ReadonlyArray<ExtractedDoc>;
  try {
    extracted = await extractor(body, {
      url,
      contentType:
        variant === "rendered"
          ? "text/html; charset=utf-8"
          : (payload.content_type ?? latest?.content_type ?? null),
    });
  } catch (error) {
    tally.failed += 1;
    if (tally.errors.length < MAX_ERRORS)
      tally.errors.push({ capture: envelope.id, error: messageOf(error) });
    return;
  }
  // a bot check is not the content, so it is not a version of the document
  if (extracted.some((doc) => blockedBy(doc) !== undefined)) return;
  for (const doc of extracted) {
    target.upsert(
      {
        ...doc,
        captures: [envelope.id],
        capture: envelope.id,
        fetched_at: payload.fetched_at ?? envelope.received_at,
        blob: payload.blob,
        recipe: payload.recipe,
        rendered: variant === "rendered",
        ai_input: doc.ai_input === "no" ? "no" : (payload.signals?.ai_input ?? "unset"),
        ...(envelope.scope !== undefined ? { scope: envelope.scope } : {}),
        ...(envelope.labels !== undefined ? { labels: envelope.labels } : {}),
      },
      envelope.received_at,
    );
  }
};

/**
 * This function builds the reading index again from the capture log and the blobs. The index is a
 * projection, and this function is the proof that its deletion loses nothing. These are its rules:
 *
 * - It builds a new generation of the tables and commits it in batches. The old index answers
 *   until the end, and a failed rebuild leaves it as it was.
 * - It reads the log as a stream, so its memory does not grow with the log.
 * - It counts and skips a damaged line, a missing blob and an extractor that throws.
 * - The documents of a recipe that has no extractor in this runtime stay, from the old index.
 * - A capture that a different writer adds during the rebuild goes into the new index.
 *
 * @beta
 */
export const reindex = async (
  runtime: CrawlRuntime,
  options: { readonly batch?: number | undefined } = {},
): Promise<ReindexResult> => {
  const since = runtime.now();
  const build = runtime.index.beginRebuild(
    options.batch === undefined ? {} : { batch: options.batch },
  );
  const tally = newTally();
  let damaged = 0;
  try {
    const scan = runtime.captures.scan(
      { source: "fetch" },
      {
        onDamaged: () => {
          damaged += 1;
        },
      },
    );
    for await (const envelope of scan) await replayRecord(runtime, build, envelope, tally);
    const carried = build.carry(new Set(runtime.extractors.recipes()));
    const counts = build.commit(since);
    return {
      captures: tally.captures,
      ...counts,
      failed: tally.failed,
      missing: tally.missing,
      damaged,
      carried,
      unknown_recipes: [...tally.unknown].sort(),
      errors: tally.errors,
    };
  } catch (error) {
    build.abort();
    throw error;
  }
};

/**
 * The result of `catchUpIndex`.
 *
 * @beta
 */
export interface CatchUpResult extends ReindexResult {
  /**
   * The value `rebuild` tells that the index was stale, and the function built it again from the
   * whole log. The value `tail` tells that it read only the captures that the index missed.
   */
  readonly mode: "rebuild" | "tail";
}

/** The tail starts this long before the newest cache entry. Two writers and their clocks can differ. */
const TAIL_SLACK_MS = 10 * 60_000;

/** This function tells if the index missed a record of the log: no cache entry as new as it, or no version of its documents. */
const missed = (runtime: CrawlRuntime, envelope: CaptureRecord): boolean => {
  if (envelope.kind !== "capture" && envelope.kind !== "revisit") return false;
  const payload = envelope.payload as CapturePayload | null;
  if (payload === null || typeof payload !== "object" || typeof payload.url !== "string")
    return false;
  const fetchedAt = payload.fetched_at ?? envelope.received_at;
  const { url, variant } = captureTarget(payload);
  const entry = runtime.index.latest(url, variant);
  if (payload.outcome === "redirect") return entry === undefined || entry.fetched_at < fetchedAt;
  if (
    typeof payload.blob !== "string" ||
    (payload.outcome !== "ok" && payload.outcome !== "not-modified")
  )
    return false;
  // a range request leaves no cache entry: only its documents tell if the index has it
  if (payload.range !== undefined)
    return (
      runtime.extractors.get(payload.recipe) !== undefined && !runtime.index.hasVersion(envelope.id)
    );
  if (entry === undefined || entry.fetched_at < fetchedAt) return true;
  return (
    runtime.extractors.get(payload.recipe) !== undefined && !runtime.index.hasVersion(envelope.id)
  );
};

/**
 * This function brings the reading index up to the capture log, with no request. `openCrawler`
 * uses it at open. An application that uses `createRuntime` uses it the same way:
 *
 * - A stale index (a new schema, or a deleted file) is built again with `reindex`.
 * - An index that is behind the log gets the captures that it missed. A process can stop between
 *   the log and the index, and SQLite can lose its last transactions after a power cut. The
 *   function reads the log from a short time before the newest cache entry.
 *
 * It gives the counts, or undefined when the index missed nothing.
 *
 * @beta
 */
export const catchUpIndex = async (runtime: CrawlRuntime): Promise<CatchUpResult | undefined> => {
  if (runtime.index.stale) return { mode: "rebuild", ...(await reindex(runtime)) };
  const newest = runtime.index.newestFetch();
  const since =
    newest === undefined ? undefined : new Date(Date.parse(newest) - TAIL_SLACK_MS).toISOString();
  const tally = newTally();
  let damaged = 0;
  const scan = runtime.captures.scan(
    { source: "fetch", ...(since === undefined ? {} : { since }) },
    {
      onDamaged: () => {
        damaged += 1;
      },
    },
  );
  for await (const envelope of scan) {
    if (missed(runtime, envelope)) await replayRecord(runtime, runtime.index, envelope, tally);
  }
  if (tally.captures === 0) return undefined;
  return {
    mode: "tail",
    captures: tally.captures,
    ...runtime.index.counts(),
    failed: tally.failed,
    missing: tally.missing,
    damaged,
    carried: 0,
    unknown_recipes: [...tally.unknown].sort(),
    errors: tally.errors,
  };
};
