/*
 * The recipe SDK. A recipe tells the crawler what to fetch and how to read it into documents.
 *
 * - `defineRecipe` declares a recipe: its name, the request for an input, and its extractor.
 * - `runRecipe` fetches one input through the crawler and gives the documents of the capture.
 * - `registerRecipe` gives the extractor to the extractors of a runtime. `openCrawler` and
 *   `createRuntime` take `recipes` and register them at open, so `reindex` reads their captures.
 *
 * Each fetch of a recipe is a fetch of the crawler. Thus robots.txt (for a page), the pace of each
 * host, the stops, the egress policy and the capture log apply. The documents are versions in the
 * index, so `find`, `read`, `verify`, `extract`, `diff` and the time travel use them.
 */
import type { FetchRequest } from "./crawler.ts";
import type { Doc, ExtractedDoc, VersionText } from "./docs.ts";
import type { Duration } from "./duration.ts";
import { durationMs } from "./duration.ts";
import type { Archived } from "./fallback.ts";
import { archivedCopy, archivedOf, fallbackReason } from "./fallback.ts";
import type { CrawlRuntime, Extractor, Extractors, Indexed, PageOptions } from "./runtime.ts";
import { HELD_BACK, fetchAndIndex, heldBackMeta, isHeldBack, recordOverride } from "./runtime.ts";
import type { AiInput } from "./signals.ts";
import { decodeBody } from "./text.ts";

/** The capture that an extractor reads: the final URL of the response and its content type. */
export interface RecipeCapture {
  readonly url: string;
  readonly contentType: string | null;
}

/**
 * This function reads one captured body into the documents that it holds. It is pure: the same
 * body and capture always give the same documents. It sends no request. It can answer later.
 */
export type RecipeExtract = (
  body: Uint8Array,
  capture: RecipeCapture,
) => ReadonlyArray<ExtractedDoc> | Promise<ReadonlyArray<ExtractedDoc>>;

/** The request of a recipe for one input: the URL, and the parts that change with the input. */
export interface RecipeRequest {
  readonly url: string;
  /** This value replaces the `accept` of the recipe for this request. */
  readonly accept?: string | undefined;
  /** These headers go with the request. The crawler does not write them into the capture. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** These query parameters hold secrets. The capture shows `REDACTED` in their place. */
  readonly secretParams?: readonly string[] | undefined;
}

/** These values declare a recipe. Only `name` and `extract` are necessary. */
export interface RecipeDefinition<Input = string> {
  /**
   * This name goes into each capture record of the recipe, so it is part of each capture id.
   * `reindex` finds the extractor by it. Do not change it after the first capture.
   */
  readonly name: string;
  /** This text tells what the recipe reads. */
  readonly description?: string | undefined;
  /**
   * The value `page` (the default) is a web page: robots.txt applies. The value `api` is a
   * documented API with terms of its own: robots.txt does not apply, and the pace still does.
   */
  readonly mode?: "api" | "page" | undefined;
  /** This value is the `Accept` header. The defaults are HTML for a page and JSON for an API. */
  readonly accept?: string | undefined;
  /** This value is the documented pace of the source: the shortest time between two of its requests. */
  readonly minInterval?: Duration | undefined;
  /** A stored copy younger than this age answers with no request. The default is `24h`. */
  readonly maxAge?: Duration | undefined;
  /** This value is the most bytes of a body that the crawler keeps. */
  readonly maxBytes?: number | undefined;
  /** This function gives the request for an input. With no function, the input is the URL. */
  readonly fetch?: ((input: Input) => string | RecipeRequest) | undefined;
  /** This function reads a captured body into documents. It is pure, and it sends no request. */
  readonly extract: RecipeExtract;
}

/** These options build the request of a recipe for one input (`Recipe.request`). */
export interface RecipeRequestOptions {
  /** This value replaces the `maxAge` of the recipe. The value `0` asks the source again. */
  readonly maxAge?: Duration | undefined;
  /** These agents get their robots.txt rules applied too, for a recipe of the mode `page`. */
  readonly onBehalfOf?: readonly string[] | undefined;
  /** This name connects the captures to the job that asked for them. */
  readonly job?: string | undefined;
  /** When this signal aborts, the crawler stops the fetch. */
  readonly signal?: AbortSignal | undefined;
  /** This label goes into each capture record of the request. */
  readonly scope?: string | undefined;
  /** These labels go into each capture record of the request. They are not part of the capture id. */
  readonly labels?: Readonly<Record<string, string>> | undefined;
  /** No request starts at or after this time (milliseconds since the epoch, on the clock of the crawler). */
  readonly deadline?: number | undefined;
}

/** A recipe that `defineRecipe` made. Give it to `runRecipe`, to `registerRecipe` or to `openCrawler`. */
export interface Recipe<Input = string> {
  readonly name: string;
  readonly description: string | null;
  readonly mode: "api" | "page";
  readonly accept: string;
  /**
   * This extractor reads the captures of the recipe. It checks the documents of the definition.
   *
   * @beta
   */
  readonly extractor: Extractor;
  /**
   * This method gives the request of the crawler for one input. A value that is not a URL throws a `TypeError`.
   *
   * @beta
   */
  request(input: Input, options?: RecipeRequestOptions): FetchRequest;
}

/**
 * This function reads a body as JSON, in the encoding that the response declares. A body that is
 * not JSON (a page about maintenance, or a login page) throws an error that names the URL and the
 * content type. In an extractor, the runtime then reports that error.
 */
export const readJson = (body: Uint8Array, capture: RecipeCapture): unknown => {
  const text = decodeBody(body, capture.contentType);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `${capture.url} answered ${capture.contentType ?? "a body of no stated type"}, not JSON`,
    );
  }
};

/**
 * These recipe names belong to the crawler: the page reader, the archived fallback, robots.txt,
 * and the sitemaps and feeds of `discover`. A recipe cannot use them.
 */
export const RESERVED_RECIPES: readonly string[] = [
  "page",
  "archive-copy",
  "archive-index",
  "robots.txt",
  "sitemap",
  "feed",
];

/**
 * These are the limits of a recipe.
 *
 * @beta
 */
export const RECIPE_LIMITS: {
  /** The longest recipe name. */
  readonly nameChars: number;
  /** The longest document id. */
  readonly docIdChars: number;
} = { nameChars: 64, docIdChars: 2048 };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const PAGE_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";
const API_ACCEPT = "application/json";
const AI_INPUTS: readonly AiInput[] = ["yes", "no", "unset"];

/** This function tells what is wrong with one document of an extractor, or gives undefined. */
const faultOf = (value: unknown, seen: Set<string>): string | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return "a document must be an object";
  const doc = value as Record<string, unknown>;
  const id = doc["doc"];
  if (typeof id !== "string" || id.length === 0 || id.length > RECIPE_LIMITS.docIdChars)
    return `doc must be a text of 1 to ${String(RECIPE_LIMITS.docIdChars)} characters`;
  // the archived fallback labels the copies of third parties, and only it makes these
  if (id.startsWith("archive:"))
    return `the id ${id} starts with archive:, which is for the archived copies`;
  if (seen.has(id)) return `two documents have the id ${id}`;
  seen.add(id);
  const kind = doc["kind"];
  if (typeof kind !== "string" || kind.length === 0) return "kind must be a text that is not empty";
  if (kind === "archived") return "the kind archived is for the archived copies";
  if (typeof doc["title"] !== "string") return "title must be a text";
  if (typeof doc["text"] !== "string") return "text must be a text";
  if (doc["url"] !== null && typeof doc["url"] !== "string") return "url must be a text or null";
  const meta = doc["meta"];
  if (meta === null || typeof meta !== "object" || Array.isArray(meta))
    return "meta must be an object";
  try {
    JSON.stringify(meta);
  } catch {
    return "meta must be JSON: no cycle and no BigInt";
  }
  const merge = doc["merge"];
  if (merge !== undefined && merge !== "latest" && merge !== "richest")
    return 'merge must be "latest" or "richest"';
  if (doc["full_text"] !== undefined && typeof doc["full_text"] !== "string")
    return "full_text must be a text";
  const aiInput = doc["ai_input"];
  if (aiInput !== undefined && !AI_INPUTS.includes(aiInput as AiInput))
    return 'ai_input must be "yes", "no" or "unset"';
  return undefined;
};

/** This function gives the documents of an extractor, or throws an error that names the first fault. */
const checkedDocs = (name: string, docs: unknown): ReadonlyArray<ExtractedDoc> => {
  if (!Array.isArray(docs))
    throw new TypeError(`the recipe ${name} gave ${typeof docs}, not an array of documents`);
  const seen = new Set<string>();
  for (const [index, doc] of docs.entries()) {
    const fault = faultOf(doc, seen);
    if (fault !== undefined)
      throw new TypeError(
        `the recipe ${name} gave a document that is not valid (${String(index)}): ${fault}`,
      );
  }
  return docs as ReadonlyArray<ExtractedDoc>;
};

/**
 * This function declares a recipe. It checks the definition at once: a name that is not valid, a
 * reserved name or a duration that it cannot read throws an error. The extractor of the recipe
 * checks each document of `extract`. A document that is not valid makes the extractor throw, and
 * the runtime reports it as an error of the extractor.
 */
export const defineRecipe = <Input = string>(
  definition: RecipeDefinition<Input>,
): Recipe<Input> => {
  const name = definition.name;
  if (typeof name !== "string" || name.length > RECIPE_LIMITS.nameChars || !NAME.test(name)) {
    throw new RangeError(
      `a recipe name is 1 to ${String(RECIPE_LIMITS.nameChars)} letters, digits and . _ : -, and it starts with a letter or a digit, not ${JSON.stringify(name) ?? "undefined"}`,
    );
  }
  if (RESERVED_RECIPES.includes(name)) {
    throw new RangeError(
      `the recipe name ${name} belongs to the crawler: give the recipe a name of its own`,
    );
  }
  if (typeof definition.extract !== "function") {
    throw new TypeError(
      `the recipe ${name} needs extract, a function that reads a body into documents`,
    );
  }
  const mode = definition.mode ?? "page";
  if (mode !== "page" && mode !== "api") {
    throw new RangeError(
      `the mode of the recipe ${name} must be "page" or "api", not ${String(mode)}`,
    );
  }
  const accept = definition.accept ?? (mode === "api" ? API_ACCEPT : PAGE_ACCEPT);
  const minIntervalMs =
    definition.minInterval === undefined ? undefined : durationMs(definition.minInterval);
  const maxAgeOf = (value: Duration): number | "auto" =>
    value === "auto" ? "auto" : durationMs(value);
  const maxAge = maxAgeOf(definition.maxAge ?? "24h");
  const maxBytes = definition.maxBytes;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) {
    throw new RangeError(`maxBytes of the recipe ${name} must be a whole number of 1 or more`);
  }
  const extract = definition.extract;
  const extractor: Extractor = async (body, capture) =>
    checkedDocs(name, await extract(body, { url: capture.url, contentType: capture.contentType }));
  const fetch = definition.fetch;
  return {
    name,
    description: definition.description ?? null,
    mode,
    accept,
    extractor,
    request(input, options = {}) {
      const asked: unknown = fetch === undefined ? input : fetch(input);
      const target = typeof asked === "string" ? { url: asked } : (asked as RecipeRequest | null);
      const url = target?.url;
      let parsed: URL | undefined;
      try {
        parsed = typeof url === "string" ? new URL(url) : undefined;
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        throw new TypeError(
          `the recipe ${name} needs an http or https URL for its input, not ${JSON.stringify(url) ?? String(url)}`,
        );
      }
      return {
        url: parsed.href,
        mode,
        recipe: name,
        accept: target?.accept ?? accept,
        headers: target?.headers,
        secretParams: target?.secretParams,
        minIntervalMs,
        maxAgeMs: options.maxAge === undefined ? maxAge : maxAgeOf(options.maxAge),
        maxBytes,
        onBehalfOf: options.onBehalfOf,
        job: options.job,
        signal: options.signal,
        scope: options.scope,
        labels: options.labels,
        deadline: options.deadline,
      };
    },
  };
};

/**
 * This function gives the extractor of a recipe to the extractors of a runtime. A second
 * registration of the same recipe does nothing. A different extractor with the same name throws
 * an error, because `reindex` must read each capture with one extractor.
 *
 * @beta
 */
export const registerRecipe = <Input>(extractors: Extractors, recipe: Recipe<Input>): void => {
  const known = extractors.get(recipe.name);
  if (known === recipe.extractor) return;
  if (known !== undefined) {
    throw new Error(
      `the recipe ${recipe.name} has a different extractor in this runtime: give each recipe a name of its own`,
    );
  }
  extractors.register(recipe.name, recipe.extractor);
};

/** These options control one run of a recipe. */
export interface RecipeRunOptions extends Omit<RecipeRequestOptions, "deadline"> {
  /** No request starts after this time from the start of the run, for example `"30s"`. */
  readonly budget?: Duration | undefined;
  /** This value is true when a person gave this input directly. It is the only way to see a held-back document. The crawler logs it. */
  readonly userProvided?: boolean | undefined;
  /**
   * The value `archive` gives a copy from a public web archive when the site refuses the page or is
   * down. Only a recipe of the mode `page` takes it. The page reader reads the copy.
   */
  readonly fallback?: "archive" | "none" | undefined;
  /** The value true also gives an archived copy of a page that the current robots.txt disallows. */
  readonly archiveDespiteRobots?: boolean | undefined;
}

/** One document of a run of a recipe: the version of the capture of the run. */
export interface RecipeDoc {
  readonly doc: string;
  readonly kind: string;
  /** This value is the title. A held-back document shows no title. */
  readonly title: string;
  readonly url: string | null;
  /** This value is the metadata. A held-back document shows only the structural fields. */
  readonly meta: Readonly<Record<string, unknown>>;
  /** This value is the length of the text. `read` gives the text. */
  readonly chars: number;
  /** This id is the capture of this version. A citation names it. */
  readonly capture: string;
  readonly fetched_at: string;
  readonly held_back: boolean;
  /** This value tells that the document is an archived copy, with the archive and the date of the copy. */
  readonly archived?: Archived | undefined;
}

/** The result of `runRecipe`. */
export interface RecipeResult {
  readonly recipe: string;
  /** This URL is the URL of the capture. Its secrets show as `REDACTED`. */
  readonly url: string;
  readonly outcome: string;
  readonly status: number;
  /** These documents came from the capture of the run, in the order of the extractor. */
  readonly docs: readonly RecipeDoc[];
  /** This id is the capture of the documents. */
  readonly capture: string | null;
  readonly fetched_at: string | null;
  /** This value is true when the stored copy answered, and the crawler sent no request. */
  readonly from_cache: boolean;
  /** This value is true when a document is held back. */
  readonly held_back: boolean;
  /** This text is the error of the extractor, when it threw for the capture. */
  readonly error: string | null;
  /** This value tells that the documents are an archived copy, not a fresh fetch. */
  readonly archived?: Archived | undefined;
  readonly note: string | null;
}

/** A recipe operates on a runtime, or on a crawler that has one (`crawler.runtime`). */
export type RecipeTarget = CrawlRuntime | { readonly runtime: CrawlRuntime };

/** This function gives the runtime of a target. */
export const runtimeOf = (target: RecipeTarget): CrawlRuntime =>
  "crawler" in target ? target : target.runtime;

/** This function gives the deadline of a budget, on the clock of the runtime. */
export const deadlineOf = (
  runtime: CrawlRuntime,
  budget: Duration | undefined,
): number | undefined =>
  budget === undefined ? undefined : Date.parse(runtime.now()) + durationMs(budget);

/** This function gives one document of a run, with the rule for a held-back document. */
const recipeDoc = async (
  runtime: CrawlRuntime,
  doc: Doc,
  capture: string | undefined,
  userProvided: boolean,
  action: string,
): Promise<RecipeDoc> => {
  const current = runtime.index.get(doc.doc) ?? doc;
  const version: VersionText | Doc =
    (capture === undefined ? undefined : runtime.index.versionText(doc.doc, capture)) ?? current;
  const aiInput: AiInput =
    current.ai_input === "no" || version.ai_input === "no" ? "no" : version.ai_input;
  const held = isHeldBack({ ai_input: aiInput }, userProvided);
  if (aiInput === "no" && userProvided) await recordOverride(runtime, current, action);
  const archived = archivedOf(version.meta);
  return {
    doc: doc.doc,
    kind: version.kind,
    title: held ? "" : version.title,
    url: version.url,
    meta: held ? heldBackMeta(version.meta) : version.meta,
    chars: version.text.length,
    capture: version.capture,
    fetched_at: version.fetched_at,
    held_back: held,
    ...(archived === undefined ? {} : { archived }),
  };
};

const noteOf = (parts: ReadonlyArray<string | null | undefined>): string | null => {
  const kept = parts.filter((part): part is string => typeof part === "string" && part.length > 0);
  return kept.length > 0 ? kept.join("; ") : null;
};

/**
 * This function starts a recipe for one input. It fetches the request through the crawler, and it
 * reads the capture with the extractor of the recipe. It gives the documents of that capture.
 * These are its rules:
 *
 * - The runtime registers the recipe the first time that it gets it. Give the recipe to
 *   `openCrawler` too, so that `reindex` reads its captures before the first fetch.
 * - A stored copy younger than `maxAge` answers with no request. When the extractor cannot read a
 *   stored copy, the crawler asks the source one more time.
 * - An extractor that throws gives no document, and `error` tells why. The fetch still succeeds.
 * - A document that asked not to be AI input shows no title and only its structural metadata,
 *   unless `userProvided`. The crawler logs each `userProvided` read of a held-back document.
 * - With `fallback: "archive"`, a page that the site refuses gets an archived copy, with
 *   `archived`. The page reader reads the copy. The extractor of the recipe reads only live
 *   captures. Thus its documents do not mix a live answer and an old copy of a third party.
 */
export const runRecipe = async <Input>(
  target: RecipeTarget,
  recipe: Recipe<Input>,
  input: Input,
  options: RecipeRunOptions = {},
): Promise<RecipeResult> => {
  const runtime = runtimeOf(target);
  if (options.fallback === "archive" && recipe.mode !== "page") {
    throw new RangeError(
      `the recipe ${recipe.name} reads an API: an archived copy is for a page, so give fallback only to a recipe of the mode page`,
    );
  }
  registerRecipe(runtime.extractors, recipe);
  const deadline = deadlineOf(runtime, options.budget);
  const request = recipe.request(input, { ...options, deadline });
  let indexed: Indexed = await fetchAndIndex(runtime, request);
  // a stored answer that the extractor cannot read is no answer: it would give the same error until maxAge
  if (indexed.error !== undefined && indexed.blocked === undefined && indexed.fetched.fromCache) {
    indexed = await fetchAndIndex(runtime, { ...request, maxAgeMs: 0 });
  }
  const userProvided = options.userProvided ?? false;
  const action = options.job ?? `recipe ${recipe.name}`;
  const fetched = indexed.fetched;
  const notes: Array<string | undefined> = [fetched.note, indexed.error];
  if (indexed.docs.length === 0 && options.fallback === "archive") {
    const reason = fallbackReason(indexed);
    if (reason !== undefined) {
      const page: PageOptions = {
        render: "never",
        maxAgeMs: request.maxAgeMs,
        onBehalfOf: request.onBehalfOf,
        job: request.job,
        signal: request.signal,
        scope: request.scope,
        labels: request.labels,
        deadline,
        fallback: "archive",
        archiveDespiteRobots: options.archiveDespiteRobots,
      };
      const answer = await archivedCopy(runtime, request.url, reason, page);
      if (answer.doc !== undefined && answer.archived !== undefined) {
        const doc = await recipeDoc(runtime, answer.doc, answer.doc.capture, userProvided, action);
        return {
          recipe: recipe.name,
          url: fetched.url,
          outcome: fetched.outcome,
          status: fetched.status,
          docs: [doc],
          capture: doc.capture,
          fetched_at: doc.fetched_at,
          from_cache: answer.fromCache,
          held_back: doc.held_back,
          error: indexed.error ?? null,
          archived: answer.archived,
          note: noteOf([
            ...notes,
            ...answer.notes,
            "the page reader read the archived copy, not the extractor of the recipe",
            doc.held_back ? HELD_BACK : undefined,
          ]),
        };
      }
      notes.push(...answer.notes);
    }
  }
  const capture = fetched.capture;
  const docs: RecipeDoc[] = [];
  for (const doc of indexed.docs)
    docs.push(await recipeDoc(runtime, doc, capture, userProvided, action));
  const held = docs.some((doc) => doc.held_back);
  return {
    recipe: recipe.name,
    url: fetched.url,
    outcome: fetched.outcome,
    status: fetched.status,
    docs,
    capture: docs[0]?.capture ?? capture ?? null,
    fetched_at: docs[0]?.fetched_at ?? fetched.fetchedAt ?? null,
    from_cache: fetched.fromCache,
    held_back: held,
    error: indexed.error ?? null,
    note: noteOf([...notes, held ? HELD_BACK : undefined]),
  };
};
