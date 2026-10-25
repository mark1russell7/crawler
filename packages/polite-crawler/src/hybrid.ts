import { createHash } from "node:crypto";
import type { Duration } from "./duration.ts";
import { durationMs } from "./duration.ts";
import type { Doc, DocDigest, Found, Passage } from "./docs.ts";
import { parseQuery } from "./docs.ts";
import type { Embedder } from "./embed.ts";
import {
  CHUNK_LIMITS,
  HYBRID_DEFAULTS,
  chunkText,
  chunkTokensOf,
  fuseRanks,
  unitVector,
} from "./embed.ts";
import { archivedOf } from "./fallback.ts";
import { snippetOf } from "./fold.ts";
import type { CrawlRuntime } from "./runtime.ts";
import { isHeldBack } from "./runtime.ts";
import type { VectorHit, VectorStore } from "./vectors.ts";

/**
 * Hybrid search ranks the stored documents two times and fuses the two lists:
 *
 * 1. The full-text index gives the BM25 candidates (`candidates`, 50 by default). Each candidate
 *    whose text has no vectors gets them from the embedder first.
 * 2. The vector store gives the documents with the closest chunks (`neighbors`, 50 by default),
 *    with a brute-force cosine over the vectors of the embedder.
 * 3. Reciprocal rank fusion (`fusionK`, 60 by default) makes one list of the two.
 *
 * The snippet and the `passage` of each hit come from its best chunk. A held-back document gets
 * no vectors, and no result gives it, exactly as for `find`. The text of a held-back version does not
 * goes to the embedder.
 */

/** These options change a hybrid search. */
export interface HybridOptions {
  /** This value is the number of BM25 candidates. The default is `HYBRID_DEFAULTS.candidates`. */
  readonly candidates?: number | undefined;
  /** This value is the number of documents from the vector search. The default is `HYBRID_DEFAULTS.neighbors`. */
  readonly neighbors?: number | undefined;
  /** This value is the constant k of reciprocal rank fusion. The default is `HYBRID_DEFAULTS.fusionK`. */
  readonly fusionK?: number | undefined;
  /** When this signal aborts, the search stops the embedder and rejects. */
  readonly signal?: AbortSignal | undefined;
}

/** These options control a hybrid search of the store. */
export interface HybridFindOptions extends HybridOptions {
  /** This value is the maximum number of results. The default is 10, and the maximum is 1000. */
  readonly limit?: number | undefined;
  /** This value keeps only the documents of one kind, for example `page` or `pdf`. */
  readonly kind?: string | null | undefined;
}

/** This is one document of a ranking of a set of documents (`rankWithin`). */
export interface Ranked {
  readonly doc: string;
  /** This value is the score. A larger score is a better match. In the mode `hybrid`, it is the fused score. */
  readonly score: number;
  /** This value is the best chunk of the document, in the mode `hybrid`. */
  readonly passage?: Passage | undefined;
}

/** These options control `embed`, which gives vectors to the stored documents that have none. */
export interface EmbedOptions {
  /** This value is the longest time of the work, for example `"10m"` (the default). No embedding starts after it. */
  readonly budget?: Duration | undefined;
  /** This value is the largest number of texts that get new vectors. The default has no limit. */
  readonly maxDocs?: number | undefined;
  /** This value keeps only the documents of one kind, for example `page` or `pdf`. */
  readonly kind?: string | null | undefined;
  /** When this signal aborts, the work stops. The result then has `stopped: "signal"`. */
  readonly signal?: AbortSignal | undefined;
}

/** The reason of the end of `embed`. */
export type EmbedStop = "done" | "budget" | "max-docs" | "signal";

/** The counts of `embed`. */
export interface EmbedResult {
  /** This value is the id of the embedder. */
  readonly embedder: string;
  /** This value is the number of documents that the work examined. */
  readonly docs: number;
  /** This value is the number of texts that got new vectors. */
  readonly embedded: number;
  /** This value is the number of documents whose text had vectors already. */
  readonly reused: number;
  /** This value is the number of documents that the work left out, because they are held back. */
  readonly held_back: number;
  /** This value is the number of new vectors: one for each chunk. */
  readonly chunks: number;
  readonly stopped: EmbedStop;
  /** This value is the time of the work in milliseconds. */
  readonly ms: number;
}

/** Hybrid search over a runtime and a vector store. `openCrawler` makes one when it has an embedder. */
export interface HybridSearch {
  readonly embedder: Embedder;
  /** This method searches the stored documents in the mode `hybrid`. It sends no request to a site. */
  find(q: string, options?: HybridFindOptions): Promise<Found[]>;
  /** This method ranks a set of documents in the mode `hybrid`, the best first. */
  rankWithin(q: string, docs: readonly string[], options?: HybridOptions): Promise<Ranked[]>;
  /** This method gives vectors to the stored documents that have none, within a budget. */
  embed(options?: EmbedOptions): Promise<EmbedResult>;
}

/**
 * These options make a hybrid search.
 *
 * @beta
 */
export interface HybridSearchOptions {
  readonly embedder: Embedder;
  /** This store keeps the vectors. The caller opens it and closes it. */
  readonly store: VectorStore;
}

/** The embedder gets this number of texts in one call at most. */
const BATCH = 32;
/** The search keeps the vectors of this number of questions. */
const QUERY_CACHE = 32;
/** The search checks this number of texts of the vector search against the index at one time. */
const PAGE = 64;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const count = (name: string, value: number | undefined, fallback: number, max: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1)
    throw new RangeError(`${name} must be a number of 1 or more, not ${String(value)}`);
  return Math.min(max, Math.floor(value));
};

/** This function checks the constant k of reciprocal rank fusion. */
const fusionKOf = (value: number | undefined): number => {
  if (value === undefined) return HYBRID_DEFAULTS.fusionK;
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`fusionK must be a number of 0 or more, not ${String(value)}`);
  return value;
};

/** This function gives a promise with its resolve and its reject. A rejection with no listener is not an error of the process. */
const deferred = <T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
};

const round = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/** The facts of a document that hybrid search checks: its kind, its AI input and the hash of its text. */
type Head = Pick<DocDigest, "doc" | "kind" | "ai_input" | "text_sha">;

/**
 * This function makes a hybrid search over a runtime. The vectors go into the store, with the id of the embedder.
 *
 * @beta
 */
export const createHybridSearch = (
  runtime: CrawlRuntime,
  options: HybridSearchOptions,
): HybridSearch => {
  const { embedder, store } = options;
  const tokens = chunkTokensOf(embedder);
  const plan = `chunks-1/${String(tokens)}/${String(Math.floor(tokens * CHUNK_LIMITS.overlap))}/${String(CHUNK_LIMITS.maxChunks)}`;
  const working = new Map<string, Promise<number>>();
  const queries = new Map<string, Float32Array>();
  let dimensions = embedder.dimensions > 0 ? embedder.dimensions : store.dimensions(embedder.id);

  /** This function gives the heads of documents, from `digests` when the index has it. */
  const headsOf = (docs: readonly string[]): Map<string, Head> => {
    const heads = new Map<string, Head>();
    if (docs.length === 0) return heads;
    const index = runtime.index;
    if (index.digests !== undefined) {
      for (const head of index.digests({ docs })) heads.set(head.doc, head);
      return heads;
    }
    for (const doc of docs) {
      const found = index.get(doc);
      if (found !== undefined) heads.set(doc, headOfDoc(found));
    }
    return heads;
  };
  const headOfDoc = (doc: Doc): Head => ({
    doc: doc.doc,
    kind: doc.kind,
    ai_input: doc.ai_input,
    text_sha: sha256(doc.text),
  });

  /** This function asks the embedder for the vectors of texts, in batches, and checks them. */
  const vectorsOf = async (
    texts: readonly string[],
    purpose: "document" | "query",
    signal: AbortSignal | undefined,
  ): Promise<Float32Array[]> => {
    const out: Float32Array[] = [];
    for (let at = 0; at < texts.length; at += BATCH) {
      signal?.throwIfAborted();
      const part = texts.slice(at, at + BATCH);
      const given = await embedder.embed(part, { signal, purpose });
      if (!Array.isArray(given) || given.length !== part.length) {
        throw new Error(
          `the embedder ${embedder.id} gave ${String(Array.isArray(given) ? given.length : 0)} vectors for ${String(part.length)} texts`,
        );
      }
      for (const vector of given) {
        const unit = unitVector(vector);
        dimensions ??= unit.length;
        if (unit.length !== dimensions || unit.length === 0) {
          throw new Error(
            `the embedder ${embedder.id} gave a vector of ${String(unit.length)} dimensions, not ${String(dimensions)}`,
          );
        }
        out.push(unit);
      }
    }
    return out;
  };

  const queryVector = async (q: string, signal: AbortSignal | undefined): Promise<Float32Array> => {
    const text = q.replace(/["*]/g, " ").replace(/\s+/g, " ").trim();
    const known = queries.get(text);
    if (known !== undefined) {
      queries.delete(text);
      queries.set(text, known);
      return known;
    }
    const [vector] = await vectorsOf([text], "query", signal);
    queries.set(text, vector!);
    if (queries.size > QUERY_CACHE) queries.delete(queries.keys().next().value!);
    return vector!;
  };

  /**
   * This function gives vectors to the texts of documents that have none, and points each document
   * at its current text. It reads each text from the index, and it does not send the text
   * of a held-back document. Two calls for one text share the work. It gives the number of new vectors.
   */
  const ensure = async (
    docs: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<{ embedded: number; reused: number; held: number; chunks: number }> => {
    const tally = { embedded: 0, reused: 0, held: 0, chunks: 0 };
    const now = runtime.now();
    const heads = headsOf(docs);
    const waiting = new Map<string, { readonly text: string; readonly docs: string[] }>();
    const shared: Array<Promise<number>> = [];
    for (const id of docs) {
      const head = heads.get(id);
      if (head === undefined) continue;
      if (isHeldBack(head)) {
        tally.held += 1;
        if (store.pointed(embedder.id, id) !== undefined) store.forget(embedder.id, id);
        continue;
      }
      if (store.plan(embedder.id, head.text_sha) === plan) {
        tally.reused += 1;
        if (store.pointed(embedder.id, id) !== head.text_sha)
          store.point(embedder.id, id, head.text_sha, now);
        continue;
      }
      const doc = runtime.index.get(id);
      if (doc === undefined || isHeldBack(doc)) continue;
      const sha = sha256(doc.text);
      const entry = waiting.get(sha);
      if (entry !== undefined) {
        entry.docs.push(id);
        continue;
      }
      const busy = working.get(sha);
      if (busy !== undefined) {
        // a different call embeds this text now: this call points the document at it after
        const after = busy.then((made) => {
          store.point(embedder.id, id, sha, now);
          return made;
        });
        // This call can stop with an error before it waits for `shared`. Then a failure of the other
        // call is not an unhandled rejection, which stops the process.
        after.catch(() => undefined);
        shared.push(after);
        continue;
      }
      waiting.set(sha, { text: doc.text, docs: [id] });
    }
    // the chunks of the texts go to the embedder in batches, and each text is written when its vectors came
    const jobs = [...waiting].map(([sha, entry]) => {
      const job = {
        sha,
        entry,
        chunks: chunkText(entry.text, { maxTokens: tokens }),
        ...deferred<number>(),
      };
      working.set(sha, job.promise);
      return job;
    });
    try {
      for (let at = 0; at < jobs.length;) {
        const batch: typeof jobs = [];
        let size = 0;
        while (
          at < jobs.length &&
          (batch.length === 0 || size + jobs[at]!.chunks.length <= BATCH)
        ) {
          batch.push(jobs[at]!);
          size += jobs[at]!.chunks.length;
          at += 1;
        }
        const vectors = await vectorsOf(
          batch.flatMap((job) => job.chunks.map((chunk) => chunk.text)),
          "document",
          signal,
        );
        let next = 0;
        for (const job of batch) {
          const chunks = job.chunks.map((chunk) => ({
            start: chunk.start,
            end: chunk.end,
            vector: vectors[next++]!,
          }));
          store.put({
            embedder: embedder.id,
            dimensions: dimensions ?? chunks[0]?.vector.length ?? 0,
            sha: job.sha,
            plan,
            chars: job.entry.text.length,
            chunks,
            docs: job.entry.docs,
            at: now,
          });
          tally.embedded += 1;
          tally.chunks += chunks.length;
          working.delete(job.sha);
          job.resolve(chunks.length);
        }
      }
    } catch (error) {
      for (const job of jobs) {
        if (working.get(job.sha) === job.promise) working.delete(job.sha);
        job.reject(error);
      }
      throw error;
    }
    await Promise.all(shared);
    return tally;
  };

  /**
   * This function gives the documents of the vector search, the best first, to `limit`. It checks
   * each document against the index. Its current text must be the text of the hit, it must not be
   * held back, and it must have the kind. With `within`, it ranks only those documents.
   */
  const neighborsOf = (
    query: Float32Array,
    limit: number,
    kind: string | null | undefined,
    within: ReadonlySet<string> | undefined,
  ): Array<{ readonly doc: string; readonly hit: VectorHit }> => {
    const hits = store.search(embedder.id, query, within === undefined ? {} : { within });
    const out: Array<{ readonly doc: string; readonly hit: VectorHit }> = [];
    for (let at = 0; at < hits.length && out.length < limit; at += PAGE) {
      const page = hits.slice(at, at + PAGE);
      const docs = [
        ...new Set(
          page.flatMap((hit) =>
            within === undefined ? hit.docs : hit.docs.filter((doc) => within.has(doc)),
          ),
        ),
      ];
      const heads = headsOf(docs);
      for (const hit of page) {
        for (const doc of hit.docs) {
          if (out.length >= limit) break;
          if (within !== undefined && !within.has(doc)) continue;
          const head = heads.get(doc);
          if (head === undefined || head.text_sha !== hit.sha || isHeldBack(head)) continue;
          if (kind !== undefined && kind !== null && head.kind !== kind) continue;
          out.push({ doc, hit });
        }
      }
    }
    return out;
  };

  const passageOf = (hit: VectorHit): Passage => ({
    start: hit.start,
    end: hit.end,
    similarity: round(hit.similarity, 4),
  });

  return {
    embedder,
    async find(q, findOptions = {}) {
      const query = parseQuery(q);
      if (query === undefined) return [];
      // the limit reads as the limit of `find` in the other modes: 1 to 1000, and 10 for a value that is not a number
      const limit = Math.max(1, Math.min(1000, Math.floor(findOptions.limit ?? 10) || 10));
      const candidates = count(
        "candidates",
        findOptions.candidates,
        HYBRID_DEFAULTS.candidates,
        1000,
      );
      const neighbors = count("neighbors", findOptions.neighbors, HYBRID_DEFAULTS.neighbors, 1000);
      const k = fusionKOf(findOptions.fusionK);
      const signal = findOptions.signal;
      // the question first: an embedder that does not work fails before any other work
      const vector = await queryVector(q, signal);
      const kind = findOptions.kind ?? null;
      const lexical = runtime.index.find(q, { limit: candidates, kind, rank: "exact" });
      await ensure(
        lexical.map((hit) => hit.doc),
        signal,
      );
      const near = neighborsOf(vector, neighbors, kind, undefined);
      const fused = fuseRanks([lexical.map((hit) => hit.doc), near.map((one) => one.doc)], k).slice(
        0,
        limit,
      );
      const byDoc = new Map(lexical.map((hit) => [hit.doc, hit]));
      const nearBy = new Map(near.map((one) => [one.doc, one.hit]));
      const results: Found[] = [];
      for (const one of fused) {
        const doc = runtime.index.get(one.id);
        if (doc === undefined || isHeldBack(doc)) continue;
        const best = nearBy.get(one.id) ?? store.best(embedder.id, sha256(doc.text), vector);
        const lexicalHit = byDoc.get(one.id);
        const archived = doc.kind === "archived" ? archivedOf(doc.meta) : undefined;
        results.push({
          doc: doc.doc,
          kind: doc.kind,
          title: doc.title,
          url: doc.url,
          snippet:
            best === undefined
              ? (lexicalHit?.snippet ?? snippetOf(doc.text, query.terms))
              : snippetOf(doc.text.slice(best.start, best.end), query.terms),
          score: round(one.score, 6),
          ai_input: doc.ai_input,
          fetched_at: doc.fetched_at,
          capture: doc.capture,
          ...(archived === undefined ? {} : { archived }),
          ...(best === undefined ? {} : { passage: passageOf(best) }),
        });
      }
      return results;
    },
    async rankWithin(q, docs, rankOptions = {}) {
      const query = parseQuery(q);
      if (query === undefined || docs.length === 0) return [];
      const candidates = count(
        "candidates",
        rankOptions.candidates,
        HYBRID_DEFAULTS.candidates,
        1000,
      );
      const neighbors = count(
        "neighbors",
        rankOptions.neighbors,
        HYBRID_DEFAULTS.neighbors,
        100_000,
      );
      const k = fusionKOf(rankOptions.fusionK);
      const signal = rankOptions.signal;
      const vector = await queryVector(q, signal);
      const lexical = runtime.index.rankWithin(q, docs, { rank: "exact" });
      // the BM25 matches first, then the other documents of the set, to the number of candidates
      const first = [...new Set([...lexical.map((hit) => hit.doc), ...docs])].slice(0, candidates);
      await ensure(first, signal);
      const within = new Set(docs);
      const near = neighborsOf(vector, neighbors, undefined, within);
      const nearBy = new Map(near.map((one) => [one.doc, one.hit]));
      const heads = headsOf(lexical.map((hit) => hit.doc).filter((doc) => !nearBy.has(doc)));
      return fuseRanks([lexical.map((hit) => hit.doc), near.map((one) => one.doc)], k).map(
        (one) => {
          const sha = heads.get(one.id)?.text_sha;
          const best =
            nearBy.get(one.id) ??
            (sha === undefined ? undefined : store.best(embedder.id, sha, vector));
          return {
            doc: one.id,
            score: round(one.score, 6),
            ...(best === undefined ? {} : { passage: passageOf(best) }),
          };
        },
      );
    },
    async embed(embedOptions = {}) {
      const started = Date.now();
      const budgetMs = durationMs(embedOptions.budget ?? "10m");
      const maxDocs =
        embedOptions.maxDocs === undefined
          ? Number.POSITIVE_INFINITY
          : count("maxDocs", embedOptions.maxDocs, 1, Number.MAX_SAFE_INTEGER);
      const kind = embedOptions.kind ?? null;
      // the budget aborts the call in progress too, so no embedding runs past it
      const timer = new AbortController();
      // a timer holds 2^31 - 1 ms at most: a longer budget waits that long, and the check of the time ends it
      const clock = setTimeout(
        () => timer.abort(new Error("the budget of embed is over")),
        Math.min(budgetMs, 2_147_483_647),
      );
      clock.unref();
      const signal =
        embedOptions.signal === undefined
          ? timer.signal
          : AbortSignal.any([embedOptions.signal, timer.signal]);
      const tally = { docs: 0, embedded: 0, reused: 0, held_back: 0, chunks: 0 };
      let stopped: EmbedStop = "done";
      const stopOf = (): EmbedStop | undefined =>
        embedOptions.signal?.aborted === true
          ? "signal"
          : timer.signal.aborted || Date.now() - started >= budgetMs
            ? "budget"
            : tally.embedded >= maxDocs
              ? "max-docs"
              : undefined;
      try {
        for await (const page of pagesOf(runtime)) {
          const docs = page.filter((head) => kind === null || head.kind === kind);
          for (let at = 0; at < docs.length;) {
            const stop = stopOf();
            if (stop !== undefined) {
              stopped = stop;
              break;
            }
            // a small group at a time, so the budget and maxDocs stop the work soon
            const room = Math.max(1, Math.min(BATCH, maxDocs - tally.embedded));
            const group = docs.slice(at, at + room).map((head) => head.doc);
            at += group.length;
            try {
              const done = await ensure(group, signal);
              tally.docs += group.length;
              tally.embedded += done.embedded;
              tally.reused += done.reused;
              tally.held_back += done.held;
              tally.chunks += done.chunks;
            } catch (error) {
              const stop = stopOf();
              if (stop === undefined) throw error;
              stopped = stop;
              break;
            }
          }
          if (stopped !== "done") break;
        }
      } finally {
        clearTimeout(clock);
      }
      return { embedder: embedder.id, ...tally, stopped, ms: Date.now() - started };
    },
  };
};

/**
 * This function gives the heads of each stored document, in pages. It uses `digests` when the
 * index has it. Else it reads the capture log and asks the index for the documents of each capture.
 */
async function* pagesOf(runtime: CrawlRuntime): AsyncGenerator<Head[]> {
  const index = runtime.index;
  if (index.digests !== undefined) {
    let after = "";
    for (;;) {
      const page = index.digests({ after, limit: 500 });
      if (page.length === 0) return;
      yield page;
      after = page.at(-1)!.doc;
    }
  }
  const seen = new Set<string>();
  let page: Head[] = [];
  for await (const envelope of runtime.captures.scan({ source: "fetch" })) {
    for (const doc of index.docsOfCapture(envelope.id)) {
      if (seen.has(doc.doc)) continue;
      seen.add(doc.doc);
      page.push({
        doc: doc.doc,
        kind: doc.kind,
        ai_input: doc.ai_input,
        text_sha: sha256(doc.text),
      });
      if (page.length >= 500) {
        yield page;
        page = [];
      }
    }
  }
  if (page.length > 0) yield page;
}
