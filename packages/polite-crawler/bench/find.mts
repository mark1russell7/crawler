/**
 * The search benchmark of finding S-30. It builds a synthetic index, times `find` and
 * `rankWithin` in each ranking mode, and compares the top 10 of each mode with exact ranking.
 *
 * Run it in CI (`.github/workflows/bench.yml`), not on a shared computer: the build of the
 * index takes about a minute and the timed queries use one core for some minutes.
 *
 *   pnpm exec tsx packages/polite-crawler/bench/find.mts --docs 30000 --out bench-find.json
 *
 * Options: --docs (30000), --words (900 a document), --runs (5 timed runs a question), --modes
 * (a comma list, default each mode), --corpus (zipf or dense), --out (the JSON results), --summary
 * (a file that gets a Markdown table, for example $GITHUB_STEP_SUMMARY), --hybrid (also time
 * hybrid search) and --dims (384, the dimensions of the vectors of --hybrid).
 *
 * The mode --hybrid measures time only. A fake embedder of almost no cost gives the vectors, so
 * the times are the times of the chunks, the vector store, the brute-force cosine and the fusion.
 * The time of a real model comes on top: it depends on the model and the computer.
 *
 * The corpus `zipf` (the default): a Zipf spread (s = 1) over 60,000 words with the English stop
 * words at the top, and 400 topics that give each document bursts of its own words. The corpus
 * `dense` is the corpus of the review (t20-find-scale.ts): 8,000 words, the rank of each word is
 * 8,000 × u³ for a uniform u, and no topics. Thus almost each word is in almost each document. A
 * document has 900 words, a title of 6 words, the kind `pdf` for one document in 10 and
 * `ai_input: "no"` for one in 100.
 *
 * The quality of a mode is its top 10 against the top 10 of `exact` for the same question:
 * overlap@10 is the share of the exact top 10 that the mode also gives, and Kendall tau is the
 * agreement of the order of the documents that the two lists share (1 is the same order).
 */
import { appendFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { DocIndex, parseQuery } from "../src/docs.ts";
import type { DocInput } from "../src/docs.ts";
import { snippetOf } from "../src/fold.ts";
import type { Embedder } from "../src/embed.ts";
import { unitVector } from "../src/embed.ts";
import { createHybridSearch } from "../src/hybrid.ts";
import type { CrawlRuntime } from "../src/runtime.ts";
import { VectorStore } from "../src/vectors.ts";

const { values: args } = parseArgs({
  options: {
    docs: { type: "string", default: "30000" },
    words: { type: "string", default: "900" },
    runs: { type: "string", default: "5" },
    modes: { type: "string", default: "" },
    corpus: { type: "string", default: "zipf" },
    out: { type: "string", default: "bench-find.json" },
    summary: { type: "string" },
    hybrid: { type: "boolean", default: false },
    dims: { type: "string", default: "384" },
  },
});
// an empty value (a workflow input that a person cleared, or a push event) takes the default
const DOCS = Number(args.docs) || 30_000;
const WORDS = Number(args.words) || 900;
const RUNS = Math.max(1, Number(args.runs) || 5);
const LIMIT = 10;
const CORPUS = args.corpus === "dense" ? "dense" : "zipf";

// ── a seeded random source, so each run builds the same corpus and asks the same questions ──
const random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ── the vocabulary ──
const STOP = [
  "the",
  "of",
  "and",
  "to",
  "a",
  "in",
  "is",
  "for",
  "on",
  "that",
  "with",
  "as",
  "by",
  "it",
  "at",
  "from",
  "this",
  "be",
  "or",
  "are",
  "was",
  "an",
  "which",
  "what",
  "how",
  "when",
  "where",
  "who",
];
const VOCAB_SIZE = CORPUS === "dense" ? 8000 : 60_000;
const vocabRandom = random(11);
const vocab: string[] = [...STOP];
{
  const seen = new Set(vocab);
  const consonants = "bcdfghjklmnprstvz";
  const vowels = "aiou";
  const last = "aou";
  while (vocab.length < VOCAB_SIZE) {
    const syllables = 2 + Math.floor(vocabRandom() * 3);
    let word = "";
    for (let at = 0; at < syllables; at += 1) {
      word += consonants[Math.floor(vocabRandom() * consonants.length)];
      const pool = at === syllables - 1 ? last : vowels;
      word += pool[Math.floor(vocabRandom() * pool.length)];
    }
    if (!seen.has(word)) {
      seen.add(word);
      vocab.push(word);
    }
  }
}
// the cumulative Zipf weights: rank r has the weight 1 / (r + 1)
const cdf = new Float64Array(VOCAB_SIZE);
{
  let sum = 0;
  for (let rank = 0; rank < VOCAB_SIZE; rank += 1) {
    sum += 1 / (rank + 1);
    cdf[rank] = sum;
  }
  for (let rank = 0; rank < VOCAB_SIZE; rank += 1) cdf[rank] = cdf[rank]! / sum;
}
const zipf = (next: () => number): string => {
  const u = next();
  if (CORPUS === "dense") return vocab[Math.floor(u ** 3 * VOCAB_SIZE)]!;
  let low = 0;
  let high = VOCAB_SIZE - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cdf[middle]! < u) low = middle + 1;
    else high = middle;
  }
  return vocab[low]!;
};
/** This function moves a rank of the zipf corpus to the same place in the vocabulary of the corpus. The stop words keep their ranks. */
const scaled = (rank: number): number =>
  rank < STOP.length
    ? rank
    : STOP.length +
      Math.floor(((rank - STOP.length) * (VOCAB_SIZE - STOP.length)) / (60_000 - STOP.length));
/** The share of the words of a document that come from its topics. */
const TOPIC_SHARE = CORPUS === "dense" ? 0 : 0.1;
const TOPICS = 400;
const TOPIC_WORDS = 25;
const topics: string[][] = [];
{
  const topicRandom = random(23);
  for (let topic = 0; topic < TOPICS; topic += 1) {
    const words = new Set<string>();
    while (words.size < TOPIC_WORDS)
      words.add(vocab[scaled(300 + Math.floor(topicRandom() * 29_700))]!);
    topics.push([...words]);
  }
}

// ── the corpus ──
const dir = mkdtempSync(join(tmpdir(), "polite-crawler-bench-"));
const index = new DocIndex(join(dir, "index.sqlite"));
const built = performance.now();
{
  const docRandom = random(37);
  const build = index.beginRebuild({ batch: 1000 });
  for (let doc = 0; doc < DOCS; doc += 1) {
    const first = topics[Math.floor(docRandom() * TOPICS)]!;
    const second = topics[Math.floor(docRandom() * TOPICS)]!;
    const words: string[] = [];
    for (let at = 0; at < WORDS; at += 1) {
      if (docRandom() < TOPIC_SHARE) {
        const topic = docRandom() < 0.7 ? first : second;
        words.push(topic[Math.floor(docRandom() * TOPIC_WORDS)]!);
      } else words.push(zipf(docRandom));
    }
    const title = [
      first[Math.floor(docRandom() * TOPIC_WORDS)]!,
      first[Math.floor(docRandom() * TOPIC_WORDS)]!,
      zipf(docRandom),
      zipf(docRandom),
      zipf(docRandom),
      zipf(docRandom),
    ].join(" ");
    const input: DocInput = {
      doc: `d${String(doc)}`,
      kind: doc % 10 === 0 ? "pdf" : "page",
      title,
      text: words.join(" "),
      url: `https://example.org/${String(doc)}`,
      meta: {},
      captures: [`fetch.${doc.toString(16).padStart(12, "0")}`],
      ai_input: doc % 100 === 7 ? "no" : "unset",
      fetched_at: "2026-10-01T00:00:00.000Z",
    };
    build.upsert(input, "2026-10-01T00:00:00.000Z");
  }
  build.commit("2026-10-01T00:00:00.000Z");
}
const buildMs = Math.round(performance.now() - built);

// ── the questions ──
const questionRandom = random(53);
const pick = <T,>(list: readonly T[]): T => list[Math.floor(questionRandom() * list.length)]!;
const band = (from: number, to: number): string => {
  const low = scaled(from);
  const high = Math.max(low + 1, scaled(to));
  return vocab[low + Math.floor(questionRandom() * (high - low))]!;
};
const shuffle = <T,>(list: T[]): T[] => {
  for (let at = list.length - 1; at > 0; at -= 1) {
    const other = Math.floor(questionRandom() * (at + 1));
    [list[at], list[other]] = [list[other]!, list[at]!];
  }
  return list;
};
interface Question {
  readonly set: "1 word" | "4 words" | "16 words";
  readonly q: string;
  readonly kind?: string | undefined;
}
const questions: Question[] = [];
for (const word of [
  "the",
  band(28, 60),
  band(60, 150),
  band(150, 400),
  band(400, 1000),
  band(1000, 3000),
  band(3000, 10_000),
  band(10_000, 30_000),
  band(30_000, 60_000),
  pick(pick(topics)),
  pick(pick(topics)),
  pick(pick(topics)),
]) {
  questions.push({ set: "1 word", q: word });
}
for (let at = 0; at < 12; at += 1) {
  const topic = pick(topics);
  const words =
    at % 3 === 0
      ? [pick(STOP), pick(topic), pick(topic), band(28, 400)]
      : at % 3 === 1
        ? [band(28, 200), band(200, 2000), band(2000, 20_000), pick(STOP)]
        : [pick(topic), pick(topic), pick(topic), band(28, 3000)];
  questions.push({ set: "4 words", q: shuffle(words).join(" ") });
}
for (let at = 0; at < 12; at += 1) {
  const topic = pick(topics);
  const words = [
    ...Array.from({ length: 6 }, () => pick(STOP)),
    band(28, 200),
    band(28, 200),
    band(28, 200),
    band(200, 3000),
    band(200, 3000),
    band(200, 3000),
    pick(topic),
    pick(topic),
    pick(topic),
    band(3000, 60_000),
  ];
  questions.push({ set: "16 words", q: shuffle(words).join(" ") });
}
// the 16-word questions again, for one kind of document
for (const question of questions.filter((one) => one.set === "16 words").slice(0, 4))
  questions.push({ ...question, kind: "pdf" });

// ── the modes ──
const db = (index as unknown as { db: DatabaseSync }).db;
const generation = (
  db.prepare("SELECT value FROM index_meta WHERE key = 'generation'").get() as { value: string }
).value;
const fts = `fts_${generation}`;
const docsTable = `docs_${generation}`;
const textsTable = `texts_${generation}`;
const statements = new Map<string, StatementSync>();
const stmt = (sql: string): StatementSync => {
  let statement = statements.get(sql);
  if (statement === undefined) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
};
const docCount = (stmt(`SELECT count(*) AS n FROM ${docsTable}`).get() as { n: number }).n;

/** The parts of a query, as `parseQuery` quotes them, with the stop words marked. */
const partsOf = (q: string): { all: string[]; any: string[] } | undefined => {
  const query = parseQuery(q);
  if (query === undefined) return undefined;
  return { all: query.all.split(" AND "), any: query.any.split(" OR ") };
};
const dfCache = new Map<string, number>();
/** This function counts the documents that hold one part. The bench keeps the counts, so a mode pays for them only in the first run. */
const dfOf = (part: string, cache: boolean): number => {
  const known = cache ? dfCache.get(part) : undefined;
  if (known !== undefined) return known;
  const n = (
    stmt(`SELECT count(*) AS n FROM ${fts} WHERE ${fts} MATCH ?`).get(part) as { n: number }
  ).n;
  if (cache) dfCache.set(part, n);
  return n;
};

interface Ranked {
  readonly docs: string[];
}

/** The ranked query of `DocIndex.find`, with the full rows (`d.*`) in the sort. */
const rankedFull = (match: string, kind: string | undefined, limit: number) =>
  stmt(
    `SELECT d.rowid AS rowid, d.*, bm25(${fts}, 3.0, 1.0) AS rank
       FROM ${fts} JOIN ${docsTable} d ON d.rowid = ${fts}.rowid
      WHERE ${fts} MATCH ? AND d.ai_input != 'no' ${kind === undefined ? "" : "AND d.kind = ?"}
      ORDER BY rank LIMIT ?`,
  ).all(...(kind === undefined ? [match, limit] : [match, kind, limit])) as Array<{
    doc: string;
    text_sha: string;
  }>;

/** The same ranking, with only the row id and the rank in the sort. */
const rankedLean = (match: string, kind: string | undefined, limit: number) => {
  const ids = stmt(
    `SELECT ${fts}.rowid AS rowid, bm25(${fts}, 3.0, 1.0) AS rank
       FROM ${fts} JOIN ${docsTable} d ON d.rowid = ${fts}.rowid
      WHERE ${fts} MATCH ? AND d.ai_input != 'no' ${kind === undefined ? "" : "AND d.kind = ?"}
      ORDER BY rank LIMIT ?`,
  ).all(...(kind === undefined ? [match, limit] : [match, kind, limit])) as Array<{
    rowid: number;
  }>;
  const row = stmt(`SELECT doc, text_sha FROM ${docsTable} WHERE rowid = ?`);
  return ids.map((id) => row.get(id.rowid) as { doc: string; text_sha: string });
};

/** The same ranking, sorted inside FTS5 (`ORDER BY rank`), so the join reads only the rows that it gives. */
const rankedInside = (match: string, kind: string | undefined, limit: number) =>
  stmt(
    `SELECT d.doc AS doc, d.text_sha AS text_sha
       FROM ${fts} JOIN ${docsTable} d ON d.rowid = ${fts}.rowid
      WHERE ${fts} MATCH ? AND ${fts}.rank MATCH 'bm25(3.0, 1.0)'
        AND d.ai_input != 'no' ${kind === undefined ? "" : "AND d.kind = ?"}
      ORDER BY ${fts}.rank LIMIT ?`,
  ).all(...(kind === undefined ? [match, limit] : [match, kind, limit])) as Array<{
    doc: string;
    text_sha: string;
  }>;

type Ranker = typeof rankedFull;

/** The snippets of the hits, as `DocIndex.find` makes them, so each mode does the same work. */
const withSnippets = (rows: Array<{ doc: string; text_sha: string }>, q: string): Ranked => {
  const terms = parseQuery(q)?.terms ?? [];
  const text = stmt(`SELECT body FROM ${textsTable} WHERE sha = ?`);
  for (const row of rows)
    snippetOf((text.get(row.text_sha) as { body: string } | undefined)?.body ?? "", terms);
  return { docs: rows.map((row) => row.doc) };
};

/** The rule of `DocIndex.find`: each part first, then one part, for the hits that are missing. */
type Parts = { all: string[]; any: string[] };
type Hit = { doc: string; text_sha: string };

/** The rule of `DocIndex.find`, with the one-part phase of a mode. */
const findWithRows = (
  ranker: Ranker,
  q: string,
  kind: string | undefined,
  orRows: (parts: Parts, kind: string | undefined) => Hit[],
): Ranked => {
  const parts = partsOf(q);
  if (parts === undefined) return { docs: [] };
  const rows: Hit[] = ranker(parts.all.join(" AND "), kind, LIMIT);
  if (rows.length < LIMIT && parts.all.length > 1) {
    const seen = new Set(rows.map((row) => row.doc));
    for (const row of orRows(parts, kind)) {
      if (rows.length >= LIMIT) break;
      if (!seen.has(row.doc)) rows.push(row);
    }
  }
  return withSnippets(rows, q);
};

const findWith = (
  ranker: Ranker,
  q: string,
  kind: string | undefined,
  any: (parts: Parts) => string,
): Ranked => findWithRows(ranker, q, kind, (parts, which) => ranker(any(parts), which, LIMIT));

/** The exact ranking of the full query, for the documents that hold one of the candidate parts. */
const rankedRescore = (
  match: string,
  candidates: string,
  kind: string | undefined,
  limit: number,
) =>
  stmt(
    `SELECT d.doc AS doc, d.text_sha AS text_sha, bm25(${fts}, 3.0, 1.0) AS rank
       FROM ${fts} JOIN ${docsTable} d ON d.rowid = ${fts}.rowid
      WHERE ${fts} MATCH ? AND +${fts}.rowid IN (SELECT rowid FROM ${fts}(?))
        AND d.ai_input != 'no' ${kind === undefined ? "" : "AND d.kind = ?"}
      ORDER BY rank LIMIT ?`,
  ).all(
    ...(kind === undefined ? [match, candidates, limit] : [match, candidates, kind, limit]),
  ) as Array<Hit & { rank: number }>;

/** The IDF of FTS5 for a part that `df` of the documents hold. */
const idfOf = (df: number): number => {
  const idf = Math.log((docCount - df + 0.5) / (df + 0.5));
  return idf <= 0 ? 1e-6 : idf;
};
const K1 = 1.2;
/** This value tells if the last query of a `safe` mode proved its top 10. */
let certified: boolean | undefined;

/**
 * The one-part phase of `safe`: rank the documents that hold a part that at most `share` of the
 * documents hold, with the full query (MaxScore). A document outside that set holds only the
 * common parts, so its score is at most the sum of their bounds, idf x (k1 + 1). When the 10th
 * score of the set is higher than that sum, the top 10 is the exact top 10. Else the phase ranks
 * each match, as exact does.
 */
const safeRows =
  (share: number) =>
  (parts: Parts, kind: string | undefined): Hit[] => {
    const full = parts.any.join(" OR ");
    const counted = parts.any.map((part) => ({ part, df: dfOf(part, false) }));
    const kept = counted.filter((one) => one.df <= share * docCount);
    const dropped = counted.filter((one) => one.df > share * docCount);
    if (kept.length === 0 || dropped.length === 0) {
      certified = dropped.length === 0;
      return rankedFull(full, kind, LIMIT);
    }
    const rows = rankedRescore(full, kept.map((one) => one.part).join(" OR "), kind, LIMIT);
    // a margin of 1 % covers a count of FTS5 rows that differs a little from the count of documents
    const bound = 1.01 * dropped.reduce((sum, one) => sum + (K1 + 1) * idfOf(one.df), 0);
    if (rows.length === LIMIT && -rows[LIMIT - 1]!.rank > bound) {
      certified = true;
      return rows;
    }
    certified = false;
    return rankedFull(full, kind, LIMIT);
  };

const rankWithinWith = (
  q: string,
  ids: { readonly json: string },
  match: (any: string[]) => string,
): Ranked => {
  const parts = partsOf(q);
  if (parts === undefined) return { docs: [] };
  const rows = stmt(
    `SELECT d.doc AS doc, bm25(${fts}, 3.0, 1.0) AS rank
       FROM ${fts} JOIN ${docsTable} d ON d.rowid = ${fts}.rowid
      WHERE ${fts} MATCH ? AND d.ai_input != 'no' AND d.doc IN (SELECT value FROM json_each(?))
      ORDER BY rank`,
  ).all(match(parts.any), ids.json) as Array<{ doc: string }>;
  return { docs: rows.map((row) => row.doc) };
};

/** This function keeps the parts that at most `share` of the documents hold, and the rarest part when none is left. */
const prune = (parts: readonly string[], share: number, cache: boolean): string[] => {
  const counted = parts.map((part) => ({ part, df: dfOf(part, cache) }));
  const kept = counted.filter((one) => one.df <= share * docCount);
  if (kept.length > 0) return kept.map((one) => one.part);
  const rarest = counted.reduce((best, one) => (one.df < best.df ? one : best));
  return [rarest.part];
};
const rarest = (parts: readonly string[], keep: number, cache: boolean): string[] =>
  parts
    .map((part) => ({ part, df: dfOf(part, cache) }))
    .sort((a, b) => a.df - b.df)
    .slice(0, keep)
    .map((one) => one.part);

interface Mode {
  readonly name: string;
  readonly about: string;
  readonly find: (q: string, kind: string | undefined) => Ranked;
  /** The ids come as a list and as the JSON of the list, so a mode does not pay for the conversion. */
  readonly rankWithin: (
    q: string,
    ids: { readonly list: string[]; readonly json: string },
  ) => Ranked;
}
const MODES: Mode[] = [
  {
    name: "exact",
    about: "the library: DocIndex.find and DocIndex.rankWithin as they are",
    find: (q, kind) => ({
      docs: index.find(q, { limit: LIMIT, kind: kind ?? null }).map((hit) => hit.doc),
    }),
    rankWithin: (q, ids) => ({ docs: index.rankWithin(q, ids.list).map((hit) => hit.doc) }),
  },
  {
    name: "fast",
    about: 'the library with rank: "fast" (prune20 in the library: the counts at each query)',
    find: (q, kind) => ({
      docs: index.find(q, { limit: LIMIT, kind: kind ?? null, rank: "fast" }).map((hit) => hit.doc),
    }),
    rankWithin: (q, ids) => ({
      docs: index.rankWithin(q, ids.list, { rank: "fast" }).map((hit) => hit.doc),
    }),
  },
  {
    name: "exact-sql",
    about: "a copy of the SQL of exact in the bench, to check that the copy agrees",
    find: (q, kind) => findWith(rankedFull, q, kind, (parts) => parts.any.join(" OR ")),
    rankWithin: (q, ids) => rankWithinWith(q, ids, (any) => any.join(" OR ")),
  },
  {
    name: "lean",
    about: "exact ranking; the sort holds only the row id and the rank, and the rows come after",
    find: (q, kind) => findWith(rankedLean, q, kind, (parts) => parts.any.join(" OR ")),
    rankWithin: (q, ids) => rankWithinWith(q, ids, (any) => any.join(" OR ")),
  },
  {
    name: "inside",
    about:
      "exact ranking; FTS5 sorts by its rank column, and the join reads only the rows it gives",
    find: (q, kind) => findWith(rankedInside, q, kind, (parts) => parts.any.join(" OR ")),
    rankWithin: (q, ids) => rankWithinWith(q, ids, (any) => any.join(" OR ")),
  },
  ...[0.5, 0.2, 0.1].map((share): Mode => ({
    name: `prune${String(Math.round(share * 100))}`,
    about: `the one-part query leaves out the parts that more than ${String(Math.round(share * 100))} % of the documents hold (counted at each query)`,
    find: (q, kind) =>
      findWith(rankedFull, q, kind, (parts) => prune(parts.any, share, false).join(" OR ")),
    rankWithin: (q, ids) => rankWithinWith(q, ids, (any) => prune(any, share, false).join(" OR ")),
  })),
  {
    name: "prune20-cached",
    about:
      "prune20 with the document counts kept between queries (the cost of the counts left out)",
    find: (q, kind) =>
      findWith(rankedFull, q, kind, (parts) => prune(parts.any, 0.2, true).join(" OR ")),
    rankWithin: (q, ids) => rankWithinWith(q, ids, (any) => prune(any, 0.2, true).join(" OR ")),
  },
  {
    name: "rescore20",
    about:
      "the one-part phase ranks with the full query, but only the documents that hold a part that at most 20 % of the documents hold",
    find: (q, kind) =>
      findWithRows(rankedFull, q, kind, (parts, which) => {
        const kept = prune(parts.any, 0.2, false);
        return kept.length === parts.any.length
          ? rankedFull(parts.any.join(" OR "), which, LIMIT)
          : rankedRescore(parts.any.join(" OR "), kept.join(" OR "), which, LIMIT);
      }),
    rankWithin: (q, ids) => {
      const parts = partsOf(q);
      if (parts === undefined) return { docs: [] };
      const kept = prune(parts.any, 0.2, false);
      const rows = stmt(
        `SELECT d.doc AS doc, bm25(${fts}, 3.0, 1.0) AS rank
           FROM ${fts} JOIN ${docsTable} d ON d.rowid = ${fts}.rowid
          WHERE ${fts} MATCH ? AND +${fts}.rowid IN (SELECT rowid FROM ${fts}(?))
            AND d.ai_input != 'no' AND d.doc IN (SELECT value FROM json_each(?))
          ORDER BY rank`,
      ).all(parts.any.join(" OR "), kept.join(" OR "), ids.json) as Array<{ doc: string }>;
      return { docs: rows.map((row) => row.doc) };
    },
  },
  ...[0.2, 0.1].map((share): Mode => ({
    name: `safe${String(Math.round(share * 100))}`,
    about: `exact top 10 (MaxScore): rescore${String(Math.round(share * 100))}, and exact ranking when the bound of the common parts does not prove the top 10; rankWithin is exact`,
    find: (q, kind) => findWithRows(rankedFull, q, kind, safeRows(share)),
    rankWithin: (q, ids) => rankWithinWith(q, ids, (any) => any.join(" OR ")),
  })),
  {
    name: "rarest3",
    about: "the one-part query keeps only the 3 rarest parts",
    find: (q, kind) =>
      findWith(rankedFull, q, kind, (parts) => rarest(parts.any, 3, false).join(" OR ")),
    rankWithin: (q, ids) => rankWithinWith(q, ids, (any) => rarest(any, 3, false).join(" OR ")),
  },
];
const wanted = args.modes
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
const modes = MODES.filter(
  (mode) => mode.name === "exact" || wanted.length === 0 || wanted.includes(mode.name),
);

// ── the measurement ──
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const quantile = (values: readonly number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
const round = (value: number): number => Math.round(value * 100) / 100;
const time = (work: () => Ranked): { ms: number; result: Ranked } => {
  let result = work();
  const times: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const start = performance.now();
    result = work();
    times.push(performance.now() - start);
  }
  return { ms: median(times), result };
};
/** The share of the exact top 10 that a list also has in its top 10. A question with no exact hit gives 1. */
const overlapAt10 = (exact: readonly string[], other: readonly string[]): number => {
  const top = exact.slice(0, LIMIT);
  if (top.length === 0) return other.length === 0 ? 1 : 0;
  const mine = new Set(other.slice(0, LIMIT));
  return top.filter((doc) => mine.has(doc)).length / top.length;
};
/** Kendall tau of the order of the documents that the two top 10 lists share. Fewer than 2 shared documents give 1. */
const tauAt10 = (exact: readonly string[], other: readonly string[]): number => {
  const position = new Map(other.slice(0, LIMIT).map((doc, at) => [doc, at]));
  const shared = exact.slice(0, LIMIT).filter((doc) => position.has(doc));
  if (shared.length < 2) return 1;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < shared.length; i += 1)
    for (let j = i + 1; j < shared.length; j += 1) {
      if (position.get(shared[i]!)! < position.get(shared[j]!)!) concordant += 1;
      else discordant += 1;
    }
  return (concordant - discordant) / (concordant + discordant);
};

interface Cell {
  readonly mode: string;
  /** For a safe mode: true when the bound proved the top 10 of the one-part phase, false when the mode ranked each match. */
  readonly certified?: boolean | undefined;
  readonly ms: number;
  readonly hits: number;
  readonly overlap10: number;
  readonly tau10: number;
  /** For rankWithin: the share of the documents of exact that the mode also gives. */
  readonly recall?: number | undefined;
}
interface Row {
  readonly task: string;
  readonly set: string;
  readonly q: string;
  readonly kind?: string | undefined;
  /** The counts of the documents that hold each part of the query. */
  readonly df: Record<string, number>;
  readonly cells: Cell[];
}
const rows: Row[] = [];
const dfTable = (q: string): Record<string, number> =>
  Object.fromEntries((partsOf(q)?.all ?? []).map((part) => [part, dfOf(part, false)]));

for (const question of questions) {
  const cells: Cell[] = [];
  let exact: Ranked | undefined;
  for (const mode of modes) {
    certified = undefined;
    const { ms, result } = time(() => mode.find(question.q, question.kind));
    exact ??= result;
    cells.push({
      mode: mode.name,
      ...(certified !== undefined ? { certified } : {}),
      ms: round(ms),
      hits: result.docs.length,
      overlap10: round(overlapAt10(exact.docs, result.docs)),
      tau10: round(tauAt10(exact.docs, result.docs)),
    });
  }
  rows.push({
    task: "find",
    set: question.set,
    q: question.q,
    ...(question.kind !== undefined ? { kind: question.kind } : {}),
    df: dfTable(question.q),
    cells,
  });
  console.error(
    `find ${question.set}${question.kind ? ` kind=${question.kind}` : ""}: ${cells.map((cell) => `${cell.mode} ${String(cell.ms)} ms`).join(", ")}`,
  );
}

// rankWithin on 40,000 ids: each document of the corpus and 10,000 ids that are not in it
const idList = Array.from({ length: Math.max(40_000, DOCS) }, (_, at) => `d${String(at)}`);
const ids = { list: idList, json: JSON.stringify(idList) };
for (const question of questions.filter((one) => one.kind === undefined)) {
  const cells: Cell[] = [];
  let exact: Ranked | undefined;
  for (const mode of modes) {
    const { ms, result } = time(() => mode.rankWithin(question.q, ids));
    exact ??= result;
    const mine = new Set(result.docs);
    cells.push({
      mode: mode.name,
      ms: round(ms),
      hits: result.docs.length,
      overlap10: round(overlapAt10(exact.docs, result.docs)),
      tau10: round(tauAt10(exact.docs, result.docs)),
      recall: round(
        exact.docs.length === 0
          ? 1
          : exact.docs.filter((doc) => mine.has(doc)).length / exact.docs.length,
      ),
    });
  }
  rows.push({
    task: "rankWithin 40k ids",
    set: question.set,
    q: question.q,
    df: dfTable(question.q),
    cells,
  });
  console.error(
    `rankWithin ${question.set}: ${cells.map((cell) => `${cell.mode} ${String(cell.ms)} ms`).join(", ")}`,
  );
}

// ── the summary: for each task, set and mode, the median and the slowest time, and the quality ──
interface Summary {
  readonly task: string;
  readonly set: string;
  readonly mode: string;
  readonly medianMs: number;
  readonly p90Ms: number;
  readonly maxMs: number;
  /** The median time of exact divided by the median time of the mode. */
  readonly speedup: number;
  readonly meanOverlap10: number;
  readonly minOverlap10: number;
  readonly meanTau10: number;
  readonly meanRecall?: number | undefined;
  /** For a safe mode: the share of the questions with a one-part phase whose top 10 the bound proved. */
  readonly certifiedShare?: number | undefined;
}
const summary: Summary[] = [];
const groups = new Map<string, Row[]>();
for (const row of rows) {
  const key = `${row.task}\u0000${row.set}${row.kind ? ` kind=${row.kind}` : ""}`;
  groups.set(key, [...(groups.get(key) ?? []), row]);
}
for (const [key, group] of groups) {
  const [task, set] = key.split("\u0000") as [string, string];
  const exactMedian = median(group.map((row) => row.cells[0]!.ms));
  for (const [at, mode] of modes.entries()) {
    const cells = group.map((row) => row.cells[at]!);
    const times = cells.map((cell) => cell.ms);
    const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
    const recalls = cells.flatMap((cell) => (cell.recall === undefined ? [] : [cell.recall]));
    const proofs = cells.flatMap((cell) =>
      cell.certified === undefined ? [] : [cell.certified ? 1 : 0],
    );
    summary.push({
      task,
      set,
      mode: mode.name,
      medianMs: round(median(times)),
      p90Ms: round(quantile(times, 0.9)),
      maxMs: round(Math.max(...times)),
      speedup: round(exactMedian / Math.max(0.01, median(times))),
      meanOverlap10: round(mean(cells.map((cell) => cell.overlap10))),
      minOverlap10: round(Math.min(...cells.map((cell) => cell.overlap10))),
      meanTau10: round(mean(cells.map((cell) => cell.tau10))),
      ...(recalls.length > 0 ? { meanRecall: round(mean(recalls)) } : {}),
      ...(proofs.length > 0 ? { certifiedShare: round(mean(proofs)) } : {}),
    });
  }
}

// ── the mode --hybrid: the time of hybrid search, with a fake embedder ──
interface HybridRow {
  readonly task: string;
  readonly set: string;
  readonly medianMs: number;
  readonly p90Ms: number;
  readonly maxMs: number;
}
interface HybridReport {
  readonly dims: number;
  readonly embed: Record<string, unknown>;
  readonly embedMs: number;
  readonly chunks: number;
  readonly vectorBytes: number;
  readonly fileBytes: number;
  /** The first search reads each vector into memory. */
  readonly firstSearchMs: number;
  readonly rows: HybridRow[];
}
let hybrid: HybridReport | undefined;
if (args.hybrid === true) {
  const DIMS = Number(args.dims) || 384;
  /** Each word adds 1 or -1 to 8 dimensions that a hash of the word chooses. */
  const embedder: Embedder = {
    id: `bench:hash-${String(DIMS)}`,
    dimensions: DIMS,
    maxInputTokens: 512,
    embed: (texts) =>
      Promise.resolve(
        texts.map((text) => {
          const vector = new Float32Array(DIMS);
          for (const word of text.split(/\s+/)) {
            let hash = 2_166_136_261;
            for (let at = 0; at < word.length; at += 1)
              hash = Math.imul(hash ^ word.charCodeAt(at), 16_777_619);
            for (let k = 0; k < 8; k += 1) {
              hash = Math.imul(hash ^ (hash >>> 15), 2_246_822_507) >>> 0;
              vector[hash % DIMS] = vector[hash % DIMS]! + ((hash & 1) === 0 ? 1 : -1);
            }
          }
          return vector;
        }),
      ),
  };
  const store = new VectorStore(join(dir, "vectors.sqlite"));
  // the hybrid search reads only the index and the clock of a runtime
  const runtime = { index, now: () => new Date().toISOString() } as unknown as CrawlRuntime;
  const search = createHybridSearch(runtime, { embedder, store });
  const embedStart = performance.now();
  const embedded = await search.embed({ budget: "3h" });
  const embedMs = Math.round(performance.now() - embedStart);
  const counts = store.counts(embedder.id);
  console.error(
    `hybrid: embed ${String(embedMs)} ms, ${String(counts.chunks)} chunks (${JSON.stringify(embedded)})`,
  );
  const firstStart = performance.now();
  await search.find(questions[0]!.q);
  const firstSearchMs = round(performance.now() - firstStart);
  const timeAsync = async (work: () => Promise<unknown>): Promise<number> => {
    await work();
    const times: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const start = performance.now();
      await work();
      times.push(performance.now() - start);
    }
    return median(times);
  };
  const hybridRows: HybridRow[] = [];
  const addRows = (task: string, perSet: Map<string, number[]>): void => {
    for (const [set, times] of perSet) {
      hybridRows.push({
        task,
        set,
        medianMs: round(median(times)),
        p90Ms: round(quantile(times, 0.9)),
        maxMs: round(Math.max(...times)),
      });
    }
  };
  const findTimes = new Map<string, number[]>();
  const withinTimes = new Map<string, number[]>();
  for (const question of questions) {
    const set = `${question.set}${question.kind === undefined ? "" : ` kind=${question.kind}`}`;
    const ms = await timeAsync(() =>
      search.find(question.q, { limit: LIMIT, kind: question.kind ?? null }),
    );
    findTimes.set(set, [...(findTimes.get(set) ?? []), ms]);
    if (question.kind === undefined) {
      const within = await timeAsync(() => search.rankWithin(question.q, ids.list));
      withinTimes.set(set, [...(withinTimes.get(set) ?? []), within]);
    }
    console.error(`hybrid find ${set}: ${String(round(ms))} ms`);
  }
  addRows("find hybrid", findTimes);
  addRows("rankWithin hybrid 40k ids", withinTimes);
  // the brute-force cosine alone: a question against each stored vector
  const scanRandom = random(71);
  const scans: number[] = [];
  for (let at = 0; at < 12; at += 1) {
    const query = unitVector(Array.from({ length: DIMS }, () => scanRandom() - 0.5));
    scans.push(await timeAsync(() => Promise.resolve(store.search(embedder.id, query))));
  }
  addRows("cosine of each vector", new Map([["12 random questions", scans]]));
  const file = join(dir, "vectors.sqlite");
  const fileBytes =
    statSync(file).size + (existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0);
  hybrid = {
    dims: DIMS,
    embed: { ...embedded },
    embedMs,
    chunks: counts.chunks,
    vectorBytes: counts.bytes,
    fileBytes,
    firstSearchMs,
    rows: hybridRows,
  };
  store.close();
}

const sqlite = (db.prepare("SELECT sqlite_version() AS version").get() as { version: string })
  .version;
const environment = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  cpu: cpus()[0]?.model ?? "unknown",
  cores: cpus().length,
  sqlite,
  corpus: CORPUS,
  docs: DOCS,
  words: WORDS,
  runs: RUNS,
  buildMs,
  docCount,
};
writeFileSync(
  args.out,
  `${JSON.stringify({ environment, modes: modes.map(({ name, about }) => ({ name, about })), summary, rows, ...(hybrid === undefined ? {} : { hybrid }) }, null, 2)}\n`,
);

const table = [
  `### find and rankWithin: ${String(DOCS)} documents of ${String(WORDS)} words (corpus ${CORPUS})`,
  "",
  `Node.js ${process.version}, SQLite ${sqlite}, ${environment.cpu}. The index took ${String(buildMs)} ms to build. Each time is the median of ${String(RUNS)} runs of one question; a set has 12 questions.`,
  "",
  "| task | set | mode | median ms | p90 ms | max ms | speedup | overlap@10 (mean, min) | tau@10 | recall | proved |",
  "| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |",
  ...summary.map(
    (one) =>
      `| ${one.task} | ${one.set} | ${one.mode} | ${String(one.medianMs)} | ${String(one.p90Ms)} | ${String(one.maxMs)} | ${String(one.speedup)}x | ${String(one.meanOverlap10)}, ${String(one.minOverlap10)} | ${String(one.meanTau10)} | ${one.meanRecall === undefined ? "" : String(one.meanRecall)} | ${one.certifiedShare === undefined ? "" : String(one.certifiedShare)} |`,
  ),
  "",
  ...modes.map((mode) => `- \`${mode.name}\`: ${mode.about}`),
  "",
  ...(hybrid === undefined
    ? []
    : [
        `### hybrid search: ${String(hybrid.chunks)} chunks of ${String(hybrid.dims)} dimensions (a fake embedder, time only)`,
        "",
        `embed took ${String(hybrid.embedMs)} ms (${String(Math.round((hybrid.chunks * 1000) / Math.max(1, hybrid.embedMs)))} chunks a second, with no model). The vectors are ${String(Math.round(hybrid.vectorBytes / 1_048_576))} MiB, and vectors.sqlite is ${String(Math.round(hybrid.fileBytes / 1_048_576))} MiB. The first search read the vectors into memory in ${String(hybrid.firstSearchMs)} ms.`,
        "",
        "| task | set | median ms | p90 ms | max ms |",
        "| --- | --- | ---: | ---: | ---: |",
        ...hybrid.rows.map(
          (one) =>
            `| ${one.task} | ${one.set} | ${String(one.medianMs)} | ${String(one.p90Ms)} | ${String(one.maxMs)} |`,
        ),
        "",
      ]),
].join("\n");
console.log(table);
if (args.summary !== undefined) appendFileSync(args.summary, table);

index.close();
rmSync(dir, { recursive: true, force: true });
