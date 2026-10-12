import type { BlobStore } from "./blobs.ts";
import type { Crawler, FetchRequest, Fetched, RenderRequest } from "./crawler.ts";
import { renderedKey } from "./crawler.ts";
import type { PageExtract } from "./html.ts";
import { canonicalUrl, extractPage, typesOf } from "./html.ts";
import { decodeBody } from "./text.ts";
import type { Doc, DocIndex, DocInput } from "./docs.ts";
import type { CaptureLog, CaptureReader } from "./log.ts";
import { isPdf, readPdf } from "./pdf.ts";
import type { AiInput } from "./signals.ts";

/**
 * An extractor changes one captured body into the documents that it holds. It has no side effects,
 * so `reindex` can replay each capture through it and build the index again with no request. It can
 * answer later, because the crawler reads a PDF asynchronously.
 */
export type Extractor = (
  body: Uint8Array,
  capture: { readonly url: string; readonly contentType: string | null },
) =>
  | ReadonlyArray<Omit<DocInput, "captures" | "ai_input">>
  | Promise<ReadonlyArray<Omit<DocInput, "captures" | "ai_input">>>;

/** This function gives the document id of a web page. Each page has one id. */
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
      candidate = Object.fromEntries(Object.entries(record).filter(([key]) => !BULKY.includes(key)));
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
 * gives a document that names the error.
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
        redirect: page.redirect,
        blocked: page.blocked,
        ...(page.notes.length > 0 ? { notes: page.notes } : {}),
      },
    },
  ];
};

const MAX_PDF_TEXT_CHARS = 200_000;

/**
 * This function changes a PDF into one document of its text. A PDF with no text, a scan for
 * example, gives a document of its title only, and the document says that it needs OCR. A damaged
 * file gives no document.
 */
const pdfDocs = async (
  body: Uint8Array,
  url: string,
): Promise<ReadonlyArray<Omit<DocInput, "captures" | "ai_input">>> => {
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

export class Extractors {
  private readonly byRecipe = new Map<string, Extractor>([["page", pageExtractor]]);

  register(recipe: string, extractor: Extractor): void {
    if (this.byRecipe.has(recipe)) throw new Error(`recipe ${recipe} already has an extractor`);
    this.byRecipe.set(recipe, extractor);
  }

  get(recipe: string): Extractor | undefined {
    return this.byRecipe.get(recipe);
  }
}

export interface CrawlRuntime {
  readonly crawler: Crawler;
  readonly index: DocIndex;
  readonly blobs: BlobStore;
  /** This reader is the read side of the capture log. The function `reindex` replays it. */
  readonly captures: CaptureReader;
  /** This log is the write side of the capture log. */
  readonly log: CaptureLog;
  readonly extractors: Extractors;
  readonly now: () => string;
}

/** This is the payload of a capture record, as the crawler writes it. */
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
}

/**
 * This function fetches one URL and adds its documents to the index. Each recipe uses it. A fetch
 * from the cache reads the stored body again, so a repeated question sends no request and still
 * gives its documents.
 */
export const fetchAndIndex = async (
  runtime: CrawlRuntime,
  request: FetchRequest,
): Promise<{ readonly fetched: Fetched; readonly docs: readonly Doc[] }> => {
  const fetched = await runtime.crawler.fetch(request);
  const capture = fetched.capture;
  if (
    fetched.body === undefined ||
    capture === undefined ||
    (fetched.outcome !== "ok" && fetched.outcome !== "not-modified")
  ) {
    return { fetched, docs: [] };
  }
  const extractor = runtime.extractors.get(request.recipe);
  if (extractor === undefined) return { fetched, docs: [] };
  const docs = (
    await extractor(fetched.body, {
      url: fetched.url,
      contentType: fetched.contentType ?? null,
    })
  ).map((doc) =>
    runtime.index.upsert(
      { ...doc, captures: [capture], ai_input: fetched.signals.ai_input },
      runtime.now(),
    ),
  );
  return { fetched, docs };
};

/** This function renders a page in the headless browser and adds what the page shows to the index. */
export const renderAndIndex = async (
  runtime: CrawlRuntime,
  request: RenderRequest,
): Promise<{ readonly fetched: Fetched; readonly docs: readonly Doc[] }> => {
  const fetched = await runtime.crawler.render(request);
  const capture = fetched.capture;
  if (fetched.body === undefined || capture === undefined || fetched.outcome !== "ok") {
    return { fetched, docs: [] };
  }
  const extractor = runtime.extractors.get(request.recipe);
  if (extractor === undefined) return { fetched, docs: [] };
  const docs = (await extractor(fetched.body, { url: fetched.url, contentType: "text/html" })).map(
    (doc) =>
      runtime.index.upsert(
        { ...doc, captures: [capture], ai_input: fetched.signals.ai_input },
        runtime.now(),
      ),
  );
  return { fetched, docs };
};

export interface PageResult {
  readonly url: string;
  readonly doc: string | null;
  readonly outcome: string;
  readonly status: number;
  readonly title: string | null;
  readonly chars: number;
  readonly rendered: boolean;
  /** These are the schema.org types that the JSON-LD of the page declares. */
  readonly structured: readonly string[];
  readonly links: number;
  readonly captures: readonly string[];
  readonly note: string | null;
}

/**
 * This function reads one web page. It first sends a plain request. It opens the browser only when
 * the page shows almost nothing without JavaScript, or when the caller asks for it.
 */
export const fetchPage = async (
  runtime: CrawlRuntime,
  url: string,
  options: {
    readonly render: "auto" | "never" | "always";
    readonly maxAgeMs?: number | undefined;
    readonly onBehalfOf?: readonly string[] | undefined;
    readonly job?: string | undefined;
  },
): Promise<PageResult> => {
  const plain = await fetchAndIndex(runtime, {
    url,
    mode: "page",
    recipe: "page",
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    maxAgeMs: options.maxAgeMs,
    onBehalfOf: options.onBehalfOf,
    job: options.job,
  });
  let docs = plain.docs;
  let rendered = false;
  let note = plain.fetched.note ?? null;
  const reachable = plain.fetched.outcome === "ok" || plain.fetched.outcome === "not-modified";
  const wanted =
    options.render === "always" ||
    (options.render === "auto" && docs[0]?.meta["needs_render"] === true);
  if (reachable && wanted) {
    const shown = await renderAndIndex(runtime, {
      url: plain.fetched.url,
      recipe: "page",
      maxAgeMs: options.maxAgeMs,
      onBehalfOf: options.onBehalfOf,
      job: options.job,
    });
    if (shown.docs.length > 0) {
      docs = shown.docs;
      rendered = true;
    } else {
      note = shown.fetched.note ?? note;
    }
  }
  const doc = docs[0];
  const types = doc?.meta["jsonld_types"];
  const links = doc?.meta["links"];
  return {
    url,
    doc: doc?.doc ?? null,
    outcome: plain.fetched.outcome,
    status: plain.fetched.status,
    title: doc?.title ?? null,
    chars: doc?.text.length ?? 0,
    rendered,
    structured: Array.isArray(types) ? (types as string[]) : [],
    links: Array.isArray(links) ? links.length : 0,
    captures: doc === undefined ? [] : [...doc.captures],
    note,
  };
};

/**
 * This function builds the reading index again from the capture log and the blobs. The index is a
 * projection, and this function is the proof that its deletion loses nothing.
 */
export const reindex = async (
  runtime: CrawlRuntime,
): Promise<{ readonly captures: number; readonly docs: number; readonly urls: number }> => {
  runtime.index.reset();
  let captures = 0;
  for await (const envelope of runtime.captures.scan({ source: "fetch" })) {
    if (envelope.kind !== "capture" && envelope.kind !== "revisit") continue;
    const payload = envelope.payload as CapturePayload;
    if (typeof payload.blob !== "string") continue;
    if (payload.outcome !== "ok" && payload.outcome !== "not-modified") continue;
    captures += 1;
    const aiInput = payload.signals?.ai_input ?? "unset";
    runtime.index.setLatest({
      url: payload.rendered === true ? renderedKey(payload.url) : payload.url,
      capture: envelope.id,
      blob: payload.blob,
      etag: payload.etag ?? null,
      last_modified: payload.last_modified ?? null,
      content_type: payload.content_type ?? null,
      fetched_at: payload.fetched_at,
      status: payload.status ?? 200,
      ai_input: aiInput,
    });
    const extractor = runtime.extractors.get(payload.recipe);
    if (extractor === undefined) continue;
    const body = await runtime.blobs.get(payload.blob);
    if (body === undefined) continue;
    for (const doc of await extractor(body, {
      url: payload.url,
      contentType: payload.content_type ?? null,
    })) {
      runtime.index.upsert(
        { ...doc, captures: [envelope.id], ai_input: aiInput },
        envelope.received_at,
      );
    }
  }
  return { captures, ...runtime.index.counts() };
};
