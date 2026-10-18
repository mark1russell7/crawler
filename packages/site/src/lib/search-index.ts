/**
 * The full-text side of the figure "How hybrid search ranks": the corpus in the real index of
 * polite-crawler (SQLite FTS5 and BM25). The script of the figure and its test use this file. A page
 * does not import it, because the index needs `node:sqlite`.
 */
import { createHash } from "node:crypto";
import type { Found } from "polite-crawler";
import { DocIndex, HYBRID_DEFAULTS } from "polite-crawler";
import { CORPUS, FETCHED_AT, QUESTIONS } from "./search-corpus.ts";

/** One row of the full-text ranking: the page, and its BM25 score (larger is better). */
export interface LexicalHit {
  readonly doc: string;
  readonly score: number;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** This function gives the id of a page of the corpus in the index: `url:` and its URL. */
export const indexIdOf = (url: string): string => `url:${url}`;

/** This function gives the hash of the corpus and the questions. The data of the figure names it. */
export const corpusHash = (): string =>
  sha256(JSON.stringify({ corpus: CORPUS, questions: QUESTIONS })).slice(0, 16);

/** This function puts each page of the corpus into a new index in memory, as one version. */
export const corpusIndex = (): DocIndex => {
  const index = new DocIndex(":memory:");
  for (const doc of CORPUS) {
    index.upsert(
      {
        doc: indexIdOf(doc.url),
        kind: "page",
        title: doc.title,
        text: doc.text,
        url: doc.url,
        meta: {},
        captures: [`fetch.${sha256(doc.url).slice(0, 12)}`],
        fetched_at: FETCHED_AT,
      },
      FETCHED_AT,
    );
  }
  return index;
};

const ids = new Map(CORPUS.map((doc) => [indexIdOf(doc.url), doc.id]));

/** This function gives the short id of the corpus for an id of the index. */
export const corpusIdOf = (doc: string): string => {
  const id = ids.get(doc);
  if (id === undefined) throw new Error(`the index gave a page that is not in the corpus: ${doc}`);
  return id;
};

/** This function gives the full-text ranking of a question: the candidates of hybrid search. */
export const lexicalOf = (
  index: DocIndex,
  q: string,
  limit: number = HYBRID_DEFAULTS.candidates,
): LexicalHit[] =>
  index
    .find(q, { limit, rank: "exact" })
    .map((hit: Found) => ({ doc: corpusIdOf(hit.doc), score: hit.score }));
